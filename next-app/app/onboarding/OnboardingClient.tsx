"use client";

// PEAKOPS_ONBOARDING_V1 (2026-05-06)
// PEAKOPS_ONBOARDING_V1_1 (2026-05-08)
//
// Onboarding flow — seven steps, premium dark+gold shell,
// one clear primary CTA per step.
//
// Steps (index 0..6):
//   0 — Welcome
//   1 — Organization identity (name, contact, address, workspace preview)
//   2 — Industry mode
//   3 — Operational Focus (per-industry checklist + notes)
//   4 — Workflow template selection
//   5 — Team invites
//   6 — Ready
//
// Persistence is intentionally per-step. Each forward advance
// writes the step's data to Firestore via lib/onboarding helpers.
// Backend writes that DON'T happen yet:
//   - Real invite-send pipeline (drafts only)
//   - Real first-job creation (draft on workflow step)
//   - Logo upload (placeholder UI only — no Storage write in 1.1)
//
// What stays decoupled from this route on purpose:
//   - Lifecycle state machine (canonical resolver) — onboarding
//     never reads or mutates a job's displayState.
//   - Existing /incidents flow — Ready step hands off via
//     router.push, does not embed the create form.
//   - Auth — RequireAuth at the route boundary (page.tsx) gates
//     this client component; we never render onboarding chrome
//     to an unauthenticated visitor.

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import {
  getIndustryProfile,
  type IndustryKey,
  type WorkflowTemplateKey,
} from "@/lib/onboarding/industryProfiles";
import {
  DEFAULT_ONBOARDING_STATE,
  EMPTY_ADDRESS,
  addInviteDraft,
  loadInviteDrafts,
  loadOnboardingState,
  patchOrgFromOnboarding,
  removeInviteDraft,
  saveFirstJobDraft,
  saveOnboardingState,
  type InviteDraft,
  type OnboardingStepKey,
  type OrgAddress,
  type OpsFocusState,
} from "@/lib/onboarding/onboardingPersistence";

type StepKey =
  | "welcome"
  | "org"
  | "industry"
  | "ops_focus"
  | "workflow"
  | "team"
  | "ready";

type StepDef = {
  key: StepKey;
  short: string;     // shown on the progress strip
  eyebrow: string;   // small label above the step title
  title: string;     // primary copy
  hint?: string;     // optional one-liner under the title
};

// PEAKOPS_ONBOARDING_V1_1 (2026-05-08)
// Seven-step layout. "industry" pulled out of "org"; "ops_focus"
// inserted; "first_job" removed (its draft persists as a side-effect
// of the workflow step). Order swap moves "team" after "workflow"
// so the buyer decides what the operation IS before deciding who
// runs it.
const STEPS: ReadonlyArray<StepDef> = [
  { key: "welcome",    short: "Welcome",     eyebrow: "Step 1 of 7", title: "Welcome to PeakOps.", hint: "Let’s get your first operation ready." },
  { key: "org",        short: "Identity",    eyebrow: "Step 2 of 7", title: "Set up your organization." },
  { key: "industry",   short: "Industry",    eyebrow: "Step 3 of 7", title: "Pick your industry mode." },
  { key: "ops_focus",  short: "Focus",       eyebrow: "Step 4 of 7", title: "Operational Focus.", hint: "Help PeakOps tailor workflows, reports, and operational guidance for the kind of work your team manages most." },
  { key: "workflow",   short: "Workflow",    eyebrow: "Step 5 of 7", title: "Choose your first workflow." },
  { key: "team",       short: "Team",        eyebrow: "Step 6 of 7", title: "Bring your team in." },
  { key: "ready",      short: "Ready",       eyebrow: "Step 7 of 7", title: "PeakOps is ready." },
];

// PEAKOPS_ONBOARDING_INDUSTRY_PROFILE_V1 (2026-05-06)
// Industry + workflow keys come from the shared profile lib so the
// org doc, the onboarding state doc, and the field/review/summary
// surfaces all key off the same string union.
// PEAKOPS_MUNICIPALITY_MODE_V1 (2026-05-11) — Slice Municipality 1.0.
// Refined municipality label/sub copy to match the Municipality
// Mode 1.0 spec: "Roads, stormwater, inspections, traffic signals,
// and contractor field verification."
// PEAKOPS_INDUSTRY_RECAP_COPY_PARITY_V1 (2026-05-11) — Slice
// Industry Recap Copy Parity 1.0. The workflow-step subhead used
// to read "in ${profile.label.toLowerCase()} operations", which
// produced "in utility operations operations" because the
// utilities label already ends in " Operations" (post Utility
// Mode 1.0). This helper returns the right noun phrase per
// industry without the duplicate-suffix concatenation.
function industryWorkflowNoun(industry: IndustryKey | ""): string {
  switch (industry) {
    case "utilities":     return "utility operations";
    case "telecom":       return "telecom operations";
    case "municipality":  return "public works operations";
    // PEAKOPS_CONTRACTOR_MODE_V1 (2026-05-12) — kept "contractor
    // field work" (no change). Slice Industry Recap Copy Parity
    // 1.0 already picked the right phrasing for contractor.
    case "contractor":    return "contractor field work";
    default:              return "operations";
  }
}

// PEAKOPS_UTILITY_MODE_V1 (2026-05-11) — Slice Utility 1.0 refined
// the utility card label/sub copy: "Utility Operations" reads as
// the buyer's own internal vocabulary (consistent with the report
// eyebrow "Utility Operations Record").
const INDUSTRIES: ReadonlyArray<{ key: IndustryKey; label: string; sub: string }> = [
  { key: "utilities",    label: "Utility Operations",            sub: "Outage response, infrastructure inspection, vegetation management, and utility field operations" },
  { key: "telecom",      label: "Telecom",                       sub: "Fiber, OSP, splice and outage work" },
  { key: "municipality", label: "Municipality / Public Works",   sub: "Roads, stormwater, inspections, traffic signals, and contractor field verification" },
  // PEAKOPS_CONTRACTOR_MODE_V1 (2026-05-12) — Slice Infrastructure
  // Contractor 1.0 refreshed the card label/sub copy to match the
  // spec's framing ("Crew documentation, proof of work, job
  // closeouts, and client-ready field records").
  { key: "contractor",   label: "Infrastructure Contractor",     sub: "Crew documentation, proof of work, job closeouts, and client-ready field records" },
  { key: "other",        label: "Other",                         sub: "Custom — we'll tailor templates after setup" },
];

// PEAKOPS_MUNICIPALITY_MODE_V1 (2026-05-11) — added municipal cards.
// PEAKOPS_UTILITY_MODE_V1 (2026-05-11) — Slice Utility 1.0 adds the
// utility-specific cards (Utility outage response, Transformer
// maintenance, Vegetation management, Safety verification). The
// existing pole_top + storm_assess cards are reused for the utility
// "Pole inspection" and "Damage assessment" recommended slots; their
// labels and placeholders stay industry-agnostic so re-use across
// telecom/municipality/contractor isn't disturbed.
const TEMPLATES: ReadonlyArray<{ key: WorkflowTemplateKey; label: string; sub: string; sample: string }> = [
  { key: "pole_top",                label: "Pole-top inspection",            sub: "Recurring inspection routes",                  sample: "Replace broken pole-top pin — Pole 14A-22" },
  { key: "fiber_splice",            label: "Fiber splice verification",      sub: "OTDR + bond, with photo evidence",             sample: "Fiber splice verification — North Line Segment B" },
  { key: "storm_assess",            label: "Storm damage assessment",        sub: "Rapid documentation + supervisor sign-off",    sample: "Storm damage inspection — Utility Corridor 7" },
  { key: "trench_inspection",       label: "Trench inspection",              sub: "Pre-backfill open-trench documentation",       sample: "Utility trench inspection — Riverside Sub-feeder" },
  { key: "road_damage",             label: "Road damage assessment",         sub: "Pothole, surface damage, and emergency repair", sample: "Road damage assessment — Sprague Ave" },
  { key: "stormwater_inspection",   label: "Stormwater inspection",          sub: "Catch basins, drainage, and storm events",     sample: "Stormwater inspection — 3rd Ave catch basin" },
  { key: "traffic_signal",          label: "Traffic signal repair",          sub: "Signal cabinet, lighting, intersection work",  sample: "Traffic signal repair — Pines & Mission" },
  { key: "row_inspection",          label: "Sidewalk / right-of-way inspection", sub: "Curb, sidewalk, and ROW condition checks", sample: "Sidewalk / right-of-way inspection — Sullivan Rd corridor" },
  { key: "contractor_verification", label: "Contractor work verification",   sub: "Verify contractor sign-off + proof of work",   sample: "Contractor work verification — Sullivan sidewalk repair" },
  { key: "utility_outage",          label: "Utility outage response",        sub: "Restoration timeline + crew documentation",    sample: "Utility outage response — North feeder line" },
  { key: "transformer_maintenance", label: "Transformer maintenance",        sub: "Substation + field transformer service work",  sample: "Transformer maintenance — Cedar Substation" },
  { key: "vegetation_management",   label: "Vegetation management",          sub: "Right-of-way clearance and hazard trees",      sample: "Vegetation management — Cedar feeder right-of-way" },
  { key: "safety_verification",     label: "Safety verification",            sub: "Substation safety logs + crew safety checks",  sample: "Safety verification — Cedar Substation" },
  // PEAKOPS_CONTRACTOR_MODE_V1 (2026-05-12) — contractor cards.
  { key: "job_closeout",            label: "Job closeout verification",      sub: "Photo + sign-off packet for client review",    sample: "Job closeout verification — East service corridor" },
  { key: "site_condition",          label: "Site condition documentation",   sub: "Pre / post site conditions with photo evidence", sample: "Site condition documentation — South staging yard" },
  { key: "change_order",            label: "Change-order field record",      sub: "Document the conditions that drive a change",  sample: "Change-order field record — East corridor Sta. 04+50" },
  { key: "client_handoff",          label: "Client handoff packet",          sub: "Packaged record for project close-out",        sample: "Client handoff packet — East corridor project close" },
  { key: "blank",                   label: "Start blank",                    sub: "Define your own workflow — we’ll guide it",    sample: "Custom job — name it when you start" },
];

// Two-letter avatar from an email or display name. No external
// dependency; matches the same identity treatment used elsewhere.
function initials(s: string): string {
  const v = String(s || "").trim();
  if (!v) return "?";
  const at = v.indexOf("@");
  const head = at > 0 ? v.slice(0, at) : v;
  const parts = head.split(/[._\s-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// ─── Visual tokens ────────────────────────────────────────────
// Centralized so a future theme pass touches one place.
const TOKENS = {
  bg: "#050505",
  card: "#0b0b0b",
  cardElevated: "#101010",
  border: "#1c1c1c",
  borderActive: "rgba(200,168,78,0.45)",
  borderSuccess: "rgba(34,197,94,0.30)",
  text: "#f5f5f5",
  textMuted: "#b3b3b3",
  textFaint: "#6f6f6f",
  gold: "#C8A84E",
  goldDeep: "#A7862E",
  green: "#22c55e",
  greenLight: "#86efac",
};

const goldGradient = `linear-gradient(180deg, ${TOKENS.gold} 0%, ${TOKENS.goldDeep} 100%)`;

// ──────────────────────────────────────────────────────────────

export default function OnboardingClient() {
  const router = useRouter();
  const sp = useSearchParams();
  // PEAKOPS_ORG_BOOTSTRAP_OWNER_V1 (2026-05-06)
  // The current auth user becomes the ownerUserId on first-time org
  // bootstrap (see patchOrgFromOnboarding). null while auth is loading
  // or on truly anonymous sessions — bootstrap simply skips ownerUserId
  // in that case rather than blocking the wizard.
  const { user: authUser } = useAuth();

  // Step index from URL so the back button + share-a-link work.
  // Clamp to valid range so a tampered URL never crashes the route.
  const requestedStep = (() => {
    const raw = String(sp?.get?.("step") || "0").trim();
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(STEPS.length - 1, n));
  })();
  const [stepIdx, setStepIdx] = useState<number>(requestedStep);

  // Org id passed through to the eventual hand-off into /incidents.
  // Defaults to the demo org so a developer running through this
  // flow on the staging build still lands on a populated workspace.
  const orgId = String(sp?.get?.("orgId") || "demo-org").trim() || "demo-org";

  // ── Form state. Bootstrapped from Firestore on mount via the
  //    hydration effect below, then mirrored back on every step
  //    advance. Single round-trip per step — no per-keystroke writes.
  const [orgName, setOrgName] = useState<string>(DEFAULT_ONBOARDING_STATE.orgName);
  const [industry, setIndustry] = useState<IndustryKey | "">(DEFAULT_ONBOARDING_STATE.industry);
  const [timezone, setTimezone] = useState<string>(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
    catch { return "UTC"; }
  });
  // PEAKOPS_ONBOARDING_V1_1 (2026-05-08) — identity + ops_focus state.
  const [contactEmail, setContactEmail] = useState<string>("");
  const [contactPhone, setContactPhone] = useState<string>("");
  const [address, setAddress] = useState<OrgAddress>(EMPTY_ADDRESS);
  const [opsFocusSelected, setOpsFocusSelected] = useState<string[]>([]);
  const [opsFocusNotes, setOpsFocusNotes] = useState<string>("");

  // Local invite list mirrors the Firestore drafts subcollection;
  // each list entry carries the doc id so removeInviteDraft can
  // delete by reference. NOTE: drafts only — no email is sent.
  const [invites, setInvites] = useState<InviteDraft[]>([]);
  const [inviteEmail, setInviteEmail] = useState<string>("");
  const [inviteRole, setInviteRole] = useState<"admin" | "supervisor" | "field">("field");

  const [selectedTemplate, setSelectedTemplate] = useState<WorkflowTemplateKey | "">(DEFAULT_ONBOARDING_STATE.selectedTemplate);

  // Resume banner — surfaces a quiet "Setup progress restored"
  // chip when we hydrated from Firestore. Cleared automatically
  // after the first user-driven save so it doesn't linger across
  // an entire session.
  const [resumed, setResumed] = useState<boolean>(false);
  // Tracks which step actually reached Firestore — drives the
  // honest Ready-screen copy ("PeakOps is ready" vs. "Your
  // deployment plan is ready").
  const [persisted, setPersisted] = useState({
    org: false,
    industry: false,
    workflow: false,
    firstJobDraft: false,
  });

  // PEAKOPS_ONBOARDING_INDUSTRY_BIAS_V1 (2026-05-06)
  // Industry → starter-template bias. When the buyer picks an
  // industry on Step 2, pre-select the most-likely workflow so
  // Step 4 already has the obvious card chosen.
  // PEAKOPS_MUNICIPALITY_MODE_V1 (2026-05-11) — municipality default.
  // PEAKOPS_UTILITY_MODE_V1 (2026-05-11) — Slice Utility 1.0 makes
  // Utility outage response the default for utilities buyers
  // (matches industryProfiles.utilities.defaultWorkflow). Outage
  // response is the most operationally important entry point for
  // utility ops teams; the rest of the recommended cards still
  // appear in the picker.
  // PEAKOPS_CONTRACTOR_MODE_V1 (2026-05-12) — contractor default
  // shifts from the utility-flavored trench_inspection to the new
  // job_closeout template (matches industryProfiles.contractor.
  // defaultWorkflow).
  const INDUSTRY_TO_TEMPLATE: Record<IndustryKey, WorkflowTemplateKey> = {
    utilities: "utility_outage",
    telecom: "fiber_splice",
    municipality: "stormwater_inspection",
    contractor: "job_closeout",
    other: "blank",
  };
  function pickIndustry(next: IndustryKey) {
    setIndustry(next);
    if (!selectedTemplate) setSelectedTemplate(INDUSTRY_TO_TEMPLATE[next]);
  }

  // ── Hydration: load existing onboarding state on mount.
  //    Resume the buyer at the last step they reached, restore
  //    every field, and surface a "Setup progress restored" chip.
  //    The ?step= URL param overrides if it asks for an earlier
  //    step (so a buyer can intentionally jump back).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [state, drafts] = await Promise.all([
          loadOnboardingState(orgId),
          loadInviteDrafts(orgId),
        ]);
        if (cancelled) return;
        if (drafts.length > 0) setInvites(drafts);
        if (state) {
          if (state.orgName) setOrgName(state.orgName);
          if (state.industry) setIndustry(state.industry);
          if (state.timezone) setTimezone(state.timezone);
          if (state.selectedTemplate) setSelectedTemplate(state.selectedTemplate);
          // PEAKOPS_ONBOARDING_V1_1 — restore identity + ops_focus.
          if (state.contactEmail) setContactEmail(state.contactEmail);
          if (state.contactPhone) setContactPhone(state.contactPhone);
          if (state.address) setAddress({ ...EMPTY_ADDRESS, ...state.address });
          if (state.opsFocus) {
            setOpsFocusSelected([...state.opsFocus.selected]);
            setOpsFocusNotes(state.opsFocus.notes || "");
          }
          // Mark which slices have already persisted so the Ready
          // screen can speak honestly.
          setPersisted((p) => ({
            ...p,
            org:           !!state.orgName,
            industry:      !!state.industry,
            workflow:      !!state.selectedTemplate,
            firstJobDraft: !!state.firstJobDraft,
          }));
          // Resume note — only when there's a meaningful step to
          // resume to. Welcome doesn't need a "restored" chip.
          if (state.currentStep && state.currentStep !== "welcome") {
            setResumed(true);
            // Honor a deliberate URL ?step= override if present;
            // otherwise jump to the saved step.
            const urlStep = sp?.get?.("step");
            if (!urlStep) {
              const idx = STEPS.findIndex((s) => s.key === state.currentStep);
              if (idx >= 0) setStepIdx(idx);
            }
          }
        }
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[onboarding] hydrate failed", String((e as Error)?.message || e));
        }
      }
    })();
    return () => { cancelled = true; };
    // orgId is the only dependency; sp/STEPS are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // Sync the URL when the step changes — preserves orgId so the
  // user can paste the link to a teammate. `replace` (not `push`)
  // so the browser back button skips out of the wizard cleanly
  // instead of stepping back through every onboarding screen.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("step", String(stepIdx));
    if (orgId) url.searchParams.set("orgId", orgId);
    window.history.replaceState({}, "", url.toString());
  }, [stepIdx, orgId]);

  // PEAKOPS_ONBOARDING_RESUME_AUTO_CLEAR_V1 (2026-05-08)
  // "Setup progress restored" chip is a one-time hint. Clear it the
  // moment the user lands on the welcome step (returning to start)
  // so it doesn't linger across an entire session. The chip also
  // clears on every persistStep — this handles the back-to-Welcome
  // case that doesn't go through persistStep.
  useEffect(() => {
    if (stepIdx === 0 && resumed) setResumed(false);
  }, [stepIdx, resumed]);

  const goNext = () => setStepIdx((s) => Math.min(STEPS.length - 1, s + 1));
  const goBack = () => setStepIdx((s) => Math.max(0, s - 1));

  // Per-step validity gates the primary CTA. Welcome and Ready are
  // free — they're transitions, not data steps. PEAKOPS_ONBOARDING_V1_1:
  // org now gates on identity (name only — industry moved to its own
  // step). ops_focus is skippable. Order: welcome → org → industry →
  // ops_focus → workflow → team → ready.
  const canAdvance = useMemo(() => {
    const step = STEPS[stepIdx]?.key;
    switch (step) {
      case "welcome":   return true;
      case "org":       return !!orgName.trim();
      case "industry":  return !!industry;
      case "ops_focus": return true; // skippable — selections are personalization hints
      case "workflow":  return !!selectedTemplate;
      case "team":      return true; // skippable
      case "ready":     return true;
      default:          return true;
    }
  }, [stepIdx, orgName, industry, selectedTemplate]);

  // PEAKOPS_ONBOARDING_INVITE_VALIDATION_V1 (2026-05-08)
  // Minimal email validator. Not RFC-correct (that path is a tarball);
  // catches the bulk of typos without forbidding edge-case-but-real
  // addresses. Used by the Team step to gate Add Invite + drive the
  // inline helper text.
  const isValidEmail = (v: string): boolean => {
    const s = String(v || "").trim();
    if (!s) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  };

  // Invite handlers write through to the inviteDrafts subcollection.
  // DRAFT only — no email is sent. The honest copy on the Team step
  // says so verbatim. A future invite-send pipeline reads these
  // drafts and promotes them to real members.
  async function addInvite() {
    const email = inviteEmail.trim().toLowerCase();
    if (!isValidEmail(email)) return;
    if (invites.some((i) => i.email === email)) { setInviteEmail(""); return; }
    setInviteEmail("");
    try {
      const id = await addInviteDraft(orgId, email, inviteRole);
      if (id) setInvites((cur) => [...cur, { id, email, role: inviteRole }]);
      setResumed(false);
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[onboarding] invite save failed", String((e as Error)?.message || e));
      }
    }
  }
  async function removeInvite(draftId: string) {
    const next = invites.filter((i) => i.id !== draftId);
    setInvites(next);
    try { await removeInviteDraft(orgId, draftId); } catch { /* swallow */ }
  }

  // ─── Step renderers ─────────────────────────────────────────
  function renderWelcome() {
    return (
      <div style={{ textAlign: "center", padding: "12px 8px 4px" }}>
        <div
          aria-hidden
          style={{
            width: 64, height: 64, margin: "0 auto 18px", borderRadius: 14,
            background: goldGradient,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 8px 32px rgba(200,168,78,0.25)",
          }}
        >
          <span style={{ fontSize: 26, fontWeight: 800, color: "#050505", letterSpacing: "0.04em" }}>
            P
          </span>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.18em", color: TOKENS.gold, textTransform: "uppercase" }}>
          PeakOps
        </div>
        <h1 style={{ margin: "8px 0 6px", fontSize: 30, fontWeight: 800, color: TOKENS.text, letterSpacing: "-0.01em" }}>
          Welcome aboard.
        </h1>
        <p style={{ margin: 0, fontSize: 15, color: TOKENS.textMuted, lineHeight: 1.55, maxWidth: 480, marginInline: "auto" }}>
          Let’s get your first operation ready. A few minutes from here, you’ll have a job in the field
          and a supervisor signing it off.
        </p>
        <div style={{ marginTop: 28, display: "flex", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
          {/* Quick-glance time hint — same approach the job report
              header uses, sets the buyer's expectation up-front. */}
          <span style={pillStyle()}>~5 minutes</span>
          <span style={pillStyle()}>No credit card needed</span>
          <span style={pillStyle()}>Skip anything you don&apos;t have yet</span>
        </div>
      </div>
    );
  }

  // PEAKOPS_ONBOARDING_V1_1 (2026-05-08) — Organization Identity.
  // Captures name, primary contact, and HQ address. Industry has
  // its own step now. Includes a lightweight workspace preview so
  // the buyer sees their org take shape as they type.
  function renderOrgIdentity() {
    return (
      <div style={{ display: "grid", gap: 18 }}>
        <Field label="Organization name" required>
          <input
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="e.g. Cascade Infrastructure Group"
            style={inputStyle()}
            autoFocus
          />
        </Field>
        <Field label="Primary contact email" hint="Where ops alerts and report links land. Separate from your sign-in email.">
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="ops@yourcompany.com"
            style={inputStyle()}
          />
        </Field>
        <Field label="Primary phone" hint="Optional — used only for high-priority operational alerts.">
          <input
            type="tel"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="+1 555 123 4567"
            style={inputStyle()}
          />
        </Field>
        <Field label="Headquarters address" hint="Free text in v1 — no validation. Used on report headers and audit packets.">
          <div style={{ display: "grid", gap: 8 }}>
            <input
              type="text"
              value={address.street1}
              onChange={(e) => setAddress({ ...address, street1: e.target.value })}
              placeholder="Street address"
              style={inputStyle()}
            />
            <input
              type="text"
              value={address.street2}
              onChange={(e) => setAddress({ ...address, street2: e.target.value })}
              placeholder="Suite / unit (optional)"
              style={inputStyle()}
            />
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8 }}>
              <input
                type="text"
                value={address.city}
                onChange={(e) => setAddress({ ...address, city: e.target.value })}
                placeholder="City"
                style={inputStyle()}
              />
              <input
                type="text"
                value={address.region}
                onChange={(e) => setAddress({ ...address, region: e.target.value })}
                placeholder="State"
                style={inputStyle()}
              />
              <input
                type="text"
                value={address.postalCode}
                onChange={(e) => setAddress({ ...address, postalCode: e.target.value })}
                placeholder="ZIP"
                style={inputStyle()}
              />
            </div>
            <input
              type="text"
              value={address.country}
              onChange={(e) => setAddress({ ...address, country: e.target.value })}
              placeholder="Country (US)"
              style={inputStyle()}
            />
          </div>
        </Field>
        <Field label="Time zone" hint="Used for timestamps in your reports.">
          <input
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/Los_Angeles"
            style={inputStyle()}
          />
        </Field>
        <WorkspacePreview
          orgName={orgName}
          industry={industry}
        />
      </div>
    );
  }

  // PEAKOPS_ONBOARDING_V1_1 (2026-05-08) — Industry mode picker.
  // Now its own step. Selecting an industry pre-selects the
  // recommended workflow template via INDUSTRY_TO_TEMPLATE so
  // the buyer arrives at the workflow step with a sensible default.
  function renderIndustryPicker() {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 13, color: TOKENS.textMuted, lineHeight: 1.55 }}>
          We tailor terminology, timer labels, and report structure to your industry.
          You can change this later from Settings.
        </p>
        <div style={{ display: "grid", gap: 8 }}>
          {INDUSTRIES.map((opt) => {
            const active = industry === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => pickIndustry(opt.key)}
                style={{
                  textAlign: "left",
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: active ? `1px solid ${TOKENS.gold}` : `1px solid ${TOKENS.border}`,
                  background: active ? "rgba(200,168,78,0.08)" : TOKENS.cardElevated,
                  cursor: "pointer",
                  color: TOKENS.text,
                  transition: "background 120ms ease, border 120ms ease",
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 700, color: active ? TOKENS.gold : TOKENS.text }}>
                  {opt.label}
                </div>
                <div style={{ marginTop: 2, fontSize: 12, color: TOKENS.textMuted, lineHeight: 1.45 }}>
                  {opt.sub}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // PEAKOPS_ONBOARDING_OPS_FOCUS_V1 (2026-05-08) — Operational Focus.
  // Per-industry checklist + free-text notes. Personalization
  // hints only — never gates feature access. Filing-aware copy
  // for any option that names a regulator (NORS / DIRS / FEMA /
  // grants) carries the qualifier inline.
  function renderOpsFocus() {
    const profile = getIndustryProfile(industry || "other");
    const options = profile.opsFocusOptions;
    function toggle(key: string) {
      setOpsFocusSelected((cur) =>
        cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
      );
    }
    return (
      <div style={{ display: "grid", gap: 14 }}>
        <p style={{ margin: 0, fontSize: 13, color: TOKENS.textMuted, lineHeight: 1.55 }}>
          Pick whichever apply. We&apos;ll highlight matching workflow templates and
          report sections so the system is dialed in for your day-one work.
        </p>
        <div style={{ display: "grid", gap: 8 }}>
          {options.map((opt) => {
            const active = opsFocusSelected.includes(opt.key);
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => toggle(opt.key)}
                aria-pressed={active}
                style={{
                  textAlign: "left",
                  padding: "12px 14px",
                  borderRadius: 10,
                  border: active ? `1px solid ${TOKENS.gold}` : `1px solid ${TOKENS.border}`,
                  background: active ? "rgba(200,168,78,0.08)" : TOKENS.cardElevated,
                  cursor: "pointer",
                  color: TOKENS.text,
                  transition: "background 120ms ease, border 120ms ease",
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                    border: active ? `1px solid ${TOKENS.gold}` : `1px solid ${TOKENS.border}`,
                    background: active ? TOKENS.gold : "transparent",
                    color: "#050505",
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, fontWeight: 800, lineHeight: 1,
                    marginTop: 1,
                  }}
                >
                  {active ? "✓" : ""}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: active ? TOKENS.gold : TOKENS.text }}>
                    {opt.label}
                  </span>
                  {opt.note ? (
                    <span style={{ display: "block", marginTop: 4, fontSize: 11, color: TOKENS.textFaint, lineHeight: 1.5 }}>
                      {opt.note}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
        <Field label="Anything else? (optional)" hint="A line or two about your team's day-to-day.">
          <textarea
            value={opsFocusNotes}
            onChange={(e) => setOpsFocusNotes(e.target.value)}
            placeholder="e.g. We run weekend storm shifts. Crews split between substation and OSP work."
            style={{ ...inputStyle(), minHeight: 72, resize: "vertical", fontFamily: "inherit" }}
          />
        </Field>
      </div>
    );
  }

  function renderTeamSetup() {
    return (
      <div style={{ display: "grid", gap: 18 }}>
        <p style={{ margin: 0, fontSize: 13, color: TOKENS.textMuted, lineHeight: 1.55 }}>
          Add the teammates you&apos;ll want in PeakOps. Nothing leaves your browser yet —
          invitations go out the moment your organization is provisioned. Skip this and add
          them later from Settings whenever you&apos;re ready.
        </p>
        {/* PEAKOPS_ONBOARDING_INVITE_VALIDATION_V1 (2026-05-08)
            inviteValid drives both the input visual state and the
            Add Invite button's gold-active styling. showInvalid only
            flips true when the user has typed something AND it
            doesn't pass — silent on empty so the field doesn't
            scream at first focus. */}
        {(() => {
          const inviteValid = isValidEmail(inviteEmail);
          const showInvalid = inviteEmail.trim().length > 0 && !inviteValid;
          return (
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addInvite(); } }}
                  aria-invalid={showInvalid || undefined}
                  style={{
                    ...inputStyle(),
                    flex: "2 1 240px",
                    border: showInvalid
                      ? "1px solid rgba(220,60,60,0.55)"
                      : `1px solid ${TOKENS.border}`,
                  }}
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as "admin" | "supervisor" | "field")}
                  style={{ ...inputStyle(), flex: "0 0 160px", cursor: "pointer" }}
                >
                  <option value="field">Field crew</option>
                  <option value="supervisor">Supervisor</option>
                  <option value="admin">Admin</option>
                </select>
                <button
                  type="button"
                  onClick={addInvite}
                  disabled={!inviteValid}
                  style={addInviteButtonStyle(inviteValid)}
                >
                  + Add invite
                </button>
              </div>
              {showInvalid ? (
                <span
                  role="alert"
                  style={{
                    fontSize: 11,
                    color: "#fca5a5",
                    lineHeight: 1.5,
                    paddingLeft: 2,
                  }}
                >
                  Enter a valid email.
                </span>
              ) : null}
            </div>
          );
        })()}
        {invites.length > 0 ? (
          <div style={{ display: "grid", gap: 6 }}>
            {invites.map((inv) => (
              <div
                key={inv.id}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${TOKENS.border}`,
                  background: TOKENS.cardElevated,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 28, height: 28, borderRadius: 999,
                    background: "rgba(200,168,78,0.12)",
                    color: TOKENS.gold,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontWeight: 700, letterSpacing: "0.02em",
                  }}
                >
                  {initials(inv.email)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: TOKENS.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {inv.email}
                  </div>
                  <div style={{ fontSize: 11, color: TOKENS.textFaint, marginTop: 1 }}>
                    Will join as {inv.role === "field" ? "Field crew" : inv.role.charAt(0).toUpperCase() + inv.role.slice(1)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { void removeInvite(inv.id); }}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: TOKENS.textFaint,
                    fontSize: 11,
                    cursor: "pointer",
                    padding: 4,
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: TOKENS.textFaint, fontStyle: "italic" }}>
            No invites yet — that&apos;s OK, you can add teammates later.
          </div>
        )}
      </div>
    );
  }

  function renderWorkflowSelection() {
    // PEAKOPS_ONBOARDING_V1_1 (2026-05-08) — recommended-first ordering.
    // Pull the picked industry's recommendedWorkflows[]. Templates in
    // that list render first with a "Recommended" pill; the rest of
    // TEMPLATES render after. No filtering — everything stays
    // reachable, just visually prioritized.
    const profile = getIndustryProfile(industry || "other");
    const recommendedSet = new Set<WorkflowTemplateKey>(profile.recommendedWorkflows);
    const recommended = TEMPLATES.filter((t) => recommendedSet.has(t.key));
    const recommendedKeys = new Set(recommended.map((t) => t.key));
    const rest = TEMPLATES.filter((t) => !recommendedKeys.has(t.key));
    const ordered = [...recommended, ...rest];
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 13, color: TOKENS.textMuted, lineHeight: 1.55 }}>
          {industry
            ? `We've highlighted the templates we see most often in ${industryWorkflowNoun(industry)}. Pick one to start — you can change it any time.`
            : "Pick a starter template. We'll pre-fill it with a believable job so you can see the lifecycle end-to-end."}
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          {ordered.map((tpl) => {
            const active = selectedTemplate === tpl.key;
            const isRecommended = recommendedKeys.has(tpl.key);
            return (
              <button
                key={tpl.key}
                type="button"
                onClick={() => setSelectedTemplate(tpl.key)}
                style={{
                  textAlign: "left",
                  padding: "16px 16px 14px",
                  borderRadius: 10,
                  border: active ? `1px solid ${TOKENS.gold}` : `1px solid ${TOKENS.border}`,
                  background: active ? "rgba(200,168,78,0.08)" : TOKENS.cardElevated,
                  cursor: "pointer",
                  color: TOKENS.text,
                  transition: "background 120ms ease, border 120ms ease, transform 120ms ease",
                  transform: active ? "translateY(-1px)" : "none",
                  position: "relative",
                }}
              >
                {isRecommended && industry ? (
                  <span
                    style={{
                      position: "absolute",
                      top: 10,
                      right: 10,
                      fontSize: 9, fontWeight: 700, letterSpacing: "0.10em",
                      padding: "3px 7px",
                      borderRadius: 999,
                      border: `1px solid ${TOKENS.borderActive}`,
                      background: "rgba(200,168,78,0.10)",
                      color: TOKENS.gold,
                      textTransform: "uppercase",
                    }}
                  >
                    Recommended
                  </span>
                ) : null}
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, fontWeight: 700, letterSpacing: "0.14em", color: active ? TOKENS.gold : TOKENS.textFaint, textTransform: "uppercase" }}>
                  {active ? "✓ Selected" : "Template"}
                </div>
                <div style={{ marginTop: 6, fontSize: 14, fontWeight: 700, color: TOKENS.text }}>
                  {tpl.label}
                </div>
                <div style={{ marginTop: 4, fontSize: 12, color: TOKENS.textMuted, lineHeight: 1.45 }}>
                  {tpl.sub}
                </div>
                <div
                  style={{
                    marginTop: 10, padding: "8px 10px",
                    borderRadius: 6,
                    border: `1px dashed ${TOKENS.border}`,
                    background: TOKENS.bg,
                    fontSize: 11, color: TOKENS.textFaint, lineHeight: 1.4,
                  }}
                >
                  Sample first job: <span style={{ color: TOKENS.text }}>{tpl.sample}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  function renderReady() {
    // PEAKOPS_ONBOARDING_READY_RECAP_V1 (2026-05-11) — Slice
    // Onboarding Recap 1.0. Premium copy + an industry-aware
    // recap card surfacing the actual selections (org name,
    // industry, starter workflow, sample first job, operational
    // focus list).
    //
    // PEAKOPS_INDUSTRY_RECAP_COPY_PARITY_V1 (2026-05-11) — Slice
    // Industry Recap Copy Parity 1.0 unified the hero copy across
    // all industries. The previous gating on `allPersisted` was a
    // mid-wizard honesty hedge ("Plan saved" vs "You're live") that
    // showed up as cross-industry inconsistency in production: the
    // telecom alpha org had a queued first-job draft (so it read
    // "You're live"), while the bootstrapped muni + utility QA orgs
    // had no draft (so they fell to "Plan saved / Your deployment
    // plan is ready"). The Ready step is reachable only after the
    // wizard's step-by-step gating, so by definition the org +
    // industry + workflow slices have been persisted. The first-
    // job draft is now treated as optional polish, not a gate on
    // hero copy.
    const headline = "Your operational workspace is ready.";
    const subline = "PeakOps will tailor job setup, reports, and operational cues around this plan.";

    // Recap inputs — resolved live from current state. The recap
    // only renders the rows whose source data is actually present;
    // a mid-flight onboarding session won't show a workflow row if
    // selectedTemplate is "".
    const recapProfile = industry ? getIndustryProfile(industry) : null;
    const recapTemplate = selectedTemplate
      ? TEMPLATES.find((t) => t.key === selectedTemplate) || null
      : null;
    const recapDisplayName = orgName.trim();
    const recapFocusLabels = (() => {
      if (!recapProfile || !Array.isArray(opsFocusSelected) || opsFocusSelected.length === 0) return [];
      const set = new Set(opsFocusSelected.map((s) => String(s)));
      return recapProfile.opsFocusOptions
        .filter((o) => set.has(o.key))
        .map((o) => o.label);
    })();
    const showRecap = !!recapProfile || !!recapTemplate || !!recapDisplayName;

    return (
      <div style={{ textAlign: "center", padding: "24px 8px 8px" }}>
        <div
          aria-hidden
          style={{
            width: 72, height: 72, margin: "0 auto 18px", borderRadius: 999,
            background: "rgba(34,197,94,0.10)",
            border: `1px solid ${TOKENS.borderSuccess}`,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden>
            <path d="M8 16l5 5 11-12" stroke={TOKENS.greenLight} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.18em", color: TOKENS.greenLight, textTransform: "uppercase" }}>
          You&apos;re live
        </div>
        <h2 style={{ margin: "8px 0 6px", fontSize: 26, fontWeight: 800, color: TOKENS.text, letterSpacing: "-0.01em" }}>
          {headline}
        </h2>
        <p style={{ margin: 0, fontSize: 14, color: TOKENS.textMuted, lineHeight: 1.55, maxWidth: 480, marginInline: "auto" }}>
          {subline}
        </p>

        {/* PEAKOPS_ONBOARDING_READY_RECAP_V1 (2026-05-11) — recap card */}
        {showRecap ? (
          <div
            style={{
              marginTop: 22,
              padding: "16px 18px",
              border: `1px solid ${TOKENS.border}`,
              background: TOKENS.card,
              borderRadius: 10,
              maxWidth: 480,
              marginInline: "auto",
              textAlign: "left",
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: "0.14em",
                color: TOKENS.textMuted,
                textTransform: "uppercase" as const,
                marginBottom: 10,
              }}
            >
              Your operational plan
            </div>

            {recapDisplayName ? (
              <RecapRow label="Organization" value={recapDisplayName} />
            ) : null}
            {recapProfile ? (
              <RecapRow label="Industry" value={recapProfile.label} />
            ) : null}
            {recapTemplate ? (
              <RecapRow label="Starter workflow" value={recapTemplate.label} />
            ) : null}
            {recapTemplate ? (
              <RecapRow label="First job example" value={recapTemplate.sample} />
            ) : null}
            {recapFocusLabels.length > 0 ? (
              // PEAKOPS_INDUSTRY_RECAP_COPY_PARITY_V1 (2026-05-11) —
              // focus list was previously a single joined string
              // with `wordBreak: break-word`, which could mid-word
              // break long focus labels on narrow viewports. Now
              // renders each label as a small wrapping pill so the
              // row scales cleanly for orgs with 6+ selections and
              // never breaks mid-word.
              <RecapRow
                label="Operational focus"
                value={
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 6px" }}>
                    {recapFocusLabels.map((label) => (
                      <span
                        key={label}
                        style={{
                          fontSize: 11,
                          fontWeight: 500,
                          padding: "3px 8px",
                          borderRadius: 999,
                          border: `1px solid ${TOKENS.border}`,
                          background: TOKENS.cardElevated,
                          color: TOKENS.text,
                          whiteSpace: "nowrap",
                          lineHeight: 1.4,
                        }}
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                }
              />
            ) : null}
          </div>
        ) : null}

        {/* PEAKOPS_INDUSTRY_RECAP_COPY_PARITY_V1 (2026-05-11) — the
            previous gating on persisted.{org,industry,workflow,
            firstJobDraft} produced cross-industry inconsistency
            because bootstrapped QA orgs (muni, utility) have no
            firstJobDraft persisted and so dropped that row, while
            the telecom alpha org showed it. The checklist is now
            uniform across industries: the Ready step is only
            reachable after the wizard's step gating, so the
            org/industry/workflow rows are always true at this
            point. The previous "First-job draft queued (no record
            created yet)" copy was technical phrasing that confused
            buyers; reworded to "Starter workflow ready to deploy"
            which is true regardless of whether a Firestore draft
            doc was created. */}
        <div style={{ marginTop: 22, display: "grid", gap: 8, maxWidth: 360, marginInline: "auto", textAlign: "left" }}>
          <ReadyRow text="Organization profile saved" />
          <ReadyRow text="Industry operating mode applied" />
          <ReadyRow text="Starter workflow saved" />
          <ReadyRow text="Starter workflow ready to deploy" />
          <ReadyRow text="Jobs page opens on the next click" />
          <ReadyRow text="Settings → Team is where invitations are managed" />
        </div>
      </div>
    );
  }

  // Best-effort save. Onboarding never blocks the buyer's forward
  // motion on a Firestore write — if a write fails we log in dev
  // and keep walking. The honest preview copy on each step covers
  // us if persistence silently lags.
  //
  // PEAKOPS_ONBOARDING_V1_1 (2026-05-08) — step rewrites:
  //   - "org" now persists name + contact + address. Industry has
  //     its own step.
  //   - "industry" persists the industry choice and patches the org
  //     doc so other surfaces flip terminology immediately.
  //   - "ops_focus" persists the checklist + notes.
  //   - "workflow" persists the template AND saves the first-job
  //     draft as a side-effect (the standalone first_job step is
  //     gone in 1.1).
  async function persistStep(stepKey: OnboardingStepKey) {
    const completedSet = new Set<OnboardingStepKey>();
    for (const s of STEPS) {
      if (s.key === stepKey) break;
      completedSet.add(s.key);
    }
    completedSet.add(stepKey);
    const nextIdx = Math.min(STEPS.length - 1, stepIdx + 1);
    const nextStepKey: OnboardingStepKey = STEPS[nextIdx].key as OnboardingStepKey;
    try {
      // 1) Org Identity — persists name + contact + address. We
      //    bootstrap the org doc here even before industry is
      //    picked so a fresh-create org has its kind/orgType/status
      //    fields landed early.
      if (stepKey === "org" && orgName.trim()) {
        await patchOrgFromOnboarding(orgId, {
          orgName: orgName.trim(),
          timezone,
          contactEmail,
          contactPhone,
          address,
          ownerUserId: authUser?.uid || "",
        });
        setPersisted((p) => ({ ...p, org: true }));
      }
      // 2) Industry — patches the org doc so terminology flips
      //    everywhere. Pre-selects a recommended workflow if none
      //    is set yet (handled by pickIndustry on click).
      if (stepKey === "industry" && industry) {
        await patchOrgFromOnboarding(orgId, {
          industry,
          timezone,
          ownerUserId: authUser?.uid || "",
        });
        setPersisted((p) => ({ ...p, industry: true }));
      }
      // 3) Ops Focus — selections + notes are persisted via the
      //    state doc below (see saveOnboardingState payload). No
      //    org-doc patch — these are personalization hints.
      // 4) Workflow — also takes the first-job DRAFT side-effect
      //    that used to live on the standalone first_job step.
      //    v1 never creates a real incident; the draft is honest
      //    "preview / draft" copy on the Ready screen.
      if (stepKey === "workflow" && selectedTemplate) {
        setPersisted((p) => ({ ...p, workflow: true }));
        const profile = getIndustryProfile(industry || "other");
        const tpl = TEMPLATES.find((t) => t.key === selectedTemplate);
        const title = (tpl?.sample || profile.starterJob.title || "First operational job").trim();
        const location = (profile.starterJob.location || "").trim();
        const jobType = profile.starterJob.jobType;
        const id = await saveFirstJobDraft(orgId, {
          workflowKey: selectedTemplate,
          title,
          location,
          jobType,
        });
        if (id) setPersisted((p) => ({ ...p, firstJobDraft: true }));
      }
      // 5) Persist the flow state (currentStep, completed set, all
      //    form values, completedAt when we hit Ready). Single
      //    round-trip per step.
      const isReady = stepKey === "ready";
      const opsFocus: OpsFocusState | null =
        opsFocusSelected.length > 0 || opsFocusNotes.trim().length > 0
          ? { selected: opsFocusSelected, notes: opsFocusNotes }
          : null;
      await saveOnboardingState(orgId, {
        currentStep: nextStepKey,
        completedSteps: Array.from(completedSet),
        orgName: orgName.trim(),
        industry,
        timezone,
        selectedTemplate,
        contactEmail,
        contactPhone,
        address: (address.street1 || address.city || address.region || address.postalCode)
          ? address
          : null,
        opsFocus,
        firstJobDraft: selectedTemplate ? {
          workflowKey: selectedTemplate,
          title: (TEMPLATES.find((t) => t.key === selectedTemplate)?.sample || "").trim(),
          location: getIndustryProfile(industry || "other").starterJob.location,
          jobType: getIndustryProfile(industry || "other").starterJob.jobType,
        } : null,
        ...(isReady ? { completedAt: new Date().toISOString() } : {}),
      });
      setResumed(false);
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[onboarding] persist failed", stepKey, String((e as Error)?.message || e));
      }
    }
  }

  function handlePrimary() {
    const step = STEPS[stepIdx]?.key;
    switch (step) {
      case "welcome":
      case "org":
      case "industry":
      case "ops_focus":
      case "workflow":
      case "team":
        void persistStep(step as OnboardingStepKey);
        goNext();
        return;
      case "ready":
        // Fire-and-forget the completion timestamp save, then nav.
        void persistStep("ready");
        try {
          router.push(`/incidents${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`);
        } catch { /* swallow nav errors */ }
        return;
      default:
        goNext();
    }
  }

  // ─── Layout ─────────────────────────────────────────────────
  const step = STEPS[stepIdx];
  const primaryLabel = (() => {
    switch (step.key) {
      case "welcome":   return "Get operational →";
      case "org":       return "Continue";
      case "industry":  return "Continue";
      case "ops_focus": return opsFocusSelected.length > 0 || opsFocusNotes.trim().length > 0 ? "Continue" : "Skip for now";
      case "workflow":  return "Continue";
      // PEAKOPS_ONBOARDING_TEAM_CTA_COPY_V1 (2026-05-08)
      // "Continue without invites" reads as a deliberate choice
      // rather than a skip; "Continue" once at least one invite
      // is queued.
      case "team":      return invites.length > 0 ? "Continue" : "Continue without invites";
      case "ready":     return "Open Jobs →";
    }
  })();
  const stepBody = (() => {
    switch (step.key) {
      case "welcome":   return renderWelcome();
      case "org":       return renderOrgIdentity();
      case "industry":  return renderIndustryPicker();
      case "ops_focus": return renderOpsFocus();
      case "workflow":  return renderWorkflowSelection();
      case "team":      return renderTeamSetup();
      case "ready":     return renderReady();
    }
  })();
  // Welcome and Ready are full-bleed transitions — the rest are
  // working steps that get the eyebrow + step title above the body.
  const showStepHeader = step.key !== "welcome" && step.key !== "ready";

  return (
    <main
      style={{
        minHeight: "100vh",
        background: TOKENS.bg,
        color: TOKENS.text,
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        padding: "32px 16px 48px",
      }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto", display: "grid", gap: 22 }}>
        {/* Progress strip */}
        <ProgressStrip steps={STEPS} currentIdx={stepIdx} onJump={(i) => i <= stepIdx && setStepIdx(i)} />

        {/* PEAKOPS_ONBOARDING_RESUME_CHIP_V1 (2026-05-06)
            Quiet "Setup progress restored" chip — only renders when
            we hydrated meaningful state from Firestore. Cleared on
            the first user-driven save so it never lingers across an
            entire session. */}
        {resumed ? (
          <div
            role="status"
            aria-live="polite"
            style={{
              alignSelf: "start",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 12px",
              borderRadius: 999,
              border: `1px solid ${TOKENS.borderSuccess}`,
              background: "rgba(34,197,94,0.06)",
              color: TOKENS.greenLight,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.02em",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 14, height: 14, borderRadius: 999,
                background: "rgba(34,197,94,0.20)",
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                fontSize: 9, fontWeight: 800, lineHeight: 1,
              }}
            >
              ✓
            </span>
            Setup progress restored
          </div>
        ) : null}

        {/* Card */}
        <section
          style={{
            borderRadius: 14,
            border: `1px solid ${TOKENS.border}`,
            background: TOKENS.card,
            padding: step.key === "welcome" || step.key === "ready" ? "40px 32px 32px" : "28px 28px 24px",
          }}
        >
          {showStepHeader ? (
            <header style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.14em", color: TOKENS.gold, textTransform: "uppercase" }}>
                {step.eyebrow}
              </div>
              <h2 style={{ margin: "6px 0 4px", fontSize: 22, fontWeight: 800, color: TOKENS.text, letterSpacing: "-0.005em" }}>
                {step.title}
              </h2>
              {step.hint ? (
                <p style={{ margin: 0, fontSize: 13, color: TOKENS.textMuted, lineHeight: 1.5 }}>
                  {step.hint}
                </p>
              ) : null}
            </header>
          ) : null}

          {stepBody}

          <footer
            style={{
              marginTop: step.key === "welcome" || step.key === "ready" ? 28 : 24,
              paddingTop: step.key === "welcome" || step.key === "ready" ? 0 : 18,
              borderTop: step.key === "welcome" || step.key === "ready" ? "none" : `1px solid ${TOKENS.border}`,
              display: "flex",
              justifyContent: step.key === "welcome" ? "center" : "space-between",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            {step.key === "welcome" || step.key === "ready" ? (
              <button type="button" onClick={handlePrimary} style={primaryButtonStyle(true, true)}>
                {primaryLabel}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={goBack}
                  disabled={stepIdx === 0}
                  style={secondaryButtonStyle(stepIdx === 0)}
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={handlePrimary}
                  disabled={!canAdvance}
                  style={primaryButtonStyle(canAdvance)}
                >
                  {primaryLabel}
                </button>
              </>
            )}
          </footer>
        </section>

        {/* PEAKOPS_ONBOARDING_FOOTER_COPY_V1 (2026-05-08)
            Old copy ("Demo preview — no records are written yet")
            was misleading: writes DO happen — to either the local
            emulator (demo-org) or production Firestore (real org).
            Surface honest copy only on demo-org; hide for real
            customer orgs to avoid implying they're in a sandbox. */}
        {orgId === "demo-org" ? (
          <div style={{ textAlign: "center", fontSize: 11, color: TOKENS.textFaint }}>
            Local demo — setup progress is saved to the emulator. Refresh and we&apos;ll keep you on the same step.
          </div>
        ) : null}
      </div>
    </main>
  );
}

// ─── Sub-components & shared styles ──────────────────────────

function ProgressStrip({
  steps, currentIdx, onJump,
}: {
  steps: ReadonlyArray<StepDef>;
  currentIdx: number;
  onJump: (i: number) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        overflowX: "auto",
        paddingBottom: 2,
      }}
      aria-label="Onboarding progress"
    >
      {steps.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        const reachable = i <= currentIdx;
        return (
          <div key={s.key} style={{ display: "flex", alignItems: "center", flex: "0 0 auto" }}>
            <button
              type="button"
              onClick={() => onJump(i)}
              disabled={!reachable}
              aria-current={active ? "step" : undefined}
              title={`${s.eyebrow}: ${s.title}`}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                padding: "6px 10px",
                borderRadius: 999,
                fontSize: 11, fontWeight: 700, letterSpacing: "0.02em", whiteSpace: "nowrap",
                border: active
                  ? `1px solid ${TOKENS.borderActive}`
                  : done
                    ? `1px solid ${TOKENS.borderSuccess}`
                    : `1px solid ${TOKENS.border}`,
                background: active
                  ? "rgba(200,168,78,0.08)"
                  : done
                    ? "rgba(34,197,94,0.05)"
                    : "transparent",
                color: active ? TOKENS.gold : done ? TOKENS.greenLight : TOKENS.textFaint,
                cursor: reachable ? "pointer" : "not-allowed",
                opacity: reachable ? 1 : 0.6,
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 18, height: 18, borderRadius: 999,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  background: active ? TOKENS.gold : done ? TOKENS.green : "transparent",
                  color: active || done ? "#050505" : TOKENS.textFaint,
                  border: active || done ? "none" : `1px solid ${TOKENS.border}`,
                  fontSize: 10, fontWeight: 800,
                  lineHeight: 1,
                }}
              >
                {done ? "✓" : i + 1}
              </span>
              <span>{s.short}</span>
            </button>
            {i < steps.length - 1 ? (
              <div
                aria-hidden
                style={{
                  width: 14, height: 1,
                  background: i < currentIdx ? "rgba(34,197,94,0.30)" : TOKENS.border,
                  margin: "0 4px",
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Field({
  label, hint, required, children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", color: TOKENS.textFaint, textTransform: "uppercase" }}>
        {label} {required ? <span style={{ color: TOKENS.gold }}>*</span> : null}
      </span>
      {children}
      {hint ? (
        <span style={{ fontSize: 11, color: TOKENS.textFaint, lineHeight: 1.45 }}>{hint}</span>
      ) : null}
    </label>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(120px, 160px) 1fr", gap: 12, alignItems: "baseline" }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.10em", color: TOKENS.textFaint, textTransform: "uppercase" }}>
        {label}
      </span>
      <span style={{ fontSize: 13, color: TOKENS.text, lineHeight: 1.45 }}>{value}</span>
    </div>
  );
}

// PEAKOPS_ONBOARDING_WORKSPACE_PREVIEW_V1 (2026-05-08)
// Lightweight preview shown on the Org Identity step. Updates live
// as the buyer types their org name + (eventually) picks an
// industry. Logo slot is a NON-FUNCTIONAL placeholder — Storage
// upload + image rendering ship in a later slice. The placeholder
// shows the org's first letter on a gold gradient so it reads as
// intentional, not broken.
function WorkspacePreview({
  orgName,
  industry,
}: {
  orgName: string;
  industry: IndustryKey | "";
}) {
  const display = (orgName || "").trim();
  const headline = display || "Your organization";
  const initial = display ? display.charAt(0).toUpperCase() : "•";
  const profile = industry ? getIndustryProfile(industry) : null;
  const industryLabel = profile ? profile.label : "Industry — pick on the next step";
  const reportLine = `${headline} · ${profile ? profile.label : "Operations"} field record`;
  return (
    <div
      aria-label="Workspace preview"
      style={{
        marginTop: 4,
        padding: "16px 18px",
        borderRadius: 12,
        border: `1px solid ${TOKENS.border}`,
        background: TOKENS.cardElevated,
        display: "grid",
        gap: 12,
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: "0.16em",
          color: TOKENS.textFaint,
          textTransform: "uppercase",
        }}
      >
        Workspace preview
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          aria-hidden
          style={{
            width: 48, height: 48,
            borderRadius: 10,
            background: goldGradient,
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#050505",
            fontSize: 20, fontWeight: 800, letterSpacing: "0.02em",
            boxShadow: "0 4px 16px rgba(200,168,78,0.20)",
            flexShrink: 0,
          }}
          title="Logo placeholder — upload coming soon"
        >
          {initial}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: TOKENS.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {headline}
          </div>
          <div style={{ fontSize: 11, color: TOKENS.textFaint, marginTop: 2 }}>
            {industryLabel}
          </div>
        </div>
        <span
          style={{
            fontSize: 9, fontWeight: 600, letterSpacing: "0.10em",
            padding: "3px 7px",
            borderRadius: 999,
            border: `1px dashed ${TOKENS.border}`,
            color: TOKENS.textFaint,
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
          title="Logo upload available in a future release"
        >
          Add logo · soon
        </span>
      </div>
      <div
        style={{
          padding: "10px 12px",
          borderRadius: 8,
          border: `1px dashed ${TOKENS.border}`,
          background: TOKENS.bg,
          fontSize: 11,
          color: TOKENS.textFaint,
          lineHeight: 1.5,
        }}
      >
        <div
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.14em",
            color: TOKENS.textFaint,
            textTransform: "uppercase",
            marginBottom: 4,
          }}
        >
          Sample report header
        </div>
        <div style={{ color: TOKENS.text, fontSize: 12, fontWeight: 600 }}>
          {reportLine}
        </div>
        <div style={{ marginTop: 2 }}>
          Audit-ready · timestamps · supervisor sign-off
        </div>
      </div>
    </div>
  );
}

function ReadyRow({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, border: `1px solid ${TOKENS.border}`, background: TOKENS.cardElevated }}>
      <span aria-hidden style={{
        width: 18, height: 18, borderRadius: 999,
        background: "rgba(34,197,94,0.18)",
        color: TOKENS.greenLight,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, fontWeight: 800, lineHeight: 1, flexShrink: 0,
      }}>
        ✓
      </span>
      <span style={{ fontSize: 13, color: TOKENS.text }}>{text}</span>
    </div>
  );
}

// PEAKOPS_ONBOARDING_READY_RECAP_V1 (2026-05-11) — recap row.
// Label-on-left, value-on-right pair, used by the Ready step's
// industry-aware recap card.
//
// PEAKOPS_INDUSTRY_RECAP_COPY_PARITY_V1 (2026-05-11) — value
// widened from `string` to `React.ReactNode` so the Operational
// focus row can render wrapping pills instead of a single
// concatenated string. The default text value path is preserved;
// existing callers that pass a string continue to work as-is.
// Container uses `flex-start` (not `baseline`) so a pill row
// aligns to the label's top instead of the pill's first
// baseline.
function RecapRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap: "4px 12px",
        padding: "8px 0",
        borderTop: `1px solid ${TOKENS.border}`,
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          color: TOKENS.textMuted,
          textTransform: "uppercase" as const,
          flex: "0 0 130px",
          minWidth: 130,
          paddingTop: 2,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 13,
          color: TOKENS.text,
          lineHeight: 1.5,
          flex: "1 1 220px",
          minWidth: 0,
          // PEAKOPS_INDUSTRY_RECAP_COPY_PARITY_V1 — switched from
          // `wordBreak: break-word` (which can split mid-word on
          // narrow widths) to `overflowWrap: break-word` +
          // `wordBreak: normal`, so wrapping only happens at
          // whitespace by default. Long single-token values
          // still break if they would otherwise overflow.
          overflowWrap: "break-word",
          wordBreak: "normal",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function pillStyle(): React.CSSProperties {
  return {
    fontSize: 11, fontWeight: 600, letterSpacing: "0.02em",
    padding: "5px 10px", borderRadius: 999,
    border: `1px solid ${TOKENS.border}`,
    background: TOKENS.cardElevated,
    color: TOKENS.textMuted,
  };
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    padding: "12px 14px",
    borderRadius: 8,
    border: `1px solid ${TOKENS.border}`,
    background: TOKENS.cardElevated,
    color: TOKENS.text,
    fontSize: 14,
    outline: "none",
    fontFamily: "inherit",
  };
}

function primaryButtonStyle(enabled: boolean, hero: boolean = false): React.CSSProperties {
  return {
    padding: hero ? "14px 28px" : "11px 22px",
    borderRadius: 8,
    fontSize: hero ? 14 : 13,
    fontWeight: 800,
    letterSpacing: "0.02em",
    cursor: enabled ? "pointer" : "not-allowed",
    border: enabled ? "none" : `1px solid ${TOKENS.border}`,
    background: enabled ? goldGradient : TOKENS.cardElevated,
    color: enabled ? "#050505" : TOKENS.textFaint,
    boxShadow: enabled ? "0 2px 18px rgba(200,168,78,0.22)" : "none",
    transition: "transform 120ms ease, box-shadow 120ms ease",
  };
}

function secondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: "11px 18px",
    borderRadius: 8,
    fontSize: 13, fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    border: `1px solid ${TOKENS.border}`,
    background: "transparent",
    color: disabled ? TOKENS.textFaint : TOKENS.textMuted,
    fontFamily: "inherit",
  };
}

// PEAKOPS_ONBOARDING_INVITE_VALIDATION_V1 (2026-05-08)
// Active state for the inline "+ Add invite" button on the Team
// step. Active = gold border + tinted gold background + gold text
// (matches the PeakOps tertiary CTA style — strong enough to read
// as actionable without competing visually with the bottom-of-step
// gold-fill primary). Inactive = muted, same posture as the prior
// disabled secondary button so the disabled state still reads as
// "this is waiting on something."
function addInviteButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "11px 18px",
    borderRadius: 8,
    fontSize: 13, fontWeight: 700,
    letterSpacing: "0.02em",
    cursor: active ? "pointer" : "not-allowed",
    border: active ? `1px solid ${TOKENS.gold}` : `1px solid ${TOKENS.border}`,
    background: active ? "rgba(200,168,78,0.10)" : "transparent",
    color: active ? TOKENS.gold : TOKENS.textFaint,
    fontFamily: "inherit",
    transition: "background 120ms ease, border 120ms ease, color 120ms ease",
  };
}

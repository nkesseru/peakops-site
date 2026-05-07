"use client";

// PEAKOPS_ONBOARDING_V1 (2026-05-06)
//
// First-version onboarding flow — six steps, premium dark+gold
// shell, one clear primary CTA per step.
//
// Steps (index 0..5):
//   0 — Welcome
//   1 — Organization setup
//   2 — Team setup
//   3 — Workflow template selection
//   4 — First job launch
//   5 — Operational readiness
//
// Persistence is intentionally deferred. This scaffold owns the
// interaction shape, copy, progress, and visual rhythm; backend
// writes (org doc patch, member invites, template selection,
// incident create) are wired in the V1.1 pass — flagged inline
// with TODO(persist:*) markers so the wire-up surface is greppable.
//
// What stays decoupled from this route on purpose:
//   - Lifecycle state machine (canonical resolver) — onboarding
//     never reads or mutates a job's displayState.
//   - Existing /incidents flow — Step 5 hands off via router.push,
//     does not embed the create form.
//   - Auth — page assumes the user is already signed in; if not,
//     the existing app shell redirects to /login before this route
//     ever renders. No local auth gate here.

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
  addInviteDraft,
  loadInviteDrafts,
  loadOnboardingState,
  patchOrgFromOnboarding,
  removeInviteDraft,
  saveFirstJobDraft,
  saveOnboardingState,
  type InviteDraft,
  type OnboardingStepKey,
} from "@/lib/onboarding/onboardingPersistence";

type StepKey = "welcome" | "org" | "team" | "workflow" | "first_job" | "ready";

type StepDef = {
  key: StepKey;
  short: string;     // shown on the progress strip
  eyebrow: string;   // small label above the step title
  title: string;     // primary copy
  hint?: string;     // optional one-liner under the title
};

const STEPS: ReadonlyArray<StepDef> = [
  { key: "welcome",   short: "Welcome",       eyebrow: "Step 1 of 6", title: "Welcome to PeakOps.", hint: "Let’s get your first operation ready." },
  { key: "org",       short: "Organization",  eyebrow: "Step 2 of 6", title: "Set up your organization." },
  { key: "team",      short: "Team",          eyebrow: "Step 3 of 6", title: "Bring your team in." },
  { key: "workflow",  short: "Workflow",      eyebrow: "Step 4 of 6", title: "Choose your first workflow." },
  { key: "first_job", short: "First job",     eyebrow: "Step 5 of 6", title: "Launch your first job." },
  { key: "ready",     short: "Ready",         eyebrow: "Step 6 of 6", title: "PeakOps is ready." },
];

// PEAKOPS_ONBOARDING_INDUSTRY_PROFILE_V1 (2026-05-06)
// Industry + workflow keys come from the shared profile lib so the
// org doc, the onboarding state doc, and the field/review/summary
// surfaces all key off the same string union.
const INDUSTRIES: ReadonlyArray<{ key: IndustryKey; label: string; sub: string }> = [
  { key: "utilities",    label: "Utilities",                sub: "Electric / gas / water field operations" },
  { key: "telecom",      label: "Telecom",                  sub: "Fiber, OSP, splice and outage work" },
  { key: "municipality", label: "Municipality",             sub: "Streets, signals, public infrastructure" },
  { key: "contractor",   label: "Infrastructure contractor", sub: "Multi-customer field crews" },
  { key: "other",        label: "Other",                    sub: "Custom — we'll tailor templates after setup" },
];

const TEMPLATES: ReadonlyArray<{ key: WorkflowTemplateKey; label: string; sub: string; sample: string }> = [
  { key: "pole_top",          label: "Pole-top inspection",       sub: "Recurring inspection routes",                sample: "Replace broken pole-top pin — Pole 14A-22" },
  { key: "fiber_splice",      label: "Fiber splice verification", sub: "OTDR + bond, with photo evidence",            sample: "Fiber splice verification — North Line Segment B" },
  { key: "storm_assess",      label: "Storm damage assessment",   sub: "Rapid documentation + supervisor sign-off",   sample: "Storm damage inspection — Utility Corridor 7" },
  { key: "trench_inspection", label: "Trench inspection",         sub: "Pre-backfill open-trench documentation",      sample: "Utility trench inspection — Riverside Sub-feeder" },
  { key: "blank",             label: "Start blank",               sub: "Define your own workflow — we’ll guide it",   sample: "Custom job — name it when you start" },
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
  const INDUSTRY_TO_TEMPLATE: Record<IndustryKey, WorkflowTemplateKey> = {
    utilities: "pole_top",
    telecom: "fiber_splice",
    municipality: "storm_assess",
    contractor: "trench_inspection",
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

  const goNext = () => setStepIdx((s) => Math.min(STEPS.length - 1, s + 1));
  const goBack = () => setStepIdx((s) => Math.max(0, s - 1));

  // Per-step validity gates the primary CTA. Welcome and Ready are
  // free — they're transitions, not data steps.
  const canAdvance = useMemo(() => {
    const step = STEPS[stepIdx]?.key;
    switch (step) {
      case "welcome":   return true;
      case "org":       return !!orgName.trim() && !!industry;
      case "team":      return true; // team setup is skippable
      case "workflow":  return !!selectedTemplate;
      case "first_job": return true;
      case "ready":     return true;
      default:          return true;
    }
  }, [stepIdx, orgName, industry, selectedTemplate]);

  // Invite handlers write through to the inviteDrafts subcollection.
  // DRAFT only — no email is sent. The honest copy on the Team step
  // says so verbatim. A future invite-send pipeline reads these
  // drafts and promotes them to real members.
  async function addInvite() {
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) return;
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

  function renderOrgSetup() {
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
        <Field label="What do you do?" required>
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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="teammate@example.com"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addInvite(); } }}
            style={{ ...inputStyle(), flex: "2 1 240px" }}
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
            disabled={!inviteEmail.trim()}
            style={secondaryButtonStyle(!inviteEmail.trim())}
          >
            + Add invite
          </button>
        </div>
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
    return (
      <div style={{ display: "grid", gap: 12 }}>
        <p style={{ margin: 0, fontSize: 13, color: TOKENS.textMuted, lineHeight: 1.55 }}>
          Pick a starter template. We&apos;ll pre-fill it with a believable job so you can
          see the lifecycle end-to-end. You can change templates any time.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          {TEMPLATES.map((tpl) => {
            const active = selectedTemplate === tpl.key;
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
                }}
              >
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

  function renderFirstJob() {
    const tpl = TEMPLATES.find((t) => t.key === selectedTemplate) || TEMPLATES[0];
    const orgLabel = orgName.trim() || "your organization";
    const inviteCount = invites.length;
    return (
      <div style={{ display: "grid", gap: 18 }}>
        <p style={{ margin: 0, fontSize: 14, color: TOKENS.textMuted, lineHeight: 1.6 }}>
          Here&apos;s what we&apos;ll set up the moment you launch:
        </p>
        <div
          style={{
            borderRadius: 12,
            border: `1px solid ${TOKENS.border}`,
            background: TOKENS.cardElevated,
            padding: "16px 18px",
            display: "grid", gap: 10,
          }}
        >
          <Summary label="Organization" value={orgLabel} />
          <Summary label="Workflow"     value={tpl.label} />
          <Summary label="First job"    value={tpl.sample} />
          <Summary label="Invites"      value={inviteCount === 0 ? "None — you can invite later" : `${inviteCount} ${inviteCount === 1 ? "person" : "people"}`} />
          <Summary label="Time zone"    value={timezone || "—"} />
        </div>
        <div style={{ fontSize: 12, color: TOKENS.textFaint, lineHeight: 1.55 }}>
          Once provisioning runs, this job lands on the Jobs board as <span style={{ color: TOKENS.gold }}>Open</span>.
          The field crew captures photos, the supervisor reviews and closes, and the audit-ready
          report appears the moment the job closes. Today&apos;s preview shows the destination — no
          record is written yet.
        </div>
      </div>
    );
  }

  function renderReady() {
    // PEAKOPS_ONBOARDING_READY_HONESTY_V1 (2026-05-06)
    // Headline depends on what actually persisted to Firestore.
    // Full persistence (org + industry + workflow + first-job
    // draft) → "PeakOps is ready." Anything missing falls back to
    // "Your deployment plan is ready." Each row also gates on its
    // matching persisted flag — a row never claims "saved" for a
    // slice that didn't make it to Firestore.
    const allPersisted = persisted.org && persisted.industry && persisted.workflow && persisted.firstJobDraft;
    const headline = allPersisted ? "PeakOps is ready." : "Your deployment plan is ready.";
    const subline = allPersisted
      ? "Your starter workflow is saved and the first job is queued as a draft. Open Jobs to take it live."
      : "We saved what we could. Open Jobs to keep going — the rest persists as you work.";
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
          {allPersisted ? "You're live" : "Plan saved"}
        </div>
        <h2 style={{ margin: "8px 0 6px", fontSize: 26, fontWeight: 800, color: TOKENS.text, letterSpacing: "-0.01em" }}>
          {headline}
        </h2>
        <p style={{ margin: 0, fontSize: 14, color: TOKENS.textMuted, lineHeight: 1.55, maxWidth: 480, marginInline: "auto" }}>
          {subline}
        </p>
        <div style={{ marginTop: 22, display: "grid", gap: 8, maxWidth: 360, marginInline: "auto", textAlign: "left" }}>
          {persisted.org ? (
            <ReadyRow text="Organization profile saved" />
          ) : null}
          {persisted.industry ? (
            <ReadyRow text="Industry operating mode applied" />
          ) : null}
          {persisted.workflow ? (
            <ReadyRow text="Starter workflow saved" />
          ) : null}
          {persisted.firstJobDraft ? (
            <ReadyRow text="First-job draft queued (no record created yet)" />
          ) : null}
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
      // 1) Patch org doc with the name/industry/timezone the moment
      //    the buyer leaves the Org step, so other surfaces can
      //    swap terminology + timer labels per industry without
      //    waiting for the full flow to complete.
      if (stepKey === "org" && orgName.trim() && industry) {
        await patchOrgFromOnboarding(orgId, {
          orgName: orgName.trim(),
          industry,
          timezone,
          ownerUserId: authUser?.uid || "",
        });
        setPersisted((p) => ({ ...p, org: true, industry: true }));
      }
      // 2) Workflow selection persists on its step.
      if (stepKey === "workflow" && selectedTemplate) {
        setPersisted((p) => ({ ...p, workflow: true }));
      }
      // 3) First-job DRAFT persists on its step. v1 never creates a
      //    real incident — UI copy says "preview / draft" so this
      //    is honest. A future pass promotes the draft to a real
      //    `incidents/{id}` via createIncidentV1.
      if (stepKey === "first_job" && selectedTemplate) {
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
      // 4) Persist the flow state (currentStep, completed set, all
      //    form values, completedAt when we hit Ready). Single
      //    round-trip per step.
      const isReady = stepKey === "ready";
      await saveOnboardingState(orgId, {
        currentStep: nextStepKey,
        completedSteps: Array.from(completedSet),
        orgName: orgName.trim(),
        industry,
        timezone,
        selectedTemplate,
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
      case "team":
      case "workflow":
      case "first_job":
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
      case "team":      return invites.length > 0 ? "Continue" : "Skip for now";
      case "workflow":  return "Continue";
      case "first_job": return "See it on the board →";
      case "ready":     return "Open Jobs →";
    }
  })();
  const stepBody = (() => {
    switch (step.key) {
      case "welcome":   return renderWelcome();
      case "org":       return renderOrgSetup();
      case "team":      return renderTeamSetup();
      case "workflow":  return renderWorkflowSelection();
      case "first_job": return renderFirstJob();
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

        <div style={{ textAlign: "center", fontSize: 11, color: TOKENS.textFaint }}>
          Demo preview — no records are written yet. Refresh this page and we&apos;ll keep you on the same step.
        </div>
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

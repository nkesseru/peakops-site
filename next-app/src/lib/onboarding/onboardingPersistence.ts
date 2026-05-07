// PEAKOPS_ONBOARDING_PERSISTENCE_V1 (2026-05-06)
//
// Client-side Firestore read/write for the onboarding flow. Single
// doc per org at `orgs/{orgId}/onboarding/state` plus three small
// drafts collections that the demo UX writes to without committing
// real lifecycle records:
//
//   orgs/{orgId}                            ← name + industry + tz patch
//   orgs/{orgId}/onboarding/state           ← flow state (this file's main doc)
//   orgs/{orgId}/inviteDrafts/{auto-id}     ← teammate invite drafts (no email sent)
//   orgs/{orgId}/jobDrafts/{auto-id}        ← first-job draft (no incident created)
//
// Drafts are intentional. The buyer sees their entries persist
// across reload — the UX promises preview + draft, not real
// invite send / real incident creation. Wiring those goes through
// the existing pipelines (`inviteOrgMember`, `createIncidentV1`)
// in a future pass.
//
// Why a single onboarding doc instead of one-doc-per-step:
//   - Onboarding state is read once on mount and written on each
//     advance — atomic on the user side, one round-trip per step.
//   - A future cross-step validation (e.g. "industry changed,
//     re-derive starter job") doesn't need a transaction.
//
// Why a separate inviteDrafts subcollection (vs. an array on the
// onboarding doc):
//   - Each invite has its own remove timestamp; subcollection lets
//     the future invite-send pipeline scan + delete drafts as
//     real members are created without touching the onboarding doc.

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  type DocumentReference,
  type CollectionReference,
} from "firebase/firestore";
import { db } from "../../../lib/firebaseClient";
import {
  INDUSTRY_PROFILE_VERSION,
  type IndustryKey,
  type WorkflowTemplateKey,
} from "./industryProfiles";
import { isDemoOrg } from "../orgKind";

export type OnboardingStepKey =
  | "welcome"
  | "org"
  | "team"
  | "workflow"
  | "first_job"
  | "ready";

export type FirstJobDraft = {
  workflowKey: WorkflowTemplateKey;
  title: string;
  location: string;
  jobType: "repair" | "damage" | "inspection" | "other";
};

export type OnboardingState = {
  currentStep: OnboardingStepKey;
  completedSteps: ReadonlyArray<OnboardingStepKey>;
  orgName: string;
  industry: IndustryKey | "";
  industryProfileVersion: string;
  timezone: string;
  selectedTemplate: WorkflowTemplateKey | "";
  firstJobDraft: FirstJobDraft | null;
  /** ISO timestamp set when the buyer clicks through Ready. */
  completedAt: string | null;
  /** Set on every save by the helper; surfaces the "Setup progress restored" copy. */
  updatedAt: string | null;
};

export const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  currentStep: "welcome",
  completedSteps: [],
  orgName: "",
  industry: "",
  industryProfileVersion: INDUSTRY_PROFILE_VERSION,
  timezone: "",
  selectedTemplate: "",
  firstJobDraft: null,
  completedAt: null,
  updatedAt: null,
};

const VALID_STEPS: OnboardingStepKey[] = [
  "welcome", "org", "team", "workflow", "first_job", "ready",
];
const VALID_INDUSTRIES: IndustryKey[] = [
  "utilities", "telecom", "municipality", "contractor", "other",
];
const VALID_TEMPLATES: WorkflowTemplateKey[] = [
  "pole_top", "fiber_splice", "storm_assess", "trench_inspection", "blank",
];

function stateRef(orgId: string): DocumentReference {
  return doc(db, "orgs", orgId, "onboarding", "state");
}
function inviteDraftsCol(orgId: string): CollectionReference {
  return collection(db, "orgs", orgId, "inviteDrafts");
}
function jobDraftsCol(orgId: string): CollectionReference {
  return collection(db, "orgs", orgId, "jobDrafts");
}
function orgRef(orgId: string): DocumentReference {
  return doc(db, "orgs", orgId);
}

function coerceState(raw: unknown): OnboardingState {
  const out: OnboardingState = { ...DEFAULT_ONBOARDING_STATE };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.currentStep === "string" && VALID_STEPS.includes(r.currentStep as OnboardingStepKey)) {
    out.currentStep = r.currentStep as OnboardingStepKey;
  }
  if (Array.isArray(r.completedSteps)) {
    out.completedSteps = r.completedSteps.filter(
      (s: unknown) => typeof s === "string" && VALID_STEPS.includes(s as OnboardingStepKey),
    ) as OnboardingStepKey[];
  }
  if (typeof r.orgName === "string") out.orgName = r.orgName;
  if (typeof r.industry === "string" && (VALID_INDUSTRIES as string[]).includes(r.industry)) {
    out.industry = r.industry as IndustryKey;
  }
  if (typeof r.industryProfileVersion === "string") out.industryProfileVersion = r.industryProfileVersion;
  if (typeof r.timezone === "string") out.timezone = r.timezone;
  if (typeof r.selectedTemplate === "string" && (VALID_TEMPLATES as string[]).includes(r.selectedTemplate)) {
    out.selectedTemplate = r.selectedTemplate as WorkflowTemplateKey;
  }
  if (r.firstJobDraft && typeof r.firstJobDraft === "object") {
    const d = r.firstJobDraft as Record<string, unknown>;
    if (typeof d.workflowKey === "string" && typeof d.title === "string") {
      const jt = String(d.jobType);
      out.firstJobDraft = {
        workflowKey: d.workflowKey as WorkflowTemplateKey,
        title: String(d.title || ""),
        location: String(d.location || ""),
        jobType: (["repair", "damage", "inspection", "other"].includes(jt) ? jt : "other") as FirstJobDraft["jobType"],
      };
    }
  }
  if (typeof r.completedAt === "string") out.completedAt = r.completedAt;
  if (typeof r.updatedAt === "string") out.updatedAt = r.updatedAt;
  return out;
}

export async function loadOnboardingState(orgId: string): Promise<OnboardingState | null> {
  if (!orgId) return null;
  const snap = await getDoc(stateRef(orgId));
  if (!snap.exists()) return null;
  return coerceState(snap.data());
}

export async function saveOnboardingState(
  orgId: string,
  patch: Partial<OnboardingState>,
): Promise<void> {
  if (!orgId) return;
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    safe[k] = v;
  }
  safe.updatedAt = serverTimestamp();
  await setDoc(stateRef(orgId), safe, { merge: true });
}

/**
 * PEAKOPS_ONBOARDING_ORG_PATCH_V1 (2026-05-06)
 * Persist the org-level fields that other surfaces read off of:
 * name, industry key, industry profile version, timezone. Used by
 * the field/review/summary pages to swap terminology + timer labels
 * per industry. `merge: true` so existing org docs (e.g. the demo
 * org) keep every field this patch doesn't touch.
 *
 * PEAKOPS_ORG_BOOTSTRAP_V1 (2026-05-06)
 * The first time we see an org doc with no `kind` set, we also seed
 * the foundation fields from docs/MULTI_ORG_IMPLEMENTATION_PLAN.md
 * Phase 1: orgType, kind, status, ownerUserId. Bootstrap fires once
 * per org — subsequent calls leave those fields alone, so the
 * original creator's uid wins and a later teammate running through
 * onboarding never overwrites it.
 *
 * Demo-org safety: `demo-org` (and any other id in the protected
 * demo list) gets kind="demo" pinned and is never bootstrapped as a
 * customer. This honors the demo↔customer separation invariant even
 * if a developer happens to run onboarding pointed at the demo
 * orgId.
 */
export async function patchOrgFromOnboarding(
  orgId: string,
  patch: {
    orgName?: string;
    industry?: IndustryKey | "";
    timezone?: string;
    /**
     * Creator's auth uid. Used only on the first bootstrap; if the org
     * doc already has a `kind` set, this is ignored so the original
     * owner is never overwritten by a later teammate's onboarding run.
     */
    ownerUserId?: string;
  },
): Promise<void> {
  if (!orgId) return;

  const ref = orgRef(orgId);
  const existingSnap = await getDoc(ref);
  const existing = existingSnap.exists() ? existingSnap.data() : null;
  const hasKind =
    !!existing &&
    typeof existing.kind === "string" &&
    existing.kind.trim().length > 0;

  const out: Record<string, unknown> = {
    industryProfileVersion: INDUSTRY_PROFILE_VERSION,
    onboardingUpdatedAt: serverTimestamp(),
  };
  const name = (patch.orgName || "").trim();
  if (name) out.name = name;
  if (patch.industry) out.industry = patch.industry;
  if (patch.timezone) out.timezone = patch.timezone;

  if (!hasKind) {
    if (isDemoOrg(orgId)) {
      // demo-org never gets the customer bootstrap. Just pin kind so
      // a future read of the doc reflects what isDemoOrg() already
      // resolves at the code layer.
      out.kind = "demo";
    } else {
      out.kind = "customer";
      out.orgType = "operator";
      out.status = "active";
      const ownerUid = (patch.ownerUserId || "").trim();
      if (ownerUid) out.ownerUserId = ownerUid;
      out.bootstrappedAt = serverTimestamp();
    }
  }

  await setDoc(ref, out, { merge: true });
}

// ─── Invite drafts ────────────────────────────────────────────

export type InviteDraft = {
  id: string;
  email: string;
  role: "admin" | "supervisor" | "field";
  createdAt?: string | null;
};

function coerceInviteDraft(id: string, raw: unknown): InviteDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const email = String(r.email || "").trim().toLowerCase();
  const role = String(r.role || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return null;
  if (role !== "admin" && role !== "supervisor" && role !== "field") return null;
  return {
    id,
    email,
    role,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
  };
}

export async function loadInviteDrafts(orgId: string): Promise<InviteDraft[]> {
  if (!orgId) return [];
  const snap = await getDocs(inviteDraftsCol(orgId));
  const out: InviteDraft[] = [];
  snap.forEach((d) => {
    const v = coerceInviteDraft(d.id, d.data());
    if (v) out.push(v);
  });
  return out;
}

export async function addInviteDraft(
  orgId: string,
  email: string,
  role: "admin" | "supervisor" | "field",
): Promise<string | null> {
  const e = String(email || "").trim().toLowerCase();
  if (!orgId || !e || !e.includes("@")) return null;
  const ref = await addDoc(inviteDraftsCol(orgId), {
    email: e,
    role,
    createdAt: serverTimestamp(),
    /**
     * IMPORTANT: this is a DRAFT only — no email is sent.
     * The status field exists so a future invite pipeline can
     * scan and promote drafts to real invites without overwriting
     * historical records.
     */
    status: "draft",
  });
  return ref.id;
}

export async function removeInviteDraft(orgId: string, draftId: string): Promise<void> {
  if (!orgId || !draftId) return;
  await deleteDoc(doc(db, "orgs", orgId, "inviteDrafts", draftId));
}

// ─── First-job draft ──────────────────────────────────────────

export type FirstJobDraftRecord = FirstJobDraft & {
  id: string;
  /** Always "draft" in v1; "launched" once a real incident is wired. */
  status: "draft" | "launched";
  createdAt?: string | null;
};

/**
 * Save (or replace) the buyer's first-job draft. We keep at most
 * one draft per org by default — overwrite on save. A future pass
 * that actually launches the job promotes the draft to a real
 * `incidents/{id}` record and deletes the draft.
 */
export async function saveFirstJobDraft(
  orgId: string,
  draft: FirstJobDraft,
): Promise<string | null> {
  if (!orgId || !draft || !draft.title) return null;
  // Replace any existing draft so we never accumulate stale rows
  // across re-runs of the wizard.
  const existing = await getDocs(jobDraftsCol(orgId));
  for (const d of existing.docs) {
    await deleteDoc(d.ref).catch(() => { /* swallow — best-effort cleanup */ });
  }
  const ref = await addDoc(jobDraftsCol(orgId), {
    workflowKey: draft.workflowKey,
    title: draft.title,
    location: draft.location,
    jobType: draft.jobType,
    status: "draft",
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

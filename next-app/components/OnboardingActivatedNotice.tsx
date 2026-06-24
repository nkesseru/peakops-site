// PR 134A.2 — Script-activated org branch for the /onboarding route.
//
// When the customer admin lands on /onboarding for an org that was
// already configured by the CS activation pipeline (createOrgV1 +
// inviteOrgMemberV1 + starter template seed + entitlement default),
// the 7-step wizard is redundant AND dangerous: at least one step
// (org identity) writes back to the org doc via patchOrgFromOnboarding
// and would clobber CS-set values (name, industry, kind).
//
// This component renders the safe branch: confirmation panel + Go
// to Dashboard CTA + small escape hatch for the rare case where an
// admin genuinely needs to walk the wizard (e.g. demo recording).
// The escape hatch is intentionally low-contrast so admins don't
// take it accidentally.

"use client";

interface MemberSummary {
  uid: string;
  role: string;
  displayName: string;
  email: string;
}

interface Props {
  orgId: string;
  orgName: string;
  industry?: string;
  bootstrappedBy?: string | null;
  bootstrappedAt?: string | null;
  members: MemberSummary[];
  starterTemplate?: { key: string; label: string; requiredProofCount: number; acceptanceCheckCount: number } | null;
  onForceWizard: () => void;
}

export function OnboardingActivatedNotice({
  orgId,
  orgName,
  industry,
  bootstrappedBy,
  bootstrappedAt,
  members,
  starterTemplate,
  onForceWizard,
}: Props) {
  const owner = members.find((m) => m.role === "owner");
  const teammates = members.filter((m) => m.role !== "owner");
  const activatedAt = bootstrappedAt ? formatRelative(bootstrappedAt) : null;

  return (
    <main
      data-testid="onboarding-activated-notice"
      data-org-id={orgId}
      className="min-h-screen bg-black text-white px-6 py-12 flex flex-col items-center justify-center"
    >
      <div className="w-full max-w-2xl">
        <div className="text-[10px] uppercase tracking-[0.22em] text-emerald-300/90 mb-2">
          ✓ Activation complete
        </div>
        <h1 className="text-2xl font-semibold tracking-tight mb-2">
          {orgName} is already set up.
        </h1>
        <p className="text-[13px] text-gray-400 leading-relaxed mb-6">
          Your account was configured through the PeakOps activation pipeline
          {activatedAt ? ` (${activatedAt})` : ""}. The onboarding wizard would
          duplicate work already done and could overwrite values your CS contact
          set during activation. We&apos;ve skipped it for you.
        </p>

        <section
          data-testid="onboarding-activated-summary"
          className="rounded-2xl border border-emerald-400/25 bg-emerald-500/[0.05] p-5 mb-6"
        >
          <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-200 mb-3">
            What&apos;s configured
          </div>
          <dl className="space-y-2 text-[13px]">
            <Row label="Organization">{orgName}</Row>
            {industry && <Row label="Industry">{industry}</Row>}
            {owner && (
              <Row label="Owner">
                {owner.displayName || owner.email || owner.uid.slice(0, 8)}
              </Row>
            )}
            {teammates.length > 0 && (
              <Row label="Team">
                {teammates.length} teammate{teammates.length === 1 ? "" : "s"} invited
              </Row>
            )}
            {starterTemplate && (
              <Row label="Starter template">
                {starterTemplate.label} · {starterTemplate.requiredProofCount} required-proof items
              </Row>
            )}
            {bootstrappedBy && (
              <Row label="Activated by">
                <span className="font-mono text-[11px] text-gray-300">{bootstrappedBy}</span>
              </Row>
            )}
          </dl>
        </section>

        <div className="flex flex-col sm:flex-row gap-3 mb-8">
          <a
            data-testid="onboarding-activated-dashboard"
            href="/dashboard"
            className="px-5 py-3 rounded-full text-[13px] font-semibold text-black bg-white hover:bg-white/90 text-center transition"
          >
            Go to dashboard →
          </a>
          <a
            data-testid="onboarding-activated-settings"
            href="/settings/organization"
            className="px-5 py-3 rounded-full text-[13px] font-semibold text-white border border-white/15 bg-white/[0.04] hover:bg-white/[0.10] text-center transition"
          >
            Manage in Settings
          </a>
        </div>

        <p className="text-[11px] text-gray-600 leading-relaxed">
          Need to reconfigure?{" "}
          <button
            data-testid="onboarding-activated-force"
            type="button"
            onClick={onForceWizard}
            className="underline decoration-gray-700 hover:decoration-gray-400 text-gray-500 hover:text-gray-300 transition"
          >
            Continue with the onboarding wizard anyway
          </button>
          . This may overwrite values your CS contact set during activation — only
          do this if you understand the risk.
        </p>
      </div>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="text-[11px] uppercase tracking-[0.16em] text-emerald-200/70 w-28 shrink-0">{label}</dt>
      <dd className="text-white">{children}</dd>
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const diffMs = Date.now() - then;
    const day = 24 * 3600 * 1000;
    if (diffMs < 60 * 1000) return "just now";
    if (diffMs < 3600 * 1000) return `${Math.round(diffMs / 60000)} minutes ago`;
    if (diffMs < day) return `${Math.round(diffMs / 3600000)} hours ago`;
    if (diffMs < 30 * day) return `${Math.round(diffMs / day)} days ago`;
    return new Date(iso).toLocaleDateString();
  } catch { return ""; }
}

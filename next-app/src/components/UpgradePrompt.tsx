"use client";

// PEAKOPS_UPGRADE_PROMPT_V1 (2026-05-13)
//
// Customer-facing modal shown when a premium feature is denied by
// requireEntitlement (HTTP 402 from a gated callable). Reusable —
// callers control open state and supply the featureKey / reason
// from the wire payload.
//
// Sprint 1 copy is intentionally narrow:
//   - one fixed message about "Operational Risk Defense"
//   - one "Contact PeakOps" CTA (mailto: only — Sprint 1 has no
//     self-serve upgrade flow, no Stripe checkout, no pricing
//     page link)
//
// reasonCopy() varies the subhead by HttpsError.details.reason so
// suspended/cancelled customers see "subscription on hold" rather
// than "your plan doesn't include this." The headline + CTA are
// the same across all reasons — keeps the contact channel single.

import type { CSSProperties } from "react";

type Reason = "feature_off" | "org_suspended" | "org_cancelled" | string;

interface Props {
  open: boolean;
  /** Feature key returned from the entitlement gate, e.g. "riskDefenseModule". */
  featureKey?: string;
  /** Machine reason from HttpsError.details.reason — drives subhead copy. */
  reason?: Reason;
  /** Optional org id, embedded in the mailto subject for faster triage. */
  orgId?: string;
  onClose: () => void;
}

const styles: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.72)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    zIndex: 1000,
  },
  card: {
    width: "100%",
    maxWidth: 440,
    background: "#0a0a0a",
    border: "1px solid #2a2a2a",
    borderRadius: 14,
    padding: 28,
    color: "#eee",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
  },
  eyebrow: {
    fontSize: 10,
    letterSpacing: "0.18em",
    color: "#C8A84E",
    fontWeight: 700,
    textTransform: "uppercase",
    marginBottom: 10,
  },
  title: {
    fontSize: 20,
    fontWeight: 600,
    margin: "0 0 10px 0",
    lineHeight: 1.25,
    color: "#fff",
  },
  body: {
    fontSize: 14,
    color: "#bbb",
    lineHeight: 1.55,
    margin: "0 0 14px 0",
  },
  reasonLine: {
    fontSize: 12,
    color: "#888",
    margin: "0 0 22px 0",
    lineHeight: 1.5,
  },
  actions: {
    display: "flex",
    gap: 10,
    justifyContent: "flex-end",
    flexWrap: "wrap",
  },
  primaryBtn: {
    background: "#C8A84E",
    color: "#000",
    border: "none",
    borderRadius: 8,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    textDecoration: "none",
    letterSpacing: "0.02em",
    display: "inline-block",
  },
  secondaryBtn: {
    background: "transparent",
    color: "#bbb",
    border: "1px solid #333",
    borderRadius: 8,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
};

function reasonCopy(reason?: Reason): string {
  switch (reason) {
    case "org_suspended":
      return "Your organization's subscription is currently suspended. Reach out to restore access.";
    case "org_cancelled":
      return "Your organization's subscription has ended. Reach out to renew.";
    case "feature_off":
    default:
      return "Your plan doesn't include this module yet. We can turn it on for your team.";
  }
}

export default function UpgradePrompt({ open, featureKey, reason, orgId, onClose }: Props) {
  if (!open) return null;

  const subject = encodeURIComponent(
    `PeakOps upgrade request${orgId ? ` — ${orgId}` : ""}${featureKey ? ` (${featureKey})` : ""}`,
  );
  const contactHref = `mailto:sales@peakops.app?subject=${subject}`;

  return (
    <div
      style={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="peakops-upgrade-title"
      onClick={(e) => {
        // Click on the overlay (not the card) closes the modal.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={styles.card}>
        <div style={styles.eyebrow}>Operational Risk Defense</div>
        <h2 id="peakops-upgrade-title" style={styles.title}>
          Operational Risk Defense required
        </h2>
        <p style={styles.body}>
          The feature you&apos;re trying to use requires Operational Risk Defense.
          Contact PeakOps to enable it for your organization.
        </p>
        <p style={styles.reasonLine}>{reasonCopy(reason)}</p>
        <div style={styles.actions}>
          <button type="button" onClick={onClose} style={styles.secondaryBtn}>
            Close
          </button>
          <a href={contactHref} style={styles.primaryBtn}>
            Contact PeakOps
          </a>
        </div>
      </div>
    </div>
  );
}

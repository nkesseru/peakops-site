// PEAKOPS_ADMIN_BILLING_V1 (2026-05-13)
//
// Internal-only admin billing editor for one org.
//
// Path:  /admin/orgs/{orgId}/billing
// Gate:  inherited from next-app/middleware.ts (stormwatch-auth=ok
//        cookie set by /api/admin/login). No additional auth here —
//        middleware already 302s unauthenticated visitors to the
//        admin login.
// Style: deliberately plain. Function over polish.
//
// Read:  orgs/{orgId}/billing/state via Admin SDK.
// Write: HTML form POST → /api/admin/orgs/{orgId}/billing (companion
//        route handler). On success the route 303-redirects back here
//        with ?saved=1 so a browser refresh does not re-submit.
//
// Out of scope (Sprint 1):
//   - Stripe automation. The stripe* fields are write-through labels
//     for ops to record the active subscription; nothing here calls
//     Stripe.
//   - Customer-facing self-serve billing.
//   - Pricing-page changes.

import { getAdminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ orgId: string }>;
type SearchParams = Promise<{ saved?: string }>;

const STATUSES = ["active", "suspended", "cancelled"] as const;
const FEATURE_KEYS = ["riskDefenseModule", "api", "sso", "whiteLabel"] as const;
const LIMIT_KEYS = [
  "capacityIncluded",
  "capacityPurchased",
  "storageGB",
  "filingsPerMonth",
  "retentionDays",
] as const;

type BillingDoc = {
  status?: string;
  plan?: string;
  entitlements?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  notes?: string;
  currentPeriod?: unknown;
  lastUpdatedAt?: { toDate?: () => Date } | Date | null;
  lastUpdatedBy?: string;
};

async function loadBilling(orgId: string): Promise<{ data: BillingDoc; exists: boolean }> {
  const db = getAdminDb();
  const snap = await db.doc(`orgs/${orgId}/billing/state`).get();
  if (!snap.exists) return { data: {}, exists: false };
  return { data: (snap.data() || {}) as BillingDoc, exists: true };
}

function fmtTs(v: BillingDoc["lastUpdatedAt"]): string {
  if (!v) return "—";
  try {
    if (typeof (v as { toDate?: () => Date }).toDate === "function") {
      return ((v as { toDate: () => Date }).toDate()).toISOString();
    }
    if (v instanceof Date) return v.toISOString();
  } catch {
    /* ignore */
  }
  return "—";
}

// Inline styles — no design system, intentional. Black bg matches
// the rest of /admin/*, contrast is enough to read on a laptop.
const S = {
  page:     { padding: "24px", color: "#ddd", fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 13 } as const,
  h1:       { fontSize: 18, fontWeight: 600, margin: "0 0 4px 0" } as const,
  sub:      { fontSize: 12, color: "#888", marginBottom: 18 } as const,
  card:     { border: "1px solid #222", padding: 16, marginBottom: 16, background: "#0a0a0a" } as const,
  cardH:    { fontSize: 11, fontWeight: 700, letterSpacing: "0.14em", color: "#C8A84E", marginBottom: 10, textTransform: "uppercase" } as const,
  row:      { display: "flex", alignItems: "center", gap: 10, marginBottom: 6 } as const,
  label:    { width: 200, color: "#aaa", fontSize: 12 } as const,
  input:    { background: "#000", color: "#eee", border: "1px solid #333", padding: "4px 8px", fontFamily: "inherit", fontSize: 13, minWidth: 220 } as const,
  textarea: { background: "#000", color: "#eee", border: "1px solid #333", padding: "6px 8px", fontFamily: "inherit", fontSize: 13, width: 500, minHeight: 70 } as const,
  saved:    { padding: "6px 10px", border: "1px solid #2a4", background: "#0a200a", color: "#9d9", marginBottom: 12, fontSize: 12 } as const,
  pre:      { background: "#000", border: "1px solid #222", padding: 10, fontSize: 12, color: "#9ad", overflow: "auto", maxHeight: 240 } as const,
  btn:      { padding: "8px 16px", background: "#C8A84E", color: "#000", border: "none", fontWeight: 700, cursor: "pointer", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" } as const,
} as const;

export default async function AdminOrgBillingPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { orgId } = await params;
  const sp = await searchParams;
  const { data, exists } = await loadBilling(orgId);

  const status = String(data.status || "active");
  const plan = String(data.plan || "");
  const entitlements = (data.entitlements || {}) as Record<string, unknown>;
  const limits = (data.limits || {}) as Record<string, unknown>;
  const stripeCustomerId = String(data.stripeCustomerId || "");
  const stripeSubscriptionId = String(data.stripeSubscriptionId || "");
  const notes = String(data.notes || "");
  const currentPeriod = data.currentPeriod;

  const action = `/api/admin/orgs/${encodeURIComponent(orgId)}/billing`;

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Billing — {orgId}</h1>
      <div style={S.sub}>
        Path: orgs/{orgId}/billing/state · {exists ? "doc exists" : "doc does not exist (deny-by-default)"}
        · last updated {fmtTs(data.lastUpdatedAt)} by {String(data.lastUpdatedBy || "—")}
      </div>

      {sp.saved === "1" ? <div style={S.saved}>Saved.</div> : null}

      <form method="POST" action={action}>
        <div style={S.card}>
          <div style={S.cardH}>Plan</div>
          <div style={S.row}>
            <label style={S.label}>plan</label>
            <input style={S.input} type="text" name="plan" defaultValue={plan} placeholder="free | pro | enterprise" />
          </div>
          <div style={S.row}>
            <label style={S.label}>status</label>
            <select style={S.input} name="status" defaultValue={status}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={S.card}>
          <div style={S.cardH}>Entitlements</div>
          {FEATURE_KEYS.map((k) => (
            <div key={k} style={S.row}>
              <label style={S.label}>{k}</label>
              <input
                type="checkbox"
                name={`entitlements.${k}`}
                defaultChecked={entitlements[k] === true}
              />
            </div>
          ))}
        </div>

        <div style={S.card}>
          <div style={S.cardH}>Limits</div>
          {LIMIT_KEYS.map((k) => (
            <div key={k} style={S.row}>
              <label style={S.label}>{k}</label>
              <input
                style={S.input}
                type="number"
                min={0}
                step={k === "storageGB" ? 0.1 : 1}
                name={`limits.${k}`}
                defaultValue={String(typeof limits[k] === "number" ? limits[k] : "")}
                placeholder="0"
              />
            </div>
          ))}
        </div>

        <div style={S.card}>
          <div style={S.cardH}>Stripe references (manual)</div>
          <div style={S.row}>
            <label style={S.label}>stripeCustomerId</label>
            <input style={S.input} type="text" name="stripeCustomerId" defaultValue={stripeCustomerId} placeholder="cus_…" />
          </div>
          <div style={S.row}>
            <label style={S.label}>stripeSubscriptionId</label>
            <input style={S.input} type="text" name="stripeSubscriptionId" defaultValue={stripeSubscriptionId} placeholder="sub_…" />
          </div>
        </div>

        <div style={S.card}>
          <div style={S.cardH}>Notes</div>
          <textarea style={S.textarea} name="notes" defaultValue={notes} placeholder="Internal-only notes about this org's billing…" />
        </div>

        <div style={{ marginTop: 18 }}>
          <button type="submit" style={S.btn}>Save</button>
        </div>
      </form>

      <div style={{ ...S.card, marginTop: 24 }}>
        <div style={S.cardH}>Current period (read-only)</div>
        {currentPeriod ? (
          <pre style={S.pre}>{JSON.stringify(currentPeriod, null, 2)}</pre>
        ) : (
          <div style={{ color: "#666", fontSize: 12 }}>—</div>
        )}
      </div>
    </div>
  );
}

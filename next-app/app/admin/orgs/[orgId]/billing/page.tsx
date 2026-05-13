// PEAKOPS_ADMIN_BILLING_V2 (2026-05-13) — Sprint 2: Operational Billing Visibility.
//
// Internal operator cockpit for one org's billing/entitlement state.
// Visibility-first; the existing Sprint 1 edit form is preserved
// verbatim at the bottom of the page.
//
// Path:  /admin/orgs/{orgId}/billing
// Gate:  inherited from next-app/middleware.ts (stormwatch-auth=ok
//        cookie set by /api/admin/login). No additional auth here —
//        middleware already 302s unauthenticated visitors to the
//        admin login.
// Style: deliberately plain. Function over polish.
//
// Reads:  orgs/{orgId} (name, createdAt)  +  orgs/{orgId}/billing/state
//         (both via Admin SDK; never touches client Firestore).
// Writes: HTML form POST → /api/admin/orgs/{orgId}/billing (companion
//         route handler). Sprint 2 adds no new write surfaces.
//
// Sprint 2 sections (all read-only):
//   1. Summary       — name, plan, status pills, dates, notes preview
//   2. Entitlements  — green/red dots per feature key (incl. future flags)
//   3. Limits vs Use — bar per metric with 80% / 100% color warnings
//   4. Op Health     — warning cards (init / Stripe / status / plan / over-capacity)
//   5. Audit         — lastUpdatedBy / lastUpdatedAt
//   + Edit form      — Sprint 1 form, preserved
//   + Raw period     — JSON.stringify of currentPeriod for transparency

import { getAdminDb } from "@/lib/firebaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = Promise<{ orgId: string }>;
type SearchParams = Promise<{ saved?: string }>;

// ─── Schema constants ────────────────────────────────────

const STATUSES = ["active", "suspended", "cancelled"] as const;

// Source-of-truth list of entitlement keys the UI knows about.
// "future flags" beyond this list are still rendered in Section 2 so
// the operator sees them — see EntitlementGrid below.
const ENTITLEMENT_KEYS = [
  "riskDefenseModule",
  "api",
  "sso",
  "whiteLabel",
  "advancedRetention",
] as const;

const LIMIT_KEYS = [
  "capacityIncluded",
  "capacityPurchased",
  "storageGB",
  "filingsPerMonth",
  "retentionDays",
] as const;

// Plans the UI considers "known". Anything else surfaces an
// "Unknown plan" warning in Section 4 but does NOT block writes.
const KNOWN_PLANS = ["free", "core", "growth", "enterprise", "legacy", "pro"] as const;

// ─── Doc types ────────────────────────────────────────────

type TimestampLike = { toDate?: () => Date } | Date | null | undefined;

type BillingDoc = {
  status?: string;
  plan?: string;
  entitlements?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  notes?: string;
  currentPeriod?: Record<string, unknown> | null;
  lastUpdatedAt?: TimestampLike;
  lastUpdatedBy?: string;
};

type OrgDoc = {
  name?: string;
  industry?: string;
  createdAt?: TimestampLike;
};

// ─── Loaders ──────────────────────────────────────────────

async function loadBilling(orgId: string): Promise<{ data: BillingDoc; exists: boolean }> {
  const db = getAdminDb();
  const snap = await db.doc(`orgs/${orgId}/billing/state`).get();
  if (!snap.exists) return { data: {}, exists: false };
  return { data: (snap.data() || {}) as BillingDoc, exists: true };
}

async function loadOrg(orgId: string): Promise<{ data: OrgDoc; exists: boolean }> {
  const db = getAdminDb();
  const snap = await db.doc(`orgs/${orgId}`).get();
  if (!snap.exists) return { data: {}, exists: false };
  return { data: (snap.data() || {}) as OrgDoc, exists: true };
}

// ─── Formatting helpers ──────────────────────────────────

function fmtTs(v: TimestampLike): string {
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

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

// usage / limit → percent (0..Infinity). null if either input is missing.
function pct(used: number | null, limit: number | null): number | null {
  if (used === null || limit === null || limit <= 0) return null;
  return (used / limit) * 100;
}

// "green" | "yellow" | "red" thresholds: <80 green, 80–99 yellow, ≥100 red.
function severity(p: number | null): "green" | "yellow" | "red" | "muted" {
  if (p === null) return "muted";
  if (p >= 100) return "red";
  if (p >= 80) return "yellow";
  return "green";
}

// ─── Inline component / style helpers ────────────────────

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
  // ─ Sprint 2 additions ─
  pillsRow: { display: "flex", flexWrap: "wrap" as const, gap: 8, marginBottom: 14 } as const,
  field:    { display: "flex", gap: 12, fontSize: 12, marginBottom: 4 } as const,
  fieldK:   { color: "#888", minWidth: 140 } as const,
  fieldV:   { color: "#ddd" } as const,
  entGrid:  { display: "grid", gridTemplateColumns: "repeat(2, minmax(220px, 320px))", gap: 8 } as const,
  entRow:   { display: "flex", alignItems: "center", gap: 10, fontSize: 13 } as const,
  barWrap:  { marginBottom: 12 } as const,
  barHead:  { display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 } as const,
  barTrack: { width: "100%", height: 8, background: "#161616", border: "1px solid #2a2a2a", borderRadius: 4, overflow: "hidden" as const } as const,
};

const COLOR = {
  green:  { bg: "#0d2a16", border: "#1e6b32", fg: "#9ed7a8" },
  yellow: { bg: "#2a2410", border: "#876a16", fg: "#d8c476" },
  red:    { bg: "#2a1010", border: "#9c2828", fg: "#e58484" },
  muted:  { bg: "#161616", border: "#2a2a2a", fg: "#7a7a7a" },
  gold:   { bg: "#1a1408", border: "#5e4a18", fg: "#C8A84E" },
} as const;

type Sev = keyof typeof COLOR;

function Pill({ label, sev = "muted" }: { label: string; sev?: Sev }) {
  const c = COLOR[sev];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 9px",
        borderRadius: 12,
        border: `1px solid ${c.border}`,
        background: c.bg,
        color: c.fg,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.05em",
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const sev: Sev = status === "active" ? "green" : status === "suspended" ? "yellow" : status === "cancelled" ? "red" : "muted";
  return <Pill label={status || "—"} sev={sev} />;
}

function PlanPill({ plan }: { plan: string }) {
  const known = (KNOWN_PLANS as readonly string[]).includes(plan);
  return <Pill label={plan || "—"} sev={known ? "gold" : "muted"} />;
}

function RdmPill({ on }: { on: boolean }) {
  return <Pill label={on ? "Risk Defense ON" : "Risk Defense off"} sev={on ? "green" : "muted"} />;
}

function EntitlementDot({ on }: { on: boolean }) {
  const c = on ? COLOR.green : COLOR.red;
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: "50%",
        background: c.fg,
        boxShadow: `0 0 0 1px ${c.border}`,
      }}
      aria-label={on ? "enabled" : "disabled"}
    />
  );
}

function UsageBar({
  label,
  used,
  limit,
  unit,
}: {
  label: string;
  used: number | null;
  limit: number | null;
  unit?: string;
}) {
  const p = pct(used, limit);
  const sev = severity(p);
  const c = COLOR[sev];
  const fillPct = p === null ? 0 : Math.min(100, Math.max(0, p));
  const usedStr = used === null ? "—" : `${used}${unit ? " " + unit : ""}`;
  const limitStr = limit === null ? "—" : `${limit}${unit ? " " + unit : ""}`;
  const pctStr = p === null ? "—" : `${p.toFixed(0)}%`;
  return (
    <div style={S.barWrap}>
      <div style={S.barHead}>
        <span style={{ color: "#aaa" }}>{label}</span>
        <span style={{ color: c.fg }}>
          {usedStr} / {limitStr} · {pctStr}
          {p !== null && p >= 100 ? " · OVER" : p !== null && p >= 80 ? " · warn" : ""}
        </span>
      </div>
      <div style={S.barTrack}>
        <div
          style={{
            width: `${fillPct}%`,
            height: "100%",
            background: c.fg,
            opacity: p === null ? 0.2 : 0.7,
          }}
        />
      </div>
    </div>
  );
}

function WarningCard({ title, body, sev }: { title: string; body: string; sev: Sev }) {
  const c = COLOR[sev];
  return (
    <div
      style={{
        border: `1px solid ${c.border}`,
        background: c.bg,
        color: c.fg,
        padding: "10px 14px",
        marginBottom: 8,
        borderRadius: 6,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>
        {title}
      </div>
      <div style={{ fontSize: 12, marginTop: 4, opacity: 0.9 }}>{body}</div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────

export default async function AdminOrgBillingPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { orgId } = await params;
  const sp = await searchParams;

  const [{ data: billing, exists: billingExists }, { data: org, exists: orgExists }] =
    await Promise.all([loadBilling(orgId), loadOrg(orgId)]);

  // Normalize billing fields with safe defaults.
  const status = String(billing.status || "active");
  const plan = String(billing.plan || "");
  const entitlements = (billing.entitlements || {}) as Record<string, unknown>;
  const limits = (billing.limits || {}) as Record<string, unknown>;
  const stripeCustomerId = String(billing.stripeCustomerId || "");
  const stripeSubscriptionId = String(billing.stripeSubscriptionId || "");
  const notes = String(billing.notes || "");
  const currentPeriod = (billing.currentPeriod || null) as Record<string, unknown> | null;

  const orgName = String(org.name || "").trim();
  const orgCreatedAt = org.createdAt;

  // currentPeriod usage extraction (Sprint 2 assumption: shape is
  // { capacityUsed, storageUsedGB, filingsThisMonth } — anything else
  // shows "—" so the section degrades cleanly until usage tracking
  // is wired up).
  const capacityUsed = num(currentPeriod?.capacityUsed);
  const storageUsedGB = num(currentPeriod?.storageUsedGB);
  const filingsThisMonth = num(currentPeriod?.filingsThisMonth);

  // Capacity limit = included + purchased.
  const capacityIncluded = num(limits.capacityIncluded);
  const capacityPurchased = num(limits.capacityPurchased);
  const capacityLimit =
    capacityIncluded !== null || capacityPurchased !== null
      ? (capacityIncluded || 0) + (capacityPurchased || 0)
      : null;
  const storageLimit = num(limits.storageGB);
  const filingsLimit = num(limits.filingsPerMonth);

  // Distinct entitlement keys to render in Section 2: known + any
  // "future" keys present on the doc beyond ENTITLEMENT_KEYS.
  const dynamicEntKeys = Array.from(
    new Set<string>([
      ...(ENTITLEMENT_KEYS as readonly string[]),
      ...Object.keys(entitlements).filter(
        (k) => !(ENTITLEMENT_KEYS as readonly string[]).includes(k),
      ),
    ]),
  );

  // ─── Operational warnings ────────────────────────────
  const warnings: Array<{ title: string; body: string; sev: Sev }> = [];
  if (!billingExists) {
    warnings.push({
      title: "Billing state not initialized",
      body: "No orgs/{orgId}/billing/state doc exists. Premium features deny-by-default until you save below.",
      sev: "red",
    });
  }
  if (!stripeCustomerId || !stripeSubscriptionId) {
    const missing = [
      !stripeCustomerId ? "stripeCustomerId" : null,
      !stripeSubscriptionId ? "stripeSubscriptionId" : null,
    ]
      .filter(Boolean)
      .join(", ");
    warnings.push({
      title: "Missing Stripe IDs",
      body: `${missing} not recorded. Manual reference only — no automation depends on these in Sprint 2.`,
      sev: "yellow",
    });
  }
  if (status === "suspended") {
    warnings.push({
      title: "Org is SUSPENDED",
      body: "Signed-packet generation will be blocked by requireEntitlement until status returns to active.",
      sev: "yellow",
    });
  }
  if (status === "cancelled") {
    warnings.push({
      title: "Org is CANCELLED",
      body: "Signed-packet generation is blocked. Historical reads continue to work.",
      sev: "red",
    });
  }
  const anyEntitlementOn = dynamicEntKeys.some((k) => entitlements[k] === true);
  if (billingExists && !anyEntitlementOn) {
    warnings.push({
      title: "No entitlements granted",
      body: "Every premium feature is off. Customer-visible flows like Generate Report will return 402 for this org.",
      sev: "yellow",
    });
  }
  if (plan && !(KNOWN_PLANS as readonly string[]).includes(plan)) {
    warnings.push({
      title: "Unknown plan label",
      body: `plan="${plan}" is not in the known list (${KNOWN_PLANS.join(", ")}). The label is informational only and does not affect entitlement; consider renaming or extending KNOWN_PLANS.`,
      sev: "muted",
    });
  }
  if (capacityLimit !== null && capacityUsed !== null && capacityUsed > capacityLimit) {
    warnings.push({
      title: "Capacity exceeded",
      body: `${capacityUsed} used vs ${capacityLimit} purchased+included. Warning only — Sprint 2 does not block usage.`,
      sev: "red",
    });
  }
  if (storageLimit !== null && storageUsedGB !== null && storageUsedGB > storageLimit) {
    warnings.push({
      title: "Storage exceeded",
      body: `${storageUsedGB} GB used vs ${storageLimit} GB limit. Warning only — Sprint 2 does not block usage.`,
      sev: "red",
    });
  }
  if (filingsLimit !== null && filingsThisMonth !== null && filingsThisMonth > filingsLimit) {
    warnings.push({
      title: "Filings exceeded",
      body: `${filingsThisMonth} filings this period vs ${filingsLimit}/month. Warning only — Sprint 2 does not block usage.`,
      sev: "red",
    });
  }

  const action = `/api/admin/orgs/${encodeURIComponent(orgId)}/billing`;
  const rdmOn = entitlements.riskDefenseModule === true;

  // Notes preview: first 200 chars, no formatting beyond newlines.
  const notesPreview =
    notes.length > 200 ? notes.slice(0, 200).trimEnd() + "…" : notes;

  return (
    <div style={S.page}>
      <h1 style={S.h1}>
        Billing — {orgName ? `${orgName} (${orgId})` : orgId}
      </h1>
      <div style={S.sub}>
        Path: orgs/{orgId}/billing/state · {billingExists ? "doc exists" : "doc does not exist (deny-by-default)"}
        · org parent doc {orgExists ? "found" : "MISSING"}
      </div>

      {sp.saved === "1" ? <div style={S.saved}>Saved.</div> : null}

      {/* ─── Section 1: Summary ─────────────────────────── */}
      <div style={S.card}>
        <div style={S.cardH}>Summary</div>
        <div style={S.pillsRow}>
          <StatusPill status={status} />
          <PlanPill plan={plan} />
          <RdmPill on={rdmOn} />
        </div>
        <div style={S.field}>
          <span style={S.fieldK}>orgId</span><span style={S.fieldV}>{orgId}</span>
        </div>
        <div style={S.field}>
          <span style={S.fieldK}>org name</span>
          <span style={S.fieldV}>{orgName || "—"}</span>
        </div>
        <div style={S.field}>
          <span style={S.fieldK}>plan</span><span style={S.fieldV}>{plan || "—"}</span>
        </div>
        <div style={S.field}>
          <span style={S.fieldK}>status</span><span style={S.fieldV}>{status}</span>
        </div>
        <div style={S.field}>
          <span style={S.fieldK}>org created</span>
          <span style={S.fieldV}>{fmtTs(orgCreatedAt)}</span>
        </div>
        <div style={S.field}>
          <span style={S.fieldK}>last updated</span>
          <span style={S.fieldV}>{fmtTs(billing.lastUpdatedAt)}</span>
        </div>
        <div style={S.field}>
          <span style={S.fieldK}>last updated by</span>
          <span style={S.fieldV}>{String(billing.lastUpdatedBy || "—")}</span>
        </div>
        <div style={{ ...S.field, alignItems: "flex-start" }}>
          <span style={S.fieldK}>notes</span>
          <span style={{ ...S.fieldV, whiteSpace: "pre-wrap" }}>
            {notesPreview || <em style={{ color: "#666" }}>(none)</em>}
          </span>
        </div>
      </div>

      {/* ─── Section 2: Entitlements ───────────────────── */}
      <div style={S.card}>
        <div style={S.cardH}>Entitlements</div>
        <div style={S.entGrid}>
          {dynamicEntKeys.map((k) => {
            const on = entitlements[k] === true;
            const isFutureKey = !(ENTITLEMENT_KEYS as readonly string[]).includes(k);
            return (
              <div key={k} style={S.entRow}>
                <EntitlementDot on={on} />
                <span style={{ color: on ? "#ddd" : "#888" }}>{k}</span>
                <span style={{ color: on ? COLOR.green.fg : COLOR.red.fg, marginLeft: "auto", fontSize: 11 }}>
                  {on ? "ENABLED" : "disabled"}
                </span>
                {isFutureKey ? (
                  <span style={{ fontSize: 10, color: "#666", marginLeft: 4 }}>(custom)</span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* ─── Section 3: Limits vs Usage ─────────────────── */}
      <div style={S.card}>
        <div style={S.cardH}>Limits vs Usage</div>
        <UsageBar
          label="Capacity (included + purchased)"
          used={capacityUsed}
          limit={capacityLimit}
        />
        <UsageBar label="Storage" used={storageUsedGB} limit={storageLimit} unit="GB" />
        <UsageBar
          label="Filings this period"
          used={filingsThisMonth}
          limit={filingsLimit}
          unit="/mo"
        />
        {capacityUsed === null && storageUsedGB === null && filingsThisMonth === null ? (
          <div style={{ fontSize: 11, color: "#666", marginTop: 6 }}>
            No usage data on currentPeriod yet. Write{" "}
            <code>{"{ capacityUsed, storageUsedGB, filingsThisMonth }"}</code> to
            <code> orgs/{orgId}/billing/state.currentPeriod</code> from a usage
            pipeline to populate these bars. UI degrades to dashes until then.
          </div>
        ) : null}
      </div>

      {/* ─── Section 4: Operational Health ─────────────── */}
      <div style={S.card}>
        <div style={S.cardH}>Operational Health</div>
        {warnings.length === 0 ? (
          <div style={{ ...S.field, color: COLOR.green.fg }}>
            <span style={S.fieldK}>status</span>
            <span>All clear — no operational warnings.</span>
          </div>
        ) : (
          warnings.map((w, i) => (
            <WarningCard key={i} title={w.title} body={w.body} sev={w.sev} />
          ))
        )}
      </div>

      {/* ─── Section 5: Audit Visibility ─────────────────── */}
      <div style={S.card}>
        <div style={S.cardH}>Audit Visibility</div>
        <div style={S.field}>
          <span style={S.fieldK}>last updated at</span>
          <span style={S.fieldV}>{fmtTs(billing.lastUpdatedAt)}</span>
        </div>
        <div style={S.field}>
          <span style={S.fieldK}>last updated by</span>
          <span style={S.fieldV}>{String(billing.lastUpdatedBy || "—")}</span>
        </div>
        <div style={{ fontSize: 11, color: "#666", marginTop: 8 }}>
          A full change log is intentionally out of scope for Sprint 2. The
          single-doc lastUpdatedAt/By is sufficient for current operator volume.
        </div>
      </div>

      {/* ─── Edit form (Sprint 1, preserved) ───────────── */}
      <form method="POST" action={action}>
        <div style={S.card}>
          <div style={S.cardH}>Edit · Plan</div>
          <div style={S.row}>
            <label style={S.label}>plan</label>
            <input style={S.input} type="text" name="plan" defaultValue={plan} placeholder="free | core | growth | enterprise" />
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
          <div style={S.cardH}>Edit · Entitlements</div>
          {ENTITLEMENT_KEYS.map((k) => (
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
          <div style={S.cardH}>Edit · Limits</div>
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
          <div style={S.cardH}>Edit · Stripe references (manual)</div>
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
          <div style={S.cardH}>Edit · Notes</div>
          <textarea style={S.textarea} name="notes" defaultValue={notes} placeholder="Internal-only notes about this org's billing…" />
        </div>

        <div style={{ marginTop: 18 }}>
          <button type="submit" style={S.btn}>Save</button>
        </div>
      </form>

      <div style={{ ...S.card, marginTop: 24 }}>
        <div style={S.cardH}>Current period (raw, read-only)</div>
        {currentPeriod ? (
          <pre style={S.pre}>{JSON.stringify(currentPeriod, null, 2)}</pre>
        ) : (
          <div style={{ color: "#666", fontSize: 12 }}>—</div>
        )}
      </div>
    </div>
  );
}

#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# ---- env ----
set -a
source ./.env.dev.local 2>/dev/null || true
set +a
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

echo "==> Bootstrapping Contract Schema v1"
echo "ROOT=$ROOT"
echo "FN_BASE=$FN_BASE"
echo "ORG_ID=$ORG_ID"
echo

# ---------------------------
# (1) Cloud Function: writeContractPayloadV1
# ---------------------------
FN_DIR="functions_clean"
mkdir -p "$FN_DIR"

cat > "$FN_DIR/writeContractPayloadV1.mjs" <<'JS'
import crypto from "crypto";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

/**
 * POST body:
 * {
 *  orgId, contractId, type, versionId, schemaVersion,
 *  payload (object),
 *  createdBy (string, optional)
 * }
 */
export async function writeContractPayloadV1(req, res) {
  try {
    const {
      orgId,
      contractId,
      type,
      versionId,
      schemaVersion,
      payload,
      createdBy = "admin_ui",
    } = req.body || {};

    if (!orgId || !contractId || !type || !versionId || !schemaVersion || !payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "Missing required fields (orgId, contractId, type, versionId, schemaVersion, payload)" });
    }

    const db = getFirestore();

    // stable-ish hash (good enough for v1). Later we can stableSort.
    const payloadHash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");

    const docId = `${versionId}_${String(type).toLowerCase()}`; // e.g. v1_dirs, v1_nors
    const ref = db.collection("contracts").doc(contractId).collection("payloads").doc(docId);

    const now = Timestamp.now();

    await ref.set(
      {
        orgId,
        contractId,
        type: String(type).toUpperCase(),
        versionId,
        schemaVersion,
        payload,
        payloadHash,
        status: "READY",
        createdBy,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    return res.json({ ok: true, orgId, contractId, payloadDocId: docId, payloadHash });
  } catch (e) {
    console.error("writeContractPayloadV1 error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
JS

echo "✅ wrote $FN_DIR/writeContractPayloadV1.mjs"

# ---------------------------
# (2) Wire function into functions_clean/index.mjs
#   - Ensure ESM already set (you already did type=module + main=index.mjs)
# ---------------------------
INDEX="$FN_DIR/index.mjs"
if [[ ! -f "$INDEX" ]]; then
  echo "❌ Missing $INDEX. Your repo uses functions_clean/index.mjs as entry. Aborting."
  exit 1
fi

# Add import + export in a safe way:
# If index.mjs uses "export const hello = ..." style, we can add a top-level export near EOF.
if ! rg -q "writeContractPayloadV1" "$INDEX"; then
  echo >> "$INDEX"
  echo "// --- Contract schema v1" >> "$INDEX"
  echo "export { writeContractPayloadV1 } from \"./writeContractPayloadV1.mjs\";" >> "$INDEX"
  echo "✅ patched $INDEX (export writeContractPayloadV1)"
else
  echo "ℹ️ $INDEX already references writeContractPayloadV1"
fi

node --check "$INDEX" >/dev/null
echo "✅ node --check functions_clean/index.mjs ok"

# ---------------------------
# (3) Next API proxy route /api/fn/writeContractPayloadV1
# ---------------------------
NEXT_API_DIR="next-app/src/app/api/fn/writeContractPayloadV1"
mkdir -p "$NEXT_API_DIR"

cat > "$NEXT_API_DIR/route.ts" <<'TS'
import { NextResponse } from "next/server";

const FN_BASE =
  process.env.FN_BASE ||
  "http://127.0.0.1:5001/peakops-pilot/us-central1";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const r = await fetch(`${FN_BASE}/writeContractPayloadV1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    // pass through JSON if possible
    try {
      return NextResponse.json(JSON.parse(text), { status: r.status });
    } catch {
      return new NextResponse(text, { status: r.status });
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TS

echo "✅ wrote $NEXT_API_DIR/route.ts"

# ---------------------------
# (4) UI: /admin/contracts and /admin/contracts/[contractId]
# ---------------------------
ADMIN_LIST_DIR="next-app/src/app/admin/contracts"
ADMIN_DETAIL_DIR="next-app/src/app/admin/contracts/[contractId]"
mkdir -p "$ADMIN_LIST_DIR" "$ADMIN_DETAIL_DIR"

cat > "$ADMIN_LIST_DIR/page.tsx" <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type ContractRow = {
  id: string;
  contractNumber?: string;
  customerId?: string;
  status?: string;
  type?: string;
  createdAt?: any;
};

export default function AdminContractsPage() {
  const [rows, setRows] = useState<ContractRow[]>([]);
  const [err, setErr] = useState<string>("");

  async function jfetch(url: string) {
    const r = await fetch(url);
    return r.json();
  }

  useEffect(() => {
    (async () => {
      try {
        setErr("");
        const j = await jfetch("/api/fn/listContractsV1");
        if (!j?.ok) throw new Error(j?.error || "listContractsV1 failed");
        setRows(Array.isArray(j.contracts) ? j.contracts : []);
      } catch (e: any) {
        setErr(String(e?.message || e));
        setRows([]);
      }
    })();
  }, []);

  const sorted = useMemo(() => rows, [rows]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0 }}>Admin · Contracts</h1>
      {!!err && <div style={{ marginTop: 10, color: "crimson" }}>{err}</div>}

      <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
        {sorted.map((c) => (
          <div key={c.id} style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <div style={{ fontWeight: 900 }}>{c.contractNumber || c.id}</div>
              <Link href={`/admin/contracts/${encodeURIComponent(c.id)}`} style={{ textDecoration: "none" }}>
                <span style={{ opacity: 0.9 }}>Open →</span>
              </Link>
            </div>
            <div style={{ opacity: 0.8, marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <span>customerId: <b>{c.customerId || "—"}</b></span>
              <span>status: <b>{c.status || "—"}</b></span>
              <span>type: <b>{c.type || "—"}</b></span>
            </div>
          </div>
        ))}
        {sorted.length === 0 && !err && <div style={{ opacity: 0.75 }}>No contracts yet.</div>}
      </div>
    </div>
  );
}
TSX

echo "✅ wrote next-app/src/app/admin/contracts/page.tsx"

cat > "$ADMIN_DETAIL_DIR/page.tsx" <<'TSX'
"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

type PayloadDoc = {
  id: string;
  type?: string;
  versionId?: string;
  schemaVersion?: string;
  status?: string;
  payloadHash?: string;
  updatedAt?: any;
  createdBy?: string;
};

export default function AdminContractDetailPage() {
  const params = useParams<{ contractId: string }>();
  const sp = useSearchParams();
  const orgId = sp.get("orgId") || "org_001";
  const contractId = params.contractId;

  const [contract, setContract] = useState<any>(null);
  const [payloads, setPayloads] = useState<PayloadDoc[]>([]);
  const [err, setErr] = useState<string>("");

  async function jfetch(url: string) {
    const r = await fetch(url);
    return r.json();
  }

  async function loadAll() {
    try {
      setErr("");
      const c = await jfetch(`/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`);
      if (!c?.ok) throw new Error(c?.error || "getContractV1 failed");
      setContract(c.contract || null);

      const p = await jfetch(`/api/fn/listContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`);
      if (!p?.ok) throw new Error(p?.error || "listContractPayloadsV1 failed");
      setPayloads(Array.isArray(p.payloads) ? p.payloads : []);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setContract(null);
      setPayloads([]);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0 }}>Admin · Contract {contractId}</h1>
        <a href={`/admin/contracts?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none", opacity: 0.8 }}>← Back</a>
      </div>
      <div style={{ opacity: 0.75, marginTop: 6 }}>Org: {orgId}</div>

      {!!err && <div style={{ marginTop: 10, color: "crimson" }}>{err}</div>}

      <div style={{ marginTop: 16, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Overview</div>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", opacity: 0.9 }}>{JSON.stringify(contract, null, 2)}</pre>
      </div>

      <div style={{ marginTop: 16, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 12, padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
          <div style={{ fontWeight: 900 }}>Payloads</div>
          <button onClick={loadAll} style={{ padding: "6px 10px", borderRadius: 10 }}>Refresh</button>
        </div>

        <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
          {payloads.map((p) => (
            <div key={p.id} style={{ border: "1px solid rgba(255,255,255,0.10)", borderRadius: 12, padding: 10 }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
                <b>{p.id}</b>
                <span style={{ opacity: 0.8 }}>type: {p.type}</span>
                <span style={{ opacity: 0.8 }}>schema: {p.schemaVersion}</span>
                <span style={{ opacity: 0.8 }}>status: {p.status}</span>
              </div>
              <div style={{ opacity: 0.7, marginTop: 6 }}>
                hash: <code>{p.payloadHash}</code>
              </div>
            </div>
          ))}
          {payloads.length === 0 && <div style={{ opacity: 0.75 }}>No payload docs yet.</div>}
        </div>
      </div>
    </div>
  );
}
TSX

echo "✅ wrote next-app/src/app/admin/contracts/[contractId]/page.tsx"

# ---------------------------
# (5) Add minimal Next API routes for list/get until you wire "real" ones
#     (These read Firestore via functions, so we proxy to functions endpoints.
#     If you don't have these endpoints yet, we'll create them as functions too.)
# ---------------------------
API_LIST="next-app/src/app/api/fn/listContractsV1"
API_GET="next-app/src/app/api/fn/getContractV1"
API_LIST_PAYLOADS="next-app/src/app/api/fn/listContractPayloadsV1"
mkdir -p "$API_LIST" "$API_GET" "$API_LIST_PAYLOADS"

cat > "$API_LIST/route.ts" <<'TS'
import { NextResponse } from "next/server";
const FN_BASE = process.env.FN_BASE || "http://127.0.0.1:5001/peakops-pilot/us-central1";
export async function GET() {
  const r = await fetch(`${FN_BASE}/listContractsV1`);
  const text = await r.text();
  try { return NextResponse.json(JSON.parse(text), { status: r.status }); }
  catch { return new NextResponse(text, { status: r.status }); }
}
TS

cat > "$API_GET/route.ts" <<'TS'
import { NextResponse } from "next/server";
const FN_BASE = process.env.FN_BASE || "http://127.0.0.1:5001/peakops-pilot/us-central1";
export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "org_001";
  const contractId = url.searchParams.get("contractId") || "";
  const r = await fetch(`${FN_BASE}/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`);
  const text = await r.text();
  try { return NextResponse.json(JSON.parse(text), { status: r.status }); }
  catch { return new NextResponse(text, { status: r.status }); }
}
TS

cat > "$API_LIST_PAYLOADS/route.ts" <<'TS'
import { NextResponse } from "next/server";
const FN_BASE = process.env.FN_BASE || "http://127.0.0.1:5001/peakops-pilot/us-central1";
export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "org_001";
  const contractId = url.searchParams.get("contractId") || "";
  const r = await fetch(`${FN_BASE}/listContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}`);
  const text = await r.text();
  try { return NextResponse.json(JSON.parse(text), { status: r.status }); }
  catch { return new NextResponse(text, { status: r.status }); }
}
TS

echo "✅ wrote Next proxy routes (listContractsV1/getContractV1/listContractPayloadsV1)"

# ---------------------------
# (6) Create the missing functions: listContractsV1, getContractV1, listContractPayloadsV1
# ---------------------------
cat > "$FN_DIR/contractsApiV1.mjs" <<'JS'
import { getFirestore } from "firebase-admin/firestore";

export async function listContractsV1(req, res) {
  try {
    const db = getFirestore();
    const snap = await db.collection("contracts").limit(50).get();
    const contracts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, contracts });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

export async function getContractV1(req, res) {
  try {
    const orgId = req.query.orgId || "org_001";
    const contractId = req.query.contractId;
    if (!contractId) return res.status(400).json({ ok:false, error:"Missing contractId" });

    const db = getFirestore();
    const doc = await db.collection("contracts").doc(String(contractId)).get();
    if (!doc.exists) return res.json({ ok:false, error:"Contract not found" });

    return res.json({ ok:true, orgId, contract: { id: doc.id, ...doc.data() } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}

export async function listContractPayloadsV1(req, res) {
  try {
    const orgId = req.query.orgId || "org_001";
    const contractId = req.query.contractId;
    if (!contractId) return res.status(400).json({ ok:false, error:"Missing contractId" });

    const db = getFirestore();
    const snap = await db.collection("contracts").doc(String(contractId)).collection("payloads").get();
    const payloads = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok:true, orgId, contractId, payloads });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error: String(e?.message || e) });
  }
}
JS

if ! rg -q "contractsApiV1" "$INDEX"; then
  echo "export { listContractsV1, getContractV1, listContractPayloadsV1 } from \"./contractsApiV1.mjs\";" >> "$INDEX"
  echo "✅ patched $INDEX (export contracts API v1)"
fi

node --check "$INDEX" >/dev/null
echo "✅ node --check ok"

echo
echo "✅ DONE. Next steps:"
echo "1) Restart dev:  bash scripts/dev/dev-down.sh || true; bash scripts/dev/dev-up.sh"
echo "2) Create contract doc in Firestore (or via your own function later)."
echo "3) Test payload write (example curl below)."
echo
echo "TEST CURL (writes payloads doc):"
cat <<EOF
curl -sS -X POST "$FN_BASE/writeContractPayloadV1" \\
  -H "Content-Type: application/json" \\
  -d '{
    "orgId": "$ORG_ID",
    "contractId": "car_abc123",
    "type": "DIRS",
    "versionId": "v1",
    "schemaVersion": "dirs.v1",
    "payload": { "placeholder": "INIT" },
    "createdBy": "admin_ui"
  }' | python3 -m json.tool
EOF
echo
echo "UI:"
echo "  http://localhost:3000/admin/contracts"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=$ORG_ID"

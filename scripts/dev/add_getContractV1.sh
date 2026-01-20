#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app
set -a
source ./.env.dev.local 2>/dev/null || true
set +a

FN_DIR="functions_clean"
NEXT_API_DIR="next-app/src/app/api/fn/getContractV1"
FN_FILE="$FN_DIR/getContractV1.mjs"
INDEX="$FN_DIR/index.mjs"

echo "==> (1) Write Cloud Function handler: $FN_FILE"
cat > "$FN_FILE" <<'MJS'
import { getFirestore } from "firebase-admin/firestore";

/**
 * GET /getContractV1?orgId=org_001&contractId=car_abc123
 */
export async function getContractV1(req, res) {
  try {
    res.set("Access-Control-Allow-Origin", "*");

    const orgId = String(req.query.orgId || "").trim();
    const contractId = String(req.query.contractId || "").trim();

    if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" });
    if (!contractId) return res.status(400).json({ ok: false, error: "Missing contractId" });

    const db = getFirestore();
    const ref = db.collection("contracts").doc(contractId);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ ok: false, error: "Contract not found", orgId, contractId });
    }

    const data = snap.data() || {};
    // Guardrail: org mismatch
    if (String(data.orgId || "") !== orgId) {
      return res.status(403).json({ ok: false, error: "ORG_MISMATCH", orgId, contractId });
    }

    return res.json({
      ok: true,
      orgId,
      contractId,
      contract: { id: snap.id, ...data },
    });
  } catch (e) {
    console.error("getContractV1 error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
MJS

echo "==> (2) Patch functions_clean/index.mjs (import + export endpoint)"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

# ensure import exists
imp = 'import { getContractV1 } from "./getContractV1.mjs";\n'
if imp not in s:
  # put it near the other imports at top (after onRequest import)
  lines = s.splitlines(True)
  out = []
  inserted = False
  for i, ln in enumerate(lines):
    out.append(ln)
    if (not inserted) and ("from \"firebase-functions/v2/https\"" in ln or "from 'firebase-functions/v2/https'" in ln):
      # insert after this line
      out.append(imp)
      inserted = True
  if not inserted:
    out.insert(0, imp)
  s = "".join(out)

# ensure export exists (top-level)
export_line = "export const getContractV1 = onRequest(getContractV1);\n"
if export_line not in s:
  anchor = "export const hello = onRequest"
  idx = s.find(anchor)
  if idx == -1:
    raise SystemExit("❌ Could not find hello export anchor in functions_clean/index.mjs")
  end = s.find("});", idx)
  if end == -1:
    raise SystemExit("❌ Could not find end of hello handler in functions_clean/index.mjs")
  end = end + 3
  s = s[:end] + "\n\n" + export_line + s[end:]

p.write_text(s)
print("✅ patched functions_clean/index.mjs (import + export)")
PY

echo "==> (3) Syntax check functions_clean/index.mjs"
node --check functions_clean/index.mjs >/dev/null
echo "✅ node --check OK"

echo "==> (4) Create Next API proxy route: $NEXT_API_DIR/route.ts"
mkdir -p "$NEXT_API_DIR"
cat > "$NEXT_API_DIR/route.ts" <<'TS'
import { NextResponse } from "next/server";

const FN_BASE =
  process.env.FN_BASE ||
  "http://127.0.0.1:5001/peakops-pilot/us-central1";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "";
  const contractId = url.searchParams.get("contractId") || "";

  const upstream = new URL(`${FN_BASE}/getContractV1`);
  if (orgId) upstream.searchParams.set("orgId", orgId);
  if (contractId) upstream.searchParams.set("contractId", contractId);

  const r = await fetch(upstream.toString(), { method: "GET" });
  const txt = await r.text();
  return new NextResponse(txt, {
    status: r.status,
    headers: { "content-type": r.headers.get("content-type") || "application/json" },
  });
}
TS

echo "✅ created Next proxy route: /api/fn/getContractV1"

echo
echo "✅ DONE."
echo "Restart dev stack:"
echo "  bash scripts/dev/dev-up.sh"
echo
echo "Smoke (emulator):"
echo "  curl -sS \"$FN_BASE/getContractV1?orgId=org_001&contractId=car_abc123\" | python3 -m json.tool"
echo
echo "Smoke (next proxy):"
echo "  curl -sS \"http://localhost:3000/api/fn/getContractV1?orgId=org_001&contractId=car_abc123\" | python3 -m json.tool"
echo
echo "Deploy (prod):"
echo "  firebase deploy --only functions:getContractV1"

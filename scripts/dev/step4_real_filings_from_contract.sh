#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
CONTRACT_ID="${3:-car_abc123}"

mkdir -p scripts/dev/_bak .logs

echo "==> (0) seed incident -> contractId link in Firestore emulator (best-effort)"
node - <<'NODE'
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: "peakops-pilot" });
const db = admin.firestore();

const ORG_ID = process.env.ORG_ID || "org_001";
const INCIDENT_ID = process.env.INCIDENT_ID || "inc_TEST";
const CONTRACT_ID = process.env.CONTRACT_ID || "car_abc123";

(async () => {
  await db.collection("incidents").doc(INCIDENT_ID).set(
    {
      id: INCIDENT_ID,
      orgId: ORG_ID,
      contractId: CONTRACT_ID,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  console.log("✅ incident linked:", INCIDENT_ID, "->", CONTRACT_ID);
})().catch((e) => {
  console.error("❌ seed failed:", e?.stack || e);
  process.exit(1);
});
NODE

echo "==> (1) write Next route /api/fn/getIncidentV1 (direct Firestore via Admin SDK is NOT available in Next runtime)"
echo "     so we’ll use functions emulator via fnProxy: add route that proxies to functions_clean/getIncidentV1 (we create it)."

# --- backups
FN_DIR="functions_clean"
NEXT_ROUTE="next-app/src/app/api/fn/getIncidentV1/route.ts"
FN_FILE="${FN_DIR}/getIncidentV1.js"
FN_INDEX="${FN_DIR}/index.js"

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FN_INDEX" "scripts/dev/_bak/functions_clean_index_${TS}.js" || true

# --- Create function getIncidentV1 (CJS, same style as other functions_clean)
cat > "$FN_FILE" <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

exports.getIncidentV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const snap = await db.collection("incidents").doc(incidentId).get();
    if (!snap.exists) return send(res, 404, { ok: false, error: "Incident not found" });

    const doc = { id: snap.id, ...snap.data() };
    return send(res, 200, { ok: true, orgId, incidentId, doc });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
JS
echo "✅ wrote functions_clean/getIncidentV1.js"

# --- export it in functions_clean/index.js if missing
if ! grep -q 'getIncidentV1' "$FN_INDEX"; then
  echo 'exports.getIncidentV1 = require("./getIncidentV1").getIncidentV1;' >> "$FN_INDEX"
  echo "✅ appended export to functions_clean/index.js"
else
  echo "ℹ️ functions_clean/index.js already exports getIncidentV1"
fi

# --- Next route proxy
mkdir -p "$(dirname "$NEXT_ROUTE")"
cp "$NEXT_ROUTE" "scripts/dev/_bak/getIncidentV1_route_${TS}.ts" 2>/dev/null || true

cat > "$NEXT_ROUTE" <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyGET(req, "getIncidentV1");
}
TS
echo "✅ wrote next route: /api/fn/getIncidentV1"

echo "==> (2) Patch downloadIncidentPacketZip to include REAL contract snapshot + REAL filings payloads"
DL="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
cp "$DL" "scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

# We do a conservative patch: only if marker missing
if "REAL_FILINGS_FROM_CONTRACT" in s:
    print("ℹ️ downloadIncidentPacketZip already patched for real filings")
    raise SystemExit(0)

# Insert helpers near top (after imports)
insert_helpers = r"""
// --- REAL_FILINGS_FROM_CONTRACT helpers ---
async function fetchJson(url: string) {
  const r = await fetch(url, { method: "GET" });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok:false, error:`non-json from ${url}`, sample:text.slice(0,200) }; }
}

function normalizeTypeToFilename(t: string) {
  const x = (t || "").toLowerCase();
  if (x.includes("dirs")) return "dirs.json";
  if (x.includes("oe") || x.includes("417")) return "oe417.json";
  if (x.includes("nors")) return "nors.json";
  if (x.includes("sar")) return "sar.json";
  if (x.includes("baba")) return "baba.json";
  return `${x || "unknown"}.json`;
}
"""

# Add after first import block
m = re.search(r"(import[\s\S]+?;\s*\n)", s)
if not m:
    raise SystemExit("❌ couldn't find imports block")
s = s[:m.end()] + insert_helpers + s[m.end():]

# Ensure we read incident + contractId inside GET before building zip
# Find where orgId/incidentId extracted
anchor = re.search(r"const orgId\s*=.*?;\s*\n\s*const incidentId\s*=.*?;\s*\n", s)
if not anchor:
    raise SystemExit("❌ couldn't find orgId/incidentId declarations")

inject = r"""
  // Pull incident doc (to resolve contractId without query param)
  const incUrl =
    `${url.origin}/api/fn/getIncidentV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
  const incJ: any = await fetchJson(incUrl);
  const incidentDoc: any = incJ?.ok ? incJ.doc : null;

  const contractIdParam = url.searchParams.get("contractId") || "";
  const contractIdResolved = contractIdParam || (incidentDoc?.contractId ? String(incidentDoc.contractId) : "");
"""
s = s[:anchor.end()] + inject + s[anchor.end():]

# Find where files are being assembled into zip. We'll inject contract snapshot + filings payloads into zip + manifest list.
# We will look for where it adds contract/contract.json already; if not, we still add.
# Insert just before zip.generateAsync(...)
m2 = re.search(r"const bytes\s*=\s*await\s*zip\.generateAsync\(", s)
if not m2:
    raise SystemExit("❌ couldn't find zip.generateAsync section")

inject2 = r"""
    // --- REAL contract snapshot + filings payloads (if contractIdResolved present) ---
    if (contractIdResolved) {
      // contract snapshot
      const cUrl =
        `${url.origin}/api/fn/getContractV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractIdResolved)}`;
      const cJ: any = await fetchJson(cUrl);
      const contractDoc: any = cJ?.ok ? cJ.doc : null;
      zip.file("contract/contract.json", Buffer.from(JSON.stringify(contractDoc || { note: "contract not found" }, null, 2), "utf8"));

      // filings payloads from contract payloads
      const pUrl =
        `${url.origin}/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractIdResolved)}&limit=50`;
      const pJ: any = await fetchJson(pUrl);
      const docs: any[] = Array.isArray(pJ?.docs) ? pJ.docs : [];

      // map each payload doc to filings/<type>.json
      for (const d of docs) {
        const t = String(d?.type || d?.id || "unknown");
        const fname = normalizeTypeToFilename(t);
        const payload = d?.payload ?? d ?? {};
        zip.file(`filings/${fname}`, Buffer.from(JSON.stringify(payload, null, 2), "utf8"));
      }
    } else {
      // still keep stub files so zip structure is predictable
      zip.file("contract/contract.json", Buffer.from(JSON.stringify({ note: "no contractId resolved" }, null, 2), "utf8"));
      zip.file("filings/dirs.json", Buffer.from(JSON.stringify({ status: "STUB" }, null, 2), "utf8"));
      zip.file("filings/oe417.json", Buffer.from(JSON.stringify({ status: "STUB" }, null, 2), "utf8"));
      zip.file("filings/nors.json", Buffer.from(JSON.stringify({ status: "STUB" }, null, 2), "utf8"));
      zip.file("filings/sar.json", Buffer.from(JSON.stringify({ status: "STUB" }, null, 2), "utf8"));
      zip.file("filings/baba.json", Buffer.from(JSON.stringify({ status: "STUB" }, null, 2), "utf8"));
    }
"""
s = s[:m2.start()] + inject2 + s[m2.start():]

p.write_text(s)
print("✅ patched downloadIncidentPacketZip: resolve contractId via incident + include real filings payloads")
PY

echo "==> (3) Patch bundle page to auto-resolve contractId and show contract/payload counts"
BUNDLE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
cp "$BUNDLE" "scripts/dev/_bak/bundle_page_${TS}.tsx"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

if "getIncidentV1" in s and "contractIdResolved" in s:
    print("ℹ️ bundle page already patched for contract auto-resolve")
    raise SystemExit(0)

# Add state for incident doc + resolved contractId
s = re.sub(r'const contractId = sp\.get\("contractId"\) \|\| "";\s*// optional',
           'const contractId = sp.get("contractId") || ""; // optional\n  const [incidentDoc, setIncidentDoc] = useState<any>(null);\n  const [contractIdResolved, setContractIdResolved] = useState<string>("");',
           s, count=1)

# In load(): fetch incident doc first + set contractIdResolved
m = re.search(r'async function load\(\) \{[\s\S]*?setErr\(""\);\s*try \{', s)
if not m:
    raise SystemExit("❌ couldn't find load() start")
insert = r"""
      // resolve incident -> contractId (so bundle is usable without query params)
      const incUrl =
        `/api/fn/getIncidentV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const incRes = await fetch(incUrl);
      const incTxt = await incRes.text();
      const incParsed = safeJson(incTxt);
      const incJ = incParsed.ok ? incParsed.v : null;
      const doc = incJ?.ok ? incJ.doc : null;
      setIncidentDoc(doc);
      const resolved = contractId || (doc?.contractId ? String(doc.contractId) : "");
      setContractIdResolved(resolved);
"""
s = s[:m.end()] + insert + s[m.end():]

# Replace usage of contractId in contract fetch condition with contractIdResolved
s = s.replace("if (contractId) {", "if (contractIdResolved) {")
s = s.replace("encodeURIComponent(contractId)", "encodeURIComponent(contractIdResolved)")

# Also update downloadUrl useMemo to use contractIdResolved (fallback to contractId for first render)
s = re.sub(r'\[orgId, incidentId, contractId\]\);',
           '[orgId, incidentId, contractId, contractIdResolved]);', s, count=1)
s = s.replace("return contractId ?",
              "return (contractIdResolved || contractId) ?")
s = s.replace("encodeURIComponent(contractId)",
              "encodeURIComponent(contractIdResolved || contractId)")

# Add a tiny line showing resolved contract id under header
s = re.sub(
    r'(Incident:\s*<b>\{incidentId\}</b>\s*)',
    r'\1{contractIdResolved ? (<> · Contract: <b>{contractIdResolved}</b></>) : null} ',
    s, count=1
)

p.write_text(s)
print("✅ patched bundle page: auto-resolve contractId via incident + use it for snapshot + download")
PY

echo "==> (4) restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> (5) smoke bundle page"
URL="http://127.0.0.1:3000/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
curl -fsS "$URL" >/dev/null || { echo "❌ bundle page failing"; tail -n 220 .logs/next.log; exit 1; }
echo "✅ bundle page OK"

echo "==> (6) smoke download headers"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}"
curl -fsSI "$DURL" | head -n 25

echo
echo "OPEN:"
echo "  $URL"
echo
echo "✅ Step 4 complete: incident->contractId + real filings pulled from contract payloads into ZIP."
echo "TIP: seed incident->contractId by running:"
echo "  ORG_ID=${ORG_ID} INCIDENT_ID=${INCIDENT_ID} CONTRACT_ID=${CONTRACT_ID} node -e '...' (or rerun this script)"

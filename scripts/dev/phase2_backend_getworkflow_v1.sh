set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app
mkdir -p .logs scripts/dev/_bak

TS="$(date +%Y%m%d_%H%M%S)"

echo "==> backup touched files"
for f in \
  functions_clean/getWorkflowV1.mjs \
  functions_clean/index.mjs \
  next-app/src/app/api/fn/getWorkflowV1/route.ts
do
  [ -f "$f" ] && cp "$f" "scripts/dev/_bak/$(basename "$f").${TS}.bak" || true
done

echo "==> (1) write functions_clean/getWorkflowV1.mjs"
cat > functions_clean/getWorkflowV1.mjs <<'MJS'
import { onRequest } from "firebase-functions/v2/https";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

export const getWorkflowV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok:false, error:"Missing orgId/incidentId" });

    // optional read (doesn't fail if missing)
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch {}

    const steps = [
      { key:"intake",   title:"Intake",          hint:"Confirm incident exists + baseline fields.", status:"TODO" },
      { key:"timeline", title:"Build Timeline",  hint:"Generate timeline events + verify ordering.", status:"TODO" },
      { key:"filings",  title:"Generate Filings",hint:"Build DIRS/OE-417/NORS/SAR payloads.",      status:"TODO" },
      { key:"export",   title:"Export Packet",   hint:"Create immutable shareable artifact (ZIP + hashes).", status:"TODO" },
    ];

    return send(res, 200, {
      ok:true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      incident,
      workflow: { version:"v1", steps }
    });
  } catch (e) {
    return send(res, 500, { ok:false, error:String(e) });
  }
});
MJS
echo "✅ wrote functions_clean/getWorkflowV1.mjs"

echo "==> (2) ensure export in functions_clean/index.mjs"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text() if p.exists() else ""
if 'getWorkflowV1' not in s:
    s = s.rstrip() + "\n\n// Phase 2\nexport { getWorkflowV1 } from \"./getWorkflowV1.mjs\";\n"
    p.write_text(s)
    print("✅ patched index.mjs")
else:
    print("✅ index.mjs already has getWorkflowV1")
PY

echo "==> (3) add Next route /api/fn/getWorkflowV1"
mkdir -p next-app/src/app/api/fn/getWorkflowV1
cat > next-app/src/app/api/fn/getWorkflowV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.get("orgId")) {
    url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  }
  return proxyGET(
    new Request(url.toString(), { method: "GET", headers: req.headers }),
    "getWorkflowV1"
  );
}
TS
echo "✅ wrote next route"

echo "==> (4) restart emulators + next"
lsof -tiTCP:3000,5001,8080,8081,4000,4400,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done

( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "==> (5) smoke workflow via Next proxy"
curl -sS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 80

echo
echo "✅ PHASE2 BACKEND WIRED"
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "STOP:"
echo "  kill $EMU_PID"
echo "  pkill -f 'next dev'"

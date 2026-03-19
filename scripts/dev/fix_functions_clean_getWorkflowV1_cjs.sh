#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

FUNCDIR="functions_clean"
PKG="$FUNCDIR/package.json"
IDX_JS="$FUNCDIR/index.js"
WF_JS="$FUNCDIR/getWorkflowV1.js"

ts="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak

echo "==> (0) backups"
[ -f "$PKG" ] && cp "$PKG" "scripts/dev/_bak/functions_clean.package.json.$ts.bak"
[ -f "$IDX_JS" ] && cp "$IDX_JS" "scripts/dev/_bak/functions_clean.index.js.$ts.bak"
[ -f "$FUNCDIR/index.mjs" ] && cp "$FUNCDIR/index.mjs" "scripts/dev/_bak/functions_clean.index.mjs.$ts.bak"
[ -f "$FUNCDIR/getWorkflowV1.mjs" ] && cp "$FUNCDIR/getWorkflowV1.mjs" "scripts/dev/_bak/functions_clean.getWorkflowV1.mjs.$ts.bak"
echo "✅ backups saved in scripts/dev/_bak/"

echo "==> (1) force functions_clean back to CommonJS (so emulator loads it reliably)"
python3 - <<'PY'
import json
from pathlib import Path

p = Path("functions_clean/package.json")
d = json.loads(p.read_text())

# Ensure CJS entrypoint
d["main"] = "index.js"
# Remove ESM mode if present
if d.get("type") == "module":
    d.pop("type", None)

p.write_text(json.dumps(d, indent=2) + "\n")
print("✅ functions_clean/package.json set to CommonJS (main=index.js)")
PY

echo "==> (2) write functions_clean/getWorkflowV1.js (CJS, v2 https onRequest)"
cat > "$WF_JS" <<'JS'
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

exports.getWorkflowV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) {
      return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });
    }

    // optional incident fetch (non-fatal)
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch (_) {}

    const steps = [
      { key: "intake",    title: "Intake",            hint: "Confirm incident exists + has baseline fields.", status: "TODO" },
      { key: "timeline",  title: "Build Timeline",    hint: "Generate timeline events + verify ordering.",     status: "TODO" },
      { key: "filings",   title: "Generate Filings",  hint: "Build DIRS/OE-417/NORS/SAR payloads.",           status: "TODO" },
      { key: "export",    title: "Export Packet",     hint: "Create immutable shareable artifact (ZIP + hashes).", status: "TODO" },
    ];

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      incident,
      workflow: { version: "v1", steps }
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e) });
  }
});
JS
echo "✅ wrote $WF_JS"

echo "==> (3) ensure functions_clean/index.js exports getWorkflowV1 (WITHOUT breaking existing exports)"
if [ ! -f "$IDX_JS" ]; then
  echo "⚠️ $IDX_JS missing. Creating a minimal index.js (verify existing exports afterward)."
  cat > "$IDX_JS" <<'JS'
exports.getWorkflowV1 = require("./getWorkflowV1").getWorkflowV1;
JS
else
  # Append only if not already present
  if ! grep -q "getWorkflowV1" "$IDX_JS"; then
    printf '\n// Phase 2\nexports.getWorkflowV1 = require("./getWorkflowV1").getWorkflowV1;\n' >> "$IDX_JS"
    echo "✅ appended getWorkflowV1 export to $IDX_JS"
  else
    echo "✅ index.js already references getWorkflowV1"
  fi
fi

echo "==> (4) hard restart emulators (functions+firestore)"
pkill -f "firebase emulators:start" 2>/dev/null || true
rm -f .logs/emulators.log 2>/dev/null || true
mkdir -p .logs
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"

for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done

echo "==> (5) confirm emulator registered getWorkflowV1"
if grep -q "getWorkflowV1" .logs/emulators.log; then
  echo "✅ getWorkflowV1 appears in emulator log"
else
  echo "❌ getWorkflowV1 still NOT registered. Showing loaded defs + tail:"
  grep -n "Loaded functions definitions" .logs/emulators.log || true
  tail -n 120 .logs/emulators.log || true
  echo "STOP: kill $EMU_PID"
  exit 1
fi

echo "==> (6) smoke direct function"
curl -sS "$FN_BASE/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | python3 -m json.tool | head -n 60

echo
echo "✅ If you see ok:true above, backend is wired."
echo "Emulators PID: $EMU_PID (leave running)"

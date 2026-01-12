#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FUNCDIR="functions_clean"
LOG=".logs/emulators.log"
PROJECT="peakops-pilot"
FN_BASE="http://127.0.0.1:5001/${PROJECT}/us-central1"

mkdir -p .logs scripts/dev/_bak

ts="$(date +%Y%m%d_%H%M%S)"

echo "==> (0) backups"
cp "${FUNCDIR}/package.json" "scripts/dev/_bak/functions_clean.package.${ts}.json" 2>/dev/null || true
cp "${FUNCDIR}/index.mjs" "scripts/dev/_bak/functions_clean.index.${ts}.mjs" 2>/dev/null || true
cp "${FUNCDIR}/getWorkflowV1.mjs" "scripts/dev/_bak/functions_clean.getWorkflowV1.${ts}.mjs" 2>/dev/null || true
echo "✅ backups saved: scripts/dev/_bak/*.${ts}.*"

echo "==> (1) force functions_clean/package.json main=index.mjs + type=module"
python3 - <<'PY'
import json
from pathlib import Path

p = Path("functions_clean/package.json")
j = json.loads(p.read_text())

# Ensure ESM entrypoint is honored
j["type"] = "module"
j["main"] = "index.mjs"

# Keep emulator happy with node version (optional but helps)
eng = j.get("engines", {})
eng["node"] = ">=22"
j["engines"] = eng

p.write_text(json.dumps(j, indent=2) + "\n")
print("✅ patched functions_clean/package.json")
PY

echo "==> (2) ensure functions_clean/getWorkflowV1.mjs exists"
cat > "${FUNCDIR}/getWorkflowV1.mjs" <<'MJS'
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

export default async function getWorkflowV1Handler(req, res) {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) {
      res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
      return;
    }

    // Optional incident read (doesn't fail if missing)
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch {}

    const steps = [
      { key: "intake",   title: "Intake",            hint: "Confirm incident exists + has baseline fields.", status: "TODO" },
      { key: "timeline", title: "Build Timeline",     hint: "Generate timeline events + verify ordering.",    status: "TODO" },
      { key: "filings",  title: "Generate Filings",   hint: "Build DIRS/OE-417/NORS/SAR payloads.",        status: "TODO" },
      { key: "export",   title: "Export Packet",      hint: "Create immutable shareable artifact (ZIP + hashes).", status: "TODO" },
    ];

    res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      asOf: new Date().toISOString(),
      incident,
      workflow: { version: "v1", steps },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
MJS
echo "✅ wrote functions_clean/getWorkflowV1.mjs"

echo "==> (3) ensure functions_clean/index.mjs exports getWorkflowV1"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("functions_clean/index.mjs")
s = p.read_text()

# If missing import, add it near other handler imports
if "getWorkflowV1Handler" not in s:
  # Insert after last import ...Handler line
  m = list(re.finditer(r"^import .*Handler.*;$", s, re.M))
  ins = m[-1].end() if m else 0
  s = s[:ins] + "\nimport getWorkflowV1Handler from \"./getWorkflowV1.mjs\";\n" + s[ins:]

# If missing export const getWorkflowV1, append near others
if re.search(r"export\s+const\s+getWorkflowV1\s*=", s) is None:
  # Place after exportContractPacketV1 if present
  m = re.search(r"export\s+const\s+exportContractPacketV1\s*=.*;\s*", s)
  if m:
    ins = m.end()
    s = s[:ins] + "\n\n// ✅ NEW\nexport const getWorkflowV1 = onRequest({ cors: true }, getWorkflowV1Handler);\n" + s[ins:]
  else:
    s += "\n\n// ✅ NEW\nexport const getWorkflowV1 = onRequest({ cors: true }, getWorkflowV1Handler);\n"

p.write_text(s)
print("✅ ensured getWorkflowV1 export in functions_clean/index.mjs")
PY

echo "==> (4) HARD restart emulators"
pkill -f "firebase emulators:start" 2>/dev/null || true
rm -f "$LOG" || true
firebase emulators:start --only functions,firestore --project "$PROJECT" > "$LOG" 2>&1 &
EMU_PID=$!

for i in $(seq 1 200); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done

echo "==> (5) confirm emulator registered getWorkflowV1"
echo "Loaded defs:"
grep -n "Loaded functions definitions" "$LOG" || true

if grep -q "getWorkflowV1" "$LOG"; then
  echo "✅ getWorkflowV1 appears in emulator log"
else
  echo "❌ getWorkflowV1 NOT found in emulator log. Showing last 120 lines:"
  tail -n 120 "$LOG" || true
  echo "STOP: kill $EMU_PID"
  exit 1
fi

echo "==> (6) smoke direct function (should be 200 + JSON)"
curl -i "$FN_BASE/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -n 40

echo
echo "✅ If you saw HTTP/1.1 200 and JSON above, you're green."
echo "STOP: kill $EMU_PID"

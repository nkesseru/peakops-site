#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

TAG="phase2-submitqueue-stable"

echo "==> (0) sanity: tag exists"
git show-ref --tags | grep -q "$TAG" || { echo "❌ tag not found: $TAG"; exit 1; }

echo "==> (1) stop dev stack (best-effort)"
bash scripts/dev/dev-down.sh 2>/dev/null || true

echo "==> (2) restore known-good functions entry"
git checkout "$TAG" -- functions_clean/index.mjs functions_clean/package.json || true

echo "==> (3) ensure functions_clean is ESM (required for export syntax)"
python3 - <<'PY'
import json
from pathlib import Path
p = Path("functions_clean/package.json")
d = json.loads(p.read_text())
d["type"] = "module"
d["main"] = "index.mjs"
# keep engines if present; don't force node version here
p.write_text(json.dumps(d, indent=2) + "\n")
print("✅ functions_clean/package.json set type=module, main=index.mjs")
PY

echo "==> (4) (re)write evidenceLockerApi.mjs (safe, standalone handler)"
cat > functions_clean/evidenceLockerApi.mjs <<'MJS'
import { getFirestore } from "firebase-admin/firestore";

export async function handleListEvidenceLockerRequest(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 25)));

    if (!orgId || !incidentId) {
      return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });
    }

    const db = getFirestore();
    const snap = await db
      .collection("incidents").doc(incidentId)
      .collection("evidence_locker")
      .orderBy("storedAt", "desc")
      .limit(limit)
      .get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok:true, orgId, incidentId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
}
MJS
echo "✅ wrote functions_clean/evidenceLockerApi.mjs"

echo "==> (5) patch index.mjs: add ONE import + ONE export (top-level only)"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

# add import right after the first firebase-functions/v2/https import (or near top)
import_line = 'import { handleListEvidenceLockerRequest } from "./evidenceLockerApi.mjs";\n'
if import_line not in s:
  lines = s.splitlines(True)
  out = []
  inserted = False
  for ln in lines:
    out.append(ln)
    if (not inserted) and ('firebase-functions/v2/https' in ln and 'import' in ln):
      out.append(import_line)
      inserted = True
  if not inserted:
    out.insert(0, import_line)
  s = "".join(out)

# add export at EOF (guaranteed top-level)
export_line = '\nexport const listEvidenceLocker = onRequest(handleListEvidenceLockerRequest);\n'
if "export const listEvidenceLocker" not in s:
  s = s.rstrip() + export_line

p.write_text(s)
print("✅ patched functions_clean/index.mjs (import + export)")
PY

echo "==> (6) syntax check (MUST pass)"
node --check functions_clean/index.mjs
node --check functions_clean/evidenceLockerApi.mjs
echo "✅ node --check passed"

echo "==> (7) start dev stack"
bash scripts/dev/dev-up.sh &

# wait until functions actually load
echo "==> (8) wait for 'Loaded functions definitions' in emulator log"
for i in $(seq 1 120); do
  if grep -q "Loaded functions definitions" "$ROOT/.logs/emulators.log" 2>/dev/null; then
    echo "✅ functions loaded"
    break
  fi
  sleep 0.25
done

echo "==> (9) smoke endpoints"
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
ORG_ID="${ORG_ID:-org_001}"

curl -sSf "$FN_BASE/hello" | python3 -m json.tool >/dev/null
curl -sSf "$FN_BASE/listIncidents?orgId=$ORG_ID" | python3 -m json.tool >/dev/null

# evidence locker smoke (pick any incident id you want)
INCIDENT_ID="${INCIDENT_ID:-inc_1h14fdtb}"
curl -sS "$FN_BASE/listEvidenceLocker?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=5" | python3 -m json.tool | head -n 60

echo ""
echo "✅ DONE"
echo "Next UI:   http://localhost:3000"
echo "Incident:  http://localhost:3000/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo "Queue:     http://localhost:3000/admin/queue"

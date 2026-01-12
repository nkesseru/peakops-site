#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"

# Find the *handler* file that actually parses req.query.incidentId
CAND_FILES="$(rg -n --files-with-matches "exportIncidentPacketV1" functions_clean || true)"
if [[ -z "$CAND_FILES" ]]; then
  echo "❌ Could not find exportIncidentPacketV1 anywhere in functions_clean"
  exit 1
fi

FILE="$(python3 - <<'PY'
import sys, pathlib, re, os
cands = os.environ["CAND_FILES"].splitlines()
best = None
best_score = -1
for f in cands:
    p = pathlib.Path(f)
    try:
        s = p.read_text()
    except Exception:
        continue
    score = 0
    # Prefer real handler patterns
    if re.search(r"req\.query\.incidentId", s): score += 10
    if re.search(r"incidentId\s*=\s*String\(", s): score += 10
    if re.search(r"db\s*=\s*admin\.firestore\(\)", s) or re.search(r"getFirestore\(", s): score += 5
    if p.name == "index.js" or p.name == "index.mjs": score -= 50
    if score > best_score:
        best_score = score
        best = f
print(best or "")
PY
)"
if [[ -z "${FILE}" ]]; then
  echo "❌ Could not locate the handler file (only found exports/index)."
  echo "Candidates were:"
  echo "$CAND_FILES"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"
echo "==> patching: $FILE"

export FILE
python3 - <<'PY'
from pathlib import Path
import re, os

p = Path(os.environ["FILE"])
s = p.read_text()

if "IDEMPOTENT_EXPORT_V1" in s:
    print("✅ already hardened (marker present)")
    raise SystemExit(0)

# 1) Insert cache-read after incidentId assignment
m_inc = re.search(r"(incidentId\s*=\s*String\([^\n]+\)\s*;?\n)", s)
if not m_inc:
    # fallback: req.query.incidentId usage
    m_inc = re.search(r"(req\.query\.incidentId[^\n]*\n)", s)
if not m_inc:
    raise SystemExit("❌ Could not find an incidentId assignment line in handler file")

cache_read = r'''
  // IDEMPOTENT_EXPORT_V1: if packet already generated for this incident, return cached meta.
  try {
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    const inc = incSnap.exists ? incSnap.data() : null;
    const cached = inc && inc.packetMeta && inc.packetMeta.packetHash ? inc.packetMeta : null;
    if (cached) {
      return send(res, 200, { ok: true, orgId, incidentId, packetMeta: cached, alreadyExists: true });
    }
  } catch (e) {
    // ignore cache read failures; continue to generate
  }

'''
s = s[:m_inc.end()] + cache_read + s[m_inc.end():]

# 2) Insert cache write-back right after packetMeta is created
m_meta = re.search(r"(const\s+packetMeta\s*=\s*\{[\s\S]*?\}\s*;)", s)
store_block = r'''
  // IDEMPOTENT_EXPORT_V1: write cache so subsequent exports are stable
  try {
    await db.collection("incidents").doc(incidentId).set(
      { orgId, incidentId, packetMeta, packetMetaUpdatedAt: new Date().toISOString() },
      { merge: true }
    );
  } catch (e) {
    // ignore cache write failures
  }

'''
if m_meta:
    s = s[:m_meta.end()] + "\n" + store_block + s[m_meta.end():]
else:
    # fallback: put write-back right before a success send() that includes packetMeta
    m_send = re.search(r"send\(\s*res\s*,\s*200\s*,\s*\{[\s\S]{0,400}?packetMeta", s)
    if m_send:
        s = s[:m_send.start()] + store_block + s[m_send.start():]
    else:
        print("⚠️ Could not find packetMeta assignment or success send() anchor; added cache-read only.")

p.write_text(s)
print("✅ hardened exportIncidentPacketV1 (idempotent + cached)")
PY

echo "==> restart emulators"
pkill -f "firebase emulators:start" 2>/dev/null || true
mkdir -p .logs
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!
sleep 3

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
echo "==> smoke hello"
curl -fsS "$FN_BASE/hello" | head -c 120; echo

echo "==> smoke exportIncidentPacketV1 twice (second should be alreadyExists:true)"
curl -fsS "$FN_BASE/exportIncidentPacketV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 260; echo
curl -fsS "$FN_BASE/exportIncidentPacketV1?orgId=$ORG_ID&incidentId=$INCIDENT_ID" | head -c 260; echo

echo
echo "✅ C DONE if second response includes alreadyExists:true"
echo "STOP: kill $EMU_PID"

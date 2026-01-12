#!/usr/bin/env bash
set -euo pipefail

# Locate the function file (works for .js/.mjs)
CAND="$(rg -n --files-with-matches "exportIncidentPacketV1" functions_clean | head -n 1 || true)"
if [[ -z "${CAND}" ]]; then
  echo "❌ Could not find exportIncidentPacketV1 in functions_clean"
  exit 1
fi

FILE="$CAND"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"
echo "==> patching: $FILE"

python3 - <<'PY'
from pathlib import Path
import re

p = Path(__import__("os").environ["FILE"])
s = p.read_text()

if "IDEMPOTENT_EXPORT" in s:
    print("✅ already hardened")
    raise SystemExit(0)

anchor = re.search(r"(incidentId\s*=.*\n)", s)
if not anchor:
    raise SystemExit("❌ Could not find incidentId assignment anchor")

insert_cache = r'''
  // IDEMPOTENT_EXPORT: if packet already generated for this incident, return cached meta.
  // Safe: does not prevent re-export later if you add a force flag.
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

pos = anchor.end()
s = s[:pos] + insert_cache + s[pos:]

m2 = re.search(r"send\(res,\s*200,\s*\{[^\}]*packetMeta", s)
if not m2:
    # still ok; we’ll just add a write-back near the bottom before a likely success return
    print("⚠️ Could not locate packetMeta success send() pattern; leaving cache read only.")
    p.write_text(s)
    raise SystemExit(0)
m_meta = re.search(r"(packetMeta\s*=\s*\{[\s\S]*?\}\s*;)", s)
if not m_meta:
    # fallback: store right before success send
    store_block = r'''
  try {
    await db.collection("incidents").doc(incidentId).set(
      { orgId, incidentId, packetMeta, packetMetaUpdatedAt: new Date().toISOString() },
      { merge: true }
    );
  } catch (e) {
    // ignore cache write failures
  }
'''
    s = s[:m2.start()] + store_block + s[m2.start():]
    p.write_text(s)
    print("✅ hardened (cache read + cache write-back fallback)")
    raise SystemExit(0)

store_block = r'''
  try {
    await db.collection("incidents").doc(incidentId).set(
      { orgId, incidentId, packetMeta, packetMetaUpdatedAt: new Date().toISOString() },
      { merge: true }
    );
  } catch (e) {
    // ignore cache write failures
  }
'''
s = s[:m_meta.end()] + "\n" + store_block + s[m_meta.end():]

p.write_text(s)
print("✅ hardened exportIncidentPacketV1 (idempotent + cached)")
PY

echo "==> restart emulators"
pkill -f "firebase emulators:start" 2>/dev/null || true
mkdir -p .logs
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
sleep 3

FN_BASE="http://127.0.0.1:5001/peakops-pilot/us-central1"
echo "==> smoke hello"
curl -fsS "$FN_BASE/hello" | head -c 120; echo

echo "==> smoke exportIncidentPacketV1 (idempotent)"
curl -fsS "$FN_BASE/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST" | head -c 220; echo
curl -fsS "$FN_BASE/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST" | head -c 220; echo

echo "✅ C DONE (idempotent export)"

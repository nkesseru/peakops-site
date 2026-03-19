#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
NEXT_PORT="${4:-3000}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

FILE="functions_clean/exportIncidentPacketV1.js"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing: $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_incident_fix_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $FILE.bak_incident_fix_*"

node - <<'NODE'
const fs = require("fs");
const path = "functions_clean/exportIncidentPacketV1.js";
let s = fs.readFileSync(path, "utf8");

// If we already have incidentData, don’t re-inject.
const hasIncidentData = /\bconst\s+incidentData\s*=/.test(s);

// Find the incidentSnap.get() line (allow whitespace variations)
const getLineRe = /const\s+incidentSnap\s*=\s*await\s+incidentRef\.get\(\)\s*;/;

if (!getLineRe.test(s)) {
  console.error("❌ Could not find: const incidentSnap = await incidentRef.get();");
  process.exit(1);
}

// Inject incidentData immediately after incidentSnap is fetched (idempotent)
if (!hasIncidentData) {
  s = s.replace(getLineRe, (m) => {
    return (
      m +
      "\n\n    // SAFE: incidentData is the incident document payload (avoid undefined `incident` refs)\n" +
      "    const incidentData = incidentSnap.exists ? (incidentSnap.data() || {}) : {};\n"
    );
  });
  console.log("✅ injected incidentData after incidentSnap.get()");
} else {
  console.log("ℹ️ incidentData already present; skipping injection");
}

// Replace references to `incident` that are clearly intended to be the incident payload.
// We DO NOT want to touch incidentId, incidentRef, incidentSnap, or string literals.
const before = s;

// Replace common packet build usage: `{ ..., incident, ... }`
s = s.replace(/(\{\s*orgId\s*,\s*incidentId\s*,\s*exportedAt\s*,\s*)incident(\s*,)/g, "$1incidentData$2");

// Replace any direct property access like incident.immutable, incident.packetMeta, etc.
s = s.replace(/\bincident\.(\w+)/g, "incidentData.$1");

// If a line exists: `const incident = ...` leave it alone, but we can safely normalize later; for now we avoid that.
fs.writeFileSync(path, s, "utf8");

const changed = s !== before;
console.log(changed ? "✅ patched exportIncidentPacketV1.js" : "ℹ️ no changes made (already patched?)");
NODE

echo
echo "==> HARD KILL ghost emulator ports + firebase"
for p in 5001 8080 4000 4400 4500 9150 8670 8740 8924; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true
sleep 1

echo "==> Start emulators (functions + firestore)"
rm -f "$LOGDIR/emulators.log"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> Wait for :5001 LISTEN"
for i in $(seq 1 200); do
  lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.25
done

echo
echo "==> Prove hello"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/hello" | head -c 120; echo || true

echo
echo "==> Export packet DIRECT emulator (expect ok:true)"
curl -sS "http://127.0.0.1:5001/${PROJECT_ID}/us-central1/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=repair" | head -c 320; echo || true

echo
echo "==> Export packet via Next proxy (expect ok:true)"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/exportIncidentPacketV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&force=1&requestedBy=repair" | head -c 320; echo || true

echo
echo "==> Confirm packetMeta non-null"
curl -sS "http://127.0.0.1:${NEXT_PORT}/api/fn/getIncidentPacketMetaV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | python3 -m json.tool | head -n 120 || true

echo
echo "If anything fails, check:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo "STOP:"
echo "  kill $EMU_PID"

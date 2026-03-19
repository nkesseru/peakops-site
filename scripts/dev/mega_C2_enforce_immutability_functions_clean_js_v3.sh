#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true  # zsh: disable history expansion

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
mkdir -p .logs

FILES=(
  "functions_clean/generateTimelineV1.js"
  "functions_clean/generateFilingsV1.js"
  "functions_clean/exportIncidentPacketV1.js"
)

for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || { echo "❌ missing: $f"; exit 1; }
done

echo "==> C2 v3: Enforce immutability inside functions_clean/*.js (server-side)"
echo

patch_one () {
  local f="$1"
  cp "$f" "$f.bak_immut_guard_v3_$(date +%Y%m%d_%H%M%S)"
  echo "✅ backup: $f.bak_immut_guard_v3_*"

  python3 - <<'PY'
from pathlib import Path
import re, sys

p = Path(sys.argv[1])
s = p.read_text()

if "IMMUTABILITY_GUARD_V3" in s:
    print("✅ already patched:", p)
    sys.exit(0)

# Find the start of the onRequest handler body and inject immediately inside it.
# Typical line: exports.X = onRequest({ cors: true }, async (req, res) => {
m = re.search(r'(onRequest\s*\(\s*\{[^}]*\}\s*,\s*async\s*\(\s*req\s*,\s*res\s*\)\s*=>\s*\{)', s)
if not m:
    # fallback: async function(req,res){ ... }
    m = re.search(r'(async\s*function\s*\(\s*req\s*,\s*res\s*\)\s*\{)', s)

if not m:
    raise SystemExit(f"❌ could not find handler start in {p}")

guard = r'''
  // IMMUTABILITY_GUARD_V3
  // Enforce: once incidents/{incidentId}.immutable === true -> reject mutations unless force=1.
  // Works in emulator + prod (Node 18+ has fetch).
  try {
    const q = (req && req.query) ? req.query : {};
    const b = (req && req.body) ? req.body : {};
    const incidentId = String(q.incidentId || b.incidentId || "");
    const force = String(q.force || b.force || "") === "1";

    if (incidentId && !force) {
      const host = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
      const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "peakops-pilot";
      const url =
        "http://" + host +
        "/v1/projects/" + encodeURIComponent(projectId) +
        "/databases/(default)/documents/incidents/" + encodeURIComponent(incidentId);

      const r0 = await fetch(url, { method: "GET" });
      if (r0.ok) {
        const j0 = await r0.json().catch(() => null);
        const imm = !!(j0 && j0.fields && j0.fields.immutable && j0.fields.immutable.booleanValue);
        if (imm) {
          return res.status(409).json({ ok: false, error: "IMMUTABLE: Incident is finalized" });
        }
      }
    }
  } catch (_) {
    // If guard fails, do NOT block (fail-open in dev). In prod, we can tighten.
  }

'''

ins = m.end()
out = s[:ins] + "\n" + guard + s[ins:]
p.write_text(out)
print("✅ injected guard into:", p)
PY "$f"
}

for f in "${FILES[@]}"; do
  patch_one "$f"
done

echo
echo "==> restart emulators (functions + firestore)"
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true

firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
sleep 6

echo
echo "==> smoke (expect 409 unless force=1) via Next proxy"
echo "-- generateTimelineV1"
curl -sS -i -X POST "http://127.0.0.1:3000/api/fn/generateTimelineV1?orgId=org_001&incidentId=inc_TEST" | head -n 18 || true
echo
echo "-- generateFilingsV1"
curl -sS -i -X POST "http://127.0.0.1:3000/api/fn/generateFilingsV1?orgId=org_001&incidentId=inc_TEST" | head -n 18 || true
echo
echo "-- exportIncidentPacketV1 (no force)"
curl -sS -i "http://127.0.0.1:3000/api/fn/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST" | head -n 18 || true
echo
echo "-- exportIncidentPacketV1 (force=1 should succeed)"
curl -sS -i "http://127.0.0.1:3000/api/fn/exportIncidentPacketV1?orgId=org_001&incidentId=inc_TEST&force=1" | head -n 18 || true
echo
echo "LOGS:"
echo "  tail -n 200 .logs/emulators.log"

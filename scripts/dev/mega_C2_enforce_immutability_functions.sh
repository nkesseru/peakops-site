#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "==> C2 Enforcing immutability inside Firebase Functions"

FUNCS="$ROOT/functions_clean"
[[ -d "$FUNCS" ]] || { echo "❌ functions_clean not found"; exit 1; }

patch_one () {
  local file="$1"
  echo "→ patching $file"

  python3 - <<PY
from pathlib import Path
import re

p = Path("$file")
s = p.read_text()

if "IMMUTABLE:" in s:
    print("  ✓ already guarded")
    exit(0)

# Insert guard after params extraction
pat = re.compile(r'(const\s+orgId.*?\n.*?incidentId.*?\n)', re.S)
m = pat.search(s)
if not m:
    raise SystemExit("❌ could not find orgId/incidentId block")

guard = '''
  // IMMUTABILITY GUARD
  const force = String(req.query?.force || req.body?.force || "") === "1";
  if (incident?.immutable === true && !force) {
    return res.status(409).json({
      ok: false,
      error: "IMMUTABLE: Incident is finalized"
    });
  }

'''

s = s[:m.end()] + guard + s[m.end():]
p.write_text(s)
print("  ✓ guard injected")
PY
}

patch_one "$FUNCS/generateTimelineV1.ts"
patch_one "$FUNCS/generateFilingsV1.ts"
patch_one "$FUNCS/exportIncidentPacketV1.ts"

echo
echo "==> Restarting emulators"
pkill -f firebase || true
firebase emulators:start --only functions,firestore &
sleep 6

echo
echo "==> DONE: immutability now enforced at source"

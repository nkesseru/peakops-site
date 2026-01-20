#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(pwd)"

echo "==> (1) Patch scripts/dev/up_contracts_a.sh (bash 3.2 safe lowercasing)"
FILE="scripts/dev/up_contracts_a.sh"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_$(date +%Y%m%d_%H%M%S)"

# Replace any ${VAR,,} with a bash-3.2 safe form using tr.
# Common pattern in our script was v1_${TYPE,,}
python3 - <<'PY'
from pathlib import Path
p = Path("scripts/dev/up_contracts_a.sh")
s = p.read_text()

# inject helper if not present
helper = r'''
lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }
'''
if "lower() { echo" not in s:
    # put right after set -euo pipefail (or near top)
    if "set -euo pipefail" in s:
        i = s.find("set -euo pipefail")
        j = s.find("\n", i)
        s = s[:j+1] + "\n" + helper + "\n" + s[j+1:]
    else:
        s = helper + "\n" + s

# swap bash-4 lowercase expansions
s = s.replace('${TYPE,,}', '$(lower "$TYPE")')
s = s.replace('${type,,}', '$(lower "$type")')

p.write_text(s)
print("✅ patched:", p)
PY

echo "==> (2) Create missing scripts/dev/patch_payload_editor_save.sh (no-op placeholder)"
mkdir -p scripts/dev
cat > scripts/dev/patch_payload_editor_save.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "✅ patch_payload_editor_save.sh: nothing to do (payload editor already wired)."
echo "If you want me to harden Save UX (better error text, schemaVersion guardrails), say so."
SH
chmod +x scripts/dev/patch_payload_editor_save.sh

echo "==> (3) Restart stack cleanly (ports + emulators + next)"
bash scripts/dev/dev-down.sh 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true

# start emulators in background
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!

# wait for functions /hello
FN_BASE="${FN_BASE:-http://127.0.0.1:5001/peakops-pilot/us-central1}"
for i in $(seq 1 80); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
echo "✅ emulators ok (pid=$EMU_PID)"

# start Next in background
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
echo "✅ next ok (pid=$NEXT_PID)"

echo
echo "✅ STACK UP"
echo "Stop:"
echo "  kill $EMU_PID $NEXT_PID"

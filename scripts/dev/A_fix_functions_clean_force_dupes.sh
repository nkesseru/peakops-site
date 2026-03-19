#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
mkdir -p .logs

echo "==> A) De-dupe duplicate force / incident declarations in functions_clean/*.js"

python3 - <<'PY'
from pathlib import Path
import re, time

files = [
  "functions_clean/generateTimelineV1.js",
  "functions_clean/generateFilingsV1.js",
  "functions_clean/exportIncidentPacketV1.js",
]

decl_pat = re.compile(r"^[ \t]*(?:const|let)[ \t]+(force|incident)[ \t]*=[^\n;]*;[ \t]*$", re.M)

def backup(p: Path):
  b = p.with_name(p.name + f".bak_dedupe_{time.strftime(%Y%m%d_%H%M%S)}")
  b.write_text(p.read_text())
  return b

for fp in files:
  p = Path(fp)
  if not p.exists():
    print(f"SKIP missing: {fp}")
    continue

  b = backup(p)
  s = p.read_text()

  kept = set()
  out_lines = []
  removed = {"force": 0, "incident": 0}

  for line in s.splitlines(True):
    m = decl_pat.match(line)
    if not m:
      out_lines.append(line)
      continue
    name = m.group(1)
    if name not in kept:
      kept.add(name)
      out_lines.append(line)
    else:
      removed[name] += 1

  out = "".join(out_lines)
  out = re.sub(r"\n{3,}", "\n\n", out)
  p.write_text(out)
  print(f"✅ {fp}: removed force={removed[force]} incident={removed[incident]} (backup {b.name})")
PY

echo
echo "==> HARD KILL ghost emulator ports + firebase processes"
for p in 5001 8080 4000 4400 4500 9150 8670 8740 8924; do
  lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "firebase" 2>/dev/null || true
sleep 1

echo
echo "==> Start emulators (functions + firestore)"
rm -f .logs/emulators.log
firebase emulators:start --only functions,firestore --project peakops-pilot > .logs/emulators.log 2>&1 &
EMU_PID=$!
echo "EMU_PID=$EMU_PID"

echo "==> wait for :5001"
for i in $(seq 1 160); do
  lsof -tiTCP:5001 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.25
done

echo
echo "==> Show loaded functions (from emulators.log)"
grep -E "http function initialized|Loaded functions definitions|Failed to load function definition|SyntaxError" -n .logs/emulators.log | tail -n 80 || true

echo
echo "==> Prove hello + getWorkflowV1 exist (or show list)"
echo "-- hello:"
curl -sS "http://127.0.0.1:5001/peakops-pilot/us-central1/hello" | head -c 160; echo || true
echo "-- getWorkflowV1:"
curl -sS "http://127.0.0.1:5001/peakops-pilot/us-central1/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -c 260; echo || true
echo "-- list (hit a fake fn to print valid functions):"
curl -sS "http://127.0.0.1:5001/peakops-pilot/us-central1/__nope__" | head -c 200; echo || true

echo
echo "STOP:"
echo "  kill $EMU_PID"

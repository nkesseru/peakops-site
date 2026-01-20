#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
cp "$FILE" "$FILE.bak_clean_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup: $FILE.bak_clean_*"

python3 - <<'PY'
from pathlib import Path

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
lines = p.read_text().splitlines(True)

out = []
removed_orphans = 0
removed_dupe_effective = 0
seen_effective = {"effectiveCanonical": False, "effectiveZipVerified": False}

for ln in lines:
    # remove literal "\n" tokens
    if "\\n" in ln:
        ln = ln.replace("\\n", "")

    s = ln.lstrip()

    # kill orphan ternary fragments that got injected
    if s.startswith(":") or s.startswith("?"):
        if "wf" in s or "export_packet" in s or "verify_zip" in s or "undefined?.immutable" in s or "hasPacketMeta" in s:
            removed_orphans += 1
            continue

    # de-dupe effectiveCanonical/effectiveZipVerified declarations
    if "const effectiveCanonical" in s:
        if seen_effective["effectiveCanonical"]:
            removed_dupe_effective += 1
            continue
        seen_effective["effectiveCanonical"] = True

    if "const effectiveZipVerified" in s:
        if seen_effective["effectiveZipVerified"]:
            removed_dupe_effective += 1
            continue
        seen_effective["effectiveZipVerified"] = True

    out.append(ln)

p.write_text("".join(out))
print(f"✅ cleaned panel: removed_orphans={removed_orphans}, removed_dupe_effective={removed_dupe_effective}")
PY

echo "🧹 restart Next (clean cache)"
pkill -f "pnpm dev --port 3000" >/dev/null 2>&1 || true
rm -rf next-app/.next >/dev/null 2>&1 || true
rm -f "$LOGDIR/next.log"
( cd next-app && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
sleep 2

echo "==> smoke"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" | head -n 6 || true
echo
echo "LOGS:"
tail -n 40 "$LOGDIR/next.log" || true

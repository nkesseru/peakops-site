#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing file: $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_c3_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup: $FILE.bak_c3_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

BANNER_TEXT = "Workflow engine not active yet — running in manual mode."

# 1) Add derived flag (no hooks needed)
# We don't assume a specific "useState" line — we just inject near the top of the component body.
if "workflowMissingDerived" not in s:
    # Try common patterns to anchor near an existing error var
    anchor_patterns = [
        r"(const\s+\[\s*err\s*,\s*setErr\s*\][^;]*;\s*\n)",
        r"(const\s+err\s*=\s*[^;\n]+;\s*\n)",
        r"(const\s+\{\s*err\s*\}\s*=\s*props;\s*\n)",
    ]
    inserted = False
    for pat in anchor_patterns:
        m = re.search(pat, s)
        if m:
            inject = (
                "const workflowMissingDerived = !!(err && (String(err).includes('getWorkflowV1') "
                "|| String(err).includes('getWorkflowV1 does not exist') "
                "|| String(err).includes('HTTP 404') "
                "|| String(err).includes('Workflow API returned non-JSON (HTTP 404)')));\n"
            )
            s = s[:m.end()] + inject + s[m.end():]
            inserted = True
            break

    # If we couldn't find an "err" anchor, inject right after the component function opens
    if not inserted:
        # Try to find the first "{\n" after the component declaration
        m2 = re.search(r"(function\s+GuidedWorkflowPanel[^{]*\{\s*\n)", s)
        if not m2:
            m2 = re.search(r"(export\s+default\s+function\s+GuidedWorkflowPanel[^{]*\{\s*\n)", s)
        if not m2:
            # Last fallback: any function that looks like the panel component
            m2 = re.search(r"(function\s+[A-Za-z0-9_]+\s*\([^\)]*\)\s*\{\s*\n)", s)
        if m2:
            inject = "const workflowMissingDerived = false; // injected fallback\n"
            s = s[:m2.end()] + inject + s[m2.end():]

# 2) Gate the scary error block so it doesn't scream when workflow is missing
# Replace the FIRST {err && (...) } style block with {err && !workflowMissingDerived && (...) }
if "{err && !workflowMissingDerived &&" not in s:
    s, n = re.subn(r"\{err\s*&&\s*\(", "{err && !workflowMissingDerived && (", s, count=1)
    # If the file uses "{err && <div" instead of "(", catch that too
    if n == 0:
        s = re.sub(r"\{err\s*&&\s*<", "{err && !workflowMissingDerived && <", s, count=1)

# 3) Insert calm banner near the top of render
if BANNER_TEXT not in s:
    banner = (
        "\n{workflowMissingDerived && (\n"
        "  <div style={{ marginTop: 10, padding: \"10px 12px\", borderRadius: 12, "
        "background: \"rgba(245,158,11,0.12)\", border: \"1px solid rgba(245,158,11,0.25)\", fontSize: 12 }}>\n"
        f"    {BANNER_TEXT} (This is OK in dev.)\n"
        "  </div>\n"
        ")}\n"
    )

    # Insert after the “Guided Workflow” header text if present
    m = re.search(r"(Guided Workflow[^\n]*\n)", s)
    if m:
        s = s[:m.end()] + banner + s[m.end():]
    else:
        # fallback: after first return(<div...>)
        m2 = re.search(r"(return\s*\(\s*<div[^>]*>\s*\n)", s)
        if m2:
            s = s[:m2.end()] + banner + s[m2.end():]

p.write_text(s)
print("✅ C3 patched: workflow 404 => calm manual mode banner (no-hook derived flag)")
PY

echo "<0001f9f9> restart Next (clean)"
mkdir -p .logs
pkill -f "pnpm dev --port 3000" >/dev/null 2>&1 || true
rm -rf next-app/.next >/dev/null 2>&1 || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incident page"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" | head -n 5 || true

echo "✅ open"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null 2>&1 || true

echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"

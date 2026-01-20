#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
BAK_GLOB="next-app/src/app/admin/incidents/[id]/page.tsx.bak_*"

echo "==> (0) Sanity"
test -f "$PAGE" || { echo "❌ Missing $PAGE"; exit 1; }

echo "==> (1) Restore latest known-good backup if exists"
LATEST_BAK="$(ls -1t $BAK_GLOB 2>/dev/null | head -n 1 || true)"
if [[ -n "${LATEST_BAK}" ]]; then
  cp "$LATEST_BAK" "$PAGE"
  echo "✅ restored from: $LATEST_BAK"
else
  echo "⚠️ no backup found at $BAK_GLOB — will patch in-place"
fi

echo "==> (2) Patch incidents page: ensure WorkflowStepCard import + clean Guided Workflow block"
python3 - <<'PY'
from pathlib import Path
import re

page = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = page.read_text()

# 2a) Ensure import path is correct.
# incidents/[id] -> admin/_components is ../../_components
import_line = 'import WorkflowStepCard from "../../_components/WorkflowStepCard";\n'

# If it imports from "../_components" or "../components" etc, normalize.
s = re.sub(r'^\s*import\s+WorkflowStepCard\s+from\s+["\'][^"\']+WorkflowStepCard["\'];\s*\n',
           '', s, flags=re.M)

# Insert import after react import (or after "use client")
m = re.search(r'(^\s*import\s+.*from\s+"react";\s*\n)', s, flags=re.M)
if m:
  insert_at = m.end()
  s = s[:insert_at] + import_line + s[insert_at:]
else:
  # fallback: after "use client";
  m2 = re.search(r'(^\s*"use client";\s*\n)', s, flags=re.M)
  if m2:
    insert_at = m2.end()
    s = s[:insert_at] + "\n" + import_line + s[insert_at:]
  else:
    s = import_line + s

# 2b) Remove any previous broken “Step cards (Phase 2)” block that causes unterminated strings.
# We target the common offenders: "Step cards (Phase 2)" comment or workflow.steps.map region.
s = re.sub(r'\{\s*/\*\s*Step cards\s*\(Phase 2\)[\s\S]*?\n\s*\}\s*\)\s*\}\s*\n',
           '', s, flags=re.M)

# Also strip obvious broken hybrid fragments
s = s.replace("})()}    <ul", "")  # common catastrophic splice
s = s.replace("})()}<ul", "")

# 2c) Inject a clean Guided Workflow render block.
# We'll try to inject inside the "Guided Workflow" panel if it exists; otherwise append near bottom of return.
block = r'''
      {/* Guided Workflow (Phase 2) */}
      {workflow?.steps?.length ? (
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          {workflow.steps.map((step: any, idx: number) => (
            <WorkflowStepCard
              key={String(step.key || idx)}
              step={step}
              index={idx}
              onSetStatus={(key, status) => {
                // optimistic: update local UI immediately (backend optional later)
                try {
                  const k = `wf:${orgId}:${incidentId}`;
                  const raw = localStorage.getItem(k);
                  const m = raw ? JSON.parse(raw) : {};
                  m[key] = status;
                  localStorage.setItem(k, JSON.stringify(m));
                } catch {}
                setWorkflow((w: any) => {
                  if (!w?.steps) return w;
                  return {
                    ...w,
                    steps: w.steps.map((st: any) =>
                      String(st.key) === String(key) ? { ...st, status } : st
                    ),
                  };
                });
              }}
            />
          ))}
        </div>
      ) : (
        <div style={{ opacity: 0.7 }}>No workflow steps.</div>
      )}
'''

# Find a good injection point:
# Prefer inserting after a heading that contains "Guided Workflow"
m = re.search(r'(Guided Workflow</[^>]+>\s*\n)', s)
if m and block.strip() not in s:
  insert_at = m.end()
  s = s[:insert_at] + block + s[insert_at:]
else:
  # fallback: inject before the final closing of the main return container.
  # We insert before the last occurrence of "\n}\n" that closes the component return.
  if block.strip() not in s:
    tail_anchor = s.rfind("\n  );")
    if tail_anchor != -1:
      # Insert a little before the component closes.
      s = s[:tail_anchor] + "\n" + block + "\n" + s[tail_anchor:]
    else:
      # last resort: append
      s += "\n" + block + "\n"

# 2d) Ensure setWorkflow exists (some versions name it differently).
# If setWorkflow isn't found, we won't invent it — but we can at least not break compile.
if "setWorkflow(" not in s:
  # Replace the onSetStatus handler with a no-op setWorkflow call removed
  s = re.sub(r'setWorkflow\([\s\S]*?\);\s*', '', s)

page.write_text(s)
print("✅ patched incidents page (import + safe workflow block)")
PY

echo "==> (3) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> (4) Smoke compile + load incident page"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
curl -fsS "$URL" >/dev/null && echo "✅ incident page loads: $URL" || {
  echo "❌ still failing — tailing next.log"
  tail -n 120 .logs/next.log || true
  exit 1
}

echo
echo "✅ DONE"
echo "Open:"
echo "  $URL"

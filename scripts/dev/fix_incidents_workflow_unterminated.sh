#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"

echo "==> backup"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

echo "==> strip python junk + broken workflow block, then re-add clean block"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 1) Remove accidental python/heredoc artifacts that should NEVER be in TSX
#    (the main killer is triple quotes which create unterminated strings)
s = s.replace("'''", "")
s = s.replace('"""', "")

# Also remove obvious injected python comments/lines if present
bad_markers = [
  "Find a good injection point",
  "Prefer inserting after a heading",
  "tail_anchor",
  "page.write_text",
  "print(\"✅ patched incidents page",
  "re.search(",
]
for m in bad_markers:
  s = s.replace(m, "")

# 2) Remove any existing "Step cards (Phase 2)" block (we'll re-add clean)
s = re.sub(
  r'\{\s*/\*\s*Step cards\s*\(Phase 2\)\s*\*/\s*\}[\s\S]*?\n\s*\}\s*\)\s*\}\s*',
  '',
  s,
  flags=re.M
)

# 3) Ensure WorkflowStepCard import is correct (incidents/[id] -> admin/_components is ../../_components)
s = re.sub(r'^\s*import\s+WorkflowStepCard\s+from\s+["\'][^"\']+WorkflowStepCard["\'];\s*\n',
           '', s, flags=re.M)

import_line = 'import WorkflowStepCard from "../../_components/WorkflowStepCard";\n'
m = re.search(r'(^\s*import\s+.*from\s+"react";\s*\n)', s, flags=re.M)
if m:
  s = s[:m.end()] + import_line + s[m.end():]
else:
  m2 = re.search(r'(^\s*"use client";\s*\n)', s, flags=re.M)
  if m2:
    s = s[:m2.end()] + "\n" + import_line + s[m2.end():]
  else:
    s = import_line + s

# 4) Insert the clean workflow block near where your UI is (before banner or before end of return)
block = r'''
      {/* Step cards (Phase 2) */}
      {workflow?.steps?.length ? (
        <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
          {workflow.steps.map((step: any, idx: number) => (
            <WorkflowStepCard
              key={String(step?.key || idx)}
              step={step}
              index={idx}
              onSetStatus={(key, status) => {
                try {
                  const k = `wf:${orgId}:${incidentId}`;
                  const raw = localStorage.getItem(k);
                  const m = raw ? JSON.parse(raw) : {};
                  m[key] = status;
                  localStorage.setItem(k, JSON.stringify(m));
                } catch {}
                // optimistic only if setWorkflow exists
                try {
                  // @ts-ignore
                  setWorkflow((w: any) => {
                    if (!w?.steps) return w;
                    return {
                      ...w,
                      steps: w.steps.map((st: any) =>
                        String(st.key) === String(key) ? { ...st, status } : st
                      ),
                    };
                  });
                } catch {}
              }}
            />
          ))}
        </div>
      ) : (
        <div style={{ opacity: 0.7 }}>No workflow steps.</div>
      )}
'''

# Put it right after "Guided Workflow" title if present, else before the last "</div>" of main return
inserted = False
m = re.search(r'(title=\{?"Guided Workflow"\}[^>]*>\s*)', s)
if m and block.strip() not in s:
  s = s[:m.end()] + "\n" + block + "\n" + s[m.end():]
  inserted = True

if not inserted and block.strip() not in s:
  anchor = s.rfind("</div>\n  );")
  if anchor != -1:
    s = s[:anchor] + "\n" + block + "\n" + s[anchor:]
  else:
    s += "\n" + block + "\n"

p.write_text(s)
print("✅ patched incidents page (removed triple-quotes + reinserted workflow block)")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke compile"
node --check "$FILE" >/dev/null 2>&1 && echo "✅ node --check OK" || {
  echo "❌ node --check failed"
  node --check "$FILE" || true
  exit 1
}

echo "==> smoke page (quote URL so zsh doesn't glob ?)"
URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
curl -fsS "$URL" >/dev/null && echo "✅ incident page responds" || {
  echo "❌ still failing - showing next.log error block"
  tail -n 80 .logs/next.log || true
  exit 1
}

echo "✅ DONE"
echo "Open: $URL"

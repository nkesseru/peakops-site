#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

INCIDENT_FILE="$ROOT/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

GRID_CANDIDATES=(
  "$ROOT/next-app/src/components/evidence/EvidenceLockerGrid.tsx"
  "$ROOT/next-app/components/evidence/EvidenceLockerGrid.tsx"
)

echo "== backup files =="
TS="$(date +%Y%m%d_%H%M%S)"
cp "$INCIDENT_FILE" "$INCIDENT_FILE.bak_$TS"

GRID_FILE=""
for f in "${GRID_CANDIDATES[@]}"; do
  if [ -f "$f" ]; then
    GRID_FILE="$f"
    cp "$f" "$f.bak_$TS"
    break
  fi
done

if [ -z "$GRID_FILE" ]; then
  echo "Could not find EvidenceLockerGrid.tsx in expected locations."
  exit 1
fi

echo "Using grid file: $GRID_FILE"

python3 <<'PY'
from pathlib import Path
import re
import sys

root = Path.home() / "peakops/my-app"
incident_file = root / "next-app/app/incidents/[incidentId]/IncidentClient.tsx"

grid_candidates = [
    root / "next-app/src/components/evidence/EvidenceLockerGrid.tsx",
    root / "next-app/components/evidence/EvidenceLockerGrid.tsx",
]
grid_file = None
for c in grid_candidates:
    if c.exists():
        grid_file = c
        break

if grid_file is None:
    raise SystemExit("EvidenceLockerGrid.tsx not found")

# -------------------------
# Patch IncidentClient.tsx
# -------------------------
s = incident_file.read_text()

if "function jumpToEvidence(" not in s:
    anchor = "function labelChipColor(label: string) {"
    helper = '''
function jumpToEvidence(evidenceIdRaw?: string, opts?: { open?: boolean }) {
  const evidenceId = String(evidenceIdRaw || "").trim();
  if (!evidenceId) return;

  try { setActiveTab("evidence"); } catch {}

  const run = () => {
    try {
      const el = document.getElementById(`evidence-${evidenceId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      }
    } catch {}

    try {
      if (typeof setSelectedEvidenceId === "function") {
        setSelectedEvidenceId(evidenceId);
      }
    } catch {}

    if (opts?.open) {
      try {
        if (typeof setPreviewOpen === "function") {
          setPreviewOpen(true);
        }
      } catch {}
    }
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(run);
  });
}

'''
    if anchor not in s:
        raise SystemExit("Could not find insertion anchor for jumpToEvidence helper")
    s = s.replace(anchor, helper + anchor, 1)

# Try to patch Jump button onClick
jump_patterns = [
    (
        r'onClick=\{\(\) => \{\s*try \{ jumpToEvidence\([^)]*\); \} catch \{\} \}\}',
        None
    ),
]

already_wired = "jumpToEvidence(" in s and re.search(r'onClick=\{\(\) => jumpToEvidence\(', s)

if not already_wired:
    replacements = [
        (
            r'onClick=\{\(\) => \{\s*try \{[^{}]*jumpToEvidence[^{}]*\} catch \{\}\s*\}\}',
            None
        ),
        (
            r'onClick=\{\(\) => \{\s*try \{[^{}]*\} catch \{\}\s*\}\}',
            'onClick={() => jumpToEvidence(item?.refId || item?.evidenceId || item?.ref || "", { open: false })}'
        ),
        (
            r'onClick=\{\(\) => [^}]*\}',
            None
        ),
    ]

    # More specific target: a button whose label is Jump
    m = re.search(
        r'(<button[^>]*\s+type="button"[^>]*)(onClick=\{[^}]*\})?([^>]*>\s*Jump\s*</button>)',
        s,
        re.S
    )
    if m:
        before, onclick, after = m.group(1), m.group(2), m.group(3)
        new_btn = before + 'onClick={() => jumpToEvidence(item?.refId || item?.evidenceId || item?.ref || "", { open: false })} ' + after
        s = s[:m.start()] + new_btn + s[m.end():]
    else:
        # fallback: any button containing Jump with multiline classnames
        m2 = re.search(
            r'(<button[\s\S]*?>\s*Jump\s*</button>)',
            s,
            re.S
        )
        if not m2:
            raise SystemExit("Could not find Jump button block to patch")
        block = m2.group(1)
        if "onClick=" in block:
            block2 = re.sub(
                r'onClick=\{[\s\S]*?\}',
                'onClick={() => jumpToEvidence(item?.refId || item?.evidenceId || item?.ref || "", { open: false })}',
                block,
                count=1
            )
        else:
            block2 = block.replace(
                "<button",
                '<button onClick={() => jumpToEvidence(item?.refId || item?.evidenceId || item?.ref || "", { open: false })}',
                1
            )
        s = s.replace(block, block2, 1)

incident_file.write_text(s)

# -------------------------
# Patch EvidenceLockerGrid.tsx
# -------------------------
g = grid_file.read_text()

if 'id={`evidence-${' not in g:
    # Try common wrappers first
    replaced = False

    wrapper_patterns = [
        r'(<div[^>]*className=\{[^}]*\}[^>]*>)',
        r'(<div[^>]*className="[^"]*"[^>]*>)',
        r'(<article[^>]*className=\{[^}]*\}[^>]*>)',
        r'(<article[^>]*className="[^"]*"[^>]*>)',
    ]

    # Look for a mapped block using ev
    map_anchor = re.search(r'\.map$begin:math:text$\\\(\\s\*\(ev\|item\)\\s\*\:\\s\*any\\s\*$end:math:text$\s*=>\s*\(', g)
    item_var = map_anchor.group(1) if map_anchor else "ev"

    # Find first wrapper after the map
    search_start = map_anchor.start() if map_anchor else 0
    sub = g[search_start:]

    for pat in wrapper_patterns:
        m = re.search(pat, sub, re.S)
        if m:
            original = m.group(1)
            if "data-evidence-id" in original or "id={`evidence-" in original:
                replaced = True
                break

            injected = original[:-1] + f' id={{`evidence-${{{item_var}.id || {item_var}.evidenceId || ""}}`}} data-evidence-id={{String({item_var}.id || {item_var}.evidenceId || "")}}>'
            sub = sub[:m.start()] + injected + sub[m.end():]
            g = g[:search_start] + sub
            replaced = True
            break

    if not replaced:
        raise SystemExit(f"Could not safely patch evidence wrapper in {grid_file}")

grid_file.write_text(g)

print("Patched:")
print(f" - {incident_file}")
print(f" - {grid_file}")
PY

echo
echo "== sanity checks =="
rg -n "function jumpToEvidence|Jump\\s*</button>|jumpToEvidence\\(" "$INCIDENT_FILE" || true
rg -n 'id=\{`evidence-\$\\{|data-evidence-id' "$GRID_FILE" || true

echo
echo "== restart next =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "${PIDS:-}" ]; then
  kill -9 $PIDS || true
fi

rm -rf "$ROOT/next-app/.next"

echo
echo "Patch complete."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
echo
echo "Then test:"
echo "  1) Open Timeline"
echo "  2) Click Jump"
echo "  3) Confirm it switches to Evidence and scrolls to the matching card"

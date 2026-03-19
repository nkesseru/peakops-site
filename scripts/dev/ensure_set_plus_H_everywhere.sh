#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "==> Ensuring set +H exists in all .sh scripts"

# Find candidate scripts (repo-wide)
mapfile -t FILES < <(find . -type f -name "*.sh" \
  -not -path "./node_modules/*" \
  -not -path "./next-app/node_modules/*" \
  -not -path "./.git/*" \
  -print)

patched=0
skipped=0

for f in "${FILES[@]}"; do
  # normalize path
  f="${f#./}"

  # skip non-regular
  [[ -f "$f" ]] || continue

  # if already contains the line, skip
  if rg -n "set \+H 2>/dev/null \|\| true" "$f" >/dev/null 2>&1; then
    ((skipped++)) || true
    continue
  fi

  cp "$f" "$f.bak_$(date +%Y%m%d_%H%M%S)"
  # Insert after shebang if present; else prepend
  if head -n 1 "$f" | rg -q "^#!"; then
    {
      head -n 1 "$f"
      echo 'set +H 2>/dev/null || true'
      tail -n +2 "$f"
    } > "$f.__tmp__"
  else
    {
      echo 'set +H 2>/dev/null || true'
      cat "$f"
    } > "$f.__tmp__"
  fi
  mv "$f.__tmp__" "$f"
  ((patched++)) || true
done

echo "✅ patched: $patched"
echo "↩️ skipped (already had it): $skipped"

#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "==> Ensuring: set +H 2>/dev/null || true in all .sh scripts (bash 3.2-safe)"

patched=0
skipped=0

find . -type f -name "*.sh" \
  -not -path "./node_modules/*" \
  -not -path "./next-app/node_modules/*" \
  -not -path "./.git/*" \
  -print | while IFS= read -r f; do
    f="${f#./}"
    [[ -f "$f" ]] || continue

    if rg -n "set \+H 2>/dev/null \|\| true" "$f" >/dev/null 2>&1; then
      skipped=$((skipped+1))
      continue
    fi

    cp "$f" "$f.bak_$(date +%Y%m%d_%H%M%S)"

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
    patched=$((patched+1))
  done

echo "✅ patched: $patched"
echo "↩️ skipped: $skipped"

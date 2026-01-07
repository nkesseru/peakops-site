#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

echo "==> searching for functions.config() usage"
MATCHES="$(rg -n "functions\.config\(" functions_clean | cat || true)"
if [ -z "${MATCHES}" ]; then
  echo "✅ no functions.config() found in functions_clean"
  exit 0
fi

echo "❌ found functions.config() calls:"
echo "$MATCHES"
echo
echo "==> patching: replace 'functions.config()' with '{}' (dev stub) so emulator doesn't crash"
# conservative: only replace exact token functions.config()
rg -l "functions\.config\(\)" functions_clean | while read -r f; do
  cp "$f" "$f.bak_no_config_$(date +%Y%m%d_%H%M%S)"
  perl -pi -e 's/functions\.config\(\)/({})/g' "$f"
  echo "✅ patched $f"
done

echo
echo "✅ done. Re-run your boot script."

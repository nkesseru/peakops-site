#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

warn() { echo "[doctor] WARN: $*"; }
ok() { echo "[doctor] OK: $*"; }

warn_count=0

check_warn() {
  warn "$1"
  warn_count=$((warn_count + 1))
}

if [[ -d app && -d next-app ]]; then
  check_warn "Both root app/ and next-app/ exist. Canonical frontend is next-app/."
else
  ok "Single frontend runtime path"
fi

if [[ -d functions && -d functions_clean ]]; then
  check_warn "Both functions/ and functions_clean/ exist. Canonical functions runtime is functions_clean/."
else
  ok "Single functions runtime path"
fi

for cfg in firebase.emu.json firebase.emu.min.json firebase.deploy.functions_clean.json next-app/firebase.json; do
  if [[ -f "$cfg" ]]; then
    check_warn "Alternate Firebase config present: $cfg (canonical is root firebase.json)"
  fi
done

src="$(jq -r '.functions.source // empty' firebase.json 2>/dev/null || true)"
if [[ "$src" != "functions_clean" ]]; then
  check_warn "firebase.json functions.source should be functions_clean (current: ${src:-<empty>})"
else
  ok "firebase.json functions.source=functions_clean"
fi

if [[ -f next-app/.env.local ]]; then
  base="$(awk -F= '/^NEXT_PUBLIC_FUNCTIONS_BASE=/{print $2}' next-app/.env.local | tail -n1 | tr -d '"' | tr -d "'" | xargs)"
  if [[ -z "$base" ]]; then
    check_warn "next-app/.env.local missing NEXT_PUBLIC_FUNCTIONS_BASE"
  elif [[ "$base" != http://127.0.0.1:* ]]; then
    check_warn "NEXT_PUBLIC_FUNCTIONS_BASE does not target localhost emulator: $base"
  else
    ok "NEXT_PUBLIC_FUNCTIONS_BASE set for local emulator"
  fi
else
  check_warn "next-app/.env.local missing"
fi

canonical_untracked="$(git ls-files --others --exclude-standard functions_clean next-app | wc -l | xargs)"
if [[ "$canonical_untracked" != "0" ]]; then
  check_warn "Untracked files exist inside canonical runtime folders (functions_clean/ or next-app/): $canonical_untracked"
else
  ok "No untracked files in canonical runtime folders"
fi

echo "[doctor] Completed with ${warn_count} warning(s)."
if [[ "$warn_count" -gt 0 ]]; then
  exit 2
fi

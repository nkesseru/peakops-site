#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

warn() { echo "[doctor] WARN: $*"; }
ok() { echo "[doctor] OK: $*"; }

strict=0
if [[ "${1:-}" == "--strict" ]]; then
  strict=1
fi

warn_count=0
duplicate_count=0
untracked_count=0

check_warn() {
  warn "$1"
  warn_count=$((warn_count + 1))
}

check_duplicate() {
  check_warn "$1"
  duplicate_count=$((duplicate_count + 1))
}

print_firebase_sources() {
  for cfg in firebase.json firebase.emu.json firebase.emu.min.json firebase.deploy.functions_clean.json next-app/firebase.json; do
    [[ -f "$cfg" ]] || continue
    local src
    src="$(jq -r '.functions.source // "<none>"' "$cfg" 2>/dev/null || echo "<parse-error>")"
    echo "[doctor] INFO: ${cfg} functions.source=${src}"
  done
}

if [[ -d app && -d next-app ]]; then
  check_duplicate "Both root app/ and next-app/ exist. Canonical frontend is next-app/."
  warn "Only next-app is supported. Do not run from app/."
else
  ok "Single frontend runtime path"
fi

if [[ -d functions && -d functions_clean ]]; then
  check_duplicate "Both functions/ and functions_clean/ exist. Canonical functions runtime is functions_clean/."
  print_firebase_sources
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
  untracked_count=$((untracked_count + canonical_untracked))
else
  ok "No untracked files in canonical runtime folders"
fi

echo "[doctor] Completed with ${warn_count} warning(s)."
if [[ "$strict" -eq 1 ]]; then
  if [[ "$duplicate_count" -gt 0 || "$untracked_count" -gt 0 ]]; then
    echo "[doctor] STRICT FAIL: duplicates=${duplicate_count}, canonical_untracked=${untracked_count}"
    exit 2
  fi
  echo "[doctor] STRICT PASS"
fi

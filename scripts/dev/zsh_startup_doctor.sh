#!/usr/bin/env bash
set -euo pipefail

USER_HOME="${HOME}"
FILES=(
  "$USER_HOME/.zshenv"
  "$USER_HOME/.zprofile"
  "$USER_HOME/.zshrc"
  "$USER_HOME/.zlogin"
  "$USER_HOME/.profile"
  "$USER_HOME/.bash_profile"
  "$USER_HOME/.bashrc"
)

default_shell="$(dscl . -read /Users/kesserumini UserShell 2>/dev/null | awk '{print $2}' || true)"
default_shell="${default_shell:-$SHELL}"

echo "[zsh-doctor] shell=${default_shell}"
echo "[zsh-doctor] zsh=$(zsh --version)"

echo "[zsh-doctor] startup files present:"
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] && echo "  - $f"
done

echo "[zsh-doctor] nvm-related lines:"
for f in "${FILES[@]}"; do
  [[ -f "$f" ]] || continue
  matches="$(nl -ba "$f" | rg -n 'nvm\.sh|bash_completion|NVM_DIR' || true)"
  [[ -n "$matches" ]] && { echo "--- $f"; echo "$matches"; }
done

trace_file="$(mktemp -t zsh_startup_trace.XXXXXX.log)"
PS4='+%N:%i> ' zsh -xlic 'echo TRACE_OK >/dev/null' 2> "$trace_file" || true

echo "[zsh-doctor] traced startup files (from zsh -xlic):"
rg -o '^\+[^>]*>' "$trace_file" | sed 's/^+//' | sed 's/>$//' | awk -F: '{print $1}' | rg '^/' | sort -u || true

echo "[zsh-doctor] trace saved: $trace_file"

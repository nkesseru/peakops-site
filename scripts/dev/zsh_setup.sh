#!/usr/bin/env zsh
set -euo pipefail

setopt interactivecomments
echo "[zsh-setup] interactivecomments enabled for this shell session."

if [[ -f "${HOME}/.zshrc" ]] && grep -q '^[[:space:]]*setopt[[:space:]]\+interactivecomments[[:space:]]*$' "${HOME}/.zshrc"; then
  echo "[zsh-setup] ~/.zshrc already contains: setopt interactivecomments"
else
  echo "[zsh-setup] To persist, run:"
  echo "echo 'setopt interactivecomments' >> ~/.zshrc"
fi

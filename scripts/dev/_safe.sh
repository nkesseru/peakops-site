#!/usr/bin/env bash
set -euo pipefail
# avoid zsh globbing pitfalls when someone runs via zsh
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

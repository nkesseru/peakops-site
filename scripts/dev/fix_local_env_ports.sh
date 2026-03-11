#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/next-app/.env.local"

say(){ echo "[fix-env] $*"; }
fail(){ echo "[fix-env] FAIL: $*" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || fail "Missing $ENV_FILE"

say "Patching $ENV_FILE to use Functions emulator on :5004 (not 5002)"

# Remove duplicate NEXT_PUBLIC_TECH_USER_ID lines (keep first occurrence)
awk '
  BEGIN { seenTech=0 }
  /^NEXT_PUBLIC_TECH_USER_ID=/ {
    if (seenTech==1) next
    seenTech=1
  }
  { print }
' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"

# Force ports to 5004 for any functions base settings used by the app
perl -0777 -pe '
  s/^FIREBASE_FUNCTIONS_EMULATOR_HOST=.*\n//mg;                        # remove (it fights you)
  s/^FN_BASE=.*\n//mg;                                                 # remove legacy
  s/^NEXT_PUBLIC_FUNCTIONS_BASE=.*\n//mg;
  s/^NEXT_PUBLIC_API_BASE=.*\n//mg;
  s/^NEXT_PUBLIC_ENV=.*/NEXT_PUBLIC_ENV=local/mg;
' -i "$ENV_FILE"

# Append canonical, single-source-of-truth values at end
cat >> "$ENV_FILE" <<'EOF'

# ---- Canonical local emulator wiring (DO NOT CHANGE) ----
NEXT_PUBLIC_ENV=local
GCLOUD_PROJECT=peakops-pilot
FIREBASE_PROJECT_ID=peakops-pilot

# Next app calls Functions via this base:
NEXT_PUBLIC_FUNCTIONS_BASE=http://127.0.0.1:5004/peakops-pilot/us-central1

# Your API proxy routes also use this base:
NEXT_PUBLIC_API_BASE=http://127.0.0.1:5004

# Convenience (optional)
NEXT_PUBLIC_TECH_USER_ID=tech_web
EOF

say "Done. Current relevant lines:"
grep -E "NEXT_PUBLIC_(FUNCTIONS_BASE|API_BASE|ENV)|GCLOUD_PROJECT|FIREBASE_PROJECT_ID|TECH_USER_ID" "$ENV_FILE" || true

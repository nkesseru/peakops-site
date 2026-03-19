#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
NEXT_DIR="$ROOT/next-app"
ENV_FILE="$NEXT_DIR/.env.local"
LOG_DIR="$ROOT/.logs"
NEXT_LOG="$LOG_DIR/next.log"

mkdir -p "$NEXT_DIR" "$LOG_DIR"

echo "==> Writing emulator env to $ENV_FILE"
cat > "$ENV_FILE" <<'EOF'
# Firebase Emulator (used by Next API routes)
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
FIREBASE_FUNCTIONS_EMULATOR_HOST=127.0.0.1:5001
FIRESTORE_EMULATOR_REST=http://127.0.0.1:8080
EOF

echo "----------------------------------"
cat "$ENV_FILE"
echo "----------------------------------"

echo "==> Killing anything on :3000"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -r kill -9 || true

echo "==> Clearing Next cache"
rm -rf "$NEXT_DIR/.next" 2>/dev/null || true

echo "==> Starting Next (logs -> $NEXT_LOG)"
# Start in background so your terminal doesn't get hijacked
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$NEXT_LOG" 2>&1 ) &

echo "==> Waiting for http://127.0.0.1:3000 to respond..."
for i in {1..80}; do
  if curl -fsS "http://127.0.0.1:3000/" >/dev/null 2>&1; then
    echo "✅ Next is up"
    break
  fi
  sleep 0.25
done

echo "==> Sanity: getZipVerificationV1 should return JSON"
curl -i "http://127.0.0.1:3000/api/fn/getZipVerificationV1?orgId=org_001&incidentId=inc_TEST" | head -n 30

echo
echo "✅ Done."
echo "Open:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo
echo "Logs:"
echo "  tail -n 200 $NEXT_LOG"

#!/usr/bin/env bash
set -euo pipefail

# zsh users: if you ever run this by copy/paste, this disables history expansion errors like: "event not found"
set +H 2>/dev/null || true

# 1) Find latest bundle zip
BUNDLE_ZIP="${1:-}"
if [[ -z "$BUNDLE_ZIP" ]]; then
  BUNDLE_ZIP="$(ls -t "$HOME/Downloads"/incident_*_bundle*.zip 2>/dev/null | head -n 1 || true)"
fi

if [[ -z "$BUNDLE_ZIP" || ! -f "$BUNDLE_ZIP" ]]; then
  echo "❌ Could not find bundle zip."
  echo "   Usage: bash scripts/dev/peek_bundle_packet_123.sh /path/to/bundle.zip"
  echo "   Or download one first (Download Bundle (ZIP)) so it appears in ~/Downloads"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
TMP="/tmp/peek_bundle_${TS}_$RANDOM"
mkdir -p "$TMP"

echo "==> (1) Using bundle:"
echo "   $BUNDLE_ZIP"
echo "   TMP=$TMP"
echo

# 2) Extract nested packet.zip
echo "==> (2) Extract nested packet.zip from bundle"
unzip -p "$BUNDLE_ZIP" packet.zip > "$TMP/packet.zip"

echo "==> packet.zip size:"
ls -lh "$TMP/packet.zip"
echo

# 3) Inspect packet contents
echo "==> (3) List packet contents (top 120)"
unzip -l "$TMP/packet.zip" | head -n 120
echo

echo "==> filings inside packet.zip"
unzip -l "$TMP/packet.zip" | grep -E '^ *[0-9]+ +[0-9-]+ +[0-9:]+ +filings/' || {
  echo "⚠️ No filings/ entries found in packet.zip"
}
echo

echo "==> Preview filings/index.json (first 120 lines)"
unzip -p "$TMP/packet.zip" filings/index.json 2>/dev/null | sed -n '1,120p' || echo "⚠️ missing filings/index.json"
echo

echo "==> Preview DIRS + OE417 heads (first 80 lines each)"
echo "--- filings/dirs.json ---"
unzip -p "$TMP/packet.zip" filings/dirs.json 2>/dev/null | sed -n '1,80p' || echo "⚠️ missing filings/dirs.json"
echo
echo "--- filings/oe417.json ---"
unzip -p "$TMP/packet.zip" filings/oe417.json 2>/dev/null | sed -n '1,80p' || echo "⚠️ missing filings/oe417.json"
echo

echo "==> Preview packet_meta.json + manifest.json heads"
echo "--- packet_meta.json ---"
unzip -p "$TMP/packet.zip" packet_meta.json 2>/dev/null | sed -n '1,120p' || echo "⚠️ missing packet_meta.json"
echo
echo "--- manifest.json (first 60) ---"
unzip -p "$TMP/packet.zip" manifest.json 2>/dev/null | sed -n '1,60p' || echo "⚠️ missing manifest.json"
echo

echo "✅ DONE"
echo "Artifacts:"
echo "  $TMP/packet.zip"
echo "  (bundle): $BUNDLE_ZIP"

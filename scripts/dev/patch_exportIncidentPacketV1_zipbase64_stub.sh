#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

CAND="$(rg -n --files-with-matches "exportIncidentPacketV1" functions_clean | head -n 1 || true)"
if [[ -z "${CAND}" ]]; then
  echo "❌ Could not find exportIncidentPacketV1 in functions_clean"
  exit 1
fi

FILE="$CAND"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"
echo "==> patching: $FILE"

python3 - <<'PY'
from pathlib import Path
import re, os

p = Path(os.environ["FILE"])
s = p.read_text()

# If it already returns zipBase64, do nothing.
if re.search(r"\bzipBase64\b", s):
    print("✅ zipBase64 already present (skipping)")
    raise SystemExit(0)

# Find the success send(res,200,{...packetMeta...}) block and add zipBase64 + filename.
m = re.search(r"send\(\s*res\s*,\s*200\s*,\s*\{([\s\S]{0,1200}?)\}\s*\)\s*;?", s)
if not m:
    raise SystemExit("❌ Could not find a send(res, 200, {...}) success response to patch")

blob = m.group(1)

# Ensure packetMeta exists in response (otherwise we’re patching the wrong send)
if "packetMeta" not in blob:
    raise SystemExit("❌ Found a success send(), but it doesn't include packetMeta; please patch manually or broaden search.")

# Inject after packetMeta
patched_blob = blob
if "packetMeta" in patched_blob and "zipBase64" not in patched_blob:
    # Add stub zipBase64 (a tiny valid empty zip is annoying; use a placeholder string for now)
    insert = """
    zipBase64: "", // TODO: generate real ZIP (manifest + hashes + payloads)
    filename: `incident_${incidentId}_packet.zip`,
"""
    # insert right after packetMeta line if possible
    patched_blob = re.sub(r"(packetMeta\s*:\s*[^,\n]+,?)", r"\1\n" + insert, patched_blob, count=1)

s2 = s[:m.start()] + f"send(res, 200, {{{patched_blob}}});" + s[m.end():]
p.write_text(s2)
print("✅ patched: exportIncidentPacketV1 now returns zipBase64 + filename (stub)")
PY

echo "✅ PATCH 2 DONE (stub zipBase64 added)"
echo "Next: replace zipBase64:\"\" with real ZIP generation."

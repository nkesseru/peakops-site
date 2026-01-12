#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak .logs

cp "$FILE" "scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: scripts/dev/_bak/downloadIncidentPacketZip_route_${TS}.ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

# ------------------------------------------------------------
# 0) Remove any corrupted AUTO_MANIFEST injection block
# ------------------------------------------------------------
s = re.sub(r"/\*__AUTO_MANIFEST_V1__\*/[\s\S]*?zip\.generateAsync\([^\)]*\);\s*", "", s)

# Also fix broken "const zipBytes = await \n zip.generateAsync(...)" patterns
s = re.sub(r"const\s+zipBytes\s*=\s*await\s*\n\s*zip\.generateAsync\(",
           "const zipBytes = await zip.generateAsync(",
           s, flags=re.M)

# ------------------------------------------------------------
# 1) Replace hashes+manifest array -> hashes + manifestFiles
#    (your file currently has: const manifest: {path...}[] = []; manifest.push(...))
# ------------------------------------------------------------
# Replace declaration block
s = re.sub(
    r"const\s+hashes:\s*Record<string,\s*string>\s*=\s*\{\};\s*\n\s*const\s+manifest:\s*\{\s*path:\s*string;\s*sha256:\s*string;\s*sizeBytes:\s*number\s*\}\[\]\s*=\s*\[\];",
    "const hashes: Record<string, string> = {};\n    const manifestFiles: { path: string; sha256: string; sizeBytes: number }[] = [];",
    s
)

# Replace manifest.push -> manifestFiles.push
s = s.replace("manifest.push({ path: f.path, sha256: h, sizeBytes: f.bytes.byteLength });",
              "manifestFiles.push({ path: f.path, sha256: h, sizeBytes: f.bytes.byteLength });")

# If some variants exist, normalize:
s = s.replace("manifest.push({", "manifestFiles.push({")

# ------------------------------------------------------------
# 2) Ensure structured filings stubs exist BEFORE hashes computed
#    We insert just BEFORE the comment "// hashes + manifest" (your file has it)
# ------------------------------------------------------------
filings_block = r'''
    // --- Filings folder (structured stubs) ---
    const filingStub = (kind: string) =>
      utf8(
        JSON.stringify(
          {
            kind,
            status: "NOT_GENERATED",
            generatedAt: null,
            reason: "Not wired yet (incident-based generation pending).",
          },
          null,
          2
        )
      );

    const filingPaths = [
      "filings/dirs.json",
      "filings/oe417.json",
      "filings/nors.json",
      "filings/sar.json",
      "filings/baba.json",
    ];

    // create each filing stub if missing
    for (const fp of filingPaths) {
      if (!files.some((x) => x.path === fp)) {
        const kind = fp.split("/")[1].replace(".json", "").toUpperCase();
        files.push({ path: fp, bytes: filingStub(kind) });
      }
    }

    // index.json registry
    if (!files.some((x) => x.path === "filings/index.json")) {
      files.push({
        path: "filings/index.json",
        bytes: utf8(
          JSON.stringify(
            {
              status: "NOT_GENERATED",
              generatedAt: null,
              files: filingPaths.map((x) => x.replace("filings/", "")),
              note: "This index becomes canonical once filings are wired.",
            },
            null,
            2
          )
        ),
      });
    }

'''

if "Filings folder (structured stubs)" not in s:
    s = re.sub(r"\s*// hashes \+ manifest \(computed before zip\)\s*\n", filings_block + "\n    // hashes + manifest (computed before zip)\n", s, count=1)

# ------------------------------------------------------------
# 3) Insert contractHash calculation and packet_meta improvements
#    We will compute contractHash from contract/contract.json if present
# ------------------------------------------------------------
# After packetHash line, inject contractHash+manifest object+packetMeta packetVersion
# First locate packetHash assignment line:
m = re.search(r'const\s+packetHash\s*=\s*sha256\(utf8\(JSON\.stringify\(hashes,\s*null,\s*2\)\)\)\);', s)
if not m:
    raise SystemExit("❌ Could not find packetHash line to anchor. Search for: const packetHash = sha256(utf8(JSON.stringify(hashes")

inject = r'''
    // --- Contract hash (locked input) ---
    const contractFile = files.find((f) => f.path === "contract/contract.json");
    const contractHash = contractFile ? sha256(contractFile.bytes) : null;

    const manifest = {
      packetVersion: "v1",
      generatedAt: nowIso,
      orgId,
      incidentId,
      contractId: contractId || null,
      packetHash,
      files: manifestFiles,
    };

'''

# Inject only if not already present
if "const contractHash" not in s:
    s = s[:m.end()] + "\n" + inject + s[m.end():]

# Replace packetMeta object to include packetVersion + contractHash + fileCount
# We’ll replace the whole packetMeta block if it matches the existing shape.
s = re.sub(
    r"const\s+packetMeta\s*=\s*\{\s*[\s\S]*?\};\s*",
    '''const packetMeta = {
      packetVersion: "v1",
      orgId,
      incidentId,
      contractId: contractId || null,
      contractHash,
      generatedAt: nowIso,
      packetHash,
      fileCount: files.length + 2, // +manifest +hashes
    };

''',
    s,
    count=1
)

# ------------------------------------------------------------
# 4) Replace the pushes for packet_meta/manifest/hashes to use new manifest object
# ------------------------------------------------------------
# Existing pushes:
# files.push(packet_meta)
# files.push(manifest.json) where manifest is array OR object
# files.push(hashes.json)
s = re.sub(
    r'files\.push\(\{\s*path:\s*"packet_meta\.json"[\s\S]*?\}\);\s*\n\s*files\.push\(\{\s*path:\s*"manifest\.json"[\s\S]*?\}\);\s*\n\s*files\.push\(\{\s*path:\s*"hashes\.json"[\s\S]*?\}\);\s*',
    'files.push({ path: "packet_meta.json", bytes: utf8(JSON.stringify(packetMeta, null, 2)) });\n    files.push({ path: "manifest.json", bytes: utf8(JSON.stringify(manifest, null, 2)) });\n    files.push({ path: "hashes.json", bytes: utf8(JSON.stringify(hashes, null, 2)) });\n',
    s,
    count=1
)

# ------------------------------------------------------------
# 5) Ensure zipBytes line is correct (single await generateAsync)
# ------------------------------------------------------------
s = re.sub(
    r"const\s+zipBytes\s*=\s*await\s*zip\.generateAsync\(\{\s*type:\s*\"uint8array\",\s*compression:\s*\"DEFLATE\"\s*\}\)\s*;",
    "const zipBytes = await zip.generateAsync({ type: \"uint8array\", compression: \"DEFLATE\" });",
    s
)

# If we have a dangling "const zipBytes = await" with nothing after, fix:
s = re.sub(
    r"const\s+zipBytes\s*=\s*await\s*\n\s*;",
    "const zipBytes = await zip.generateAsync({ type: \"uint8array\", compression: \"DEFLATE\" });\n",
    s
)

p.write_text(s)
print("✅ patched downloadIncidentPacketZip: manifestFiles + contractHash + filings stubs + manifest object + clean zipBytes")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke HEAD download"
DURL="http://127.0.0.1:3000/api/fn/downloadIncidentPacketZip?orgId=org_001&incidentId=inc_TEST&contractId=car_abc123"
curl -fsSI "$DURL" | head -n 25

echo
echo "==> verify zip contents include required files"
TMP="/tmp/packet_smoke_${TS}"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/packet.zip"
unzip -l "$TMP/packet.zip" | egrep "manifest\.json|hashes\.json|packet_meta\.json|filings/index\.json" || {
  echo "❌ required files missing in zip"
  unzip -l "$TMP/packet.zip" | head -n 60
  exit 1
}
echo "✅ zip contains manifest.json + hashes.json + packet_meta.json + filings/index.json"

echo
echo "✅ DONE"
echo "Open:"
echo "  http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"

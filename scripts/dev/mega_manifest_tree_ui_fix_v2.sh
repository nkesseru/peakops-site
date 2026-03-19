#!/usr/bin/env bash
set -euo pipefail
setopt NO_NOMATCH 2>/dev/null || true
set +H 2>/dev/null || true

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

PAGE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
test -f "$PAGE" || { echo "❌ missing: $PAGE"; exit 1; }

cp "$PAGE" "$PAGE.bak_manifestfix2_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_manifestfix2_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# 1) Fix JSX typo that breaks parsing / runtime
s = s.replace("{manifestItems.length > 0 && ( {", "{manifestItems.length > 0 && (")

# 2) Ensure JSZip import exists
if 'from "jszip"' not in s and "from 'jszip'" not in s:
    if re.search(r'^"use client";\s*$', s, flags=re.M):
        s = re.sub(r'^"use client";\s*$',
                   '"use client";\nimport JSZip from "jszip";',
                   s, count=1, flags=re.M)
    else:
        # fallback: top of file
        s = 'import JSZip from "jszip";\n' + s

# 3) Ensure manifest state exists (only if missing)
if "const [manifestBusy" not in s:
    m = re.search(r'const\s+\[packetMeta,\s*setPacketMeta\][^\n]*\n', s)
    if not m:
        m = re.search(r'const\s+\[[^\]]+\]\s*=\s*useState[^\n]*\n', s)
    if not m:
        raise SystemExit("❌ could not find insertion point for manifest state")

    insert_at = m.end()
    state_block = """
  const [manifestBusy, setManifestBusy] = useState(false);
  const [manifestErr, setManifestErr] = useState("");
  const [manifestItems, setManifestItems] = useState<{ path: string; bytes?: number; sha256?: string }[]>([]);
""".lstrip("\n")
    s = s[:insert_at] + state_block + s[insert_at:]

# 4) Inject loadManifestFromZip() if missing
if re.search(r'\basync function\s+loadManifestFromZip\b', s) is None:
    fn = r'''
  async function loadManifestFromZip() {
    if (manifestBusy || busyAction) return;
    setManifestBusy(true);
    setManifestErr("");
    try {
      // Fetch the packet ZIP
      const r = await fetch(packetZipUrl, { method: "GET" });
      if (!r.ok) throw new Error(`Download packet failed (HTTP ${r.status})`);

      const buf = await r.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);

      const manFile = zip.file("manifest.json");
      const hashFile = zip.file("hashes.json");
      if (!manFile) throw new Error("manifest.json not found in ZIP");
      if (!hashFile) throw new Error("hashes.json not found in ZIP");

      const manText = await manFile.async("string");
      const hashText = await hashFile.async("string");

      const man = JSON.parse(manText || "{}");
      const hashes = JSON.parse(hashText || "{}");

      // Normalize manifest files list
      let files = [];
      if (Array.isArray(man.files)) files = man.files;
      else if (Array.isArray(man.items)) files = man.items;
      else if (Array.isArray(man.manifest)) files = man.manifest;

      const out = [];
      for (const f of files) {
        const path = String((f && (f.path || f.name)) || "").trim();
        if (!path) continue;

        const bytes =
          (typeof f?.bytes === "number" && f.bytes) ? f.bytes :
          (typeof f?.size === "number" && f.size) ? f.size :
          (typeof hashes?.files?.[path]?.bytes === "number" ? hashes.files[path].bytes : undefined);

        const sha =
          (typeof f?.sha256 === "string" && f.sha256) ? f.sha256 :
          (typeof f?.hash === "string" && f.hash) ? f.hash :
          (typeof hashes?.files?.[path]?.sha256 === "string" ? hashes.files[path].sha256 : undefined);

        out.push({ path, bytes, sha256: sha });
      }

      out.sort((a,b) => a.path.localeCompare(b.path));
      setManifestItems(out);
      pushToast(`Loaded file tree: ${out.length} files ✅`, "ok");
    } catch (e: any) {
      setManifestItems([]);
      setManifestErr(String(e?.message || e));
      pushToast(String(e?.message || e), "err");
    } finally {
      setManifestBusy(false);
    }
  }
'''.lstrip("\n")

    # Insert right before return (
    m = re.search(r'\n\s*return\s*\(\s*\n', s)
    if not m:
        raise SystemExit("❌ Could not find 'return (' to insert loadManifestFromZip() before it.")
    s = s[:m.start()] + "\n" + fn + "\n" + s[m.start():]

# 5) Ensure the button calls the function reference (not a missing symbol)
s = re.sub(r'onClick=\{loadManifestFromZip\}', 'onClick={loadManifestFromZip}', s)
s = re.sub(r'onClick=\{loadManifestFromZip\s*\(\s*\)\s*\}', 'onClick={loadManifestFromZip}', s)

p.write_text(s)
print("✅ patched bundle page: fixed JSX + ensured JSZip + ensured loadManifestFromZip()")
PY

echo "🧹 clear Next cache + restart Next"
rm -rf next-app/.next 2>/dev/null || true
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke bundle page (should be 200)"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" | head -n 5

echo "✅ open bundle page:"
open -na "Google Chrome" "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "✅ Click: Load File Tree"

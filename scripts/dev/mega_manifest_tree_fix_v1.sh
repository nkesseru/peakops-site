#!/usr/bin/env bash
set -euo pipefail

# Make zsh safe for copy/paste scripts
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

PAGE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
test -f "$PAGE" || { echo "❌ missing: $PAGE"; exit 1; }

cp "$PAGE" "$PAGE.bak_manifest_tree_fix_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_manifest_tree_fix_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# 0) Fix the known broken JSX fragment: "{manifestItems.length > 0 && ( {"
s = s.replace("{manifestItems.length > 0 && ( {", "{manifestItems.length > 0 && (")

# 1) Ensure JSZip import exists (we need it for parsing ZIP client-side)
if re.search(r"from\s+['\"]jszip['\"]", s) is None:
    # Try to insert after the Link import if present, else after the first react import.
    if "from \"next/link\"" in s:
        s = s.replace('from "next/link";', 'from "next/link";\nimport JSZip from "jszip";', 1)
    elif "from 'next/link'" in s:
        s = s.replace("from 'next/link';", "from 'next/link';\nimport JSZip from 'jszip';", 1)
    else:
        # fallback: after first import line
        s = re.sub(r"(^import[^\n]*\n)", r"\1import JSZip from \"jszip\";\n", s, count=1, flags=re.M)

# 2) Inject state + function if missing
if "async function loadManifestFromZip" not in s and "function loadManifestFromZip" not in s:
    insert_block = r'''
  // --- File Tree (manifest + hashes inside the Packet ZIP) ---
  const [manifestBusy, setManifestBusy] = useState(false);
  const [manifestErr, setManifestErr] = useState("");
  const [manifestItems, setManifestItems] = useState<{ path: string; bytes: number; sha256?: string; ok?: boolean }[]>([]);

  async function loadManifestFromZip() {
    if (manifestBusy) return;
    setManifestBusy(true);
    setManifestErr("");
    try {
      const r = await fetch(packetZipUrl, { method: "GET" });
      if (!r.ok) throw new Error(`Packet ZIP fetch failed (HTTP ${r.status})`);
      const buf = await r.arrayBuffer();

      const zip = await (JSZip as any).loadAsync(buf);

      const manFile = zip.file("manifest.json");
      const hashFile = zip.file("hashes.json");
      if (!manFile) throw new Error("manifest.json not found in Packet ZIP");
      if (!hashFile) throw new Error("hashes.json not found in Packet ZIP");

      const manText = await manFile.async("string");
      const hashText = await hashFile.async("string");

      const man = JSON.parse(manText || "{}");
      const hashesRaw = JSON.parse(hashText || "{}");

      // normalize hashes into { [path]: sha256 }
      let hashMap: Record<string, string> = {};
      if (hashesRaw && typeof hashesRaw === "object") {
        if (Array.isArray((hashesRaw as any).files)) {
          for (const h of (hashesRaw as any).files) {
            const path = String(h?.path || h?.name || "").trim();
            const sha = String(h?.sha256 || h?.hash || "").trim();
            if (path && sha) hashMap[path] = sha;
          }
        } else {
          // assume direct map
          for (const k of Object.keys(hashesRaw)) {
            const v = (hashesRaw as any)[k];
            if (typeof v === "string") hashMap[String(k)] = v;
          }
        }
      }

      // normalize manifest array
      let files: any[] = [];
      if (Array.isArray((man as any).files)) files = (man as any).files;
      else if (Array.isArray((man as any).items)) files = (man as any).items;
      else if (Array.isArray((man as any).manifest)) files = (man as any).manifest;

      const out = [];
      for (const f of files) {
        const path = String(f?.path || f?.name || "").trim();
        if (!path) continue;
        const bytes = Number(f?.bytes ?? f?.size ?? 0) || 0;
        const sha = String(f?.sha256 || f?.hash || "").trim() || undefined;
        const ok = sha ? (hashMap[path] === sha) : undefined;
        out.push({ path, bytes, sha256: sha, ok });
      }
      out.sort((a, b) => a.path.localeCompare(b.path));
      setManifestItems(out);
    } catch (e: any) {
      setManifestErr(String(e?.message || e));
      setManifestItems([]);
    } finally {
      setManifestBusy(false);
    }
  }
  // --- /File Tree ---
'''.strip("\n") + "\n\n"

    # Insert before the main return (
    m = re.search(r"\n\s*return\s*\(\s*\n", s)
    if not m:
        raise SystemExit("❌ Could not find insertion point for loadManifestFromZip (no 'return (' found).")
    s = s[:m.start()] + "\n" + insert_block + s[m.start():]

# 3) Ensure the Files panel uses our handler (replace any placeholder alert)
# If you previously had an alert-based stub, replace it.
s = re.sub(
    r'onClick=\{\(\)\s*=>\s*alert\([^)]*\)\}',
    "onClick={loadManifestFromZip}",
    s
)

# Also if you have onClick={loadManifestFromZip} already, keep it.
# But make sure the button isn't referencing a different name:
s = s.replace("onClick={loadManifestFromZip}", "onClick={loadManifestFromZip}")

p.write_text(s)
print("✅ manifest tree handler/state + JSZip import ensured")
PY

echo "🧹 clearing next cache"
rm -rf next-app/.next 2>/dev/null || true

echo "🚀 restarting next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke bundle page"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" | head -n 5

echo "✅ open bundle page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "✅ Click: Load File Tree"

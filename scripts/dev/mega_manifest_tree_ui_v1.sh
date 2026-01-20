#!/usr/bin/env bash
set -euo pipefail
setopt NO_NOMATCH 2>/dev/null || true
set +H 2>/dev/null || true

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

PAGE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
test -f "$PAGE" || { echo "❌ missing: $PAGE"; exit 1; }

cp "$PAGE" "$PAGE.bak_manifesttree_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_manifesttree_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()
if 'from "jszip"' not in s and "JSZip" not in s:
    if re.search(r'^"use client";\s*$', s, flags=re.M):
        s = re.sub(r'^"use client";\s*$', '"use client";\nimport JSZip from "jszip";', s, count=1, flags=re.M)
    else:
        # fallback: top of file
        s = 'import JSZip from "jszip";\n' + s

if "manifestItems" not in s:
    m = re.search(r'const\s+\[packetMeta,\s*setPacketMeta\][^\n]*\n', s)
    if not m:
        # fallback: after first useState
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
if "async function loadManifestFromZip" not in s:
    # Insert after loadPacketMeta() if present, else after other helpers near top
    anchor = re.search(r'async function loadPacketMeta\(\)\s*\{[\s\S]*?\n  }\n', s)
    if not anchor:
        anchor = re.search(r'function pushToast\([^\)]*\)\s*\{[\s\S]*?\n  }\n', s)
    if not anchor:
        raise SystemExit("❌ could not find insertion point for loadManifestFromZip()")

    insert_at = anchor.end()

    fn = r'''
  async function loadManifestFromZip() {
    setManifestBusy(true);
    setManifestErr("");
    try {
      // download the canonical packet ZIP (same URL your download button uses)
      const r = await fetch(packetZipUrl, { method: "GET" });
      if (!r.ok) throw new Error(`Download packet ZIP failed (HTTP ${r.status})`);

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

      // normalize manifest arrays: { files:[...] } OR { items:[...] } OR direct array
      const files =
        Array.isArray(man?.files) ? man.files :
        Array.isArray(man?.items) ? man.items :
        Array.isArray(man) ? man :
        [];

      function pickHash(path: string): string {
        const direct = hashes?.[path];
        if (typeof direct === "string") return direct;
        const f1 = hashes?.files?.[path];
        if (typeof f1 === "string") return f1;
        const f2 = hashes?.hashes?.[path];
        if (typeof f2 === "string") return f2;
        return "";
      }

      const out: { path: string; bytes?: number; sha256?: string }[] = [];
      for (const f of files) {
        const path = String(f?.path || f?.name || "").trim();
        if (!path) continue;
        const bytes =
          (typeof f?.bytes === "number") ? f.bytes :
          (typeof f?.size === "number") ? f.size :
          undefined;
        const sha =
          (typeof f?.sha256 === "string" && f.sha256) ? f.sha256 :
          (typeof f?.hash === "string" && f.hash) ? f.hash :
          pickHash(path);

        out.push({ path, bytes, sha256: sha || undefined });
      }

      out.sort((a,b) => a.path.localeCompare(b.path));
      setManifestItems(out);
      pushToast(`Loaded file tree: ${out.length} files`, "ok");
    } catch (e: any) {
      setManifestItems([]);
      setManifestErr(String(e?.message || e));
      pushToast(String(e?.message || e), "err");
    } finally {
      setManifestBusy(false);
    }
  }
'''.lstrip("\n")

    s = s[:insert_at] + "\n" + fn + "\n" + s[insert_at:]

if "Load File Tree" not in s:
    ui = r'''
      <div style={{ marginTop: 14, border: "1px solid #1f2937", borderRadius: 12, padding: 16 }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Files (from manifest)</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={loadManifestFromZip} disabled={manifestBusy || !!busyAction} style={btn(false)}>
            {manifestBusy ? "Loading…" : "Load File Tree"}
          </button>
          {manifestErr && <span style={{ color: "#ff8a8a", fontSize: 12 }}>{manifestErr}</span>}
        </div>

        {manifestItems.length > 0 && (
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.9 }}>
            {manifestItems.map((it) => (
              <div key={it.path} style={{ display: "flex", gap: 10, padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <span style={{ minWidth: 360 }}>{it.path}</span>
                <span style={{ opacity: 0.7 }}>{typeof it.bytes === "number" ? `${it.bytes} B` : ""}</span>
                <span style={{ opacity: 0.55, marginLeft: "auto" }}>{it.sha256 ? it.sha256.slice(0, 16) + "…" : ""}</span>
              </div>
            ))}
          </div>
        )}
      </div>
'''.lstrip("\n")

    # Insert before Back link area (existing pattern in your file)
    m = re.search(r'\n\s*<div style=\{\{ marginTop: 16[^\n]*\}\}>\s*\n\s*<Link href=', s)
    if not m:
        m = re.search(r'\n\s*<div style=\{\{ marginTop: 14, fontSize: 12, opacity: 0\.75 \}\}>\s*\n\s*<Link href=', s)
    if not m:
        # fallback: before final wrapper close
        m = re.search(r'\n\s*</div>\s*\n\s*\);\s*\n\s*}\s*$', s, flags=re.M)
        if not m:
            raise SystemExit("❌ could not find insertion point for Files panel")
        insert_at = m.start()
        s = s[:insert_at] + "\n" + ui + "\n" + s[insert_at:]
    else:
        insert_at = m.start()
        s = s[:insert_at] + "\n" + ui + s[insert_at:]
s = s.replace("loadManifestFromZip()", "loadManifestFromZip()")

p.write_text(s)
print("✅ bundle page patched: loadManifestFromZip + Load File Tree panel")
PY

echo "🧹 clearing Next cache"
rm -rf next-app/.next 2>/dev/null || true

echo "🚀 restart Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ open bundle page:"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "✅ Click: Load File Tree"

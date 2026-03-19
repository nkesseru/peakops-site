#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true
setopt NO_NOMATCH 2>/dev/null || true

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

PAGE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
test -f "$PAGE" || { echo "❌ missing: $PAGE"; exit 1; }

cp "$PAGE" "$PAGE.bak_fix_verify_zip_ui_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup saved: $PAGE.bak_fix_verify_zip_ui_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# 1) Ensure we have a sha256 helper (browser WebCrypto)
if "async function sha256Hex(" not in s:
    helper = r'''
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  // WebCrypto SHA-256
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
'''.lstrip("\n")

    # Insert helper near other helpers (after pushToast if present, else near top)
    m = re.search(r'function\s+pushToast\([^)]*\)\s*\{[\s\S]*?\n\}', s)
    if m:
        insert_at = m.end()
        s = s[:insert_at] + "\n\n" + helper + "\n" + s[insert_at:]
    else:
        s = helper + "\n" + s

# 2) Replace handleVerifyZip with a deterministic implementation
replacement = r'''
async function handleVerifyZip() {
  if (busyAction) return;
  try {
    setBusyAction("verify");
    pushToast("Verifying ZIP…", "ok");

    // Download the packet ZIP and compare sha256 with server header
    const r = await fetch(packetZipUrl, { method: "GET" });
    if (!r.ok) throw new Error(`Verify ZIP failed (HTTP ${r.status})`);

    const expected = (r.headers.get("x-peakops-zip-sha256") || "").trim().toLowerCase();
    if (!expected) throw new Error("Verify ZIP failed: missing x-peakops-zip-sha256 header");

    const buf = await r.arrayBuffer();
    const actual = (await sha256Hex(buf)).trim().toLowerCase();

    if (actual !== expected) {
      throw new Error(`SHA256 mismatch (expected ${expected.slice(0,12)}…, got ${actual.slice(0,12)}…)`);
    }

    pushToast("ZIP verified ✅ (sha256 matches)", "ok");
  } catch (e: any) {
    pushToast(`ZIP verification FAILED: ${String(e?.message || e)}`, "err");
  } finally {
    setBusyAction("");
  }
}
'''.lstrip("\n")

# Match any existing handleVerifyZip block (a few variants)
pat = re.compile(r'async\s+function\s+handleVerifyZip\s*\(\)\s*\{[\s\S]*?\n\}', re.M)
if pat.search(s):
    s = pat.sub(replacement, s, count=1)
else:
    # If it doesn't exist, inject it near other handlers (handleDownload etc.)
    anchor = re.search(r'async\s+function\s+handleDownload\s*\([^)]*\)\s*\{', s)
    if not anchor:
        raise SystemExit("❌ Could not find insertion point (handleDownload).")
    # Insert just before handleDownload
    s = s[:anchor.start()] + replacement + "\n\n" + s[anchor.start():]

p.write_text(s)
print("✅ patched bundle page: handleVerifyZip now computes sha256 correctly (no undefined variable)")
PY

echo "🧹 clearing Next cache"
rm -rf next-app/.next 2>/dev/null || true

echo "🚀 restarting Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ open bundle page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" || true

echo "✅ Now click: Verify ZIP (should go green)"

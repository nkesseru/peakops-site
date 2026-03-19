#!/usr/bin/env bash
set -euo pipefail
setopt NO_NOMATCH 2>/dev/null || true
set +H 2>/dev/null || true

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

ZIP_ROUTE="next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
BUNDLE_PAGE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"

test -f "$ZIP_ROUTE" || { echo "❌ missing $ZIP_ROUTE"; exit 1; }
test -f "$BUNDLE_PAGE" || { echo "❌ missing $BUNDLE_PAGE"; exit 1; }

cp "$ZIP_ROUTE"  "$ZIP_ROUTE.bak_zipstable_$(date +%Y%m%d_%H%M%S)"
cp "$BUNDLE_PAGE" "$BUNDLE_PAGE.bak_verifyatomic_$(date +%Y%m%d_%H%M%S)"
echo "✅ backups saved"

python3 - <<'PY'
from pathlib import Path
import re

# -------------------------
# 1) Make ZIP deterministic
# -------------------------
p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

# A) Prefer incident.packetMeta.exportedAt (or stored export time) as generatedAt for packet_meta.json
# We look for "const nowIso" / "generatedAt: nowIso" and replace with "generatedAt: exportedAtIso"
# exportedAtIso should come from incident packetMeta if available, otherwise fallback to nowIso.
if "exportedAtIso" not in s:
  # Insert near where incident/packetMeta is known (best-effort: right after nowIso).
  s = re.sub(
    r'(const\s+nowIso\s*=\s*[^;\n]+;)',
    r'\1\n  const exportedAtIso = (incident as any)?.packetMeta?.exportedAt || nowIso;',
    s,
    count=1
  )

# Replace generatedAt: nowIso -> generatedAt: exportedAtIso
s, n_ga = re.subn(r'generatedAt:\s*nowIso', 'generatedAt: exportedAtIso', s)

# B) Ensure zip file insertion order is stable (sort paths before zip.file)
# Look for "for (const f of files) zip.file" and wrap with sorting by path.
if "filesSortedForZip" not in s:
  s = re.sub(
    r'(\s*const\s+zip\s*=\s*new\s+JSZip\(\);\s*\n)(\s*for\s*\(const\s+f\s+of\s+files\)\s+zip\.file\(f\.path,\s*f\.bytes\);\s*\n)',
    r'\1  const filesSortedForZip = [...files].sort((a,b) => a.path.localeCompare(b.path));\n\2'.replace(
      'for (const f of files)', 'for (const f of filesSortedForZip)'
    ),
    s,
    count=1
  )

p.write_text(s)

# -------------------------
# 2) Make Verify ZIP atomic
# -------------------------
p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# We enforce: Verify uses a single GET packetZipUrl and compares computed sha to SAME response header.
# We'll create/replace handleVerifyZip with a known-good version.
# Find existing handler start:
m = re.search(r'async function handleVerifyZip\(\)\s*\{', s)
if not m:
  raise SystemExit("❌ Could not find handleVerifyZip() in bundle page")

# naive block replace: from handleVerifyZip() { ... } (balanced by simple heuristic to next "\n}\n" at same indent)
start = m.start()
# find next "\n  }\n" or "\n}\n" after start (best effort)
end = s.find("\n  }\n", start)
if end == -1:
  end = s.find("\n}\n", start)
if end == -1:
  raise SystemExit("❌ Could not locate end of handleVerifyZip()")

replacement = r'''
async function handleVerifyZip() {
  if (busyAction) return;
  try {
    setBusyAction("verify");
    pushToast("Verifying ZIP…", "ok");

    // Single GET so headers + bytes are from the SAME response
    const r = await fetch(packetZipUrl, { method: "GET", cache: "no-store" });
    if (!r.ok) throw new Error(`Verify ZIP failed (HTTP ${r.status})`);

    const expected = (r.headers.get("x-peakops-zip-sha256") || "").trim();
    if (!expected) throw new Error("Verify ZIP failed: server did not send x-peakops-zip-sha256");

    const buf = new Uint8Array(await r.arrayBuffer());
    const actual = sha256(buf);

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
'''.strip("\n")

s2 = s[:start] + replacement + s[end+4:]  # +4 to drop closing "  }\n"
p.write_text(s2)
PY

echo "🧹 clear Next cache"
rm -rf next-app/.next 2>/dev/null || true

echo "🚀 restart Next"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ smoke bundle page"
curl -I -sS "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001" | head -n 5

echo "✅ open bundle page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"

echo
echo "NEXT STEP:"
echo "1) Click Generate Packet (once)"
echo "2) Click Verify ZIP (should now be stable)"

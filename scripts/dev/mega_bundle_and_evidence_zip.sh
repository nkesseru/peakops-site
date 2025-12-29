#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

echo "==> 0) sanity"
test -f functions_clean/index.mjs || { echo "❌ missing functions_clean/index.mjs"; exit 1; }
test -f "next-app/src/app/admin/incidents/[id]/page.tsx" || { echo "❌ missing incident page"; exit 1; }

###############################################################################
# 1) functions_clean: add canonical getIncidentBundle + exportEvidenceLockerZip #
###############################################################################
echo "==> 1) Patch functions_clean/index.mjs"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("functions_clean/index.mjs")
s = p.read_text()

# Ensure imports
def ensure_import(line, must_contain):
    global s
    if must_contain in s:
        return
    # insert after first import block
    m = re.search(r'^(import .*?;\s*\n)+', s, flags=re.M)
    if not m:
        raise SystemExit("Cannot find import block in index.mjs")
    s = s[:m.end()] + line + "\n" + s[m.end():]

ensure_import('import crypto from "crypto";', 'import crypto')
ensure_import('import JSZip from "jszip";', 'import JSZip')
ensure_import('', 'getFirestore')  # likely already present

# Helper functions (only once)
helpers = r'''
function _stableSortKeys(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(_stableSortKeys);
  if (typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = _stableSortKeys(obj[k]);
    return out;
  }
  return obj;
}
function _stableStringify(obj) { return JSON.stringify(_stableSortKeys(obj), null, 2); }
function _sha256Hex(bufOrStr) {
  const b = (typeof bufOrStr === "string") ? Buffer.from(bufOrStr, "utf8") : Buffer.from(bufOrStr);
  return crypto.createHash("sha256").update(b).digest("hex");
}
'''
if "_stableStringify" not in s:
    # insert near top after hello (safe)
    m = re.search(r'export const hello\s*=\s*onRequest\([\s\S]*?\);\s*', s)
    ins = m.end() if m else 0
    s = s[:ins] + "\n\n" + helpers + "\n" + s[ins:]

# Canonical getIncidentBundle handler (always ok:true with defaults)
bundle_handler = r'''
export const getIncidentBundle = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    if (!orgId || !incidentId) return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });

    const db = getFirestore();
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();

    const incident = incSnap.exists ? ({ id: incSnap.id, ...(incSnap.data() || {}) }) : ({ id: incidentId, orgId });
    const filingsMeta = incident?.filingsMeta ?? null;
    const timelineMeta = incident?.timelineMeta ?? null;

    const filingsSnap = await incRef.collection("filings").get().catch(() => ({ docs: [] }));
    const filings = (filingsSnap.docs || []).map(d => ({ id: d.id, ...(d.data() || {}) }));

    // timeline events (optional)
    let timelineEvents = [];
    try {
      const tSnap = await incRef.collection("timeline_events").orderBy("createdAt","asc").limit(200).get();
      timelineEvents = tSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    } catch {}

    // logs (optional). Keep safe defaults.
    const logs = { system: [], user: [], filing: [] };

    return res.json({
      ok: true,
      orgId,
      incidentId,
      incident,
      filings,
      filingsMeta,
      timelineMeta,
      timelineEvents,
      logs,
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});
'''
# Replace existing getIncidentBundle if present, else append
if "export const getIncidentBundle" in s:
    s = re.sub(r'export const getIncidentBundle\s*=\s*onRequest\([\s\S]*?\n\}\);\n', bundle_handler + "\n", s, flags=re.M)
else:
    s = s.rstrip() + "\n\n" + bundle_handler + "\n"

# Evidence ZIP export function
export_zip = r'''
export const exportEvidenceLockerZip = onRequest(async (req, res) => {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok:false, error:"Use GET" });

    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));

    if (!orgId || !incidentId) return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });

    const db = getFirestore();
    const col = db.collection("incidents").doc(incidentId).collection("evidence_locker");
    const snap = await col.orderBy("storedAt","asc").limit(limit).get();

    const docs = snap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

    // Build deterministic zip
    const zip = new JSZip();
    const manifest = {
      orgId,
      incidentId,
      generatedAt: new Date().toISOString(),
      count: docs.length,
      files: [],
    };

    const hashes = {};
    const folder = zip.folder("evidence");

    for (const d of docs) {
      const kind = String(d.kind || "UNKNOWN");
      const filingType = String(d.filingType || "UNKNOWN");
      const storedAt = d.storedAt?.toDate?.() ? d.storedAt.toDate().toISOString() : (d.storedAt? String(d.storedAt): "");
      const name = `${storedAt.replace(/[:.]/g,"-")}_${filingType}_${kind}_${d.id}.json`;

      const content = _stableStringify(d);
      const h = _sha256Hex(content);

      hashes[`evidence/${name}`] = h;
      folder.file(name, content);

      manifest.files.push({
        path: `evidence/${name}`,
        filingType,
        kind,
        storedAt,
        hash: h,
        bytes: Buffer.byteLength(content, "utf8"),
      });
    }

    const manifestJson = _stableStringify(manifest);
    hashes["manifest.json"] = _sha256Hex(manifestJson);
    zip.file("manifest.json", manifestJson);

    const hashesJson = _stableStringify(hashes);
    const packetHash = _sha256Hex(hashesJson);
    zip.file("hashes.json", hashesJson);

    zip.file("README.txt", [
      "PeakOps Evidence Locker Export (ZIP)",
      `orgId: ${orgId}`,
      `incidentId: ${incidentId}`,
      `count: ${docs.length}`,
      `packetHash: ${packetHash}`,
      "",
      "Includes deterministic JSON + per-file SHA256 hashes.",
    ].join("\\n"));

    const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const b64 = buf.toString("base64");
    const filename = `peakops_evidence_${incidentId}_${orgId}_${new Date().toISOString().replace(/[:.]/g,"-")}_${packetHash.slice(0,8)}.zip`;

    return res.json({
      ok: true,
      orgId,
      incidentId,
      count: docs.length,
      packetHash,
      filename,
      sizeBytes: buf.length,
      zipBase64: b64,
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});
'''
if "export const exportEvidenceLockerZip" not in s:
    s = s.rstrip() + "\n\n" + export_zip + "\n"

p.write_text(s)
print("✅ functions_clean/index.mjs patched (bundle + evidence zip)")
PY

echo "==> 2) Next API route proxy: /api/fn/exportEvidenceLockerZip"
mkdir -p next-app/src/app/api/fn/exportEvidenceLockerZip

cat > next-app/src/app/api/fn/exportEvidenceLockerZip/route.ts <<'TS'
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "";
  const incidentId = url.searchParams.get("incidentId") || "";
  const limit = url.searchParams.get("limit") || "200";

  const base = process.env.NEXT_PUBLIC_PEAKOPS_FN_BASE || "";
  if (!base) {
    return NextResponse.json({ ok:false, error:"NEXT_PUBLIC_PEAKOPS_FN_BASE not set" }, { status: 500 });
  }
  if (!orgId || !incidentId) {
    return NextResponse.json({ ok:false, error:"Missing orgId/incidentId" }, { status: 400 });
  }

  const upstream = `${base}/exportEvidenceLockerZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=${encodeURIComponent(limit)}`;
  const r = await fetch(upstream);
  const j = await r.json().catch(() => ({}));
  return NextResponse.json(j, { status: r.ok ? 200 : r.status });
}
TS

echo "==> 3) UI: add Download Evidence ZIP button (best-effort patch)"
PAGE='next-app/src/app/admin/incidents/[id]/page.tsx'
python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

if "downloadEvidenceZip" not in s:
    # Insert helper function near loadEvidenceLocker
    m = re.search(r'const\s+loadEvidenceLocker\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*;\s*', s, flags=re.M)
    if not m:
        raise SystemExit("Could not find loadEvidenceLocker to anchor downloadEvidenceZip insert")

    insert = r'''

  const downloadEvidenceZip = async () => {
    try {
      if (!orgId || !incidentId) return;
      const r = await fetch(`/api/fn/exportEvidenceLockerZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=200`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "exportEvidenceLockerZip failed");

      const b64 = String(j.zipBase64 || "");
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: "application/zip" });

      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = j.filename || `evidence_${incidentId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setBanner(`✅ Evidence ZIP downloaded (${j.count || 0} items)`);
    } catch (e:any) {
      console.error(e);
      setBanner(`❌ Evidence ZIP export failed: ${String(e?.message || e)}`);
    }
  };
'''
    s = s[:m.end()] + insert + s[m.end():]

# Add button into Evidence Locker panel header (insert after Refresh Evidence button)
s = s.replace(
    '{busyEvidence ? "Loading…" : "Refresh Evidence"}',
    '{busyEvidence ? "Loading…" : "Refresh Evidence"}\n            </Button>\n            <Button disabled={busyEvidence || (evidenceCount||0)===0} onClick={downloadEvidenceZip}>Download ZIP</Button>\n            <Button'
)

p.write_text(s)
print("✅ Incident page patched with Download ZIP button")
PY

echo "==> 4) Restart dev env"
bash scripts/dev/dev-down.sh 2>/dev/null || true
bash scripts/dev/dev-up.sh

echo "✅ Done."
echo "Test:"
echo "  Open incident: http://localhost:3000/admin/incidents/inc_b7u8e7ur?orgId=org_001"
echo "  Click: Refresh Evidence -> Download ZIP"

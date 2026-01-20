#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()
orig = s
if "function safeJson(" not in s and "function safeParseJson(" not in s:
    insert_after = re.search(r'function\s+writeLocal\([^)]*\)\s*\{[\s\S]*?\}\n', s)
    if not insert_after:
        raise SystemExit("❌ Could not find writeLocal() to anchor helper injection.")
    helper = """
function safeJson(text: string): { ok: true; v: any } | { ok: false; err: string } {
  try { return { ok: true, v: JSON.parse(text) }; }
  catch (e: any) { return { ok: false, err: String(e?.message || e) }; }
}
"""
    s = s[:insert_after.end()] + helper + s[insert_after.end():]

if "const [meta" not in s:
    m = re.search(r'const\s+\[wf,\s*setWf\]\s*=\s*useState<[^>]+>\([^)]*\);\s*', s)
    if not m:
        raise SystemExit("❌ Could not find wf state to anchor meta injection.")
    s = s[:m.end()] + "\n  const [meta, setMeta] = useState<any>(null);\n" + s[m.end():]

if "const exportReady" not in s:
    m = re.search(r'const\s+donePct\s*=\s*percentDone\(steps\);\s*', s)
    if not m:
        # fallback: insert after localStatus function or after setStatus
        m = re.search(r'function\s+setStatus\([^)]*\)\s*\{[\s\S]*?\}\n', s)
    if not m:
        raise SystemExit("❌ Could not find anchor for readiness booleans.")
    insert = (
        "\n  const exportReady = !!(meta?.packetMeta && (meta.packetMeta?.packetHash || meta.packetMeta?.hash) && Number(meta.packetMeta?.sizeBytes || 0) > 0);\n"
    )
    s = s[:m.end()] + insert + s[m.end():]
if "async function exportNow(" not in s:
    # anchor: after load() function (first occurrence)
    m = re.search(r'async\s+function\s+load\(\)\s*\{[\s\S]*?\n\s*\}\n', s)
    if not m:
        raise SystemExit("❌ Could not find load() to anchor exportNow().")

    handler = """
  async function exportNow() {
    setBusy(true);
    setErr("");
    try {
      const url =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}` +
        `&limit=200`;

      const r = await fetch(url, { method: "GET" });
      const text = await r.text();
      if (!text || !text.trim()) throw new Error(`Export API returned empty body (HTTP ${r.status})`);

      const parsed = (typeof safeParseJson === "function")
        ? safeParseJson(text)
        : (typeof safeJson === "function" ? safeJson(text) : { ok:false, err:"No JSON parser helper" });

      if (!(parsed as any).ok) {
        const sample = text.slice(0, 120).replace(/\\s+/g, " ");
        throw new Error(`Export API returned non-JSON (HTTP ${r.status}): ${(parsed as any).error || (parsed as any).err} — ${sample}`);
      }

      const j = (parsed as any).value ?? (parsed as any).v;
      if (j?.ok === false) throw new Error(String(j?.error || "exportIncidentPacketV1 failed"));

      // Merge any returned packetMeta into meta so exportReady can flip immediately
      setMeta((m: any) => ({ ...(m || {}), ...(j || {}), packetMeta: j?.packetMeta || (m?.packetMeta) || null }));

      // Refresh workflow/meta from backend
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
"""
    s = s[:m.end()] + handler + s[m.end():]
inject_pat = re.compile(r'(\{s\.hint\s*&&\s*<div[^>]*>[\s\S]*?</div>\}\s*)', re.M)
if inject_pat.search(s) and "exportNow" in s and "Export Packet" not in s:
    ui = r"""\1
                {String(s.key) === "export" && (
                  <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <button
                      style={pill(false)}
                      onClick={exportNow}
                      disabled={busy}
                      title="Generate the immutable packet + hashes (read-only export)"
                    >
                      {busy ? "Exporting…" : "Export Packet"}
                    </button>

                    {exportReady && (
                      <span style={{ fontSize: 12, opacity: 0.8 }}>
                        ✅ packetMeta present
                      </span>
                    )}
                  </div>
                )}
"""
    s = inject_pat.sub(ui, s, count=1)
if "setMeta(" not in orig:
    pass

if "const workflow" in s and "setMeta(j)" not in s:
    s = re.sub(
        r'(const\s+workflow:\s*Workflow\s*=\s*j\?\.\s*workflow\s*\|\|\s*\{\}\s*;\s*\n\s*setWf\(workflow\);\s*)',
        r'\1\n      setMeta(j);\n',
        s,
        count=1
    )

if s == orig:
    print("⚠️ No changes made — patch may already be applied or file differs. Search for 'Export Packet' in the file.")
else:
    p.write_text(s)
    print("✅ patched GuidedWorkflowPanel: added Step 4 Export button + exportNow()")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page loads" \
  || { echo "❌ still failing"; tail -n 180 .logs/next.log; exit 1; }

echo "✅ DONE"

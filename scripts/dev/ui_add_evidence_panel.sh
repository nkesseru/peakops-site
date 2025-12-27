#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true   # disable history expansion (zsh safety)

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

python3 - <<'PY'
from pathlib import Path
p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Guard: only add once
if "Evidence Locker" in s and "loadEvidenceLocker" in s:
    print("✅ Evidence Locker panel already exists. Skipping.")
    raise SystemExit(0)
anchor = "const [timelineEvents, setTimelineEvents]"
state_block = """const [evidenceDocs, setEvidenceDocs] = useState<any[]>([]);
  const [evidenceErr, setEvidenceErr] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState<Record<string, boolean>>({});
"""
if anchor in s and state_block not in s:
    s = s.replace(anchor, state_block + "  " + anchor, 1)
if "async function loadEvidenceLocker()" not in s:
    jfetch_anchor = "async function jfetch(url: string)"
    if jfetch_anchor in s:
        insert_at = s.find("}\n\n", s.find(jfetch_anchor))
        insert_at = insert_at + 3 if insert_at != -1 else -1
        if insert_at == -1:
            raise SystemExit("❌ could not find insertion point after jfetch")
        loader = """
  async function loadEvidenceLocker() {
    try {
      setEvidenceErr(null);
      const j = await jfetch(`/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=25`);
      if (!j || j.ok !== true) throw new Error(j?.error || "listEvidenceLocker failed");
      setEvidenceDocs(Array.isArray(j.docs) ? j.docs : (Array.isArray(j.items) ? j.items : []));
    } catch (e: any) {
      setEvidenceErr(e?.message || String(e));
      setEvidenceDocs([]);
    }
  }
"""
        s = s[:insert_at] + loader + s[insert_at:]
    else:
        raise SystemExit("❌ could not find jfetch() in file")
panel = r"""
      <div style={{ marginTop: 16 }}>
        <PanelCard title="Evidence Locker">
          <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center", marginBottom:10 }}>
            <Button disabled={!!busy} onClick={loadEvidenceLocker}>Refresh Evidence</Button>
            <div style={{ fontSize:12, opacity:0.7 }}>
              {evidenceDocs.length} entries{evidenceErr ? " · error" : ""}
            </div>
            {evidenceErr && <div style={{ fontSize:12, color:"crimson", fontWeight:800 }}>{evidenceErr}</div>}
          </div>

          {evidenceDocs.length === 0 ? (
            <div style={{ opacity:0.75 }}>No evidence entries yet for this incident.</div>
          ) : (
            <div style={{ display:"grid", gap:8 }}>
              {evidenceDocs.map((x:any) => {
                const id = String(x.id || "");
                const open = !!evidenceOpen[id];
                const ts = (x.storedAt && x.storedAt._seconds)
                  ? new Date(x.storedAt._seconds * 1000).toLocaleString()
                  : (x.storedAt ? String(x.storedAt) : "—");
                const hv = x.hash?.value ? String(x.hash.value) : "";
                const hshort = hv ? (hv.length > 18 ? `${hv.slice(0,12)}…${hv.slice(-4)}` : hv) : "—";
                return (
                  <div key={id} style={{
                    border:"1px solid color-mix(in oklab, CanvasText 12%, transparent)",
                    borderRadius:12,
                    padding:10,
                    background:"color-mix(in oklab, CanvasText 3%, transparent)"
                  }}>
                    <div style={{ display:"flex", justifyContent:"space-between", gap:12, alignItems:"flex-start" }}>
                      <div>
                        <div style={{ fontSize:12, opacity:0.7 }}>
                          {ts} · {x.filingType || "—"} · {x.kind || "—"}
                        </div>
                        <div style={{ fontWeight:900 }}>
                          {x.jobId ? <span style={{ fontFamily:"ui-monospace, Menlo, monospace" }}>{x.jobId}</span> : "—"}
                        </div>
                        <div style={{ fontSize:12, opacity:0.85, marginTop:4 }}>
                          Hash: <span style={{ fontFamily:"ui-monospace, Menlo, monospace" }}>{hshort}</span>
                        </div>
                      </div>

                      <div style={{ display:"flex", gap:8 }}>
                        <Button disabled={!hv} onClick={() => hv && navigator.clipboard?.writeText(hv)}>Copy hash</Button>
                        <Button onClick={() => setEvidenceOpen(o => ({ ...o, [id]: !o[id] }))}>
                          {open ? "Hide" : "Show"}
                        </Button>
                      </div>
                    </div>

                    {open && (
                      <pre style={{ marginTop:10, whiteSpace:"pre-wrap", fontSize:12, opacity:0.92 }}>
{(x.payloadPreview || (x.payload ? JSON.stringify(x.payload, null, 2) : JSON.stringify(x, null, 2)))}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </PanelCard>
      </div>
"""
needle = 'PanelCard title="What Needs Attention"'
pos = s.find(needle)
if pos == -1:
    # fallback: append before final return close
    end = s.rfind("\n  );")
    if end == -1: raise SystemExit("❌ could not find return end")
    s = s[:end] + panel + s[end:]
else:
    # Find the closing </PanelCard> after that section and insert right after it
    close = s.find("</PanelCard>", pos)
    if close == -1: raise SystemExit("❌ could not find </PanelCard> for Needs Attention")
    close2 = s.find("\n", close)
    s = s[:close2+1] + panel + s[close2+1:]

p.write_text(s)
print("✅ Evidence Locker UI panel added")
PY

echo "✅ UI patch applied to $FILE"

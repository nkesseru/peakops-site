"use client";
import AdminNav from "../../../_components/AdminNav";
import JsonViewer from "../../../_components/JsonViewer";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams, useRouter }  from "next/navigation";
import JSZip from "jszip";
import JsonCodeBlock from "../../../_components/JsonCodeBlock";
import { useToast } from "../../../_components/useToast";
import PrettyJson from "../../../_components/PrettyJson";
function isProbablyJson(text: string) {
  const t = (text || "").trim();
  return (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
}
function safeParseJson(text: string) {
  try { return JSON.parse(text); } catch { return null; }
}


type NodeT = { name: string; path: string; isDir: boolean; children?: NodeT[] };

function buildTree(paths: string[]): NodeT {
  const root: NodeT = { name: "root", path: "", isDir: true, children: [] };
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    let cur = root;
    let accum = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accum = accum ? `${accum}/${part}` : part;
      const isDir = i < parts.length - 1;
      cur.children ||= [];
      let child = cur.children.find(c => c.name === part);
      if (!child) {
        child = { name: part, path: accum, isDir, children: isDir ? [] : undefined };
        cur.children.push(child);
      }
      cur = child;
    }
  }
  return root;
}

function flatten(n: NodeT): NodeT[] {
  const out: NodeT[] = [];
  (function walk(x: NodeT) {
    out.push(x);
    (x.children || []).forEach(walk);
  })(n);
  return out;
}

function ghostBtn() {
  return {
    padding: "7px 12px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontWeight: 900,
    cursor: "pointer",
    fontSize: 12,
  } as const;
}

export default function PacketPreview() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const orgId = sp.get("orgId") || "org_001";
  const router = useRouter();
  // Normalize URL: always keep orgId in query (prevents orgId=undefined calls)
  useEffect(() => {
    const cur = sp.get("orgId");
    if (!cur) router.replace(`${location.pathname}?orgId=${encodeURIComponent(orgId)}`);
  }, [orgId]); // eslint-disable-line

  const versionId = sp.get("versionId") || "v1";
  const contractId = params.id;

  const { show, Toast } = useToast();

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  const [zip, setZip] = useState<JSZip | null>(null);
  const [meta, setMeta] = useState<any>(null);

  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>("contract/contract.json");
  const [selectedText, setSelectedText] = useState<string>("");

  const [expanded, setExpanded] = useState<Record<string, boolean>>({ contract:true, payloads:true });

  async function load() {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/fn/exportContractPacketV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&versionId=${encodeURIComponent(versionId)}&limit=200`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "exportContractPacketV1 failed");
      
      setErr(""); // cleared on success
setMeta(j);

      const b64 = String(j.zipBase64 || "");
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const z = await JSZip.loadAsync(bytes);
      setZip(z);

      // default selection if exists
      if (z.file("contract/contract.json")) {
        setSelectedPath("contract/contract.json");
      } else {
        const anyFile = Object.keys(z.files).find(p => !z.files[p].dir);
        if (anyFile) setSelectedPath(anyFile);
      }
    } catch (e:any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function readSelected() {
    if (!zip) return;
    const f = zip.file(selectedPath);
    if (!f) return;
    const txt = await f.async("string");
    setSelectedText(txt);
  }

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(selectedPath);
      show("ok","Path copied");
    } catch {}
  }

  async function downloadSelectedFile() {
    if (!zip) return;
    const f = zip.file(selectedPath);
    if (!f) return;
    const blob = await f.async("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = selectedPath.split("/").pop() || "file";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    show("ok","Downloaded");
  }

  async function downloadZip() {
    if (!meta?.zipBase64) return;
    const bytes = Uint8Array.from(atob(String(meta.zipBase64)), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = meta.filename || `peakops_contractpacket_${contractId}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  useEffect(() => { load(); }, [contractId]); // eslint-disable-line
  useEffect(() => { readSelected(); }, [zip, selectedPath]); // eslint-disable-line

  const files = useMemo(() => {
    if (!zip) return [];
    return Object.keys(zip.files)
      .filter(p => !zip.files[p].dir)
      .sort((a,b)=>a.localeCompare(b));
  }, [zip]);

  const tree = useMemo(() => buildTree(files), [files]);
  const flat = useMemo(() => flatten(tree).filter(n => n.path), [tree]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flat;
    return flat.filter(n => n.path.toLowerCase().includes(q));
  }, [flat, query]);

  function renderNode(n: NodeT, depth=0) {
    const isOpen = expanded[n.path] ?? (depth < 2);
    const rowStyle: any = {
      display:"flex",
      alignItems:"center",
      gap: 8,
      padding: "6px 8px",
      borderRadius: 10,
      cursor: "pointer",
      opacity: n.isDir ? 0.9 : 1,
      background: (!n.isDir && selectedPath === n.path) ? "color-mix(in oklab, CanvasText 10%, transparent)" : "transparent"
    };

    return (
      <div key={n.path} style={{ marginLeft: depth * 10 }}>
        <div
          style={{ rowStyle }}
          onClick={() => {
            if (n.isDir) setExpanded((s)=>({ ...s, [n.path]: !isOpen }));
            else setSelectedPath(n.path);
          }}
          title={n.path}
        >
          <span style={{ width: 16, textAlign:"center", opacity: 0.7 }}>
            {n.isDir ? (isOpen ? "▾" : "▸") : "·"}
          </span>
          <span style={{ fontWeight: n.isDir ? 900 : 800, fontSize: 12.5 }}>
            {n.name}
          </span>
        </div>
        {n.isDir && isOpen && (n.children || []).map((c)=>renderNode(c, depth+1))}
      </div>
    );
  }

  const isJson = selectedPath.endsWith(".json") || selectedPath.endsWith(".txt") || selectedPath.endsWith(".md");

  return (
    <div style={{ padding: 22, color:"CanvasText", fontFamily:"system-ui" }}>
      {Toast}

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap: 14, flexWrap:"wrap" }}>
        <div>
          <div style={{ fontWeight: 1000, fontSize: 22 }}>Admin · Packet Preview</div>

      {err && (
        <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>
          {String(err)}
        </div>
      )}

          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
            Org: <b>{orgId}</b> · Contract: <b>{contractId}</b> · Version: <b>{versionId}</b>
          </div>
        </div>

        <div style={{ display:"flex", gap: 10, alignItems:"center", flexWrap:"wrap" }}>
          <AdminNav orgId={orgId} contractId={contractId} versionId={versionId} />
          <button onClick={load} disabled={busy} style={ghostBtn()}>{busy ? "Loading…" : "Refresh"}</button>
          <button onClick={downloadZip} disabled={!meta?.zipBase64} style={ghostBtn()}>Download ZIP</button>
        </div>
      </div>

      {err && <div style={{ marginTop: 10, color:"crimson", fontWeight: 900 }}>{err}</div>}

      {meta && (
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
          filename: {meta.filename} · sizeBytes: {meta.sizeBytes} · packetHash: {meta.packetHash}
        </div>
      )}

      <div style={{ marginTop: 12, display:"grid", gridTemplateColumns:"360px 1fr", gap: 12, alignItems:"start" }}>
        <div style={{
          border:"1px solid color-mix(in oklab, CanvasText 12%, transparent)",
          borderRadius: 14,
          background:"color-mix(in oklab, CanvasText 3%, transparent)",
          overflow:"hidden"
        }}>
          <div style={{ padding:"10px 12px", borderBottom:"1px solid color-mix(in oklab, CanvasText 10%, transparent)" }}>
            <div style={{ fontWeight: 1000 }}>Packet Tree</div>
            <input
              value={query}
              onChange={(e)=>setQuery(e.target.value)}
              placeholder="Search files…"
              style={{
                marginTop: 8,
                width:"100%",
                padding: "8px 10px",
                borderRadius: 12,
                border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
                background: "transparent",
                color: "CanvasText",
                fontSize: 12.5
              }}
            />
          </div>

          <div style={{ padding: 10, maxHeight: 620, overflow:"auto" }}>
            {query.trim()
              ? filtered.map(n => renderNode(n, 0))
              : (tree.children || []).map(n => renderNode(n, 0))}
          </div>
        </div>

        <div style={{ display:"grid", gap: 12 }}>
          <div style={{ display:"flex", gap: 10, flexWrap:"wrap", alignItems:"center" }}>
            <div style={{ fontFamily:"ui-monospace, Menlo, monospace", fontSize: 12, opacity: 0.85 }}>
              {selectedPath}
            </div>
            <button onClick={copyPath} style={ghostBtn()}>Copy path</button>
            <button onClick={downloadSelectedFile} style={ghostBtn()}>Download file</button>
          </div>

          {isJson ? (
            <JsonCodeBlock
              value={selectedText}
              title="Preview"
              subtitle={selectedPath}
              maxHeight={720}
              defaultWrap={true}
            />
          ) : (
            <div style={{
              border:"1px solid color-mix(in oklab, CanvasText 12%, transparent)",
              borderRadius: 14,
              background:"color-mix(in oklab, CanvasText 3%, transparent)",
              padding: 12,
              fontFamily:"ui-monospace, Menlo, monospace",
              fontSize: 13.5,
              lineHeight: 1.6,
              whiteSpace:"pre-wrap",
              minHeight: 420
            }}>
              {selectedText || "—"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

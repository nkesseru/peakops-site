#!/usr/bin/env bash
set -euo pipefail

REPO="$(pwd)"
NEXT="$REPO/next-app"

echo "==> (0) Sanity"
test -d "$NEXT" || { echo "❌ next-app not found"; exit 1; }

echo "==> (1) Ensure JSZip in next-app"
( cd "$NEXT" && pnpm add jszip >/dev/null ) || true

echo "==> (2) Ensure shared components exist"
mkdir -p "$NEXT/src/app/admin/_components"

# AdminNav (small + consistent)
cat > "$NEXT/src/app/admin/_components/AdminNav.tsx" <<'TSX'
"use client";

import Link from "next/link";

const btn = {
  padding: "6px 10px",
  borderRadius: 999,
  border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
  background: "color-mix(in oklab, CanvasText 6%, transparent)",
  color: "CanvasText",
  textDecoration: "none",
  fontWeight: 900,
  fontSize: 12,
};

const ghost = { ...btn, background: "transparent", opacity: 0.9 };

export default function AdminNav(props: { orgId: string; contractId?: string; versionId?: string }) {
  const { orgId, contractId, versionId } = props;
  const q = `?orgId=${encodeURIComponent(orgId)}${versionId ? `&versionId=${encodeURIComponent(versionId)}` : ""}`;
  const base = `/admin/contracts?orgId=${encodeURIComponent(orgId)}`;
  const contract = contractId ? `/admin/contracts/${encodeURIComponent(contractId)}?orgId=${encodeURIComponent(orgId)}` : null;
  const payloads = contractId ? `/admin/contracts/${encodeURIComponent(contractId)}/payloads${q}` : null;
  const packet = contractId ? `/admin/contracts/${encodeURIComponent(contractId)}/packet${q}` : null;

  return (
    <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center" }}>
      <Link href={base} style={ghost}>← Contracts</Link>
      {contract && <Link href={contract} style={ghost}>Contract Overview</Link>}
      {payloads && <Link href={payloads} style={ghost}>Payloads</Link>}
      {packet && <Link href={packet} style={ghost}>Packet Preview</Link>}
    </div>
  );
}
TSX

# Mini toast helper
cat > "$NEXT/src/app/admin/_components/useToast.ts" <<'TS'
"use client";
import { useCallback, useState } from "react";

export function useToast() {
  const [msg, setMsg] = useState<string>("");
  const [kind, setKind] = useState<"ok"|"err"|"">("");

  const show = useCallback((k:"ok"|"err", m:string) => {
    setKind(k); setMsg(m);
    window.setTimeout(() => { setKind(""); setMsg(""); }, 1800);
  }, []);

  const Toast = kind ? (
    <div style={{
      position:"fixed",
      right: 18,
      top: 18,
      zIndex: 9999,
      padding: "10px 12px",
      borderRadius: 14,
      background: kind === "ok" ? "color-mix(in oklab, lime 18%, black)" : "color-mix(in oklab, red 18%, black)",
      border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
      color: "CanvasText",
      fontWeight: 900,
      backdropFilter: "blur(10px)"
    }}>
      {msg}
    </div>
  ) : null;

  return { show, Toast };
}
TS

echo "✅ components ready"

echo "==> (3) Overwrite Payload Editor page (Apple-level UX)"
mkdir -p "$NEXT/src/app/admin/contracts/[id]/payloads/[payloadId]"
cat > "$NEXT/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx" <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import AdminNav from "../../../../_components/AdminNav";
import JsonCodeBlock from "../../../../_components/JsonCodeBlock";
import { useToast } from "../../../../_components/useToast";

function btn(label: string, primary=false) {
  return {
    padding: "7px 12px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: primary ? "color-mix(in oklab, CanvasText 10%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontWeight: 900,
    cursor: "pointer",
    fontSize: 12,
  } as const;
}

export default function AdminPayloadEditor() {
  const params = useParams<{ id: string; payloadId: string }>();
  const sp = useSearchParams();
  const orgId = sp.get("orgId") || "org_001";
  const versionId = sp.get("versionId") || "v1";
  const contractId = params.id;
  const payloadId = params.payloadId;

  const { show, Toast } = useToast();

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [doc, setDoc] = useState<any>(null);

  const [text, setText] = useState<string>('{\n  "_placeholder": "INIT"\n}\n');
  const [valid, setValid] = useState<boolean>(true);

  const parsed = useMemo(() => {
    try {
      const v = JSON.parse(text);
      setValid(true);
      return v;
    } catch {
      setValid(false);
      return null;
    }
  }, [text]);

  async function load() {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=200`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");
      const found = (j.docs || []).find((x:any) => String(x.id) === String(payloadId));
      if (!found) throw new Error(`Payload doc not found: ${payloadId}`);
      setDoc(found);
      setText(JSON.stringify(found.payload ?? {}, null, 2) + "\n");
    } catch (e:any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!valid) { show("err","Fix JSON first"); return; }
    if (!doc) { show("err","No doc loaded"); return; }

    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/fn/writeContractPayloadV1`, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({
          orgId,
          contractId,
          type: doc.type,
          versionId: doc.versionId || versionId,
          schemaVersion: doc.schemaVersion,
          payload: parsed,
          createdBy: "admin_ui",
        })
      });
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "writeContractPayloadV1 failed");
      show("ok","Saved ✅");
      await load();
    } catch (e:any) {
      setErr(String(e?.message || e));
      show("err","Save failed");
    } finally {
      setBusy(false);
    }
  }

  function format() {
    if (!valid) { show("err","Invalid JSON"); return; }
    setText(JSON.stringify(parsed, null, 2) + "\n");
    show("ok","Formatted");
  }

  useEffect(() => { if (contractId && payloadId) load(); }, [contractId, payloadId]); // eslint-disable-line

  return (
    <div style={{ padding: 22, color:"CanvasText", fontFamily:"system-ui" }}>
      {Toast}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap: 14, flexWrap:"wrap" }}>
        <div>
          <div style={{ fontWeight: 1000, fontSize: 22 }}>Admin · Payload Editor</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
            Org: <b>{orgId}</b> · Contract: <b>{contractId}</b> · Doc: <b>{payloadId}</b>
          </div>
        </div>

        <div style={{ display:"flex", gap: 10, alignItems:"center", flexWrap:"wrap" }}>
          <AdminNav orgId={orgId} contractId={contractId} versionId={versionId} />
          <button onClick={load} disabled={busy} style={btn(busy ? "Loading…" : "Refresh")}>{busy ? "Loading…" : "Refresh"}</button>
          <button onClick={format} disabled={busy || !valid} style={btn("Format JSON")}>Format JSON</button>
          <button onClick={save} disabled={busy || !valid} style={btn("Save", true)}>Save</button>
        </div>
      </div>

      {err && <div style={{ marginTop: 10, color:"crimson", fontWeight: 900 }}>{err}</div>}

      <div style={{ marginTop: 12, display:"grid", gridTemplateColumns:"1.2fr 0.8fr", gap: 12, alignItems:"start" }}>
        <div style={{
          border:"1px solid color-mix(in oklab, CanvasText 12%, transparent)",
          borderRadius: 14,
          background:"color-mix(in oklab, CanvasText 3%, transparent)",
          overflow:"hidden"
        }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"10px 12px",
            borderBottom:"1px solid color-mix(in oklab, CanvasText 10%, transparent)" }}>
            <div style={{ fontWeight: 900 }}>
              JSON
              <span style={{ marginLeft: 10, fontSize: 12, opacity: 0.75 }}>
                {valid ? "✅ Valid" : "❌ Invalid"}
              </span>
            </div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Tip: paste valid JSON only</div>
          </div>
          <textarea
            value={text}
            onChange={(e)=>setText(e.target.value)}
            spellCheck={false}
            style={{
              width:"100%",
              minHeight: 560,
              padding: 12,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "CanvasText",
              fontFamily: "ui-monospace, Menlo, monospace",
              fontSize: 13.5,
              lineHeight: 1.5,
              resize: "vertical"
            }}
          />
        </div>

        <div style={{ display:"grid", gap: 12 }}>
          <JsonCodeBlock
            value={doc || { loading: true }}
            title="Metadata"
            subtitle="type · schema · hashes · timestamps"
            maxHeight={260}
            defaultWrap={true}
          />
          <JsonCodeBlock
            value={parsed ?? { error: "Invalid JSON" }}
            title="Parsed Payload (read-only)"
            subtitle="what will be written"
            maxHeight={360}
            defaultWrap={true}
          />
        </div>
      </div>
    </div>
  );
}
TSX

echo "✅ Payload Editor upgraded"

echo "==> (4) Overwrite Packet Preview page (tree + search + copy path + download file)"
mkdir -p "$NEXT/src/app/admin/contracts/[id]/packet"
cat > "$NEXT/src/app/admin/contracts/[id]/packet/page.tsx" <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import JSZip from "jszip";
import AdminNav from "../../../_components/AdminNav";
import JsonCodeBlock from "../../../_components/JsonCodeBlock";
import { useToast } from "../../../_components/useToast";

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
          style={rowStyle}
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
TSX

echo "✅ Packet Preview upgraded"

echo "==> (5) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$REPO/.logs"
( cd "$NEXT" && pnpm dev --port 3000 > "$REPO/.logs/next.log" 2>&1 ) &
sleep 1
curl -fsS "http://127.0.0.1:3000" >/dev/null && echo "✅ Next restarted"

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads/v1_dirs?orgId=org_001&versionId=v1"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"

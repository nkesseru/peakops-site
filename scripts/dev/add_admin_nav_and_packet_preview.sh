#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

cd ~/peakops/my-app

echo "==> (0) Ensure deps (JSZip) in next-app"
pnpm -C next-app add jszip >/dev/null

echo "==> (1) Create AdminNav component"
mkdir -p next-app/src/app/admin/_components
cat > next-app/src/app/admin/_components/AdminNav.tsx <<'TSX'
"use client";

import Link from "next/link";

export default function AdminNav(props: {
  orgId: string;
  contractId?: string;
  payloadId?: string;
  versionId?: string;
}) {
  const { orgId, contractId, payloadId, versionId } = props;

  const pill: React.CSSProperties = {
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    textDecoration: "none",
    color: "CanvasText",
    fontWeight: 800,
    fontSize: 12,
    opacity: 0.9,
    whiteSpace: "nowrap",
  };

  const wrap: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };

  return (
    <div style={wrap}>
      <Link href={`/admin/contracts?orgId=${encodeURIComponent(orgId)}`} style={pill}>
        ← Contracts
      </Link>

      {contractId && (
        <Link href={`/admin/contracts/${encodeURIComponent(contractId)}?orgId=${encodeURIComponent(orgId)}`} style={pill}>
          Contract Overview
        </Link>
      )}

      {contractId && (
        <Link
          href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads?orgId=${encodeURIComponent(orgId)}`}
          style={pill}
        >
          Payloads
        </Link>
      )}

      {contractId && (
        <Link
          href={`/admin/contracts/${encodeURIComponent(contractId)}/packet?orgId=${encodeURIComponent(orgId)}&versionId=${encodeURIComponent(
            versionId || "v1"
          )}`}
          style={pill}
        >
          Packet Preview
        </Link>
      )}

      {payloadId && contractId && (
        <Link
          href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads/${encodeURIComponent(payloadId)}?orgId=${encodeURIComponent(orgId)}`}
          style={pill}
        >
          Edit Payload
        </Link>
      )}
    </div>
  );
}
TSX

echo "==> (2) Create Packet Preview page"
mkdir -p next-app/src/app/admin/contracts/'[id]'/packet
cat > next-app/src/app/admin/contracts/'[id]'/packet/page.tsx <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import JSZip from "jszip";
import AdminNav from "../../../_components/AdminNav";

function decodeB64(b64: string): Uint8Array {
  // Handles standard base64 (no data: prefix)
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function buildTree(paths: string[]) {
  type Node = { name: string; path: string; children: Node[]; isFile: boolean };
  const root: Node = { name: "/", path: "", children: [], isFile: false };

  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    let cur = root;
    let running = "";
    parts.forEach((part, idx) => {
      running += (running ? "/" : "") + part;
      let child = cur.children.find((c) => c.name === part);
      if (!child) {
        child = { name: part, path: running, children: [], isFile: idx === parts.length - 1 };
        cur.children.push(child);
      }
      cur = child;
      cur.isFile = idx === parts.length - 1;
    });
  }

  const sort = (n: any) => {
    n.children.sort((a: any, b: any) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1; // folders first
      return a.name.localeCompare(b.name);
    });
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

export default function ContractPacketPreview() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const orgId = sp.get("orgId") || "org_001";
  const versionId = sp.get("versionId") || "v1";

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [meta, setMeta] = useState<any>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [zipObj, setZipObj] = useState<JSZip | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [preview, setPreview] = useState<string>("");

  async function load() {
    setBusy(true);
    setErr("");
    setPreview("");
    try {
      const url = `/api/fn/exportContractPacketV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(
        contractId
      )}&versionId=${encodeURIComponent(versionId)}&limit=200`;
      const r = await fetch(url);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "exportContractPacketV1 failed");

      setMeta(j);

      const bytes = decodeB64(j.zipBase64);
      const z = await JSZip.loadAsync(bytes);
      setZipObj(z);

      const names = Object.keys(z.files).filter((k) => !z.files[k].dir);
      setFiles(names);

      // default selection
      const preferred =
        names.find((n) => n.endsWith("contract/contract.json")) ||
        names.find((n) => n.endsWith("manifest.json")) ||
        names[0] ||
        "";
      setSelected(preferred);

    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function loadFile(path: string) {
    if (!zipObj) return;
    setSelected(path);
    setPreview("");
    try {
      const f = zipObj.file(path);
      if (!f) return setPreview("(missing file in zip)");
      const text = await f.async("string");
      // cap big files so the UI doesn't choke
      setPreview(text.length > 200_000 ? text.slice(0, 200_000) + "\n\n…(truncated)…" : text);
    } catch {
      setPreview("(preview unavailable for this file)");
    }
  }

  useEffect(() => {
    if (contractId) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId]);

  useEffect(() => {
    if (selected) loadFile(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, zipObj]);

  const tree = useMemo(() => buildTree(files), [files]);

  const btn: React.CSSProperties = {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontWeight: 900,
    cursor: busy ? "not-allowed" : "pointer",
  };

  const mono: React.CSSProperties = { fontFamily: "ui-monospace, Menlo, monospace" };

  const downloadUrl = meta
    ? `/api/fn/exportContractPacketV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(
        contractId
      )}&versionId=${encodeURIComponent(versionId)}&limit=200`
    : "";

  function TreeNode({ node, depth }: any) {
    const pad = 10 + depth * 12;
    if (node.path === "") {
      return node.children.map((c: any) => <TreeNode key={c.path} node={c} depth={0} />);
    }
    const isActive = selected === node.path;
    const row: React.CSSProperties = {
      padding: "6px 10px",
      paddingLeft: pad,
      borderRadius: 10,
      cursor: node.isFile ? "pointer" : "default",
      background: isActive ? "color-mix(in oklab, CanvasText 8%, transparent)" : "transparent",
      opacity: node.isFile ? 1 : 0.9,
    };
    return (
      <div>
        <div
          style={row}
          onClick={() => {
            if (node.isFile) loadFile(node.path);
          }}
        >
          <span style={{ opacity: 0.75, marginRight: 8 }}>{node.isFile ? "📄" : "📁"}</span>
          <span style={node.isFile ? mono : undefined}>{node.name}</span>
        </div>
        {node.children?.length > 0 && node.children.map((c: any) => <TreeNode key={c.path} node={c} depth={depth + 1} />)}
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>Admin · Packet Preview</h1>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
            Org: <b>{orgId}</b> · Contract: <b>{contractId}</b> · Version: <b>{versionId}</b>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button onClick={load} disabled={busy} style={btn}>{busy ? "Loading…" : "Refresh"}</button>
          {downloadUrl && (
            <a href={downloadUrl} style={{ ...btn, textDecoration: "none", display: "inline-block" }}>
              Download ZIP
            </a>
          )}
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <AdminNav orgId={orgId} contractId={contractId} versionId={versionId} />
      </div>

      {err && <div style={{ marginTop: 14, color: "crimson", fontWeight: 900 }}>{err}</div>}

      {meta && (
        <div style={{ marginTop: 14, fontSize: 12, opacity: 0.8 }}>
          filename: <span style={mono}>{meta.filename}</span> · sizeBytes: <b>{meta.sizeBytes}</b> · packetHash:{" "}
          <span style={mono}>{meta.packetHash}</span>
        </div>
      )}

      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "360px 1fr", gap: 12 }}>
        <div
          style={{
            border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
            borderRadius: 14,
            padding: 10,
            background: "color-mix(in oklab, CanvasText 3%, transparent)",
            maxHeight: "70vh",
            overflow: "auto",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Packet Tree</div>
          {files.length === 0 && !err && <div style={{ opacity: 0.7 }}>No files.</div>}
          {files.length > 0 && <TreeNode node={tree} depth={0} />}
        </div>

        <div
          style={{
            border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
            borderRadius: 14,
            padding: 10,
            background: "color-mix(in oklab, CanvasText 3%, transparent)",
            maxHeight: "70vh",
            overflow: "auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
            <div style={{ fontWeight: 900 }}>Preview</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{selected ? <span style={mono}>{selected}</span> : "—"}</div>
          </div>
          <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.35, opacity: 0.95 }}>
{preview || (selected ? "Loading…" : "Pick a file on the left.")}
          </pre>
        </div>
      </div>
    </div>
  );
}
TSX

echo "==> (3) Patch 3 pages to include AdminNav (safe insert)"
python3 - <<'PY'
from pathlib import Path

targets = [
  Path("next-app/src/app/admin/contracts/[id]/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/payloads/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"),
]

for p in targets:
  if not p.exists():
    print("skip missing:", p)
    continue

  s = p.read_text()

  if "AdminNav" not in s:
    # add import near top
    if '"use client"' in s:
      parts = s.split("\n", 3)
      # crude but stable: after first 2 lines
      lines = s.splitlines()
      out = []
      inserted = False
      for i,line in enumerate(lines):
        out.append(line)
        if not inserted and line.strip() == '"use client";':
          out.append("")
          out.append('import AdminNav from "../../_components/AdminNav";' if "contracts/[id]/payloads/[payloadId]" in str(p) else
                     'import AdminNav from "../_components/AdminNav";' if "contracts/[id]/page.tsx" in str(p) else
                     'import AdminNav from "../../_components/AdminNav";')
          inserted = True
      s = "\n".join(out)

  # insert AdminNav render once we have orgId/contractId in scope; we add a guarded block:
  if "/*__ADMIN_NAV__*/" not in s:
    insert = '\n      {/*__ADMIN_NAV__*/}\n      <div style={{ marginTop: 10 }}>\n        <AdminNav orgId={orgId} contractId={contractId} payloadId={typeof payloadId !== "undefined" ? payloadId : undefined} versionId={"v1"} />\n      </div>\n'
    # place after title header (first return <div ...>)
    idx = s.find("return (")
    if idx != -1:
      idx2 = s.find("<div", idx)
      if idx2 != -1:
        idx3 = s.find(">", idx2)
        if idx3 != -1:
          s = s[:idx3+1] + insert + s[idx3+1:]

  p.write_text(s)
  print("patched:", p)

PY

echo "==> (4) Restart Next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1
echo "✅ done"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"

#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

echo "==> (1) Ensure JSZip in next-app"
cd next-app
pnpm add jszip >/dev/null
cd ..

echo "==> (2) Create PacketTree component"
mkdir -p next-app/src/app/admin/_components
cat > next-app/src/app/admin/_components/PacketTree.tsx <<'TSX'
"use client";
import { useState } from "react";

export type TreeNode = {
  name: string;
  path: string;
  children?: TreeNode[];
};

export default function PacketTree({
  tree,
  onSelect,
}: {
  tree: TreeNode[];
  onSelect: (path: string) => void;
}) {
  return (
    <div style={{ fontFamily: "ui-monospace", fontSize: 13 }}>
      {tree.map((n) => (
        <Node key={n.path} node={n} depth={0} onSelect={onSelect} />
      ))}
    </div>
  );
}

function Node({
  node,
  depth,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const isDir = !!node.children?.length;

  return (
    <div>
      <div
        style={{
          paddingLeft: depth * 12,
          cursor: "pointer",
          opacity: isDir ? 0.9 : 1,
        }}
        onClick={() => (isDir ? setOpen(!open) : onSelect(node.path))}
      >
        {isDir ? (open ? "▾ " : "▸ ") : "• "} {node.name}
      </div>
      {open &&
        node.children?.map((c) => (
          <Node key={c.path} node={c} depth={depth + 1} onSelect={onSelect} />
        ))}
    </div>
  );
}
TSX

echo "==> (3) Patch Packet Preview page with tree + preview"
cat > next-app/src/app/admin/contracts/[id]/packet/page.tsx <<'TSX'
"use client";
import JSZip from "jszip";
import { useEffect, useState } from "react";
import PacketTree, { TreeNode } from "@/app/admin/_components/PacketTree";
import { useSearchParams, useParams } from "next/navigation";

export default function PacketPreview() {
  const { id } = useParams();
  const sp = useSearchParams();
  const orgId = sp.get("orgId")!;
  const versionId = sp.get("versionId") || "v1";

  const [tree, setTree] = useState<TreeNode[]>([]);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string>("contract/contract.json");

  useEffect(() => {
    fetch(
      `/api/fn/exportContractPacketV1?orgId=${orgId}&contractId=${id}&versionId=${versionId}&limit=200`
    )
      .then((r) => r.json())
      .then(async (j) => {
        const zip = await JSZip.loadAsync(j.zipBase64, { base64: true });
        const out: Record<string, string> = {};
        const paths: string[] = [];

        await Promise.all(
          Object.keys(zip.files).map(async (k) => {
            if (!zip.files[k].dir) {
              out[k] = await zip.files[k].async("string");
              paths.push(k);
            }
          })
        );

        setFiles(out);
        setTree(buildTree(paths));
      });
  }, []);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", gap: 16 }}>
      <div style={{ borderRight: "1px solid #333", paddingRight: 8 }}>
        <PacketTree tree={tree} onSelect={setActive} />
      </div>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          background: "#0b0b0b",
          padding: 16,
          borderRadius: 12,
          fontSize: 13,
        }}
      >
        {files[active] || "Select a file"}
      </pre>
    </div>
  );
}

function buildTree(paths: string[]): TreeNode[] {
  const root: any = {};
  for (const p of paths) {
    const parts = p.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      cur[part] ||= { __path: parts.slice(0, i + 1).join("/") };
      cur = cur[part];
    });
  }

  function walk(obj: any): TreeNode[] {
    return Object.entries(obj)
      .filter(([k]) => k !== "__path")
      .map(([k, v]: any) => ({
        name: k,
        path: v.__path,
        children: walk(v),
      }));
  }

  return walk(root);
}
TSX

echo "==> (4) Restart Next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 ) &

echo "OPEN:"
echo "http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"

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

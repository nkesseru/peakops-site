#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

REPO="$HOME/peakops/my-app"
NEXT="$REPO/next-app"

cd "$REPO"
mkdir -p "$REPO/.logs"
mkdir -p "$NEXT/src/app/admin/_components"

echo "==> (1) Write AdminNav (with Cmd+K palette)"
cat > "$NEXT/src/app/admin/_components/AdminNav.tsx" <<'TSX'
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const btnBase: React.CSSProperties = {
  padding: "7px 12px",
  borderRadius: 999,
  border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
  background: "color-mix(in oklab, CanvasText 6%, transparent)",
  color: "CanvasText",
  textDecoration: "none",
  fontWeight: 800,
  fontSize: 12,
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
};

const btnGhost: React.CSSProperties = {
  ...btnBase,
  background: "transparent",
  border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)",
  fontWeight: 700,
  opacity: 0.9,
};

type Item = { label: string; href: string; hint?: string };

export default function AdminNav(props: {
  orgId: string;
  contractId?: string | null;
  versionId?: string | null;
  active?: "contracts" | "contract" | "payloads" | "packet";
}) {
  const orgId = props.orgId || "org_001";
  const contractId = props.contractId || "";
  const versionId = props.versionId || "v1";

  const items: Item[] = useMemo(() => {
    const base = `/admin/contracts?orgId=${encodeURIComponent(orgId)}`;
    const contract = contractId
      ? `/admin/contracts/${encodeURIComponent(contractId)}?orgId=${encodeURIComponent(orgId)}`
      : base;
    const payloads = contractId
      ? `/admin/contracts/${encodeURIComponent(contractId)}/payloads?orgId=${encodeURIComponent(orgId)}`
      : base;
    const packet = contractId
      ? `/admin/contracts/${encodeURIComponent(contractId)}/packet?orgId=${encodeURIComponent(orgId)}&versionId=${encodeURIComponent(versionId)}`
      : base;

    return [
      { label: "Contracts", href: base, hint: "List" },
      { label: "Contract Overview", href: contract, hint: contractId || "—" },
      { label: "Payloads", href: payloads, hint: "Schemas" },
      { label: "Packet Preview", href: packet, hint: "Tree + JSON" },
    ];
  }, [orgId, contractId, versionId]);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter((x) => (x.label + " " + (x.hint || "")).toLowerCase().includes(s));
  }, [items, q]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (!isCmdK) return;
      e.preventDefault();
      setOpen(true);
      setQ("");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Link href={items[0].href} style={props.active === "contracts" ? btnBase : btnGhost}>← Contracts</Link>
        <Link href={items[1].href} style={props.active === "contract" ? btnBase : btnGhost}>Contract Overview</Link>
        <Link href={items[2].href} style={props.active === "payloads" ? btnBase : btnGhost}>Payloads</Link>
        <Link href={items[3].href} style={props.active === "packet" ? btnBase : btnGhost}>Packet Preview</Link>
      </div>

      <button
        onClick={() => { setOpen(true); setQ(""); }}
        style={{ ...btnGhost, cursor: "pointer" }}
        title="Command palette (⌘K)"
      >
        ⌘K
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "color-mix(in oklab, Canvas 55%, transparent)",
            backdropFilter: "blur(10px)",
            zIndex: 9999,
            display: "grid",
            placeItems: "start center",
            paddingTop: 90,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(720px, 92vw)",
              borderRadius: 18,
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              background: "color-mix(in oklab, CanvasText 6%, Canvas)",
              boxShadow: "0 30px 100px rgba(0,0,0,0.45)",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: 12, borderBottom: "1px solid color-mix(in oklab, CanvasText 12%, transparent)" }}>
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Type to jump… (Contracts, Payloads, Packet)"
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 12,
                  border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
                  background: "Canvas",
                  color: "CanvasText",
                  outline: "none",
                  fontSize: 14,
                }}
              />
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
                Enter to open • Esc to close
              </div>
            </div>

            <div style={{ maxHeight: "52vh", overflow: "auto" }}>
              {filtered.map((it) => (
                <a
                  key={it.label}
                  href={it.href}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "12px 14px",
                    textDecoration: "none",
                    color: "CanvasText",
                    borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setOpen(false);
                  }}
                  onClick={() => setOpen(false)}
                >
                  <span style={{ fontWeight: 900 }}>{it.label}</span>
                  <span style={{ opacity: 0.7, fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 }}>
                    {it.hint || ""}
                  </span>
                </a>
              ))}
              {filtered.length === 0 && (
                <div style={{ padding: 14, opacity: 0.7 }}>No matches.</div>
              )}
            </div>
          </div>
          <div
            style={{ position: "fixed", inset: 0 }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
TSX

echo "==> (2) Write JsonCodeBlock (color + line nums + copy + wrap)"
cat > "$NEXT/src/app/admin/_components/JsonCodeBlock.tsx" <<'TSX'
"use client";

import { useMemo, useState } from "react";

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// cheap-ish JSON highlighter: keys, strings, numbers, booleans, null
function highlightJson(json: string) {
  const esc = escapeHtml(json);

  // keys: "foo":
  let out = esc.replace(/"(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:/g, (m) => {
    return `<span style="color:#8ab4f8;font-weight:800">${m}</span>`;
  });

  // strings (not keys): "bar"
  out = out.replace(/:\s*("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")/g, (_m, g1) => {
    return `: <span style="color:#9ae6b4">${g1}</span>`;
  });

  // numbers
  out = out.replace(/:\s*(-?\d+(\.\d+)?([eE][+\-]?\d+)?)/g, (_m, g1) => {
    return `: <span style="color:#fbbf24">${g1}</span>`;
  });

  // booleans + null
  out = out.replace(/:\s*(true|false|null)/g, (_m, g1) => {
    const c = g1 === "null" ? "#a3a3a3" : "#f472b6";
    return `: <span style="color:${c};font-weight:800">${g1}</span>`;
  });

  return out;
}

export default function JsonCodeBlock(props: { value: any; title?: string; defaultWrap?: boolean }) {
  const [wrap, setWrap] = useState(!!props.defaultWrap);

  const json = useMemo(() => {
    try {
      if (typeof props.value === "string") return props.value;
      return JSON.stringify(props.value ?? {}, null, 2);
    } catch {
      return String(props.value ?? "");
    }
  }, [props.value]);

  const html = useMemo(() => highlightJson(json), [json]);

  const lines = useMemo(() => {
    const n = json.split("\n").length;
    return Array.from({ length: n }, (_, i) => String(i + 1));
  }, [json]);

  async function copy() {
    try { await navigator.clipboard.writeText(json); } catch {}
  }

  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 16,
        overflow: "hidden",
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 12px",
          borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 12, opacity: 0.85 }}>
          {props.title || "JSON"}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setWrap((v) => !v)}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              background: "transparent",
              color: "CanvasText",
              fontSize: 12,
              fontWeight: 800,
              cursor: "pointer",
              opacity: 0.9,
            }}
          >
            {wrap ? "No wrap" : "Wrap"}
          </button>
          <button
            onClick={copy}
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              background: "transparent",
              color: "CanvasText",
              fontSize: 12,
              fontWeight: 800,
              cursor: "pointer",
              opacity: 0.9,
            }}
          >
            Copy
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "52px 1fr" }}>
        <pre
          style={{
            margin: 0,
            padding: "12px 10px",
            background: "transparent",
            borderRight: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
            color: "color-mix(in oklab, CanvasText 55%, transparent)",
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.55,
            textAlign: "right",
            userSelect: "none",
            overflow: "hidden",
          }}
        >
          {lines.join("\n")}
        </pre>

        <pre
          style={{
            margin: 0,
            padding: 12,
            whiteSpace: wrap ? "pre-wrap" : "pre",
            wordBreak: wrap ? "break-word" : "normal",
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.55,
            overflow: "auto",
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
TSX

echo "==> (3) Patch AdminNav imports (fix relative paths)"
python3 - <<'PY'
from pathlib import Path

root = Path.home() / "peakops/my-app/next-app/src/app/admin/contracts"

targets = [
  (root / "[id]" / "page.tsx", "../../_components/AdminNav"),
  (root / "[id]" / "payloads" / "page.tsx", "../../../_components/AdminNav"),
  (root / "[id]" / "payloads" / "[payloadId]" / "page.tsx", "../../../../_components/AdminNav"),
  (root / "[id]" / "packet" / "page.tsx", "../../../_components/AdminNav"),
]

for p, rel in targets:
  if not p.exists():
    continue
  s = p.read_text()
  # Normalize any previous variants to correct one
  s2 = s
  s2 = s2.replace("from '../_components/AdminNav'", f"from '{rel}'")
  s2 = s2.replace('from "../_components/AdminNav"', f"from '{rel}'")
  s2 = s2.replace("from '../../_components/AdminNav'", f"from '{rel}'")
  s2 = s2.replace('from "../../_components/AdminNav"', f"from '{rel}'")
  s2 = s2.replace("from '../../../_components/AdminNav'", f"from '{rel}'")
  s2 = s2.replace('from "../../../_components/AdminNav"', f"from '{rel}'")
  s2 = s2.replace("from '../../../../_components/AdminNav'", f"from '{rel}'")
  s2 = s2.replace('from "../../../../_components/AdminNav"', f"from '{rel}'")
  s2 = s2.replace("from './_components/AdminNav'", f"from '{rel}'")
  s2 = s2.replace('from "./_components/AdminNav"', f"from '{rel}'")
  s2 = s2.replace("from '../components/AdminNav'", f"from '{rel}'")
  s2 = s2.replace('from "../components/AdminNav"', f"from '{rel}'")
  s2 = s2.replace("from '../../components/AdminNav'", f"from '{rel}'")
  s2 = s2.replace('from "../../components/AdminNav"', f"from '{rel}'")
  s2 = s2.replace("from '../../../components/AdminNav'", f"from '{rel}'")
  s2 = s2.replace('from "../../../components/AdminNav"', f"from '{rel}'")
  s2 = s2.replace("from '../../../../components/AdminNav'", f"from '{rel}'")
  s2 = s2.replace('from "../../../../components/AdminNav"', f"from '{rel}'")

  if s2 != s:
    p.write_text(s2)
    print(f"✅ patched import: {p}")
PY

echo "==> (4) Restart Next"
pkill -f "next dev" 2>/dev/null || true
( cd "$NEXT" && pnpm dev --port 3000 > "$REPO/.logs/next.log" 2>&1 ) &
sleep 1
curl -fsS "http://127.0.0.1:3000" >/dev/null && echo "✅ Next restarted"

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
echo
echo "Try ⌘K anywhere on admin pages."

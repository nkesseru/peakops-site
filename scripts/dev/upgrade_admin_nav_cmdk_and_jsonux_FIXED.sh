#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

REPO="$HOME/peakops/my-app"
NEXT="$REPO/next-app"

cd "$REPO"
mkdir -p "$NEXT/src/app/admin/_components"
cat > "$NEXT/src/app/admin/_components/AdminNav.tsx" <<'TSX'
"use client";
import { useEffect, useMemo, useState } from "react";
type Item = { label: string; href: string; hint?: string };

export default function AdminNav(props: {
  orgId: string;
  contractId?: string;
  versionId?: string;
}) {
  const { orgId, contractId, versionId } = props;

  const items: Item[] = useMemo(() => {
    const base = `/admin/contracts?orgId=${encodeURIComponent(orgId)}`;
    const overview = contractId ? `/admin/contracts/${encodeURIComponent(contractId)}?orgId=${encodeURIComponent(orgId)}` : base;
    const payloads = contractId ? `/admin/contracts/${encodeURIComponent(contractId)}/payloads?orgId=${encodeURIComponent(orgId)}` : base;
    const packet = contractId ? `/admin/contracts/${encodeURIComponent(contractId)}/packet?orgId=${encodeURIComponent(orgId)}&versionId=${encodeURIComponent(versionId || "v1")}` : base;
    return [
      { label: "Contracts", href: base, hint: "List" },
      { label: "Contract Overview", href: overview, hint: contractId || "" },
      { label: "Payloads", href: payloads, hint: "Schemas" },
      { label: "Packet Preview", href: packet, hint: "Tree + JSON" },
    ];
  }, [orgId, contractId, versionId]);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) { e.preventDefault(); setOpen(v => !v); setQ(""); }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return items;
    return items.filter(x => (x.label + " " + (x.hint || "")).toLowerCase().includes(s));
  }, [q, items]);

  const border = "1px solid color-mix(in oklab, CanvasText 18%, transparent)";
  const pill = (active?: boolean) => ({
    padding: "7px 10px",
    borderRadius: 999,
    border,
    background: active ? "color-mix(in oklab, CanvasText 12%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontWeight: 800,
    textDecoration: "none",
    fontSize: 12,
    display: "inline-flex",
    gap: 8,
    alignItems: "center",
    cursor: "pointer",
  } as const);

  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      {items.map(x => (
        <a key={x.label} href={x.href} style={pill(false)}>{x.label}</a>
      ))}
      <button onClick={() => { setOpen(true); setQ(""); }} style={pill(false)}>
        ⌘K <span style={{ opacity: 0.8, fontWeight: 700 }}>Jump</span>
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9999, display: "grid", placeItems: "center", padding: 18 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: "min(720px, 100%)", borderRadius: 18, border, background: "color-mix(in oklab, Canvas 92%, CanvasText 8%)", boxShadow: "0 30px 80px rgba(0,0,0,0.55)", overflow: "hidden" }}
          >
            <div style={{ padding: 12, borderBottom: border }}>
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Type to jump… (Contracts, Payloads, Packet)"
                style={{ width: "100%", padding: 12, borderRadius: 12, border, background: "Canvas", color: "CanvasText", outline: "none", fontSize: 14 }}
              />
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>Enter to open · Esc to close</div>
            </div>

            <div style={{ padding: 8 }}>
              {filtered.map(x => (
                <a key={x.label} href={x.href} style={{ display: "flex", justifyContent: "space-between", padding: "10px 12px", borderRadius: 12, textDecoration: "none", color: "CanvasText", fontWeight: 800 }}>
                  <span>{x.label}</span>
                  <span style={{ opacity: 0.6, fontWeight: 700 }}>{x.hint || ""}</span>
                </a>
              ))}
              {filtered.length === 0 && <div style={{ padding: 12, opacity: 0.7 }}>No matches.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
TSX
cat > "$NEXT/src/app/admin/_components/PrettyJson.tsx" <<'TSX'
"use client";
import { useMemo, useState } from "react";

export default function PrettyJson(props: { value: any; title?: string; defaultWrap?: boolean }) {
  const [wrap, setWrap] = useState(!!props.defaultWrap);
  const text = useMemo(() => { try { return JSON.stringify(props.value ?? {}, null, 2); } catch { return String(props.value); } }, [props.value]);
  async function copy() { try { await navigator.clipboard.writeText(text); } catch {} }

  const mono = "ui-monospace, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
  const border = "1px solid color-mix(in oklab, CanvasText 16%, transparent)";

  return (
    <div style={{ border, borderRadius: 14, overflow: "hidden", background: "color-mix(in oklab, CanvasText 3%, transparent)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: 10, borderBottom: border }}>
        <div style={{ fontWeight: 900, fontSize: 12, opacity: 0.85 }}>{props.title || "Preview"}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setWrap(v => !v)} style={{ padding: "6px 10px", borderRadius: 999, border, background: "transparent", color: "CanvasText", fontWeight: 900, cursor: "pointer" }}>
            {wrap ? "Wrap" : "No wrap"}
          </button>
          <button onClick={copy} style={{ padding: "6px 10px", borderRadius: 999, border, background: "transparent", color: "CanvasText", fontWeight: 900, cursor: "pointer" }}>
            Copy
          </button>
        </div>
      </div>
      <pre style={{ margin: 0, padding: 12, fontFamily: mono, fontSize: 12, lineHeight: 1.5, whiteSpace: wrap ? "pre-wrap" : "pre", overflowX: "auto", opacity: 0.92 }}>
{text}
      </pre>
    </div>
  );
}
TSX

echo "✅ wrote AdminNav + PrettyJson"

echo "==> (6) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$REPO/.logs"
( cd "$NEXT" && pnpm dev --port 3000 > "$REPO/.logs/next.log" 2>&1 ) &

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then
    echo "✅ Next is up"
    echo "OPEN:"
    echo "  http://localhost:3000/admin/contracts?orgId=org_001"
    echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"
    exit 0
  fi
  sleep 0.25
done

echo "❌ Next did not come up. Tail logs:"
tail -n 120 "$REPO/.logs/next.log" || true
exit 1

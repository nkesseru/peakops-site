#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-$HOME/peakops/my-app}"
NEXT="$REPO/next-app"

cd "$REPO"
mkdir -p "$NEXT/src/app/admin/_components"

echo "==> (1) Write AdminNav (includes Cmd+K + breadcrumbs)"
cat > "$NEXT/src/app/admin/_components/AdminNav.tsx" <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";

type CmdItem = { label: string; hint?: string; href: string };

function border() {
  return "1px solid color-mix(in oklab, CanvasText 16%, transparent)";
}
function pill(active = false) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: 999,
    border: border(),
    background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    textDecoration: "none",
    fontWeight: 900,
    cursor: "pointer",
    userSelect: "none",
  } as const;
}
function panel() {
  return {
    border: border(),
    borderRadius: 18,
    background: "color-mix(in oklab, CanvasText 4%, transparent)",
    overflow: "hidden",
    boxShadow: "0 18px 80px rgba(0,0,0,0.35)",
  } as const;
}
function inputStyle() {
  return {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: border(),
    background: "Canvas",
    color: "CanvasText",
    outline: "none",
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 13,
  } as const;
}

export default function AdminNav(props: { orgId: string; contractId?: string; versionId?: string; active?: "contracts"|"contract"|"payloads"|"packet"|"editor" }) {
  const { orgId, contractId, versionId } = props;
  const active = props.active;

  const base = useMemo(() => ({
    contracts: `/admin/contracts?orgId=${encodeURIComponent(orgId)}`,
    contract: contractId ? `/admin/contracts/${encodeURIComponent(contractId)}?orgId=${encodeURIComponent(orgId)}` : "",
    payloads: contractId ? `/admin/contracts/${encodeURIComponent(contractId)}/payloads?orgId=${encodeURIComponent(orgId)}` : "",
    packet: contractId ? `/admin/contracts/${encodeURIComponent(contractId)}/packet?orgId=${encodeURIComponent(orgId)}&versionId=${encodeURIComponent(versionId || "v1")}` : "",
  }), [orgId, contractId, versionId]);

  const items: CmdItem[] = useMemo(() => {
    const out: CmdItem[] = [];
    out.push({ label: "Contracts", hint: "List", href: base.contracts });
    if (contractId) {
      out.push({ label: "Contract Overview", hint: contractId, href: base.contract });
      out.push({ label: "Payloads", hint: "Schemas", href: base.payloads });
      out.push({ label: "Packet Preview", hint: "Tree + JSON", href: base.packet });
    }
    return out;
  }, [base, contractId]);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    return items.filter(x => (x.label + " " + (x.hint || "")).toLowerCase().includes(t));
  }, [q, items]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.key.toLowerCase() === "k") && (e.metaKey || e.ctrlKey);
      if (isCmdK) { e.preventDefault(); setOpen(v => !v); }
      if (!open) return;

      if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setIdx(i => Math.min(i + 1, Math.max(0, filtered.length - 1))); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        const hit = filtered[idx];
        if (hit?.href) window.location.href = hit.href;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, idx]);

  useEffect(() => {
    if (open) { setQ(""); setIdx(0); }
  }, [open]);

  return (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap: 12, flexWrap:"wrap" }}>
      <div style={{ display:"flex", gap: 10, flexWrap:"wrap", alignItems:"center" }}>
        <a href={base.contracts} style={pill(active === "contracts")}>← Contracts</a>
        {contractId && <a href={base.contract} style={pill(active === "contract")}>Contract Overview</a>}
        {contractId && <a href={base.payloads} style={pill(active === "payloads" || active === "editor")}>Payloads</a>}
        {contractId && <a href={base.packet} style={pill(active === "packet")}>Packet Preview</a>}
      </div>

      <div style={{ display:"flex", gap: 10, alignItems:"center", flexWrap:"wrap" }}>
        <button type="button" onClick={() => setOpen(true)} style={pill(false)}>
          ⌘K
          <span style={{ opacity: 0.65, fontWeight: 800, fontSize: 12 }}>Jump</span>
        </button>
      </div>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position:"fixed", inset:0,
            background:"rgba(0,0,0,0.55)",
            backdropFilter:"blur(10px)",
            display:"grid",
            placeItems:"start center",
            paddingTop: 90,
            zIndex: 9999,
          }}
        >
          <div onClick={(e)=>e.stopPropagation()} style={{ width:"min(720px, 92vw)" }}>
            <div style={panel()}>
              <div style={{ padding: 14 }}>
                <input
                  autoFocus
                  value={q}
                  onChange={(e)=>{ setQ(e.target.value); setIdx(0); }}
                  placeholder="Type to jump… (Contracts, Payloads, Packet)"
                  style={inputStyle()}
                />
                <div style={{ marginTop: 8, opacity: 0.7, fontSize: 12 }}>
                  Enter to open · Esc to close · ↑/↓ to navigate
                </div>
              </div>

              <div style={{ borderTop: border() }}>
                {filtered.length === 0 && (
                  <div style={{ padding: 14, opacity: 0.75 }}>No matches.</div>
                )}
                {filtered.map((x, i) => (
                  <a
                    key={x.href}
                    href={x.href}
                    onMouseEnter={()=>setIdx(i)}
                    style={{
                      display:"flex",
                      justifyContent:"space-between",
                      gap: 12,
                      padding:"12px 14px",
                      textDecoration:"none",
                      color:"CanvasText",
                      background: i === idx ? "color-mix(in oklab, CanvasText 10%, transparent)" : "transparent",
                      borderTop: i === 0 ? "none" : border(),
                    }}
                  >
                    <div style={{ fontWeight: 900 }}>{x.label}</div>
                    <div style={{ opacity: 0.7, fontFamily:"ui-monospace, Menlo, monospace", fontSize: 12 }}>{x.hint || ""}</div>
                  </a>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
TSX
echo "✅ wrote AdminNav.tsx"

echo "==> (2) Write PrettyJson component (better readability + copy + wrap)"
cat > "$NEXT/src/app/admin/_components/PrettyJson.tsx" <<'TSX'
"use client";

import { useMemo, useState } from "react";

function border() {
  return "1px solid color-mix(in oklab, CanvasText 14%, transparent)";
}
function btn(active = false) {
  return {
    padding: "7px 10px",
    borderRadius: 12,
    border: border(),
    background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontWeight: 900,
    cursor: "pointer",
  } as const;
}

export default function PrettyJson(props: { value: any; title?: string; defaultWrap?: boolean }) {
  const { value, title } = props;
  const [wrap, setWrap] = useState(props.defaultWrap ?? false);

  const text = useMemo(() => {
    try {
      return JSON.stringify(value ?? {}, null, 2);
    } catch {
      return String(value ?? "");
    }
  }, [value]);

  async function copy() {
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  return (
    <div style={{ border: border(), borderRadius: 14, overflow:"hidden", background:"color-mix(in oklab, CanvasText 3%, transparent)" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap: 10, padding:"10px 12px", borderBottom: border() }}>
        <div style={{ fontWeight: 900 }}>{title || "Preview"}</div>
        <div style={{ display:"flex", gap: 8 }}>
          <button type="button" onClick={()=>setWrap(w=>!w)} style={btn(wrap)}>{wrap ? "Wrap: On" : "Wrap: Off"}</button>
          <button type="button" onClick={copy} style={btn(false)}>Copy</button>
        </div>
      </div>

      <pre style={{
        margin: 0,
        padding: 14,
        fontFamily: "ui-monospace, Menlo, monospace",
        fontSize: 13,
        lineHeight: 1.55,
        whiteSpace: wrap ? "pre-wrap" : "pre",
        overflow: "auto",
        tabSize: 2 as any,
      }}>
{text}
      </pre>
    </div>
  );
}
TSX
echo "✅ wrote PrettyJson.tsx"

echo "==> (3) Patch pages to import AdminNav/PrettyJson (fix broken import paths)"
python3 - <<'PY'
from pathlib import Path
root = Path("next-app/src/app/admin")

# files we want to ensure nav exists on (safe list; adjust later)
targets = [
  root / "contracts" / "page.tsx",
  root / "contracts" / "[id]" / "page.tsx",
  root / "contracts" / "[id]" / "payloads" / "page.tsx",
  root / "contracts" / "[id]" / "payloads" / "[payloadId]" / "page.tsx",
  root / "contracts" / "[id]" / "packet" / "page.tsx",
]

def rel_import(from_file: Path, comp_file: Path):
  # return relative import path without extension
  rel = comp_file.relative_to(from_file.parent)
  s = str(rel).replace("\\", "/")
  if s.endswith(".tsx"): s = s[:-4]
  if not s.startswith("."):
    s = "./" + s
  return s

admin_nav = root / "_components" / "AdminNav.tsx"
pretty = root / "_components" / "PrettyJson.tsx"

changed = 0
for f in targets:
  if not f.exists():
    continue
  s = f.read_text(errors="ignore")

  nav_path = rel_import(f, admin_nav)
  s2 = s

  # normalize any AdminNav import that was wrong
  import_line = f'import AdminNav from "{nav_path}";'
  # remove existing AdminNav import lines
  lines = s2.splitlines()
  lines = [ln for ln in lines if "AdminNav" not in ln or "import" not in ln]
  s2 = "\n".join(lines)

  # inject AdminNav import after "use client" if present, else at top
  if '"use client";' in s2:
    s2 = s2.replace('"use client";', '"use client";\n\n' + import_line)
  else:
    s2 = import_line + "\n" + s2

  # Packet page: ensure PrettyJson import exists (used in preview)
  if f.name == "page.tsx" and f.parent.name == "packet":
    pj_path = rel_import(f, pretty)
    if f'import PrettyJson from "{pj_path}";' not in s2:
      s2 = s2.replace(import_line, import_line + "\n" + f'import PrettyJson from "{pj_path}";')

  if s2 != s:
    f.write_text(s2)
    changed += 1
    print("✅ patched:", f)

print("✅ page patch complete (files changed:", changed, ")")
PY

echo "==> (4) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
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

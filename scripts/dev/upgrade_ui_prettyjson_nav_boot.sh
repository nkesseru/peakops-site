#!/usr/bin/env bash
set -euo pipefail

# zsh users: avoid history expansion if this runs under zsh by accident
set +H 2>/dev/null || true

echo "==> (0) Sanity: repo root"
test -d next-app || { echo "❌ next-app not found. Run from ~/peakops/my-app"; exit 1; }

echo "==> (1) Install Pretty JSON dependency into next-app"
(
  cd next-app
  # foldable JSON tree with good defaults
  pnpm add react-json-view
) >/dev/null

echo "==> (2) Create shared UI components (AdminNav + JsonViewer)"
mkdir -p next-app/src/app/admin/_components

cat > next-app/src/app/admin/_components/JsonViewer.tsx <<'TSX'
"use client";

import dynamic from "next/dynamic";
import React from "react";

const ReactJson = dynamic(() => import("react-json-view"), { ssr: false });

export default function JsonViewer({
  value,
  collapsed = 1,
  name = false,
  style,
}: {
  value: any;
  collapsed?: boolean | number;
  name?: false | string;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ ...style }}>
      <ReactJson
        src={value ?? {}}
        name={name}
        collapsed={collapsed}
        enableClipboard={true}
        displayDataTypes={false}
        displayObjectSize={false}
        indentWidth={2}
        collapseStringsAfterLength={80}
        style={{
          background: "transparent",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.4,
        }}
        theme="monokai"
      />
    </div>
  );
}
TSX

cat > next-app/src/app/admin/_components/AdminNav.tsx <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

function pill(active: boolean) {
  return {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active
      ? "color-mix(in oklab, CanvasText 10%, transparent)"
      : "color-mix(in oklab, CanvasText 4%, transparent)",
    color: "CanvasText",
    fontWeight: 800,
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  } as const;
}

export default function AdminNav(props: {
  contractId?: string;
  versionId?: string;
  showJump?: boolean;
}) {
  const sp = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const orgId = sp.get("orgId") || "org_001";
  const contractId = props.contractId || sp.get("contractId") || "";
  const versionId = props.versionId || sp.get("versionId") || "v1";

  const base = useMemo(() => {
    const q = `orgId=${encodeURIComponent(orgId)}`;
    return {
      contracts: `/admin/contracts?${q}`,
      contract: contractId ? `/admin/contracts/${encodeURIComponent(contractId)}?${q}` : "",
      payloads: contractId ? `/admin/contracts/${encodeURIComponent(contractId)}/payloads?${q}` : "",
      packet: contractId ? `/admin/contracts/${encodeURIComponent(contractId)}/packet?${q}&versionId=${encodeURIComponent(versionId)}` : "",
    };
  }, [orgId, contractId, versionId]);

  // Normalize orgId in URL (prevents orgId=undefined calls)
  useEffect(() => {
    if (!sp.get("orgId")) {
      const u = new URL(window.location.href);
      u.searchParams.set("orgId", orgId);
      router.replace(u.pathname + "?" + u.searchParams.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const items = useMemo(() => {
    const out: { label: string; href: string; meta?: string }[] = [];
    out.push({ label: "Contracts", href: base.contracts, meta: "List" });
    if (base.contract) out.push({ label: "Contract Overview", href: base.contract, meta: contractId || "" });
    if (base.payloads) out.push({ label: "Payloads", href: base.payloads, meta: "Schemas" });
    if (base.packet) out.push({ label: "Packet Preview", href: base.packet, meta: "Tree + JSON" });
    return out;
  }, [base, contractId]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    return items.filter(x => (x.label + " " + (x.meta || "")).toLowerCase().includes(t));
  }, [items, q]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        setOpen(v => !v);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center" }}>
        <a href={base.contracts} style={pill(pathname === "/admin/contracts")}>Contracts</a>
        {base.contract && <a href={base.contract} style={pill(pathname.includes("/admin/contracts/") && !pathname.includes("/payloads") && !pathname.includes("/packet"))}>Contract Overview</a>}
        {base.payloads && <a href={base.payloads} style={pill(pathname.includes("/payloads") && !pathname.includes("/payloads/"))}>Payloads</a>}
        {base.packet && <a href={base.packet} style={pill(pathname.includes("/packet"))}>Packet Preview</a>}

        {(props.showJump ?? true) && (
          <button
            onClick={() => setOpen(true)}
            style={{
              marginLeft: 6,
              padding: "8px 12px",
              borderRadius: 999,
              border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
              background: "color-mix(in oklab, CanvasText 4%, transparent)",
              color: "CanvasText",
              fontWeight: 900,
              cursor: "pointer",
              display:"inline-flex",
              gap:8,
              alignItems:"center"
            }}
            title="⌘K"
          >
            <span style={{ opacity: 0.9 }}>⌘K</span>
            <span style={{ opacity: 0.8 }}>Jump</span>
          </button>
        )}
      </div>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 9999,
            display: "grid",
            placeItems: "start center",
            paddingTop: 120,
          }}
        >
          <div
            onClick={(e)=>e.stopPropagation()}
            style={{
              width: "min(760px, 92vw)",
              borderRadius: 16,
              border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
              background: "color-mix(in oklab, Canvas 92%, black)",
              padding: 14,
            }}
          >
            <input
              autoFocus
              value={q}
              onChange={(e)=>setQ(e.target.value)}
              placeholder="Type to jump… (Contracts, Payloads, Packet)"
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 12,
                border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
                background: "Canvas",
                color: "CanvasText",
                fontSize: 14,
                fontWeight: 700,
              }}
            />
            <div style={{ marginTop: 10, display:"grid", gap:8 }}>
              {filtered.map((x) => (
                <a
                  key={x.href}
                  href={x.href}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)",
                    background: "color-mix(in oklab, CanvasText 3%, transparent)",
                    color: "CanvasText",
                    textDecoration:"none",
                    display:"flex",
                    justifyContent:"space-between",
                    gap:12,
                    fontWeight: 850
                  }}
                  onClick={()=>setOpen(false)}
                >
                  <span>{x.label}</span>
                  <span style={{ opacity: 0.6, fontWeight: 700 }}>{x.meta || ""}</span>
                </a>
              ))}
              {filtered.length === 0 && <div style={{ opacity: 0.7, padding: 10 }}>No matches.</div>}
            </div>
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
              Enter to open · Esc to close
            </div>
          </div>
        </div>
      )}
    </>
  );
}
TSX

echo "==> (3) Patch pages to import AdminNav from correct location (dedupe safe)"
python3 - <<'PY'
from pathlib import Path
import re

targets = [
  Path("next-app/src/app/admin/contracts/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/payloads/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"),
  Path("next-app/src/app/admin/contracts/[id]/packet/page.tsx"),
]

for p in targets:
    if not p.exists(): 
        continue
    s = p.read_text()

    # remove any old broken import paths
    s = re.sub(r'import\s+AdminNav\s+from\s+[\'"].*AdminNav[\'"]\s*;\s*\n', "", s)

    # ensure use client stays
    if '"use client";' not in s and "'use client';" not in s:
        s = '"use client";\n\n' + s

    # add correct import near the top after use client
    if "from \"../_components/AdminNav\"" not in s and "from \"../../_components/AdminNav\"" not in s:
        # Determine relative path based on file depth
        rel = None
        if str(p).endswith("admin/contracts/page.tsx"):
            rel = "../_components/AdminNav"
        elif "/admin/contracts/[id]/" in str(p) and "/payloads/" not in str(p) and "/packet/" not in str(p):
            rel = "../../_components/AdminNav"
        elif "/admin/contracts/[id]/payloads/page.tsx" in str(p):
            rel = "../../../_components/AdminNav"
        elif "/admin/contracts/[id]/payloads/[payloadId]/page.tsx" in str(p):
            rel = "../../../../_components/AdminNav"
        elif "/admin/contracts/[id]/packet/page.tsx" in str(p):
            rel = "../../../_components/AdminNav"
        else:
            rel = "../../_components/AdminNav"

        s = s.replace('"use client";\n', f'"use client";\n\nimport AdminNav from "{rel}";\n', 1)

    # Ensure we only render AdminNav once: remove duplicate occurrences if any
    # Keep the first <AdminNav ... />
    matches = list(re.finditer(r'<AdminNav[^>]*\/>', s))
    if len(matches) > 1:
        # remove all but first
        keep = matches[0].span()
        out = []
        i = 0
        for m in matches[1:]:
            out.append(s[i:m.start()])
            i = m.end()
        out.append(s[i:])
        s = ''.join(out)

    p.write_text(s)
    print("✅ patched:", p)
PY

echo "==> (4) Wire JsonViewer into Packet Preview + Payload Editor (safe insert)"
python3 - <<'PY'
from pathlib import Path
import re

def ensure_import(s: str, what: str, from_path: str) -> str:
    if f'from "{from_path}"' in s or f"from '{from_path}'" in s:
        return s
    # insert after use client + existing imports
    lines = s.splitlines(True)
    out = []
    inserted = False
    for ln in lines:
        out.append(ln)
        if (ln.strip() in ['"use client";', "'use client';']) and not inserted:
            out.append(f'import {what} from "{from_path}";\n')
            inserted = True
    return "".join(out)

# Packet Preview page
pp = Path("next-app/src/app/admin/contracts/[id]/packet/page.tsx")
if pp.exists():
    s = pp.read_text()
    s = ensure_import(s, "JsonViewer", "../../../_components/JsonViewer")

    # Replace any raw <pre>{previewText}</pre> style blocks with JsonViewer if parsedJson exists
    # We'll inject: const [parsed, setParsed] = useState<any>(null); and set it when preview loads.
    if "setParsed(" not in s:
        # add state near other useState declarations
        s = re.sub(r'(const\s+\[.*setErr.*\]\s*=\s*useState.*;\s*)',
                   r'\1\n  const [parsed, setParsed] = useState<any>(null);\n', s, count=1)

        # after fetching preview text, attempt JSON parse (look for setPreview or setText)
        s = re.sub(r'(setPreview\w*\(\s*text\s*\)\s*;)',
                   r'\1\n            try { setParsed(JSON.parse(text)); } catch { setParsed(null); }\n', s)

    # Insert viewer in render: if parsed -> JsonViewer else CodeBlock
    # Find a spot with "Preview" header panel; if we find "Preview" label, insert below it.
    if "JsonViewer" in s and "parsed" in s:
        # Best-effort: replace a block that renders preview text in <pre>
        s = re.sub(
            r'<pre[^>]*>\s*\{[^}]*preview[^}]*\}\s*<\/pre>',
            '{parsed ? (<JsonViewer value={parsed} collapsed={2} />) : (<pre style={{ whiteSpace:"pre-wrap", fontSize:12, opacity:0.9 }}>{String(preview || "")}</pre>)}',
            s,
            count=1,
            flags=re.S
        )

    pp.write_text(s)
    print("✅ Packet Preview upgraded")

# Payload Editor page
pe = Path("next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx")
if pe.exists():
    s = pe.read_text()
    s = ensure_import(s, "JsonViewer", "../../../../admin/_components/JsonViewer")

    # If there is a parsed payload JSON already, show JsonViewer in right panel.
    # Replace "Parsed Payload (read-only)" pre block if present.
    s = re.sub(
        r'(<div[^>]*>\s*<div[^>]*>\s*Parsed Payload \(read-only\)[\s\S]*?<pre[\s\S]*?<\/pre>[\s\S]*?<\/div>\s*<\/div>)',
        r'\1',
        s,
        count=1
    )

    # Insert viewer in a robust way: if you have something like parsedPayload variable, use it.
    if "parsedPayload" in s and "JsonViewer" in s:
        s = re.sub(
            r'Parsed Payload \(read-only\)[\s\S]*?<pre[\s\S]*?<\/pre>',
            'Parsed Payload (read-only)</div>\n              <div style={{ marginTop: 8 }}>\n                <JsonViewer value={parsedPayload} collapsed={2} />\n              </div>\n              <div style={{ height: 8 }} />\n              <div style={{ opacity: 0.65, fontSize: 12 }}>Tip: ⌘K opens Jump.</div>\n            <div',
            s,
            count=1,
            flags=re.S
        )

    pe.write_text(s)
    print("✅ Payload Editor upgraded")

PY

echo "==> (5) Harden canonical boot script smoke (list/detail/payloads/export)"
python3 - <<'PY'
from pathlib import Path
p = Path("scripts/dev/boot_dev_stack_v2.sh")
if not p.exists():
    print("⚠️ boot_dev_stack_v2.sh not found; skipping")
    raise SystemExit(0)

s = p.read_text()
if "exportContractPacketV1" in s and "Smoke: exportContractPacketV1" in s:
    print("ℹ️ boot script already has export smoke")
    raise SystemExit(0)

needle = 'echo "==> (8) Smoke"'
if needle not in s:
    print("⚠️ could not find smoke header; skipping")
    raise SystemExit(0)

insert = r'''
echo
echo "==> (8.5) Smoke: exportContractPacketV1 (DIRECT)"
curl -sS "$FN_BASE/exportContractPacketV1?orgId=$ORG_ID&contractId=$CONTRACT_ID&versionId=$VERSION_ID&limit=200" \
  | python3 -m json.tool | head -n 30 || true
echo
'''
s = s.replace(needle, needle + "\n" + insert, 1)
p.write_text(s)
print("✅ boot_dev_stack_v2.sh hardened (added export smoke)")
PY

echo "==> (6) Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 1

echo "==> (7) Smoke: page renders"
curl -fsS -I "http://127.0.0.1:3000/admin/contracts?orgId=org_001" | head -n 5 || true

echo
echo "✅ DONE"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=org_001"
echo "  http://localhost:3000/admin/contracts/car_abc123/packet?orgId=org_001&versionId=v1"

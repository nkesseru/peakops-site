#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
COMP_DIR="next-app/src/app/admin/_components"
mkdir -p "$COMP_DIR" scripts/dev/_bak .logs

ts="$(date +%Y%m%d_%H%M%S)"
cp "$PAGE" "scripts/dev/_bak/incidents_page_${ts}.tsx"
echo "✅ backup: scripts/dev/_bak/incidents_page_${ts}.tsx"

########################################
# (A) New reusable components
########################################

cat > "$COMP_DIR/BackendBadge.tsx" <<'TSX'
"use client";

import React, { useEffect, useState } from "react";

type Props = { orgId: string; incidentId: string };

function pill(ok: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: ok ? "color-mix(in oklab, lime 18%, transparent)" : "color-mix(in oklab, red 18%, transparent)",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 900,
    userSelect: "none",
  };
}

export default function BackendBadge({ orgId, incidentId }: Props) {
  const [ok, setOk] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string>("checking…");

  useEffect(() => {
    let cancelled = false;
    async function ping() {
      try {
        const url =
          `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}`;
        const r = await fetch(url, { method: "GET" });
        const t = await r.text();
        if (!t || !t.trim()) throw new Error(`empty (HTTP ${r.status})`);
        const j = JSON.parse(t);
        if (j?.ok === false) throw new Error(j?.error || "ok:false");
        if (!cancelled) {
          setOk(true);
          setMsg("backend ok");
        }
      } catch (e: any) {
        if (!cancelled) {
          setOk(false);
          setMsg(String(e?.message || e).slice(0, 60));
        }
      }
    }
    ping();
    return () => { cancelled = true; };
  }, [orgId, incidentId]);

  if (ok === null) return <span style={pill(false)}>backend…</span>;
  return <span style={pill(!!ok)}>{ok ? "Backend: OK" : `Backend: ${msg}`}</span>;
}
TSX

cat > "$COMP_DIR/TimelinePreviewMock.tsx" <<'TSX'
"use client";

import React, { useState } from "react";

type Item = { t: string; title: string; desc: string };

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
    padding: 12,
  };
}

export default function TimelinePreviewMock() {
  const [open, setOpen] = useState(false);

  const items: Item[] = [
    { t: "T+0", title: "Incident created", desc: "Basic incident record exists." },
    { t: "T+5m", title: "Timeline generated", desc: "Events ordered oldest → newest." },
    { t: "T+10m", title: "Filings generated", desc: "DIRS / OE-417 / NORS / SAR / BABA payloads created." },
    { t: "T+15m", title: "Packet exported", desc: "ZIP + hashes produced for audit." },
  ];

  return (
    <div style={{ marginTop: 10 }}>
      <div
        onClick={() => setOpen(!open)}
        style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9, userSelect: "none" }}
      >
        {open ? "▼" : "▶"} Timeline Preview (mock)
      </div>

      {!open ? (
        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
          (Mock) UI contract for the real timeline engine.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          {items.map((it) => (
            <div key={it.title} style={card()}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontWeight: 950 }}>{it.title}</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>{it.t}</div>
              </div>
              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>{it.desc}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
TSX

cat > "$COMP_DIR/FilingMetaStub.tsx" <<'TSX'
"use client";

import React, { useState } from "react";

type Props = { incident?: any };

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
    padding: 12,
  };
}

export default function FilingMetaStub({ incident }: Props) {
  const [open, setOpen] = useState(false);

  const filingsMeta = incident?.filingsMeta ?? null;
  const timelineMeta = incident?.timelineMeta ?? null;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={card()}>
        <div style={{ fontWeight: 950, marginBottom: 6 }}>Packet State (stub)</div>

        <div style={{ display: "grid", gap: 6, fontSize: 13, opacity: 0.9 }}>
          <div>
            <span style={{ opacity: 0.7 }}>filingsMeta:</span>{" "}
            {filingsMeta ? "✅ present" : "—"}
          </div>
          <div>
            <span style={{ opacity: 0.7 }}>timelineMeta:</span>{" "}
            {timelineMeta ? "✅ present" : "—"}
          </div>

          <div style={{ fontSize: 12, opacity: 0.75 }}>
            (Stub) This becomes the canonical packet readiness panel.
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <div
            onClick={() => setOpen(!open)}
            style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9, userSelect: "none" }}
          >
            {open ? "▼" : "▶"} View meta JSON
          </div>

          {open && (
            <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
{JSON.stringify({ filingsMeta, timelineMeta }, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
TSX

echo "✅ wrote components: BackendBadge, TimelinePreviewMock, FilingMetaStub"

########################################
# (B) Patch incidents page once (markers)
########################################

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 1) Ensure imports exist
def ensure_import(line: str):
    nonlocal_s = None

# Add imports if missing
imports = [
  'import BackendBadge from "../_components/BackendBadge";',
  'import TimelinePreviewMock from "../_components/TimelinePreviewMock";',
  'import FilingMetaStub from "../_components/FilingMetaStub";',
]
for imp in imports:
    if imp not in s:
        # insert after first react import line
        m = re.search(r'^import .*from "react";\s*$', s, re.M)
        if m:
            s = s[:m.end()] + "\n" + imp + s[m.end():]
        else:
            # fallback near top
            s = imp + "\n" + s

# 2) Add BackendBadge into the top header row (safe marker)
if "/*__BACKEND_BADGE__*/" not in s:
    # find the first header row that contains Refresh button (very common in your page)
    # insert badge before Refresh button
    s = re.sub(
        r'(<button[^>]*onClick=\{load\}[^>]*>[\s\S]*?</button>)',
        r'/*__BACKEND_BADGE__*/\n<div style={{ display:"flex", gap:10, alignItems:"center" }}>\n  <BackendBadge orgId={orgId} incidentId={incidentId} />\n  \1\n</div>',
        s,
        count=1
    )

# 3) Replace or insert the “extras” block under Guided Workflow (safe markers)
EXTRA_START="/*__PHASE2_EXTRAS_START__*/"
EXTRA_END="/*__PHASE2_EXTRAS_END__*/"
extras = f"""{EXTRA_START}
<TimelinePreviewMock />
<FilingMetaStub incident={{wf?.incident}} />
{EXTRA_END}"""

# Remove duplicate Packet State stubs if they exist (best-effort)
s = re.sub(r'<Panel[^>]*title="Packet State[\s\S]*?</Panel>\s*', '', s)
s = re.sub(r'Packet State \(stub\)[\s\S]*?View meta JSON[\s\S]*?(?:</pre>\s*)?', '', s)

if EXTRA_START in s and EXTRA_END in s:
    s = re.sub(re.escape(EXTRA_START) + r'[\s\S]*?' + re.escape(EXTRA_END), extras, s)
else:
    # Insert after first GuidedWorkflowPanel render if present
    m = re.search(r'<GuidedWorkflowPanel[^>]*/>\s*', s)
    if m:
        s = s[:m.end()] + "\n" + extras + s[m.end():]
    else:
        # fallback: insert before return closing
        t = s.rfind("return (")
        if t != -1:
            s = s[:t] + "\n" + extras + "\n" + s[t:]

p.write_text(s)
print("✅ patched incidents page: imports + backend badge + extras block")
PY

########################################
# (C) Restart + smoke
########################################
echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke: $URL"
if curl -fsS "$URL" >/dev/null ; then
  echo "✅ INCIDENT PAGE GREEN"
  echo "OPEN: $URL"
else
  echo "❌ still failing — tail next.log"
  tail -n 120 .logs/next.log || true
  exit 1
fi

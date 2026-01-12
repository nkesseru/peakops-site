#!/usr/bin/env bash
set -euo pipefail

cd ~/peakops/my-app
mkdir -p scripts/dev/_bak .logs

ts="$(date +%Y%m%d_%H%M%S)"

backup() {
  local f="$1"
  if [ -f "$f" ]; then
    cp "$f" "scripts/dev/_bak/$(basename "$f").bak_${ts}"
    echo "✅ backup: $f -> scripts/dev/_bak/$(basename "$f").bak_${ts}"
  fi
}

# ---------- Paths ----------
GWP="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
BADGE="next-app/src/app/admin/_components/BackendBadge.tsx"
EXPORT_ROUTE="next-app/src/app/api/fn/exportIncidentPacketV1/route.ts"
BUNDLE_PAGE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"

# ---------- 0) Ensure BackendBadge exists ----------
if [ ! -f "$BADGE" ]; then
  mkdir -p "$(dirname "$BADGE")"
  cat > "$BADGE" <<'TSX'
"use client";
import React from "react";

export default function BackendBadge(props: { ok: boolean }) {
  const ok = !!props.ok;
  return (
    <span
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
        background: ok
          ? "color-mix(in oklab, #22c55e 18%, transparent)"
          : "color-mix(in oklab, #ef4444 18%, transparent)",
        color: "CanvasText",
        fontSize: 12,
        fontWeight: 900,
        letterSpacing: 0.2,
        userSelect: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
      title={ok ? "Backend reachable" : "Backend not reachable"}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: ok ? "#22c55e" : "#ef4444",
          display: "inline-block",
        }}
      />
      {ok ? "Backend OK" : "Backend DOWN"}
    </span>
  );
}
TSX
  echo "✅ wrote: $BADGE"
fi

# ---------- 1) Ensure Next proxy route for exportIncidentPacketV1 exists ----------
if [ ! -f "$EXPORT_ROUTE" ]; then
  mkdir -p "$(dirname "$EXPORT_ROUTE")"
  cat > "$EXPORT_ROUTE" <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return proxyGET(req, "exportIncidentPacketV1");
}
TS
  echo "✅ wrote: $EXPORT_ROUTE"
fi

# ---------- 2) Ensure bundle page exists ----------
if [ ! -f "$BUNDLE_PAGE" ]; then
  mkdir -p "$(dirname "$BUNDLE_PAGE")"
  cat > "$BUNDLE_PAGE" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    padding: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
  };
}

function btn(): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    fontWeight: 900,
    textDecoration: "none",
    display: "inline-block",
    cursor: "pointer",
    color: "CanvasText",
  };
}

function safeJson(text: string): { ok: true; v: any } | { ok: false; err: string } {
  try {
    return { ok: true, v: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, err: String(e?.message || e) };
  }
}

export default function IncidentBundlePage() {
  const params = useParams() as any;
  const sp = useSearchParams();

  const orgId = sp.get("orgId") || "org_001";
  const incidentId = String(params?.id || "inc_TEST");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [packet, setPacket] = useState<any>(null);
  const [timeline, setTimeline] = useState<any>(null);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const pktUrl =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const tlUrl =
        `/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&limit=200`;

      const [pktR, tlR] = await Promise.all([fetch(pktUrl), fetch(tlUrl)]);
      const [pktT, tlT] = await Promise.all([pktR.text(), tlR.text()]);

      const pktP = safeJson(pktT || "");
      if (!pktP.ok) throw new Error(`Packet API non-JSON (HTTP ${pktR.status}): ${pktP.err}`);

      if (pktP.v?.ok === false) throw new Error(String(pktP.v?.error || "exportIncidentPacketV1 failed"));
      setPacket(pktP.v);

      const tlP = safeJson(tlT || "");
      if (tlP.ok && tlP.v?.ok !== false) setTimeline(tlP.v);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setPacket(null);
      setTimeline(null);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, [orgId, incidentId]);

  const packetMeta = packet?.packetMeta || packet?.meta || null;
  const packetHash = packetMeta?.packetHash || packet?.packetHash || "";
  const sizeBytes = packetMeta?.sizeBytes ?? packet?.sizeBytes ?? null;

  const timelineDocs = useMemo(() => {
    const docs = timeline?.docs;
    return Array.isArray(docs) ? docs : [];
  }, [timeline]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 950 }}>Admin · Incident Bundle</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button style={btn()} onClick={load} disabled={busy}>
            {busy ? "Loading…" : "Refresh"}
          </button>
          <Link
            href={`/admin/incidents/${encodeURIComponent(incidentId)}?orgId=${encodeURIComponent(orgId)}`}
            style={{ ...btn(), opacity: 0.9 }}
          >
            Back to Incident
          </Link>
        </div>
      </div>

      {err && (
        <div style={{ marginTop: 12, color: "crimson", fontWeight: 900 }}>
          {err}
        </div>
      )}

      <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
        <section style={card()}>
          <div style={{ fontWeight: 950 }}>Packet Meta</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
            packetHash: <b>{packetHash || "—"}</b><br />
            sizeBytes: <b>{sizeBytes ?? "—"}</b>
          </div>

          <div style={{ marginTop: 10 }}>
            <a
              href={`/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`}
              style={btn()}
            >
              Generate / Refresh Packet (dev)
            </a>
          </div>

          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>View raw JSON</summary>
            <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
              {JSON.stringify(packet, null, 2)}
            </pre>
          </details>
        </section>

        <section style={card()}>
          <div style={{ fontWeight: 950 }}>Timeline</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
            events: <b>{timelineDocs.length}</b> (oldest → newest)
          </div>
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>View events</summary>
            <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
              {JSON.stringify(timelineDocs, null, 2)}
            </pre>
          </details>
        </section>

        <section style={{ ...card(), fontSize: 12, opacity: 0.85 }}>
          Read-only bundle view. Goal: immutable “shareable artifact” + audit trail.
        </section>
      </div>
    </div>
  );
}
TSX
  echo "✅ wrote: $BUNDLE_PAGE"
fi

# ---------- 3) Patch GuidedWorkflowPanel export button + exportNow ----------
backup "$GWP"

python3 - <<'PY'
from pathlib import Path

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

orig = s

# Ensure pill() exists (some patches used pill but later removed it)
if "function pill(" not in s:
  # insert right after card() if present, else after imports
  insert = """
function pill(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active
      ? "color-mix(in oklab, CanvasText 10%, transparent)"
      : "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
    userSelect: "none",
    textDecoration: "none",
    lineHeight: "16px",
  };
}
""".strip("\n") + "\n\n"

  idx = s.find("function card(")
  if idx != -1:
    # insert after the closing brace of card()
    end = s.find("}\n", idx)
    # find next blank line after card block
    end2 = s.find("\n\n", end)
    if end2 != -1:
      s = s[:end2+2] + insert + s[end2+2:]
    else:
      s = s + "\n\n" + insert
  else:
    # after imports
    imp_end = s.find("\n\n", s.find("import"))
    if imp_end != -1:
      s = s[:imp_end+2] + insert + s[imp_end+2:]
    else:
      s = insert + s

# Ensure exportNow() exists
if "function exportNow(" not in s and "async function exportNow(" not in s:
  # Insert exportNow right before the return (
  marker = "return ("
  pos = s.find(marker)
  if pos != -1:
    inject = """
  async function exportNow() {
    try {
      // Best-effort: trigger backend export (doesn't matter if it fails in dev)
      setBusy(true);
      setErr("");

      const api =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const r = await fetch(api, { method: "GET" });
      const txt = await r.text().catch(() => "");

      // If backend returns JSON ok:false, surface it. Otherwise ignore.
      try {
        const j = JSON.parse(txt || "{}");
        if (j?.ok === false) setErr(String(j?.error || "exportIncidentPacketV1 failed"));
      } catch {
        // ignore non-JSON (Next HTML error etc)
      }

      // Always open bundle page (your canonical artifact view)
      const bundleUrl =
        `/admin/incidents/${encodeURIComponent(incidentId)}/bundle?orgId=${encodeURIComponent(orgId)}`;
      window.open(bundleUrl, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
""".strip("\n") + "\n\n"
    s = s[:pos] + inject + s[pos:]

# Add Export button UI if missing
if "onClick={exportNow}" not in s:
  # place inside header row near Refresh button: find first occurrence of "Refresh" button
  needle = "onClick={load}"
  i = s.find(needle)
  if i != -1:
    # insert a button AFTER the refresh button block end </button>
    end_btn = s.find("</button>", i)
    if end_btn != -1:
      end_btn2 = end_btn + len("</button>")
      add = """
        <button
          style={pill(false)}
          onClick={exportNow}
          disabled={busy}
          title="Generate the immutable packet + hashes (read-only export)"
        >
          Export
        </button>
""".rstrip("\n")
      s = s[:end_btn2] + "\n" + add + s[end_btn2:]

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: ensured pill() + exportNow() + Export button")
PY

# ---------- Restart Next + smoke tests ----------
echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

INC_URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
BUNDLE_URL="http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"

echo "==> smoke incident page"
curl -fsS "$INC_URL" >/dev/null && echo "✅ incident page OK" || {
  echo "❌ incident page failing"
  tail -n 180 .logs/next.log || true
  exit 1
}

echo "==> smoke bundle page"
curl -fsS "$BUNDLE_URL" >/dev/null && echo "✅ bundle page OK" || {
  echo "❌ bundle page failing"
  tail -n 180 .logs/next.log || true
  exit 1
}

echo
echo "✅ PATCH COMPLETE"
echo "OPEN:"
echo "  $INC_URL"
echo "  $BUNDLE_URL"
echo
echo "LOGS:"
echo "  tail -n 120 .logs/next.log"
echo "  tail -n 120 .logs/emulators.log"

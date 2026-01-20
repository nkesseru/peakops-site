#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

DIR="next-app/src/app/admin/incidents/[id]/bundle"
FILE="$DIR/page.tsx"
mkdir -p "$DIR"

if [ -f "$FILE" ]; then
  ts="$(date +%Y%m%d_%H%M%S)"
  cp "$FILE" "$FILE.bak_${ts}"
  echo "✅ backup: $FILE.bak_${ts}"
fi

cat > "$FILE" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    padding: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
  };
}

function pill(active?: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active ? "color-mix(in oklab, lime 18%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 900,
    textDecoration: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
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
  const [wf, setWf] = useState<any>(null);
  const [timeline, setTimeline] = useState<any>(null);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      // workflow/meta
      const wfUrl =
        `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const wr = await fetch(wfUrl);
      const wtxt = await wr.text();
      const wp = safeJson(wtxt);
      if (!wp.ok) throw new Error(`getWorkflowV1 non-JSON (HTTP ${wr.status}): ${wp.err}`);
      if (wp.v?.ok === false) throw new Error(String(wp.v?.error || "getWorkflowV1 failed"));
      setWf(wp.v);

      // timeline
      const tUrl =
        `/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}` +
        `&limit=200`;

      const tr = await fetch(tUrl);
      const ttxt = await tr.text();
      const tp = safeJson(ttxt);
      if (!tp.ok) throw new Error(`getTimelineEvents non-JSON (HTTP ${tr.status}): ${tp.err}`);
      if (tp.v?.ok === false) throw new Error(String(tp.v?.error || "getTimelineEvents failed"));
      setTimeline(tp.v);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

  const packetMeta = wf?.packetMeta || wf?.meta?.packetMeta || wf?.incident?.packetMeta || null;
  const timelineMeta = wf?.timelineMeta || wf?.meta?.timelineMeta || wf?.incident?.timelineMeta || null;
  const filingsMeta = wf?.filingsMeta || wf?.meta?.filingsMeta || wf?.incident?.filingsMeta || null;

  const packetReady = !!(packetMeta && (packetMeta.packetHash || packetMeta.hash) && Number(packetMeta.sizeBytes || 0) > 0);

  const backHref = useMemo(
    () => `/admin/incidents/${encodeURIComponent(incidentId)}?orgId=${encodeURIComponent(orgId)}`,
    [incidentId, orgId]
  );

  const exportHref = useMemo(
    () =>
      `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}` +
      `&limit=200`,
    [incidentId, orgId]
  );

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText", display: "grid", gap: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 950 }}>Incident Bundle</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={load} disabled={busy} style={pill(false)}>
            {busy ? "Loading…" : "Refresh"}
          </button>
          <Link href={backHref} style={pill(false)}>
            ← Back to Incident
          </Link>
        </div>
      </div>

      {err && <div style={{ ...card(), color: "crimson", fontWeight: 900 }}>{err}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div style={card()}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
            <div style={{ fontWeight: 950 }}>Packet Readiness</div>
            <span style={pill(packetReady)}>{packetReady ? "READY" : "NOT READY"}</span>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
            <div>timelineMeta: {timelineMeta ? "✅ present" : "—"}</div>
            <div>filingsMeta: {filingsMeta ? "✅ present" : "—"}</div>
            <div>packetMeta: {packetMeta ? "✅ present" : "—"}</div>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a href={exportHref} style={pill(false)}>
              Download Packet ZIP
            </a>
          </div>

          {packetMeta && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>View packetMeta</summary>
              <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
{JSON.stringify(packetMeta, null, 2)}
              </pre>
            </details>
          )}
        </div>

        <div style={card()}>
          <div style={{ fontWeight: 950 }}>Timeline Snapshot</div>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
            Events: <b>{Number(timeline?.count || 0)}</b>
          </div>

          {!!timeline?.docs?.length && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>View events</summary>
              <pre style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 12, opacity: 0.9 }}>
{JSON.stringify(timeline?.docs, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </div>

      <div style={{ ...card(), fontSize: 12, opacity: 0.85 }}>
        Read-only bundle view. Goal: immutable “shareable artifact” for audit + evidence.
      </div>
    </div>
  );
}
TSX

echo "✅ wrote: $FILE"

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "==> smoke bundle page: $URL"
curl -fsS "$URL" >/dev/null \
  && echo "✅ bundle page loads" \
  || { echo "❌ bundle page failing"; tail -n 180 .logs/next.log; exit 1; }

echo "✅ DONE"
echo "OPEN:"
echo "  $URL"

#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"

mkdir -p "$(dirname "$FILE")" .logs scripts/dev/_bak

if [ -f "$FILE" ]; then
  cp "$FILE" "scripts/dev/_bak/incidents_id_page_${TS}.tsx"
  echo "✅ backup -> scripts/dev/_bak/incidents_id_page_${TS}.tsx"
fi

cat > "$FILE" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import AdminNav from "../_components/AdminNav";
import GuidedWorkflowPanel from "../_components/GuidedWorkflowPanel";

function panelCardStyle(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 16,
    padding: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
  };
}

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "transparent",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
    userSelect: "none",
  };
}

type WFResp = {
  ok: boolean;
  orgId?: string;
  incidentId?: string;
  workflow?: { version?: string; steps?: any[] };
  error?: string;
};

export default function AdminIncidentDetail() {
  const params = useParams() as any;
  const sp = useSearchParams();

  const orgId = sp.get("orgId") || "org_001";
  const incidentId = String(params?.id || "inc_TEST");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [wf, setWf] = useState<WFResp | null>(null);

  const stepsCount = useMemo(() => wf?.workflow?.steps?.length || 0, [wf]);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const url =
        `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const r = await fetch(url);
      const text = await r.text();

      let j: WFResp;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(`Workflow API returned non-JSON (HTTP ${r.status})`);
      }
      if (!j.ok) throw new Error(j.error || "getWorkflowV1 failed");
      setWf(j);
    } catch (e: any) {
      setWf(null);
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <AdminNav orgId={orgId} />

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 950 }}>Admin · Incident</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b> · Steps: <b>{stepsCount}</b>
          </div>
        </div>

        <button style={pill(false)} onClick={load} disabled={busy}>
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err ? (
        <div style={{ marginTop: 12, color: "crimson", fontWeight: 900 }}>
          {err}
        </div>
      ) : null}

      <div style={{ marginTop: 14 }}>
        <div style={panelCardStyle()}>
          <div style={{ fontWeight: 950, marginBottom: 8 }}>Guided Workflow</div>
          <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />
        </div>
      </div>

      <div style={{ marginTop: 14, display: "grid", gap: 12 }}>
        <div style={panelCardStyle()}>
          <div style={{ fontWeight: 950, marginBottom: 6 }}>Filing Meta</div>
          <div style={{ opacity: 0.7 }}>Not generated yet (Phase 2 UI wiring next).</div>
        </div>
        <div style={panelCardStyle()}>
          <div style={{ fontWeight: 950, marginBottom: 6 }}>Evidence Locker</div>
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </div>
        <div style={panelCardStyle()}>
          <div style={{ fontWeight: 950, marginBottom: 6 }}>Timeline</div>
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </div>
        <div style={panelCardStyle()}>
          <div style={{ fontWeight: 950, marginBottom: 6 }}>Filings</div>
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </div>
      </div>
    </div>
  );
}
TSX

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001"
echo "==> smoke $URL"
curl -fsS "$URL" >/dev/null && echo "✅ incidents page is green" || {
  echo "❌ still failing — tailing next.log"
  tail -n 120 .logs/next.log || true
  exit 1
}

echo
echo "OPEN:"
echo "  $URL"

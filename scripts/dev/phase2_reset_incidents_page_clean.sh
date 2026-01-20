#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p scripts/dev/_bak
cp "$FILE" "scripts/dev/_bak/incidents_id_page.${TS}.bak"
echo "✅ backup: scripts/dev/_bak/incidents_id_page.${TS}.bak"

cat > "$FILE" <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import AdminNav from "../../_components/AdminNav";

function pill(active: boolean) {
  return {
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active ? "color-mix(in oklab, CanvasText 10%, transparent)" : "transparent",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 800,
    textDecoration: "none",
    cursor: "pointer",
  } as const;
}

function Panel({ title, children }: { title: string; children: any }) {
  return (
    <div
      style={{
        border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
        borderRadius: 14,
        padding: 12,
        background: "color-mix(in oklab, CanvasText 3%, transparent)",
      }}
    >
      <div style={{ fontWeight: 950, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

type WFStep = { key: string; title?: string; hint?: string; status?: string };
type WFResp = { ok: boolean; orgId?: string; incidentId?: string; workflow?: { version?: string; steps?: WFStep[] }; error?: string };

export default function AdminIncidentDetail() {
  const sp = useSearchParams();
  const params = useParams() as any;

  const incidentId = String(params?.id || "inc_TEST");
  const orgId = sp.get("orgId") || "org_001";

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [wf, setWf] = useState<WFResp | null>(null);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`);
      const text = await r.text();
      const j = JSON.parse(text) as WFResp;
      if (!j.ok) throw new Error(j.error || "getWorkflowV1 failed");
      setWf(j);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  const steps = useMemo(() => (wf?.workflow?.steps || []), [wf]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <AdminNav orgId={orgId} incidentId={incidentId} />

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 950 }}>Admin · Incident</div>
          <div style={{ fontSize: 12, opacity: 0.8 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button style={pill(false)} onClick={load} disabled={busy}>
            {busy ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {err ? (
        <div style={{ marginTop: 12, color: "crimson", fontWeight: 900 }}>
          {err}
        </div>
      ) : null}

      <div style={{ marginTop: 14, display: "grid", gap: 14 }}>
        <Panel title="Guided Workflow">
          <div style={{ display: "grid", gap: 10 }}>
            {steps.length === 0 ? (
              <div style={{ opacity: 0.7 }}>No workflow steps.</div>
            ) : (
              steps.map((s, idx) => (
                <div
                  key={String(s.key || idx)}
                  style={{
                    border: "1px solid color-mix(in oklab, CanvasText 12%, transparent)",
                    borderRadius: 14,
                    padding: 12,
                    background: "color-mix(in oklab, CanvasText 2%, transparent)",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                    <div style={{ fontWeight: 950 }}>
                      {s.title || s.key}
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      <span style={{
                        padding: "3px 8px",
                        borderRadius: 999,
                        border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
                        background: "color-mix(in oklab, CanvasText 8%, transparent)",
                        fontWeight: 900,
                      }}>
                        {(s.status || "TODO").toUpperCase()}
                      </span>
                    </div>
                  </div>
                  {s.hint ? <div style={{ opacity: 0.75, fontSize: 13 }}>{s.hint}</div> : null}
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel title="Filing Meta">
          <div style={{ opacity: 0.7 }}>Not generated yet (Phase 2 UI wiring next).</div>
        </Panel>

        <Panel title="Evidence Locker">
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </Panel>

        <Panel title="Timeline">
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </Panel>

        <Panel title="Filings">
          <div style={{ opacity: 0.7 }}>Not wired yet (Phase 2 UI wiring next).</div>
        </Panel>
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

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents/[id] compiles now" \
  || { echo "❌ still failing"; tail -n 140 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"

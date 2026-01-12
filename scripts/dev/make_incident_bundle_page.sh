#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

DIR='next-app/src/app/admin/incidents/[id]/bundle'
FILE="$DIR/page.tsx"

mkdir -p "$DIR"

# Backup if exists
if [ -f "$FILE" ]; then
  TS="$(date +%Y%m%d_%H%M%S)"
  cp "$FILE" "$FILE.bak_$TS"
  echo "✅ backup: $FILE.bak_$TS"
fi

cat > "$FILE" <<'TSX'
"use client";

import React from "react";
import { useSearchParams, useParams } from "next/navigation";
import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";
import TimelinePreviewMock from "../../_components/TimelinePreviewMock";

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
    color: "CanvasText",
  };
}

export default function IncidentBundlePage() {
  const sp = useSearchParams();
  const params = useParams() as any;

  const incidentId = String(params?.id || "inc_TEST");
  const orgId = sp.get("orgId") || "org_001";

  return (
    <div style={{ padding: 24, display: "grid", gap: 16, color: "CanvasText" }}>
      <h1 style={{ fontSize: 22, fontWeight: 950, margin: 0 }}>Incident Bundle</h1>

      <section style={card()}>
        <div style={{ fontWeight: 900 }}>Incident</div>
        <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
          ID: <b>{incidentId}</b>
          <br />
          Org: <b>{orgId}</b>
        </div>
      </section>

      <section style={card()}>
        <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />
      </section>

      <section style={card()}>
        <TimelinePreviewMock orgId={orgId} incidentId={incidentId} />
      </section>

      <section style={card()}>
        <div style={{ fontWeight: 900 }}>Export</div>
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
          Read-only packet export.
        </div>
        <div style={{ marginTop: 10 }}>
          <a
            href={`/api/fn/exportEvidenceLockerZip?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(
              incidentId
            )}&limit=200`}
            style={btn()}
          >
            Download Incident Evidence ZIP
          </a>
        </div>
      </section>

      <div style={{ fontSize: 12, opacity: 0.75 }}>
        <a
          href={`/admin/incidents/${encodeURIComponent(incidentId)}?orgId=${encodeURIComponent(orgId)}`}
          style={{ textDecoration: "none", color: "CanvasText" }}
        >
          ← Back to Incident
        </a>
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

echo "✅ OPEN:"
echo "http://localhost:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo
echo "Edit (zsh-safe):"
echo "noglob nano '$FILE'"

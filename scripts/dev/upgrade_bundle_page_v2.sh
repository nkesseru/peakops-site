#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/bundle/page.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_$TS"
echo "✅ backup: $FILE.bak_$TS"

python3 - <<'PY'
from pathlib import Path

p = Path("next-app/src/app/admin/incidents/[id]/bundle/page.tsx")
s = p.read_text()

# If already upgraded, bail.
if "Immutable Incident Artifact" in s and "packetHash" in s and "sizeBytes" in s:
    print("✅ bundle v2 already present")
    raise SystemExit(0)

# Replace entire file with a clean, safe v2.
p.write_text(r'''"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

type PacketResp =
  | { ok: true; orgId: string; incidentId: string; packetMeta?: { packetHash?: string; sizeBytes?: number; generatedAt?: string } }
  | { ok: false; error: string };

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 16,
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
  };
}

function mono(): React.CSSProperties {
  return { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" };
}

function safeJson(text: string): { ok: true; v: any } | { ok: false; err: string } {
  try { return { ok: true, v: JSON.parse(text) }; } catch (e: any) { return { ok: false, err: String(e?.message || e) }; }
}

export default function IncidentBundlePage() {
  const params = useParams() as any;
  const sp = useSearchParams();

  const incidentId = String(params?.id || "inc_TEST");
  const orgId = sp.get("orgId") || "org_001";

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [packet, setPacket] = useState<PacketResp | null>(null);

  const exportUrl = useMemo(() => {
    return `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
  }, [orgId, incidentId]);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(exportUrl, { method: "GET" });
      const text = await r.text();
      if (!text || !text.trim()) throw new Error(`Export API returned empty body (HTTP ${r.status})`);
      const parsed = safeJson(text);
      if (!parsed.ok) throw new Error(`Export API returned non-JSON (HTTP ${r.status}): ${parsed.err}`);
      const j = parsed.v as PacketResp;
      if ((j as any)?.ok === false) throw new Error(String((j as any)?.error || "exportIncidentPacketV1 failed"));
      setPacket(j);
    } catch (e: any) {
      setPacket(null);
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [orgId, incidentId]);

  const meta = (packet && (packet as any).packetMeta) ? (packet as any).packetMeta : (packet as any)?.packetMeta;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 24, fontWeight: 950 }}>Immutable Incident Artifact</div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b>
          </div>
        </div>
        <button style={btn()} onClick={load} disabled={busy}>
          {busy ? "Loading…" : "Refresh"}
        </button>
      </div>

      {err && (
        <div style={{ ...card(), marginTop: 14, borderColor: "color-mix(in oklab, crimson 55%, transparent)" }}>
          <div style={{ fontWeight: 950, color: "crimson" }}>Load failed</div>
          <div style={{ marginTop: 8, ...mono(), fontSize: 12, whiteSpace: "pre-wrap" }}>{err}</div>
        </div>
      )}

      <div style={{ display: "grid", gap: 12, marginTop: 14 }}>
        <div style={card()}>
          <div style={{ fontWeight: 950 }}>Packet Meta</div>
          <div style={{ marginTop: 10, display: "grid", gap: 6, fontSize: 13, opacity: 0.9 }}>
            <div><span style={{ opacity: 0.7 }}>packetHash:</span> <span style={mono()}>{meta?.packetHash || "—"}</span></div>
            <div><span style={{ opacity: 0.7 }}>sizeBytes:</span> <span style={mono()}>{meta?.sizeBytes ?? "—"}</span></div>
            <div><span style={{ opacity: 0.7 }}>generatedAt:</span> <span style={mono()}>{meta?.generatedAt || "—"}</span></div>
          </div>

          <div style={{ marginTop: 12 }}>
            <a href={exportUrl} style={btn()}>
              Download Packet (ZIP)
            </a>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
            This is the canonical “shareable artifact” for audits + evidence. (Read-only export)
          </div>
        </div>

        <div style={card()}>
          <div style={{ fontWeight: 950 }}>Files (stub)</div>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
            Next: render a real file tree (manifest + hashes + payloads). For now, this is intentionally minimal + stable.
          </div>
          <div style={{ marginTop: 10, ...mono(), fontSize: 12, opacity: 0.9, whiteSpace: "pre-wrap" }}>
            contract/contract.json
            {"\n"}timeline/events.json
            {"\n"}filings/*.json
            {"\n"}hashes.json
            {"\n"}packet.zip
          </div>
        </div>

        <div style={{ fontSize: 12, opacity: 0.7 }}>
          <a href={`/admin/incidents/${encodeURIComponent(incidentId)}?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none" }}>
            ← Back to Incident
          </a>
        </div>
      </div>
    </div>
  );
}
''')
print("✅ wrote bundle page v2")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

URL="http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "==> smoke: $URL"
curl -fsS "$URL" >/dev/null && echo "✅ bundle page OK" || { echo "❌ bundle page failing"; tail -n 160 .logs/next.log; exit 1; }

echo "✅ B DONE"

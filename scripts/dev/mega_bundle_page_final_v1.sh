#!/usr/bin/env bash
set -euo pipefail
setopt NO_NOMATCH 2>/dev/null || true
set +H 2>/dev/null || true

PAGE='next-app/src/app/admin/incidents/[id]/bundle/page.tsx'
cp "$PAGE" "$PAGE.bak_final_$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
echo "✅ backup saved: $PAGE.bak_final_*"

cat > "$PAGE" <<'TSX'
"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";

type Toast = { id: string; msg: string; kind: "ok" | "warn" | "err" };
type PacketMeta = {
  packetHash?: string;
  sizeBytes?: number;
  exportedAt?: string;
  filingsCount?: number;
  timelineCount?: number;
  source?: string;
};

function mkId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function card() {
  return {
    border: "1px solid rgba(255,255,255,0.10)",
    borderRadius: 14,
    padding: 16,
    background: "rgba(255,255,255,0.04)",
  } as const;
}

function btn(primary: boolean) {
  return {
    appearance: "none",
    border: "1px solid rgba(255,255,255,0.14)",
    background: primary ? "rgba(16,185,129,0.18)" : "rgba(255,255,255,0.06)",
    color: "white",
    padding: "10px 12px",
    borderRadius: 12,
    fontWeight: 850,
    fontSize: 13,
    cursor: "pointer",
  } as const;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function BundlePage() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();

  const incidentId = params.id;
  const orgId = sp.get("orgId") || "";
  const contractId = sp.get("contractId") || "";

  const [packetMeta, setPacketMeta] = useState<PacketMeta | null>(null);
  const [immutable, setImmutable] = useState(false);

  const [zipMeta, setZipMeta] = useState<{ zipSha256: string; zipSize: number; generatedAt: string } | null>(null);

  const [err, setErr] = useState("");
  const [busyAction, setBusyAction] = useState("");

  const [toasts, setToasts] = useState<Toast[]>([]);
  function pushToast(msg: string, kind: Toast["kind"] = "ok") {
    const id = mkId();
    setToasts((x) => [{ id, msg, kind }, ...x].slice(0, 3));
    setTimeout(() => setToasts((x) => x.filter((t) => t.id !== id)), 2400);
  }

  const packetZipUrl = useMemo(() => {
    return (
      `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}` +
      (contractId ? `&contractId=${encodeURIComponent(contractId)}` : "")
    );
  }, [orgId, incidentId, contractId]);

  const bundleZipUrl = useMemo(() => {
    return (
      `/api/fn/downloadIncidentBundleZip?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}` +
      (contractId ? `&contractId=${encodeURIComponent(contractId)}` : "")
    );
  }, [orgId, incidentId, contractId]);

  async function refreshZipMetaFromHead() {
    try {
      const head = await fetch(packetZipUrl, { method: "HEAD" });
      if (!head.ok) return;
      const zipSha256 = (head.headers.get("x-peakops-zip-sha256") || "").trim();
      const generatedAt = (head.headers.get("x-peakops-generatedat") || "").trim();
      const zipSize = Number(head.headers.get("x-peakops-zip-size") || "0") || 0;
      if (zipSha256 || zipSize) setZipMeta({ zipSha256, zipSize, generatedAt });
    } catch {
      // ignore
    }
  }

  async function loadPacketMeta() {
    setErr("");
    try {
      const r = await fetch(
        `/api/fn/getIncidentPacketMetaV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`,
        { method: "GET" }
      );
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(String(j?.error || "Failed to load packet meta"));
      setPacketMeta(j.packetMeta || null);
      setImmutable(!!j.immutable);
      await refreshZipMetaFromHead();
    } catch (e: any) {
      setPacketMeta(null);
      setErr(String(e?.message || e));
    }
  }

  async function handleGeneratePacket() {
    if (busyAction) return;
    try {
      setBusyAction("generate");
      pushToast("Generating packet…", "ok");

      const r = await fetch(
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}&requestedBy=ui`,
        { method: "GET" }
      );
      const j: any = await r.json().catch(() => ({}));

      await loadPacketMeta();

      if (j?.immutable) {
        pushToast("Already exported (immutable) ✅", "ok");
      } else if (j?.ok === false) {
        throw new Error(String(j?.error || "export failed"));
      } else {
        pushToast("Packet generated ✅", "ok");
      }
    } catch (e: any) {
      pushToast(`Generate failed: ${String(e?.message || e)}`, "err");
    } finally {
      setBusyAction("");
    }
  }

  async function handleCopyHash() {
    try {
      const h = packetMeta?.packetHash;
      if (!h) return pushToast("No packet hash yet.", "warn");
      await navigator.clipboard.writeText(String(h));
      pushToast("Copied packet hash ✅", "ok");
    } catch {
      pushToast("Copy blocked by browser.", "warn");
    }
  }

  async function handleDownload(url: string, filename: string, label: string) {
    if (busyAction) return;
    try {
      setBusyAction(label);
      pushToast(`Preparing ${label}…`, "ok");

      const r = await fetch(url, { method: "GET" });
      if (!r.ok) throw new Error(`${label} failed (HTTP ${r.status})`);
      const blob = await r.blob();

      const a = document.createElement("a");
      const objUrl = URL.createObjectURL(blob);
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);

      pushToast(`${label} downloaded ✅`, "ok");
      await refreshZipMetaFromHead();
    } catch (e: any) {
      pushToast(String(e?.message || e), "err");
    } finally {
      setBusyAction("");
    }
  }

  async function handleVerifyZip() {
    if (busyAction) return;
    try {
      setBusyAction("verify");
      pushToast("Verifying ZIP…", "ok");

      const head = await fetch(packetZipUrl, { method: "HEAD" });
      if (!head.ok) throw new Error(`HEAD failed (HTTP ${head.status})`);
      const expected = (head.headers.get("x-peakops-zip-sha256") || "").trim();
      if (!expected) throw new Error("Missing x-peakops-zip-sha256 header");

      const r = await fetch(packetZipUrl, { method: "GET" });
      if (!r.ok) throw new Error(`ZIP download failed (HTTP ${r.status})`);
      const buf = await r.arrayBuffer();
      const actual = await sha256Hex(buf);

      if (actual.toLowerCase() === expected.toLowerCase()) {
        pushToast("ZIP verified ✅ (sha256 matches)", "ok");
      } else {
        pushToast("ZIP verification FAILED ❌", "err");
      }

      await refreshZipMetaFromHead();
    } catch (e: any) {
      pushToast(String(e?.message || e), "err");
    } finally {
      setBusyAction("");
    }
  }

  useEffect(() => {
    if (!orgId || !incidentId) return;
    void loadPacketMeta();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId, contractId]);

  return (
    <div style={{ minHeight: "100vh", padding: 24, background: "#0b0f19", color: "white" }}>
      {/* Toast overlay */}
      <div style={{ position: "fixed", top: 16, right: 16, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8, pointerEvents: "none" }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              minWidth: 260,
              background: t.kind === "ok" ? "rgba(20,140,70,0.92)" : t.kind === "warn" ? "rgba(160,120,20,0.92)" : "rgba(160,30,30,0.92)",
              color: "white",
              boxShadow: "0 12px 28px rgba(0,0,0,0.35)",
              fontSize: 13,
              fontWeight: 850,
            }}
          >
            {t.msg}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 28, fontWeight: 950 }}>Immutable Incident Artifact</div>
            {immutable ? (
              <span style={{ fontSize: 11, fontWeight: 950, padding: "4px 8px", borderRadius: 999, background: "rgba(16,185,129,0.22)", border: "1px solid rgba(16,185,129,0.35)" }}>
                IMMUTABLE ✅
              </span>
            ) : null}
          </div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b>
          </div>
        </div>

        <button onClick={loadPacketMeta} disabled={!!busyAction} style={btn(false)}>
          Refresh
        </button>
      </div>

      {err && <div style={{ marginTop: 10, color: "#ff6b6b", fontWeight: 900, whiteSpace: "pre-wrap" }}>{err}</div>}

      <div style={{ marginTop: 14, ...card() }}>
        <div style={{ fontWeight: 950, marginBottom: 6 }}>Packet Meta</div>

        <div style={{ fontSize: 12, opacity: 0.9, lineHeight: 1.6 }}>
          packetHash: <span style={{ opacity: 0.95 }}>{packetMeta?.packetHash || "—"}</span>{" "}
          <button onClick={handleCopyHash} disabled={!!busyAction} style={{ ...btn(false), padding: "6px 10px" }}>
            Copy Hash
          </button>
          <br />
          sizeBytes: <span style={{ opacity: 0.95 }}>{packetMeta?.sizeBytes ?? "—"}</span>
          <br />
          exportedAt: <span style={{ opacity: 0.95 }}>{packetMeta?.exportedAt || "—"}</span>
          <br />
          filingsCount: <span style={{ opacity: 0.95 }}>{packetMeta?.filingsCount ?? "—"}</span>
          <br />
          timelineCount: <span style={{ opacity: 0.95 }}>{packetMeta?.timelineCount ?? "—"}</span>
          <br />
          source: <span style={{ opacity: 0.95 }}>{packetMeta?.source || "—"}</span>

          <hr style={{ margin: "10px 0", opacity: 0.15 }} />

          zipSha256: <span style={{ opacity: 0.95 }}>{zipMeta?.zipSha256 || "—"}</span>
          <br />
          zipSize: <span style={{ opacity: 0.95 }}>{zipMeta?.zipSize ? String(zipMeta.zipSize) : "—"}</span>
          <br />
          zipGeneratedAt: <span style={{ opacity: 0.95 }}>{zipMeta?.generatedAt || "—"}</span>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={handleGeneratePacket} disabled={!!busyAction} style={btn(true)}>
            {busyAction ? "Working…" : "Generate Packet"}
          </button>

          <button onClick={() => handleDownload(packetZipUrl, `incident_${incidentId}_packet.zip`, "Packet ZIP")} disabled={!!busyAction} style={btn(false)}>
            Download Packet (ZIP)
          </button>

          <button onClick={() => handleDownload(bundleZipUrl, `incident_${incidentId}_bundle.zip`, "Bundle ZIP")} disabled={!!busyAction} style={btn(false)}>
            Download Bundle (ZIP)
          </button>

          <button onClick={handleVerifyZip} disabled={!!busyAction} style={btn(false)}>
            Verify ZIP
          </button>
        </div>
      </div>

      <div style={{ marginTop: 16, fontSize: 12, opacity: 0.85 }}>
        <Link href={`/admin/incidents/${encodeURIComponent(incidentId)}?orgId=${encodeURIComponent(orgId)}`} style={{ color: "inherit" }}>
          ← Back to Incident
        </Link>
      </div>
    </div>
  );
}
TSX

echo "🧹 clearing next cache"
pkill -f "pnpm dev --port 3000" 2>/dev/null || true
rm -rf next-app/.next || true

echo "🚀 restarting next"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "✅ open bundle page"
open "http://127.0.0.1:3000/admin/incidents/inc_TEST/bundle?orgId=org_001"
echo "✅ Click: Generate Packet → Download Packet → Verify ZIP"

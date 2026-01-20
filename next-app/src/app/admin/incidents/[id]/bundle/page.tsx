"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import JSZip from "jszip";

type ToastKind = "ok" | "warn" | "err";
type PacketMeta = {
  packetHash: string | null;
  exportedAt: string | null;
  sizeBytes: number | null;
  filingsCount: number | null;
  timelineCount: number | null;
  source: string | null;
  generatedAt?: string | null;
  zipSha256?: string | null;
  zipSize?: number | null;
};
type PacketMetaResp =
  | { ok: true; orgId: string; incidentId: string; immutable?: boolean; packetMeta: any; zipMeta?: any }
  | { ok: false; error: string };

function btn(primary: boolean): React.CSSProperties {
  return {
    border: "1px solid rgba(255,255,255,0.14)",
    background: primary ? "rgba(34,197,94,0.18)" : "rgba(255,255,255,0.06)",
    color: "inherit",
    padding: "9px 12px",
    borderRadius: 999,
    fontWeight: 800,
    fontSize: 12,
    cursor: "pointer",
    opacity: 1,
  };
}
function card(): React.CSSProperties {
  return {
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.04)",
    borderRadius: 14,
    padding: 16,
  };
}
function hexFromBuf(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i++) s += u[i].toString(16).padStart(2, "0");
  return s;
}
async function sha256ArrayBuffer(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return hexFromBuf(digest);
}
async function safeJson<T = any>(r: Response): Promise<{ ok: true; v: T } | { ok: false; err: string; text: string }> {
  const text = await r.text();
  try {
    return { ok: true, v: JSON.parse(text) };
  } catch (e: any) {
    return { ok: false, err: String(e?.message || e), text };
  }
}

type FileRow = { path: string; bytes?: number; sha256?: string; hash?: string; ok?: boolean };

export default function BundlePage() {
  const params = useParams() as any;
  const sp = useSearchParams();

  const orgId = String(sp.get("orgId") || "org_001");
  const incidentId = String(params?.id || "inc_TEST");

  // BOOTSTRAP_BADGES_BULLETPROOF: hydrate truth on mount/id change (after ids exist)
  useEffect(() => {
    if (!orgId || !incidentId) return;
    void loadPacketMeta();
    void hydrateZipVerification();
    void hydrateLock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);


  const contractId = String(sp.get("contractId") || "");

  const [toasts, setToasts] = useState<{ id: string; msg: string; kind: ToastKind }[]>([]);
  const [busyAction, setBusyAction] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const [packetMeta, setPacketMeta] = useState<PacketMeta | null>(null);

  


  // Bootstrap: keep badges sticky across hard refresh
  const [immutable, setImmutable] = useState<boolean>(false);
  const [zipVerified, setZipVerified] = useState<boolean>(false);

  


  

  

const [manifestBusy, setManifestBusy] = useState<boolean>(false);
  const [manifestItems, setManifestItems] = useState<FileRow[]>([]);

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

  function pushToast(msg: string, kind: ToastKind = "ok") {
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setToasts((x) => [...x, { id, msg, kind }]);
    window.setTimeout(() => setToasts((x) => x.filter((t) => t.id !== id)), 2600);
  }

  async function loadPacketMeta() {
    setErr("");
    // 1) Try canonical meta endpoint (Firestore-backed)
    try {
      const u =
        `/api/fn/getIncidentPacketMetaV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      const r = await fetch(u, { method: "GET" });
      const pj = await safeJson<PacketMetaResp>(r);
      if (!pj.ok) throw new Error(`non-json: ${pj.err}`);
      const j = pj.v;

      if (j.ok) {
        if (j.immutable) setImmutable(true);
        const pm = j.packetMeta || {};
        setPacketMeta({
          packetHash: pm.packetHash ?? null,
          exportedAt: pm.exportedAt ?? null,
          sizeBytes: typeof pm.sizeBytes === "number" ? pm.sizeBytes : null,
          filingsCount: typeof pm.filingsCount === "number" ? pm.filingsCount : null,
          timelineCount: typeof pm.timelineCount === "number" ? pm.timelineCount : null,
          source: pm.source ?? "getIncidentPacketMetaV1",
          generatedAt: null,
          zipSha256: null,
          zipSize: null,
        });
        return;
      }

      // ok:false from meta endpoint: show error, then fall through to ZIP header fallback
      setErr(j.error || "Packet meta unavailable; falling back to ZIP headers…");
    } catch (e: any) {
      setErr(String(e?.message || e));
    }

    // 2) ZIP header fallback (works even if Firestore/functions are down)
    try {
      const hr = await fetch(packetZipUrl, { method: "HEAD" });
      if (!hr.ok) throw new Error(`HEAD packet zip failed (HTTP ${hr.status})`);

      const packetHash = hr.headers.get("x-peakops-packethash") || "";
      const generatedAt = hr.headers.get("x-peakops-generatedat") || "";
      const zipSha256 = hr.headers.get("x-peakops-zip-sha256") || "";
      const zipSize = Number(hr.headers.get("x-peakops-zip-size") || "0") || 0;

      setPacketMeta({
        packetHash: packetHash || null,
        exportedAt: null,
        sizeBytes: null,
        filingsCount: null,
        timelineCount: null,
        source: "zip_headers_fallback",
        generatedAt: generatedAt || null,
        zipSha256: zipSha256 || null,
        zipSize: zipSize || null,
      });
      if (!packetHash) setErr("Packet meta endpoint unavailable; showing ZIP header fallback.");
    } catch (e: any) {
      setPacketMeta(null);
      setErr(String(e?.message || e));
    }
  }


  async function hydrateIncidentLock() {
    try {
      const u =
        `/api/fn/getIncidentLockV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(u, { method: "GET" });
      const j = await r.json().catch(() => null);
      if (j?.ok && j?.immutable) setImmutable(true);
    } catch {
      // swallow
    }
  }


async function hydrateLock() {
  try {
    const u =
      `/api/fn/getIncidentLockV1?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}`;
    const r = await fetch(u, { method: "GET" });
    const j = await r.json().catch(() => null);
    if (j?.ok && typeof j.immutable === "boolean") {
      if (j.immutable) setImmutable(true);
    }
  } catch {
    // swallow
  }
}

async function hydrateZipVerification() {
  try {
    const u =
      `/api/fn/getZipVerificationV1?orgId=${encodeURIComponent(orgId)}` +
      `&incidentId=${encodeURIComponent(incidentId)}`;
    const r = await fetch(u, { method: "GET" });
    const j = await r.json().catch(() => null);
    const zm = j?.zipMeta || null;
    if (zm?.zipSha256) {
    setZipVerified(true);
      // Merge into existing packetMeta shape without blowing away canonical fields
      setPacketMeta((prev: any) => {
        const base = prev || {};
        return {
          ...base,
          zipSha256: base.zipSha256 || zm.zipSha256,
          zipSize: base.zipSize || zm.zipSize,
          zipGeneratedAt: base.zipGeneratedAt || zm.zipGeneratedAt,
          zipVerifiedAt: zm.verifiedAt || base.zipVerifiedAt,
          zipVerifiedBy: zm.verifiedBy || base.zipVerifiedBy,
        };
      });
    }
  } catch {
    // swallow
  }
}


  async function persistZipMeta(zm: { zipSha256: string; zipSize: number; zipGeneratedAt: string }) {
    try {
      const u = `/api/fn/persistZipVerificationV1`;
      const r = await fetch(u, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          incidentId,
          zipSha256: zm.zipSha256,
          zipSize: zm.zipSize,
          zipGeneratedAt: zm.zipGeneratedAt,
          verifiedBy: "ui",
          verifiedAt: new Date().toISOString(),
        }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || `persist failed (HTTP ${r.status})`);
      // After persisting, re-hydrate so badges stay sticky
      await hydrateZipVerification();
    } catch (e: any) {
      pushToast(`Persist ZIP verification failed: ${String(e?.message || e)}`, "warn");
    }
  }


  async function handleCopyHash() {
    const h = packetMeta?.packetHash;
    if (!h) return pushToast("No packetHash yet.", "warn");
    try {
      await navigator.clipboard.writeText(String(h));
      pushToast("Copied packet hash ✅", "ok");
    } catch {
      pushToast("Could not copy (browser blocked).", "warn");
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
    } catch (e: any) {
      pushToast(String(e?.message || e), "err");
    } finally {
      setBusyAction("");
    }
  }

  
  async function handleFinalizeIncident() {
    if (busyAction) return;
    if (immutable) return pushToast("Already immutable.", "warn");
    if (!zipVerified) return pushToast("Verify ZIP first (integrity), then finalize.", "warn");

    try {
      setBusyAction("Finalize");
      pushToast("Finalizing incident…", "ok");

      const r = await fetch("/api/fn/finalizeIncidentV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, incidentId, immutableBy: "ui" }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || `Finalize failed (HTTP ${r.status})`);

      setImmutable(true);
      pushToast("Incident finalized (immutable) ✅", "ok");
    } catch (e: any) {
      pushToast(`Finalize failed: ${String(e?.message || e)}`, "err");
    } finally {
      setBusyAction("");
    }
  }

async function handleGeneratePacket() {
    if (busyAction) return;
    try {
      setBusyAction("Generate");
      const u =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}&requestedBy=ui`;
      const r = await fetch(u, { method: "GET" });
      const pj = await safeJson<any>(r);
      if (!pj.ok) throw new Error(`export non-json: ${pj.err}`);
      if (pj.v?.ok === false) throw new Error(String(pj.v?.error || `export failed (HTTP ${r.status})`));

      if (pj.v?.immutable) pushToast("Already exported (immutable) ✅", "ok");
      else pushToast("Packet exported ✅", "ok");

      await loadPacketMeta();
    } catch (e: any) {
      pushToast(`Generate failed: ${String(e?.message || e)}`, "err");
    } finally {
      setBusyAction("");
    }
  }

  async function handleVerifyZip() {
  if (busyAction) return;
  try {
    setBusyAction("verify");
    pushToast("Verifying ZIP…", "ok");

    // Download the packet ZIP and compare sha256 with server header
    const r = await fetch(packetZipUrl, { method: "GET" });
    if (!r.ok) throw new Error(`Verify ZIP failed (HTTP ${r.status})`);

    const expected = (r.headers.get("x-peakops-zip-sha256") || "").trim().toLowerCase();
    if (!expected) throw new Error("Verify ZIP failed: missing x-peakops-zip-sha256 header");

    const buf = await r.arrayBuffer();
    const actual = (await sha256Hex(buf)).trim().toLowerCase();

    if (actual !== expected) {
      throw new Error(`SHA256 mismatch (expected ${expected.slice(0,12)}…, got ${actual.slice(0,12)}…)`);
    }

    pushToast("ZIP verified ✅ (sha256 matches)", "ok");

      // Persist "ZIP Verified" into Firestore so it survives refresh/restart
      try {
        const u =
          `/api/fn/persistZipVerificationV1?orgId=${encodeURIComponent(orgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}`;
        await fetch(u, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            zipSha256: String(zipSha256),
            zipSize: Number(zipSize || 0),
            zipGeneratedAt: String(zipGeneratedAt || new Date().toISOString()),
            verifiedAt: new Date().toISOString(),
            verifiedBy: "ui",
          }),
        });
      } catch {
        // ignore persistence failure in UI flow
      }


  } catch (e: any) {
    pushToast(`ZIP verification FAILED: ${String(e?.message || e)}`, "err");
  } finally {
    setBusyAction("");
  }
}


async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  // WebCrypto SHA-256
  const hash = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}


  async function loadManifestFromZip() {
    if (manifestBusy || busyAction) return;
    try {
      setManifestBusy(true);
      pushToast("Loading file tree…", "ok");

      const r = await fetch(packetZipUrl, { method: "GET" });
      if (!r.ok) throw new Error(`Download packet zip failed (HTTP ${r.status})`);
      const buf = await r.arrayBuffer();

      const zip = await JSZip.loadAsync(buf);

      const manFile = zip.file("manifest.json");
      const hashFile = zip.file("hashes.json");
      if (!manFile) throw new Error("manifest.json not found in ZIP");
      if (!hashFile) throw new Error("hashes.json not found in ZIP");

      const manText = await manFile.async("string");
      const hashText = await hashFile.async("string");

      const man = JSON.parse(manText || "{}");
      const hashes = JSON.parse(hashText || "{}");

      // manifest.json may contain { files:[...] } or { items:[...] } etc.
      let files: any[] = [];
      if (Array.isArray(man.files)) files = man.files;
      else if (Array.isArray(man.items)) files = man.items;
      else if (Array.isArray(man.manifest)) files = man.manifest;

      const out: FileRow[] = [];
      for (const f of files) {
        const path = String(f?.path || f?.name || "").trim();
        if (!path) continue;
        const bytes =
          typeof f?.bytes === "number" ? f.bytes :
          typeof f?.size === "number" ? f.size :
          undefined;

        const sha = String(f?.sha256 || f?.hash || "").trim() || undefined;
        const sha2 = sha || (hashes && typeof hashes === "object" ? (hashes[path] || hashes[`/${path}`]) : undefined);

        out.push({ path, bytes, sha256: sha2, ok: !!sha2 });
      }

      out.sort((a, b) => a.path.localeCompare(b.path));
      setManifestItems(out);

      pushToast(`Loaded ${out.length} files ✅`, "ok");
    } catch (e: any) {
      pushToast(String(e?.message || e), "err");
    } finally {
      setManifestBusy(false);
    }
  }
  const badgeStyle = (ok: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    border: "1px solid rgba(255,255,255,0.12)",
    background: ok ? "rgba(34,197,94,0.18)" : "rgba(255,255,255,0.06)",
    marginLeft: 8,
  });

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      {/* Toast overlay */}
      <div style={{ position: "fixed", right: 18, top: 18, zIndex: 9999, display: "flex", flexDirection: "column", gap: 10 }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.12)",
              background:
                t.kind === "ok" ? "rgba(34,197,94,0.20)" :
                t.kind === "warn" ? "rgba(234,179,8,0.20)" :
                "rgba(239,68,68,0.20)",
              fontSize: 12,
              fontWeight: 800,
              maxWidth: 360,
            }}
          >
            {t.msg}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 950 }}>
            Immutable Incident Artifact
            <span style={badgeStyle(true)}>✓ Canonical</span>
            <span style={badgeStyle(immutable)}> {immutable ? "✓" : "—"} Immutable</span>
            <span style={badgeStyle(zipVerified)}> {zipVerified ? "✓" : "—"} ZIP Verified</span>
          </div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Org: <b>{orgId}</b> · Incident: <b>{incidentId}</b>
          </div>
        </div>
        <button onClick={loadPacketMeta} style={btn(false)}>Refresh</button>
      </div>

      {err && (
        <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>
          {err}
        </div>
      )}

      <div style={{ marginTop: 14, ...card() }}>
        <div style={{ fontWeight: 950, marginBottom: 6 }}>Packet Meta</div>

        <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.7 }}>
          packetHash: <span style={{ opacity: 0.95 }}>{packetMeta?.packetHash || "—"}</span>{" "}
          <button onClick={handleCopyHash} disabled={!!busyAction || immutable} style={{ ...btn(false), padding: "6px 10px", marginLeft: 8 }}>
            Copy Hash
          </button>
          <br />
          sizeBytes: <span style={{ opacity: 0.95 }}>{packetMeta?.sizeBytes != null ? String(packetMeta.sizeBytes) : "—"}</span>
          <br />
          exportedAt: <span style={{ opacity: 0.95 }}>{packetMeta?.exportedAt || "—"}</span>
          <br />
          filingsCount: <span style={{ opacity: 0.95 }}>{packetMeta?.filingsCount != null ? String(packetMeta.filingsCount) : "—"}</span>
          <br />
          timelineCount: <span style={{ opacity: 0.95 }}>{packetMeta?.timelineCount != null ? String(packetMeta.timelineCount) : "—"}</span>
          <br />
          source: <span style={{ opacity: 0.95 }}>{packetMeta?.source || "—"}</span>
          <br />
          <br />
          zipSha256: <span style={{ opacity: 0.95 }}>{packetMeta?.zipSha256 || "—"}</span>
          <br />
          zipSize: <span style={{ opacity: 0.95 }}>{packetMeta?.zipSize != null ? String(packetMeta.zipSize) : "—"}</span>
          <br />
          zipGeneratedAt: <span style={{ opacity: 0.95 }}>{packetMeta?.generatedAt || "—"}</span>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button onClick={handleGeneratePacket} disabled={!!busyAction || immutable} style={btn(true)}>
            {busyAction ? "Working…" : "Generate Packet"}
          </button>

          <button
            onClick={() => handleDownload(packetZipUrl, `incident_${incidentId}_packet.zip`, "Packet ZIP")}
            disabled={!!busyAction || immutable}
            style={btn(false)}
          >
            Download Packet (ZIP)
          </button>

          <button
            onClick={() => handleDownload(bundleZipUrl, `incident_${incidentId}_bundle.zip`, "Bundle ZIP")}
            disabled={!!busyAction || immutable}
            style={btn(false)}
          >
            Download Bundle (ZIP)
          </button>

          <button onClick={handleVerifyZip} disabled={!!busyAction || immutable} style={btn(false)}>
            Verify ZIP
          </button>

          <button onClick={handleFinalizeIncident} disabled={!!busyAction || !zipVerified || immutable} style={btn(false)}>
            {immutable ? "Finalized" : "Finalize Incident"}
          </button>
        </div>

        <div style={{ marginTop: 8, fontSize: 11, opacity: 0.75 }}>
          Packet = canonical “shareable artifact” for audits + evidence. Bundle = packet.zip + bundle_manifest.json.
        </div>
      </div>

      <div style={{ marginTop: 14, ...card() }}>
        <div style={{ fontWeight: 950, marginBottom: 6 }}>Files</div>
        <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
          Load manifest.json + hashes.json from the Packet ZIP and render a normalized file list.
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={loadManifestFromZip} disabled={manifestBusy || !!busyAction} style={btn(false)}>
            {manifestBusy ? "Loading…" : "Load File Tree"}
          </button>
          {manifestItems.length > 0 && (
            <div style={{ fontSize: 12, opacity: 0.8 }}>
              {manifestItems.length} files loaded
            </div>
          )}
        </div>

        {manifestItems.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>
              path · bytes · sha256
            </div>
            <pre style={{ fontSize: 12, opacity: 0.9, whiteSpace: "pre-wrap" }}>
{manifestItems.map((f) => `${f.ok ? "✓" : "—"} ${f.path}  ${f.bytes ?? "?"}  ${f.sha256 ?? "—"}`).join("")}
            </pre>
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, fontSize: 12, opacity: 0.85 }}>
        <Link href={`/admin/incidents/${encodeURIComponent(incidentId)}?orgId=${encodeURIComponent(orgId)}`} style={{ color: "inherit" }}>
          ← Back to Incident
        </Link>
      </div>
    </div>
  );
}

"use client";

import React, { useEffect, useMemo, useState } from "react";
import FilingMetaStub from "../../_components/FilingMetaStub";
import TimelinePreviewMock from "../../_components/TimelinePreviewMock";
import BackendBadge from "../../_components/BackendBadge";
import { useParams, useSearchParams } from "next/navigation";
import AdminNav from "../../_components/AdminNav";
import GuidedWorkflowPanel from "../../_components/GuidedWorkflowPanel";
import ValidationPanel from "../../_components/ValidationPanel";
import { mintEvidenceReadUrl, getBestEvidenceImageRef } from "@/lib/evidence/signedThumb";


function btn(primary: boolean): React.CSSProperties {
  return {
    border: primary ? "none" : "1px solid #1a1a1a",
    background: primary ? "#C8A84E" : "#0a0a0a",
    color: primary ? "#000" : "#ccc",
    padding: "9px 14px",
    borderRadius: 6,
    fontWeight: 600,
    fontSize: 12,
    cursor: "pointer",
  };
}


  async function handleCreateIncidentV1(orgId: string) {
    try {
      const r = await fetch("/api/fn/createIncidentV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgId, title: "New Incident" }),
      });
      const j = await r.json().catch(() => null);
      if (!j?.ok) throw new Error(j?.error || `Create failed (HTTP ${r.status})`);
      const newId = j.incidentId;
      window.location.href = `/admin/incidents/${encodeURIComponent(newId)}?orgId=${encodeURIComponent(orgId)}`;
    } catch (e: any) {
      alert(String(e?.message || e));
    }
  }



function isImmutable409(status: number, bodyText: string) {
  return status === 409 && (bodyText || "").includes("IMMUTABLE");
}



function Panel(props: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid #1a1a1a",
        borderRadius: 8,
        padding: 14,
        background: "#0a0a0a",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, color: "#fff" }}>{props.title}</div>
      {props.children}
    </div>
  );
}

function panelCardStyle(): React.CSSProperties {
  return {
    border: "1px solid #1a1a1a",
    borderRadius: 8,
    padding: 14,
    background: "#0a0a0a",
  };
}

function pill(active: boolean): React.CSSProperties {
  return {
    padding: "7px 12px",
    borderRadius: 6,
    border: "1px solid #1a1a1a",
    background: active ? "#111" : "#0a0a0a",
    color: "#ccc",
    fontSize: 12,
    fontWeight: 600,
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

  
  async function hydrateLock() {
    try {
      const u = `/api/fn/getIncidentLockV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(u, { method: "GET" });
      const j = await r.json().catch(() => null);
      if (j?.ok && typeof j.immutable === "boolean") setImmutable(!!j.immutable);
    } catch {
      // swallow
    }
  }


  const [immutable, setImmutable] = React.useState<boolean>(false);

  const [busy, setBusy] = React.useState<string>("");

  // Evidence preview
  const [evidenceItems, setEvidenceItems] = useState<any[]>([]);
  const [evidenceUrls, setEvidenceUrls] = useState<Record<string, string>>({});

  async function loadEvidence() {
    try {
      const r = await fetch(`/api/fn/listEvidenceLocker?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&limit=20`);
      const j = await r.json().catch(() => null);
      if (!j?.ok) return;
      const items: any[] = Array.isArray(j.docs) ? j.docs : [];
      setEvidenceItems(items);
      const urls: Record<string, string> = {};
      await Promise.all(items.slice(0, 12).map(async (ev: any) => {
        const ref = getBestEvidenceImageRef(ev);
        if (!ref?.storagePath || !ref?.bucket) return;
        try {
          const result = await mintEvidenceReadUrl({ orgId, incidentId, storagePath: ref.storagePath, bucket: ref.bucket });
          if (result?.ok && result.url) urls[ev.id] = result.url;
        } catch { /* skip */ }
      }));
      setEvidenceUrls(urls);
    } catch { /* swallow */ }
  }

  async function runAction(kind: "timeline" | "filings" | "export") {
    if (busy) return;
    try {
      setBusy(kind);
      const base = kind === "timeline"
        ? `/api/fn/generateTimelineV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&requestedBy=ui`
        : kind === "filings"
        ? `/api/fn/generateFilingsV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}&requestedBy=ui`
        : `/api/fn/exportIncidentPacketV1`;

      const fetchOpts: RequestInit = { method: "POST" };
      if (kind === "export") {
        fetchOpts.headers = { "Content-Type": "application/json" };
        fetchOpts.body = JSON.stringify({ orgId, incidentId, requestedBy: "ui" });
      }
      const r = await fetch(base, fetchOpts);
      const t = await r.text();

      if (isImmutable409(r.status, t)) {
        setErr("Locked: this incident is finalized (immutable). You can only Export with force=1 (admin).");
        setBusy("");
        return;
      }

      let j: any = null;
      try { j = JSON.parse(t); } catch {}
      if (!r.ok || (j && j.ok === false)) {
        const msg = j?.error || t || `HTTP ${r.status}`;
        alert(`${kind.toUpperCase()} failed: ${msg}`);
        return;
      }
    } finally {
      setBusy("");
    }
  }

  const [err, setErr] = useState<string>("");
  const [wf, setWf] = useState<WFResp | null>(null);

  const stepsCount = useMemo(() => wf?.workflow?.steps?.length || 0, [wf]);

  // Derive stepper state from workflow + localStorage (same merge as GuidedWorkflowPanel)
  const STEPPER_KEYS = ["intake", "timeline", "filings", "export"] as const;
  const STEPPER_LABELS: Record<string, string> = { intake: "Intake", timeline: "Timeline", filings: "Filings", export: "Packet" };
  const stepperStates = useMemo(() => {
    const wfSteps = wf?.workflow?.steps || [];
    const serverMap: Record<string, string> = {};
    for (const s of wfSteps) serverMap[s.key] = s.status || "TODO";
    // Merge localStorage overrides — only advance from TODO, never regress from server DONE
    try {
      const localRaw = typeof window !== "undefined" ? localStorage.getItem(`wf:${orgId}:${incidentId}`) : null;
      const local: Record<string, string> = localRaw ? JSON.parse(localRaw) : {};
      for (const [k, v] of Object.entries(local)) {
        if (!v) continue;
        const server = serverMap[k] || "TODO";
        // Server says DONE — keep it (authoritative)
        if (server === "DONE") continue;
        // localStorage advances from TODO/DOING — allow
        serverMap[k] = v;
      }
    } catch { /* ignore */ }
    return STEPPER_KEYS.map((key) => ({ key, label: STEPPER_LABELS[key], status: serverMap[key] || "TODO" }));
  }, [wf, orgId, incidentId]);
  // Packet readiness from existing workflow response
  const packetMeta = useMemo(() => (wf as any)?.incident?.packetMeta || null, [wf]);
  const filingsReady = useMemo(() => !!(wf as any)?.workflow?.filingsReady, [wf]);
  const exportReady = useMemo(() => !!(wf as any)?.workflow?.exportReady, [wf]);

  // Incident identity from workflow response
  const incident = useMemo(() => (wf as any)?.incident || null, [wf]);
  const incidentTitle = useMemo(() => String(incident?.title || "").trim(), [incident]);
  const displayStatus = useMemo(() => {
    if (immutable) return "Finalized";
    const raw = String(incident?.status || "").trim().toLowerCase();
    if (raw === "closed") return "Closed";
    if (raw === "in_progress") return "In Progress";
    if (raw === "open") return "Active";
    return "Draft";
  }, [incident, immutable]);
  const updatedAt = useMemo(() => {
    const raw = incident?.updatedAt;
    if (!raw) return "";
    try {
      const d = typeof raw === "string" ? new Date(raw) : raw?._seconds ? new Date(raw._seconds * 1000) : null;
      return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    } catch { return ""; }
  }, [incident]);

  const activeStepIdx = useMemo(() => {
    const firstTodo = stepperStates.findIndex((s) => s.status !== "DONE");
    return firstTodo >= 0 ? firstTodo : stepperStates.length - 1;
  }, [stepperStates]);

  async function load() {
    setBusy("load");
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
      setBusy("");
    }
  }

  useEffect(() => {
    void hydrateLock();
    void load();
    void loadEvidence();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, incidentId]);

  return (
    <div style={{ padding: "28px 24px", fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: "#fff", minHeight: "calc(100vh - 44px)", background: "#000" }}>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {incidentTitle || `Incident ${incidentId}`}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "#666" }}>{orgId}</span>
            <span style={{ fontSize: 11, color: "#333" }}>·</span>
            <span style={{ fontSize: 11, color: "#666", fontFamily: "ui-monospace, monospace" }}>{incidentId}</span>
            <span style={{ fontSize: 11, color: "#333" }}>·</span>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: "1px 6px", borderRadius: 3,
              background: immutable ? "rgba(200,168,78,0.15)" : "rgba(255,255,255,0.05)",
              border: immutable ? "1px solid rgba(200,168,78,0.3)" : "1px solid #1a1a1a",
              color: immutable ? "#C8A84E" : "#888",
            }}>
              {displayStatus}
            </span>
            {updatedAt && (
              <>
                <span style={{ fontSize: 11, color: "#333" }}>·</span>
                <span style={{ fontSize: 10, color: "#555" }}>Updated {updatedAt}</span>
              </>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button style={pill(false)} onClick={load} disabled={!!busy}>
            {busy ? "Loading…" : "Refresh"}
          </button>
          <button style={{ ...btn(true), fontSize: 11 }} onClick={() => handleCreateIncidentV1(orgId)}>
            + New
          </button>
        </div>
      </div>

      {/* Horizontal Stepper */}
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, padding: "10px 20px", background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: 8 }}>
        {/* Stepper rail */}
        <div style={{ flex: 1, position: "relative" }}>
          {/* Lines behind nodes */}
          <div style={{ position: "absolute", top: 10, left: "12.5%", right: "12.5%", height: 1, background: "#151515" }} />
          <div style={{ position: "absolute", top: 10, left: "12.5%", width: `${Math.min(100, (activeStepIdx / (stepperStates.length - 1)) * 75)}%`, height: 1, background: "rgba(200,168,78,0.35)" }} />

          <div style={{ position: "relative", display: "grid", gridTemplateColumns: `repeat(${stepperStates.length}, 1fr)` }}>
            {stepperStates.map((step, idx) => {
              const isDone = step.status === "DONE";
              const isActive = idx === activeStepIdx && !isDone;
              return (
                <div key={step.key} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                  <div style={{
                    width: isActive ? 24 : 20, height: isActive ? 24 : 20, borderRadius: 12,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: isActive ? "#C8A84E" : isDone ? "rgba(200,168,78,0.25)" : "#111",
                    border: isActive ? "2px solid rgba(200,168,78,0.7)" : isDone ? "1px solid rgba(200,168,78,0.35)" : "1px solid #1a1a1a",
                    boxShadow: isActive ? "0 0 10px rgba(200,168,78,0.4)" : "none",
                    fontSize: 9, fontWeight: 700,
                    color: isActive ? "#000" : isDone ? "#C8A84E" : "#444",
                    zIndex: 1,
                  }}>
                    {isDone ? (
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    ) : (
                      <span>{idx + 1}</span>
                    )}
                  </div>
                  <span style={{ fontSize: 9, fontWeight: isActive ? 700 : 500, color: isActive ? "#fff" : isDone ? "#C8A84E" : "#444", textAlign: "center" }}>
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {/* Context */}
        <div style={{ fontSize: 10, color: "#444", whiteSpace: "nowrap", borderLeft: "1px solid #1a1a1a", paddingLeft: 10 }}>
          {activeStepIdx + 1}/{stepperStates.length} {stepperStates[activeStepIdx]?.label}
        </div>
      </div>

      {err ? (
        <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.25)", color: "#fca5a5", fontSize: 12 }}>
          {err}
        </div>
      ) : null}

      {/* Two-column layout */}
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "minmax(0, 5fr) minmax(260px, 3fr)", gap: 10, alignItems: "start" }}>

        {/* LEFT: Actions + Readiness + Evidence + Timeline */}
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ border: "1px solid #1a1a1a", background: "#0a0a0a", borderRadius: 8, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>Field Actions</div>
              {immutable && (
                <span style={{ fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 4, background: "rgba(200,168,78,0.15)", border: "1px solid rgba(200,168,78,0.3)", color: "#C8A84E" }}>
                  FINALIZED
                </span>
              )}
            </div>

            <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button disabled={immutable || busy === "timeline"} onClick={() => runAction("timeline")} style={btn(false)}>
                {busy === "timeline" ? "Working…" : "Timeline"}
              </button>
              <button disabled={immutable || busy === "filings"} onClick={() => runAction("filings")} style={btn(false)}>
                {busy === "filings" ? "Working…" : "Filings"}
              </button>
              <button disabled={immutable || busy === "export"} onClick={() => runAction("export")} style={btn(true)}>
                {busy === "export" ? "Working…" : "Export"}
              </button>
              <a style={{ ...btn(false), textDecoration: "none", display: "inline-flex", alignItems: "center", fontSize: 11 }} href={`/admin/incidents/${encodeURIComponent(incidentId)}/bundle?orgId=${encodeURIComponent(orgId)}`}>
                Artifact →
              </a>
            </div>
            <div style={{ marginTop: 6, fontSize: 10, color: "#444" }}>
              Timeline → Filings → Export → Verify → Finalize
            </div>
          </div>

          {/* Packet Readiness */}
          <div style={panelCardStyle()}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Packet Status</div>
            <div style={{ border: "1px solid #1a1a1a", borderRadius: 6, overflow: "hidden" }}>
              {[
                { label: "Filings", ok: filingsReady, detail: filingsReady ? "Generated" : "Not generated" },
                { label: "Export", ok: exportReady, detail: exportReady ? "Ready" : "Not exported" },
                { label: "Lock", ok: immutable, detail: immutable ? "Finalized" : "Mutable" },
              ].map((r, i) => (
                <div key={r.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderBottom: i < 2 ? "1px solid #111" : "none", background: "#050505" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 5, height: 5, borderRadius: 3, background: r.ok ? "#4ade80" : "#333" }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: "#ccc" }}>{r.label}</span>
                  </div>
                  <span style={{ fontSize: 10, color: r.ok ? "#4ade80" : "#555" }}>{r.detail}</span>
                </div>
              ))}
            </div>
            {packetMeta && (
              <div style={{ marginTop: 6, fontSize: 10, color: "#555" }}>
                {packetMeta.exportedAt && <span>Exported {packetMeta.exportedAt} </span>}
                {packetMeta.packetHash && <span style={{ fontFamily: "ui-monospace, monospace", color: "#444" }}>{String(packetMeta.packetHash).slice(0, 12)}…</span>}
              </div>
            )}
          </div>

          {/* Evidence Preview */}
          <div style={panelCardStyle()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Evidence</span>
              <span style={{ fontSize: 10, color: "#555" }}>{evidenceItems.length} item{evidenceItems.length !== 1 ? "s" : ""}</span>
            </div>
            {evidenceItems.length === 0 ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 0" }}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="#333" strokeWidth="1.2"/><circle cx="5.5" cy="6" r="1" fill="#333"/><path d="M2 11l3-3 2 2 3-4 4 5" stroke="#333" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                <span style={{ color: "#444", fontSize: 11 }}>No evidence uploaded yet. Photos and files will appear here.</span>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 4, overflowX: "auto", paddingBottom: 2 }}>
                {evidenceItems.slice(0, 12).map((ev: any) => {
                  const url = evidenceUrls[ev.id];
                  const isImage = (ev.file?.contentType || "").startsWith("image/");
                  const label = ev.label || (Array.isArray(ev.labels) ? ev.labels[0] : "") || "";
                  return (
                    <div key={ev.id} style={{ width: 56, height: 56, borderRadius: 4, border: "1px solid #1a1a1a", background: "#050505", overflow: "hidden", flexShrink: 0 }} title={label || ev.id}>
                      {url && isImage ? (
                        <img src={url} alt={label || ev.id} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#333" }}>
                          {isImage ? "…" : (ev.file?.contentType || "file").split("/").pop()}
                        </div>
                      )}
                    </div>
                  );
                })}
                {evidenceItems.length > 12 && (
                  <div style={{ width: 56, height: 56, borderRadius: 4, border: "1px solid #1a1a1a", background: "#050505", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#555", flexShrink: 0 }}>
                    +{evidenceItems.length - 12}
                  </div>
                )}
              </div>
            )}
          </div>

          <TimelinePreviewMock orgId={orgId} incidentId={incidentId} />
        </div>

        {/* RIGHT: Workflow + Status Checks */}
        <div>
          <GuidedWorkflowPanel orgId={orgId} incidentId={incidentId} />
        </div>

      </div>
    </div>
  );
}

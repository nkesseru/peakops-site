"use client";

import React, { useEffect, useMemo, useState } from "react";

type R = { valid: boolean; errors: string[] };
type Resp = {
  ok: boolean;
  orgId: string;
  incidentId: string;
  generatedAt: string;
  results: { DIRS: R; OE_417: R };
};

function card(): React.CSSProperties {
  return {
    border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
    borderRadius: 14,
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
    padding: 12,
  };
}

function pill(kind: "ok" | "warn" | "bad"): React.CSSProperties {
  const border =
    kind === "ok"
      ? "color-mix(in oklab, lime 38%, transparent)"
      : kind === "warn"
      ? "color-mix(in oklab, gold 38%, transparent)"
      : "color-mix(in oklab, red 40%, transparent)";
  const bg =
    kind === "ok"
      ? "color-mix(in oklab, lime 12%, transparent)"
      : kind === "warn"
      ? "color-mix(in oklab, gold 12%, transparent)"
      : "color-mix(in oklab, red 12%, transparent)";
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: `1px solid ${border}`,
    background: bg,
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: 0.2,
  };
}

function btn(): React.CSSProperties {
  return {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
    cursor: "pointer",
    fontWeight: 900,
  };
}

async function copyText(s: string) {
  try { await navigator.clipboard.writeText(s); } catch {}
}

export default function ValidationPanel(props: {
  orgId: string;
  incidentId: string;
  onOkChange?: (ok: boolean) => void;
}) {
  const { orgId, incidentId, onOkChange } = props;

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [data, setData] = useState<Resp | null>(null);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const url = `/api/fn/validateIncidentFilingsV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(url, { method: "GET" });
      const t = await r.text();
      const j = JSON.parse(t);
      if (j?.ok === false) throw new Error(String(j?.error || "validation failed"));
      setData(j);
      onOkChange?.(!!j?.ok);
    } catch (e: any) {
      setData(null);
      setErr(String(e?.message || e));
      onOkChange?.(false);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void load(); }, [orgId, incidentId]); // eslint-disable-line

  const summary = useMemo(() => {
    const d = data;
    if (!d) return null;
    const bad = (!d.results.DIRS.valid ? 1 : 0) + (!d.results.OE_417.valid ? 1 : 0);
    return { bad };
  }, [data]);

  function renderRow(label: "DIRS" | "OE_417", r: R) {
    const kind = r.valid ? "ok" : "bad";
    return (
      <div style={{ ...card(), padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
          <div style={{ fontWeight: 950, fontSize: 14 }}>{label}</div>
          <span style={pill(kind)}>{r.valid ? "VALID" : "INVALID"}</span>
        </div>

        {!r.valid && (
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>
              {r.errors.length} issue(s)
            </summary>
            <ul style={{ marginTop: 8, marginBottom: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
              {r.errors.map((x, i) => (
                <li key={i} style={{ color: "crimson", fontWeight: 800 }}>{x}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  }

  return (
    <div style={card()}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <div>
          <div style={{ fontWeight: 950 }}>Schema Validation</div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            DIRS + OE-417 · {data ? `generated ${new Date(data.generatedAt).toLocaleString()}` : "—"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button style={btn()} onClick={() => copyText(JSON.stringify(data || {}, null, 2))} disabled={!data}>
            Copy JSON
          </button>
          <button style={btn()} onClick={load} disabled={busy}>
            {busy ? "Checking…" : "Re-check"}
          </button>
        </div>
      </div>

      {err && <div style={{ marginTop: 10, color: "crimson", fontWeight: 900 }}>{err}</div>}

      {!err && data && (
        <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
          {renderRow("DIRS", data.results.DIRS)}
          {renderRow("OE_417", data.results.OE_417)}

          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
            {data.ok ? "✅ All checks pass." : `❌ ${summary?.bad || 0} filing(s) failing validation.`}
          </div>
        </div>
      )}
    </div>
  );
}

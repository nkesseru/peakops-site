#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

REPO="$HOME/peakops/my-app"
NEXT="$REPO/next-app"
FILE="$NEXT/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"

mkdir -p "$(dirname "$FILE")"

cat > "$FILE" <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import AdminNav from "../../../_components/AdminNav";

function tryParseJson(s: string) {
  try { return { ok: true as const, value: JSON.parse(s) }; }
  catch (e: any) { return { ok: false as const, error: String(e?.message || e) }; }
}

function prettyJson(x: any) {
  try { return JSON.stringify(x, null, 2); } catch { return "{}"; }
}

function mono(s: string) {
  return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{s}</span>;
}

async function postJson(url: string, body: any) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch {}
  if (!r.ok) throw new Error(j?.error || text || `HTTP ${r.status}`);
  if (j && j.ok === false) throw new Error(j.error || "Request failed");
  return j ?? {};
}

export default function PayloadEditor() {
  const params = useParams<{ id: string; payloadId: string }>();
  const sp = useSearchParams();

  const orgId = sp.get("orgId") || "org_001";
  const contractId = params.id;
  const payloadIdRaw = params.payloadId || "";
  const payloadId = decodeURIComponent(payloadIdRaw);
  const payloadIdNoExt = payloadId.replace(/\.json$/i, "");

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [meta, setMeta] = useState<any>({});
  const [doc, setDoc] = useState<any>(null);
  const [text, setText] = useState<string>('{\n  "_placeholder": "INIT"\n}\n');

  const parsed = useMemo(() => tryParseJson(text), [text]);

  async function load() {
    if (!contractId || !orgId) return;
    setBusy(true);
    setErr("");
    setMeta({ loading: true });

    try {
      const r = await fetch(
        `/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=200`,
        { method: "GET" }
      );
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");

      const docs = Array.isArray(j.docs) ? j.docs : [];
      const found =
        docs.find((d: any) => String(d.id || "") === payloadId) ||
        docs.find((d: any) => String(d.id || "") === payloadIdNoExt) ||
        docs.find((d: any) => String(d.payloadDocId || "") === payloadId) ||
        docs.find((d: any) => String(d.payloadDocId || "") === payloadIdNoExt);

      if (!found) {
        setDoc(null);
        setMeta({ loading: false, count: docs.length, lookedFor: [payloadId, payloadIdNoExt] });
        setErr(`Payload doc not found: ${payloadId}`);
        return;
      }

      setDoc(found);
      setMeta({
        loading: false,
        id: found.id,
        type: found.type,
        schemaVersion: found.schemaVersion,
        versionId: found.versionId,
        payloadHash: found.payloadHash,
        createdBy: found.createdBy,
        createdAt: found.createdAt,
        updatedAt: found.updatedAt,
      });

      // hydrate editor with payload JSON
      setText(prettyJson(found.payload ?? {}));
    } catch (e: any) {
      setErr(String(e?.message || e));
      setMeta({ loading: false, error: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!parsed.ok) {
      setErr(`JSON invalid: ${parsed.error}`);
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const out = await postJson("/api/fn/writeContractPayloadV1", {
        orgId,
        contractId,
        type: doc?.type || "UNKNOWN",
        versionId: doc?.versionId || sp.get("versionId") || "v1",
        schemaVersion: doc?.schemaVersion || "unknown.v1",
        payload: parsed.value,
        createdBy: "admin_ui",
      });
      // After save, reload so hash/meta stays accurate
      await load();
      // tiny success hint
      setErr("");
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  function formatJson() {
    const p = tryParseJson(text);
    if (!p.ok) {
      setErr(`JSON invalid: ${p.error}`);
      return;
    }
    setText(prettyJson(p.value));
  }

  useEffect(() => { load(); }, [contractId, orgId, payloadIdRaw]); // eslint-disable-line

  return (
    <div style={{ padding: 22, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 950, fontSize: 22, lineHeight: 1.1 }}>Admin · Payload Editor</div>
          <div style={{ marginTop: 6, opacity: 0.75, fontSize: 12 }}>
            Org: {mono(orgId)} · Contract: {mono(contractId)} · Doc: {mono(payloadId)}
          </div>
          {err && <div style={{ marginTop: 8, color: "crimson", fontWeight: 900 }}>{err}</div>}
        </div>

        <AdminNav orgId={orgId} contractId={contractId} />

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button onClick={load} disabled={busy} style={btn()}>
            {busy ? "Loading…" : "Refresh"}
          </button>
          <button onClick={formatJson} disabled={busy} style={btn()}>
            Format JSON
          </button>
          <button onClick={save} disabled={busy || !parsed.ok} style={btn(true)}>
            Save
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 0.9fr", gap: 14, marginTop: 14 }}>
        <div style={panel()}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderBottom: border() }}>
            <div style={{ fontWeight: 900 }}>JSON</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Tip: paste valid JSON only</div>
            <div style={{ marginLeft: "auto", fontSize: 12, opacity: parsed.ok ? 0.85 : 1, color: parsed.ok ? "inherit" : "crimson", fontWeight: 800 }}>
              {parsed.ok ? "✅ Valid" : "❌ Invalid"}
            </div>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            style={{
              width: "100%",
              minHeight: 520,
              padding: 12,
              resize: "vertical",
              fontFamily: "ui-monospace, Menlo, monospace",
              fontSize: 12,
              lineHeight: 1.45,
              outline: "none",
              border: "none",
              background: "transparent",
              color: "CanvasText",
            }}
          />
        </div>

        <div style={{ display: "grid", gap: 14 }}>
          <div style={panel()}>
            <div style={{ padding: "10px 12px", borderBottom: border(), fontWeight: 900 }}>Metadata</div>
            <pre style={pre()}>{prettyJson(meta)}</pre>
          </div>

          <div style={panel()}>
            <div style={{ padding: "10px 12px", borderBottom: border(), fontWeight: 900 }}>Parsed Payload (read-only)</div>
            <pre style={pre()}>{parsed.ok ? prettyJson(parsed.value) : "{}"}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function border() {
  return "1px solid color-mix(in oklab, CanvasText 16%, transparent)";
}
function panel() {
  return {
    border: border(),
    borderRadius: 14,
    overflow: "hidden",
    background: "color-mix(in oklab, CanvasText 3%, transparent)",
  } as const;
}
function pre() {
  return {
    margin: 0,
    padding: 12,
    whiteSpace: "pre-wrap",
    fontFamily: "ui-monospace, Menlo, monospace",
    fontSize: 12,
    lineHeight: 1.45,
    opacity: 0.92,
  } as const;
}
function btn(primary = false) {
  return {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: primary ? "color-mix(in oklab, CanvasText 10%, transparent)" : "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontWeight: 900,
    cursor: "pointer",
  } as const;
}
TSX

echo "✅ wrote: $FILE"

echo "==> Restart Next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$REPO/.logs"
( cd "$NEXT" && pnpm dev --port 3000 > "$REPO/.logs/next.log" 2>&1 ) &

# wait for Next
for i in $(seq 1 80); do
  curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1 && break
  sleep 0.25
done

echo "✅ Next is up"
echo "OPEN:"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads/v1_dirs?orgId=org_001"

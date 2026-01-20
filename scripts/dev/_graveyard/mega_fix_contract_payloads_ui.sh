#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

echo "==> (1) Create Next API route: /api/fn/getContractPayloadsV1"
mkdir -p next-app/src/app/api/fn/getContractPayloadsV1
cat > next-app/src/app/api/fn/getContractPayloadsV1/route.ts <<'TS'
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const qs = url.searchParams.toString();

    // Prefer env in Next (set this in next-app/.env.local if you want), else default to local emulator
    const FN_BASE =
      process.env.NEXT_PUBLIC_FN_BASE ||
      process.env.FN_BASE ||
      "http://127.0.0.1:5001/peakops-pilot/us-central1";

    const upstream = `${FN_BASE}/getContractPayloadsV1?${qs}`;
    const r = await fetch(upstream, { method: "GET" });

    const text = await r.text();
    return new NextResponse(text, {
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") || "application/json" },
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TS
echo "✅ wrote next-app/src/app/api/fn/getContractPayloadsV1/route.ts"

echo
echo "==> (2) Create /admin/contracts/[id]/payloads page (list + links)"
mkdir -p next-app/src/app/admin/contracts/[id]/payloads
cat > next-app/src/app/admin/contracts/'[id]'/payloads/page.tsx <<'TSX'
"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function mono(s: string) {
  return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{s}</span>;
}

export default function AdminContractPayloads() {
  const params = useParams<{ id: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const orgId = sp.get("orgId") || "org_001";

  const [docs, setDocs] = useState<any[]>([]);
  const [err, setErr] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=50`);
      const text = await r.text();
      let j: any = {};
      try { j = JSON.parse(text); } catch { j = { ok: false, error: text.slice(0, 500) }; }
      if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");
      setDocs(Array.isArray(j.docs) ? j.docs : []);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setDocs([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (contractId) load(); }, [contractId]); // eslint-disable-line

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>Admin · Contract {contractId} · Payloads</h1>
        <a href={`/admin/contracts/${encodeURIComponent(contractId)}?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none", opacity: 0.8, color: "CanvasText" }}>
          ← Back
        </a>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>Org: {orgId}</div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
        <button
          onClick={load}
          disabled={busy}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>

        {err ? <div style={{ color: "crimson", fontWeight: 800 }}>{err}</div> : <div style={{ opacity: 0.75 }}>Count: <b>{docs.length}</b></div>}
      </div>

      <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
        {docs.map((d: any) => (
          <a
            key={d.id}
            href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads/${encodeURIComponent(d.id)}?orgId=${encodeURIComponent(orgId)}`}
            style={{ textDecoration: "none", color: "CanvasText" }}
          >
            <div style={{
              border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
              borderRadius: 14,
              padding: 12,
              background: "color-mix(in oklab, CanvasText 3%, transparent)",
            }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>{d.type || d.id}</div>
                <div style={{ opacity: 0.75 }}>schema:</div>
                <div style={{ fontWeight: 800 }}>{d.schemaVersion || "—"}</div>
                <div style={{ opacity: 0.75 }}>doc:</div>
                <div>{mono(String(d.id || ""))}</div>
              </div>
              <div style={{ marginTop: 6, fontSize: 13, opacity: 0.85 }}>
                {mono(String(d.payloadHash || "—"))}
              </div>
            </div>
          </a>
        ))}
        {docs.length === 0 && !err && <div style={{ opacity: 0.7 }}>No payload docs found.</div>}
      </div>
    </div>
  );
}
TSX
echo "✅ wrote next-app/src/app/admin/contracts/[id]/payloads/page.tsx"

echo
echo "==> (3) Create /admin/contracts/[id]/payloads/[payloadId] page (simple JSON editor)"
mkdir -p next-app/src/app/admin/contracts/'[id]'/payloads/'[payloadId]'
cat > next-app/src/app/admin/contracts/'[id]'/payloads/'[payloadId]'/page.tsx <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function mono(s: string) {
  return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{s}</span>;
}

export default function AdminContractPayloadEditor() {
  const params = useParams<{ id: string; payloadId: string }>();
  const sp = useSearchParams();
  const contractId = params.id;
  const payloadId = params.payloadId;
  const orgId = sp.get("orgId") || "org_001";

  const [doc, setDoc] = useState<any>(null);
  const [text, setText] = useState<string>("{}");
  const [err, setErr] = useState<string>("");
  const [banner, setBanner] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const inferred = useMemo(() => {
    // payload doc IDs are like v1_dirs, v1_baba ...
    const parts = String(payloadId || "").split("_");
    const versionId = parts[0] || "v1";
    const type = parts.slice(1).join("_").toUpperCase(); // DIRS, OE_417, etc
    const schemaVersion = `${type.toLowerCase()}.v1`;
    return { versionId, type, schemaVersion };
  }, [payloadId]);

  async function load() {
    setBusy(true);
    setErr("");
    setBanner("");
    try {
      const r = await fetch(`/api/fn/getContractPayloadsV1?orgId=${encodeURIComponent(orgId)}&contractId=${encodeURIComponent(contractId)}&limit=200`);
      const text = await r.text();
      let j: any = {};
      try { j = JSON.parse(text); } catch { j = { ok: false, error: text.slice(0, 500) }; }
      if (!j?.ok) throw new Error(j?.error || "getContractPayloadsV1 failed");
      const docs = Array.isArray(j.docs) ? j.docs : [];
      const found = docs.find((x: any) => String(x.id) === String(payloadId));
      if (!found) throw new Error(`Payload doc not found: ${payloadId}`);
      setDoc(found);
      setText(JSON.stringify(found.payload || {}, null, 2));
    } catch (e: any) {
      setErr(String(e?.message || e));
      setDoc(null);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setErr("");
    setBanner("");
    try {
      let payloadObj: any = {};
      try { payloadObj = JSON.parse(text); } catch { throw new Error("Invalid JSON"); }

      const r = await fetch(`/api/fn/writeContractPayloadV1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId,
          contractId,
          type: inferred.type,
          versionId: inferred.versionId,
          schemaVersion: inferred.schemaVersion,
          payload: payloadObj,
          createdBy: "admin_ui",
        }),
      });
      const t = await r.text();
      let j: any = {};
      try { j = JSON.parse(t); } catch { j = { ok: false, error: t.slice(0, 500) }; }
      if (!j?.ok) throw new Error(j?.error || "writeContractPayloadV1 failed");
      setBanner(`✅ Saved (${j.payloadDocId || payloadId})`);
      await load();
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { if (contractId && payloadId) load(); }, [contractId, payloadId]); // eslint-disable-line

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>
          Admin · {mono(contractId)} · {mono(payloadId)}
        </h1>
        <a href={`/admin/contracts/${encodeURIComponent(contractId)}/payloads?orgId=${encodeURIComponent(orgId)}`} style={{ textDecoration: "none", opacity: 0.8, color: "CanvasText" }}>
          ← Back
        </a>
      </div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>Org: {orgId}</div>

      <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <button
          onClick={load}
          disabled={busy}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: "color-mix(in oklab, CanvasText 6%, transparent)",
            cursor: busy ? "not-allowed" : "pointer",
          }}
        >
          {busy ? "Loading…" : "Refresh"}
        </button>

        <button
          onClick={save}
          disabled={busy}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: "color-mix(in oklab, CanvasText 10%, transparent)",
            cursor: busy ? "not-allowed" : "pointer",
            fontWeight: 800,
          }}
        >
          Save
        </button>

        {banner && <div style={{ fontWeight: 900 }}>{banner}</div>}
        {err && <div style={{ color: "crimson", fontWeight: 900 }}>{err}</div>}
      </div>

      {doc && (
        <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
          type: <b>{doc.type}</b> · schema: <b>{doc.schemaVersion}</b> · hash: {mono(String(doc.payloadHash || "—"))}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          style={{
            width: "100%",
            minHeight: 520,
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: "color-mix(in oklab, CanvasText 2%, transparent)",
            color: "CanvasText",
            fontFamily: "ui-monospace, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.4,
            padding: 12,
          }}
        />
        <div style={{ marginTop: 8, opacity: 0.65, fontSize: 12 }}>
          Tip: paste valid JSON only. Save writes to Firestore via <b>writeContractPayloadV1</b>.
        </div>
      </div>
    </div>
  );
}
TSX
echo "✅ wrote next-app/src/app/admin/contracts/[id]/payloads/[payloadId]/page.tsx"

echo
echo "==> (4) Restart Next on 3000"
lsof -tiTCP:3000 -sTCP:LISTEN | xargs -I{} kill -9 {} 2>/dev/null || true
( pnpm -C next-app dev --port 3000 > .logs/next.log 2>&1 & )
sleep 0.5
echo "✅ Next restarted (tail logs: tail -n 80 .logs/next.log)"

echo
echo "==> (5) Quick smokes"
ORG_ID="${ORG_ID:-org_001}"
curl -sS "http://127.0.0.1:3000/api/fn/getContractPayloadsV1?orgId=${ORG_ID}&contractId=car_abc123&limit=50" | python3 -m json.tool | head -n 40 || true

echo
echo "✅ UI:"
echo "  http://localhost:3000/admin/contracts?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/car_abc123?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads?orgId=${ORG_ID}"
echo "  http://localhost:3000/admin/contracts/car_abc123/payloads/v1_dirs?orgId=${ORG_ID}"

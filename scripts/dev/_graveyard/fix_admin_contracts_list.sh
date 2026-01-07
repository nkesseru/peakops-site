#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
cd "$ROOT"

# -----------------------------
# 1) API route: /api/contracts/list
# -----------------------------
mkdir -p "next-app/src/app/api/contracts/list"
cat > "next-app/src/app/api/contracts/list/route.ts" <<'TS'
import { NextResponse } from "next/server";
import { initializeApp, getApps, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length) return;

  // In dev/emulator, projectId is enough.
  // FIRESTORE_EMULATOR_HOST is honored automatically by firebase-admin.
  initializeApp({
    projectId: process.env.NEXT_PUBLIC_PEAKOPS_PROJECT_ID || "peakops-pilot",
    credential: applicationDefault(),
  });
}

function toIso(x: any) {
  if (!x) return null;
  if (typeof x === "string") return x;
  if (typeof x === "object" && typeof x._seconds === "number") return new Date(x._seconds * 1000).toISOString();
  if (x instanceof Timestamp) return x.toDate().toISOString();
  return String(x);
}

export async function GET(req: Request) {
  try {
    initAdmin();
    const db = getFirestore();

    const url = new URL(req.url);
    const orgId = String(url.searchParams.get("orgId") || "");
    const limit = Math.min(parseInt(String(url.searchParams.get("limit") || "50"), 10) || 50, 200);

    if (!orgId) {
      return NextResponse.json({ ok: false, error: "Missing orgId" }, { status: 400 });
    }

    // v1: contracts are in top-level collection, partitioned by orgId
    const snap = await db
      .collection("contracts")
      .where("orgId", "==", orgId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const docs = snap.docs.map((d) => {
      const x: any = d.data() || {};
      return {
        id: d.id,
        orgId: x.orgId || orgId,
        contractNumber: x.contractNumber || "",
        customerId: x.customerId || "",
        type: x.type || "",
        status: x.status || "",
        createdAt: toIso(x.createdAt),
        updatedAt: toIso(x.updatedAt),
      };
    });

    return NextResponse.json({ ok: true, orgId, count: docs.length, docs });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
TS

echo "✅ wrote: next-app/src/app/api/contracts/list/route.ts"

# -----------------------------
# 2) Admin list page: /admin/contracts
# -----------------------------
mkdir -p "next-app/src/app/admin/contracts"
cat > "next-app/src/app/admin/contracts/page.tsx" <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

function mono(s: string) {
  return <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{s}</span>;
}

export default function AdminContractsList() {
  const sp = useSearchParams();
  const orgId = sp.get("orgId") || "org_001";

  const [docs, setDocs] = useState<any[]>([]);
  const [err, setErr] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(`/api/contracts/list?orgId=${encodeURIComponent(orgId)}&limit=50`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "list contracts failed");
      setDocs(Array.isArray(j.docs) ? j.docs : []);
    } catch (e: any) {
      setErr(String(e?.message || e));
      setDocs([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); }, [orgId]); // eslint-disable-line

  const rows = useMemo(() => docs, [docs]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>Admin · Contracts</h1>
        <div style={{ fontSize: 12, opacity: 0.7 }}>Org: {orgId}</div>
      </div>

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

        {err ? (
          <div style={{ color: "crimson", fontWeight: 800 }}>{err}</div>
        ) : (
          <div style={{ opacity: 0.75 }}>Contracts: <b>{rows.length}</b></div>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        {rows.length === 0 && !err && <div style={{ opacity: 0.7 }}>No contracts found.</div>}

        {rows.length > 0 && (
          <div style={{ border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)", borderRadius: 14, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "220px 160px 120px 120px 1fr", gap: 0, padding: 10, fontSize: 12, opacity: 0.8, borderBottom: "1px solid color-mix(in oklab, CanvasText 12%, transparent)" }}>
              <div>ID</div>
              <div>Contract #</div>
              <div>Type</div>
              <div>Status</div>
              <div>Customer</div>
            </div>

            {rows.map((c: any) => (
              <a
                key={c.id}
                href={`/admin/contracts/${encodeURIComponent(c.id)}?orgId=${encodeURIComponent(orgId)}`}
                style={{
                  textDecoration: "none",
                  color: "CanvasText",
                  display: "grid",
                  gridTemplateColumns: "220px 160px 120px 120px 1fr",
                  padding: 12,
                  borderBottom: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
                  background: "color-mix(in oklab, CanvasText 2%, transparent)",
                }}
              >
                <div>{mono(String(c.id))}</div>
                <div style={{ fontWeight: 800 }}>{c.contractNumber || "—"}</div>
                <div>{c.type || "—"}</div>
                <div>{c.status || "—"}</div>
                <div>{c.customerId ? mono(String(c.customerId)) : "—"}</div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
TSX

echo "✅ wrote: next-app/src/app/admin/contracts/page.tsx"

echo
echo "NEXT:"
echo "1) (Important) make sure Next is started from next-app/: pnpm -C next-app dev --port 3000"
echo "2) Visit: http://localhost:3000/admin/contracts?orgId=org_001"

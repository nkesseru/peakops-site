#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

# Stop zsh history expansion ruining scripts that contain "!"
set +H 2>/dev/null || true

echo "==> (1) Patch functions_clean/getContractsV1.mjs (cursor pagination)"
cat > functions_clean/getContractsV1.mjs <<'MJS'
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, FieldPath } from "firebase-admin/firestore";

if (!getApps().length) initializeApp();
const db = getFirestore();

export default async function getContractsV1(req, res) {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const orgId = String(req.query.orgId || "").trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

    // Cursor inputs (both required to paginate)
    const cursorUpdatedAtMsRaw = req.query.cursorUpdatedAtMs;
    const cursorId = String(req.query.cursorId || "").trim();

    if (!orgId) return res.status(400).json({ ok: false, error: "Missing orgId" });

    let q = db.collection("contracts")
      .where("orgId", "==", orgId)
      .orderBy("updatedAt", "desc")
      .orderBy(FieldPath.documentId(), "desc")
      .limit(limit);

    // If cursor provided, use startAfter(updatedAt, docId)
    if (cursorUpdatedAtMsRaw !== undefined && cursorUpdatedAtMsRaw !== null && String(cursorUpdatedAtMsRaw).trim() !== "" && cursorId) {
      const ms = Number(cursorUpdatedAtMsRaw);
      if (!Number.isFinite(ms) || ms <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid cursorUpdatedAtMs" });
      }
      const ts = Timestamp.fromMillis(ms);
      q = q.startAfter(ts, cursorId);
    }

    const snap = await q.get();
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // next cursor = last doc in this page
    let nextCursor = null;
    if (snap.docs.length > 0) {
      const last = snap.docs[snap.docs.length - 1];
      const data = last.data() || {};
      const updatedAt = data.updatedAt;
      // expect Timestamp; tolerate others
      let nextMs = null;
      if (updatedAt && typeof updatedAt === "object" && typeof updatedAt.toMillis === "function") nextMs = updatedAt.toMillis();
      if (updatedAt && typeof updatedAt === "object" && typeof updatedAt._seconds === "number") nextMs = updatedAt._seconds * 1000;
      if (typeof updatedAt === "string") {
        const t = Date.parse(updatedAt);
        if (!Number.isNaN(t)) nextMs = t;
      }
      nextCursor = (nextMs && last.id) ? { cursorUpdatedAtMs: nextMs, cursorId: last.id } : null;
    }

    return res.json({ ok: true, orgId, count: docs.length, docs, nextCursor });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
MJS
echo "✅ functions_clean/getContractsV1.mjs updated"

echo "==> (2) Patch functions_clean/index.mjs import + export (getContractsV1)"
python3 - <<'PY'
from pathlib import Path
p = Path("functions_clean/index.mjs")
s = p.read_text()

# ensure import exists
imp = 'import getContractsV1 from "./getContractsV1.mjs";'
if imp not in s:
  # insert after first onRequest import line
  i = s.find('from "firebase-functions/v2/https"')
  if i == -1:
    raise SystemExit("❌ couldn't find firebase-functions/v2/https import")
  line_end = s.find("\n", i)
  s = s[:line_end+1] + imp + "\n" + s[line_end+1:]

# ensure export exists
exp = "export const getContractsV1 = onRequest(getContractsV1);"
if exp not in s:
  # place after hello export
  anchor = "export const hello"
  j = s.find(anchor)
  if j == -1:
    raise SystemExit("❌ couldn't find hello export to anchor placement")
  end = s.find(");", j)
  if end == -1:
    raise SystemExit("❌ couldn't find end of hello handler")
  end = end + 3
  s = s[:end] + "\n\n" + exp + "\n" + s[end:]

p.write_text(s)
print("✅ functions_clean/index.mjs wired getContractsV1")
PY

echo "==> (3) Patch Next admin contracts page for Load More"
mkdir -p next-app/src/app/admin/contracts
cat > next-app/src/app/admin/contracts/page.tsx <<'TSX'
"use client";

import { useEffect, useMemo, useState } from "react";

type Cursor = { cursorUpdatedAtMs: number; cursorId: string } | null;

export default function AdminContractsList() {
  const sp = useMemo(() => new URLSearchParams(typeof window !== "undefined" ? window.location.search : ""), []);
  const orgId = sp.get("orgId") || "org_001";

  const [rows, setRows] = useState<any[]>([]);
  const [nextCursor, setNextCursor] = useState<Cursor>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function load(reset: boolean) {
    setBusy(true);
    setErr("");
    try {
      const cursor = reset ? null : nextCursor;
      const qs = new URLSearchParams();
      qs.set("orgId", orgId);
      qs.set("limit", "5");
      if (cursor?.cursorUpdatedAtMs && cursor?.cursorId) {
        qs.set("cursorUpdatedAtMs", String(cursor.cursorUpdatedAtMs));
        qs.set("cursorId", cursor.cursorId);
      }

      const r = await fetch(`/api/fn/getContractsV1?${qs.toString()}`);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getContractsV1 failed");

      const docs = Array.isArray(j.docs) ? j.docs : [];
      const nc = j.nextCursor && j.nextCursor.cursorUpdatedAtMs && j.nextCursor.cursorId ? j.nextCursor : null;

      setRows(prev => reset ? docs : [...prev, ...docs]);
      setNextCursor(nc);
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(true); }, []); // eslint-disable-line

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "CanvasText" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900 }}>Admin · Contracts</h1>
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>Org: {orgId}</div>
        </div>
        <div style={{ fontSize: 12, opacity: 0.6 }}>
          Ordering: updatedAt desc → docId desc (stable pagination).
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14, alignItems: "center" }}>
        <button
          onClick={() => load(true)}
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

        <div style={{ opacity: 0.8 }}>Contracts: <b>{rows.length}</b></div>

        <button
          onClick={() => load(false)}
          disabled={busy || !nextCursor}
          style={{
            padding: "8px 12px",
            borderRadius: 12,
            border: "1px solid color-mix(in oklab, CanvasText 20%, transparent)",
            background: nextCursor ? "color-mix(in oklab, CanvasText 6%, transparent)" : "transparent",
            opacity: nextCursor ? 1 : 0.5,
            cursor: (busy || !nextCursor) ? "not-allowed" : "pointer",
          }}
        >
          Load more
        </button>

        {err && <div style={{ color: "crimson", fontWeight: 800 }}>{err}</div>}
      </div>

      <div style={{ marginTop: 14, border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 160px 90px 90px 1fr", gap: 0, padding: 10, fontSize: 12, opacity: 0.75, borderBottom: "1px solid color-mix(in oklab, CanvasText 12%, transparent)" }}>
          <div>ID</div><div>Contract #</div><div>Type</div><div>Status</div><div>Customer</div>
        </div>

        {rows.map((r: any) => (
          <a
            key={r.id}
            href={`/admin/contracts/${encodeURIComponent(r.id)}?orgId=${encodeURIComponent(orgId)}`}
            style={{
              display: "grid",
              gridTemplateColumns: "180px 160px 90px 90px 1fr",
              gap: 0,
              padding: 12,
              textDecoration: "none",
              color: "CanvasText",
              borderTop: "1px solid color-mix(in oklab, CanvasText 10%, transparent)",
            }}
          >
            <div style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{r.id}</div>
            <div style={{ fontWeight: 800 }}>{r.contractNumber || "—"}</div>
            <div>{r.type || "—"}</div>
            <div>{r.status || "—"}</div>
            <div style={{ opacity: 0.9 }}>{r.customerId || "—"}</div>
          </a>
        ))}

        {rows.length === 0 && !err && (
          <div style={{ padding: 12, opacity: 0.7 }}>No contracts found.</div>
        )}
      </div>
    </div>
  );
}
TSX
echo "✅ next-app admin contracts page updated"

echo
echo "✅ B applied."
echo "NEXT: restart your canonical stack runner:"
echo "  bash scripts/dev/contracts_stack_up.sh car_abc123 cust_acme_001 v1"
echo
echo "Then open:"
echo "  http://localhost:3000/admin/contracts?orgId=org_001"

#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

# --------
# (1) API route: validateIncidentFilingsV1
# --------
API_DIR="next-app/src/app/api/fn/validateIncidentFilingsV1"
mkdir -p "$API_DIR"

cat > "$API_DIR/route.ts" <<'TS'
import { proxyGET } from "../_lib/fnProxy";

export const runtime = "nodejs";

/**
 * validateIncidentFilingsV1 (UI helper)
 * - Loads incident bundle (filings)
 * - Validates DIRS + OE_417 payloads
 * - Returns compact JSON suitable for UI
 *
 * NOTE: This route does NOT call Firebase directly.
 * It calls your existing Next fn routes so it works in emulator/prod equally.
 */
function isIso(s: any) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

function validateDirs(p: any) {
  const errs: string[] = [];
  if ((p?.filingType || "") !== "DIRS") errs.push("filingType must be 'DIRS'");
  if (typeof p?.incidentId !== "string" || !p.incidentId) errs.push("incidentId required (string)");
  if (typeof p?.orgId !== "string" || !p.orgId) errs.push("orgId required (string)");
  if (!isIso(p?.startTime)) errs.push("startTime required (ISO string)");

  const ot = String(p?.outageType || "");
  const allowed = new Set(["WIRELINE","WIRELESS","BROADBAND","OTHER"]);
  if (!allowed.has(ot)) errs.push("outageType required (WIRELINE/WIRELESS/BROADBAND/OTHER)");

  const nar = String(p?.narrative || "");
  if (nar.trim().length < 10) errs.push("narrative required (>=10 chars)");

  const ac = p?.affectedCount;
  if (typeof ac !== "number" || ac < 0) errs.push("affectedCount required (number >=0)");

  if (typeof p?.location !== "object" || !p.location) errs.push("location required (object)");
  return errs;
}

function validateOE417(p: any) {
  const errs: string[] = [];
  if ((p?.filingType || "") !== "OE_417") errs.push("filingType must be 'OE_417'");
  if (typeof p?.incidentId !== "string" || !p.incidentId) errs.push("incidentId required (string)");
  if (typeof p?.orgId !== "string" || !p.orgId) errs.push("orgId required (string)");
  if (!isIso(p?.startTime)) errs.push("startTime required (ISO string)");

  const et = String(p?.eventType || "");
  if (!et) errs.push("eventType required (string)");

  const imp = String(p?.impact || "");
  const allowed = new Set(["PARTIAL_SERVICE","TOTAL_OUTAGE","DEGRADED","OTHER"]);
  if (!allowed.has(imp)) errs.push("impact required (PARTIAL_SERVICE/TOTAL_OUTAGE/DEGRADED/OTHER)");

  const nar = String(p?.narrative || "");
  if (nar.trim().length < 10) errs.push("narrative required (>=10 chars)");

  return errs;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "org_001";
  const incidentId = url.searchParams.get("incidentId") || "";

  if (!incidentId) {
    return new Response(JSON.stringify({ ok: false, error: "Missing incidentId" }), { status: 400 });
  }

  // pull incident bundle via Next fn route (works in emulator/prod)
  const origin = url.origin;
  const bUrl = `${origin}/api/fn/getIncidentBundleV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
  const bRes = await fetch(bUrl);
  const bTxt = await bRes.text();

  let bundle: any = null;
  try { bundle = JSON.parse(bTxt); } catch {}

  const filings = Array.isArray(bundle?.filings) ? bundle.filings : [];
  const pickType = (d: any) => String(d?.type || d?.filingType || "").toUpperCase();
  const byType: Record<string, any> = {};
  for (const f of filings) byType[pickType(f)] = f;

  const dirsPayload = byType["DIRS"]?.payload || byType["DIRS"] || {};
  const oePayload = byType["OE_417"]?.payload || byType["OE_417"] || {};

  const dirsErrs = validateDirs(dirsPayload);
  const oeErrs = validateOE417(oePayload);

  const out = {
    ok: dirsErrs.length === 0 && oeErrs.length === 0,
    orgId,
    incidentId,
    generatedAt: new Date().toISOString(),
    results: {
      DIRS: { valid: dirsErrs.length === 0, errors: dirsErrs },
      OE_417: { valid: oeErrs.length === 0, errors: oeErrs },
    }
  };

  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
TS

echo "✅ created: $API_DIR/route.ts"

# --------
# (2) UI component: ValidationPanel.tsx (colors + collapsible errors)
# --------
COMP_DIR="next-app/src/app/admin/_components"
mkdir -p "$COMP_DIR"

cat > "$COMP_DIR/ValidationPanel.tsx" <<'TSX'
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
TSX

echo "✅ created: $COMP_DIR/ValidationPanel.tsx"

# --------
# (3) Wire into incident page (PanelCard under Packet State)
# --------
INC_FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
if [[ ! -f "$INC_FILE" ]]; then
  echo "❌ missing incidents page: $INC_FILE"
  exit 1
fi

cp "$INC_FILE" "$INC_FILE.bak_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup: $INC_FILE.bak_*"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# ensure import
if "ValidationPanel" not in s:
  s = re.sub(r'(^import .*?\n)+',
             lambda m: m.group(0) + 'import ValidationPanel from "../../_components/ValidationPanel";\n',
             s, count=1, flags=re.M)

# insert panel near existing Packet State stub, else insert after GuidedWorkflowPanel
inserted = False
marker = "Packet State"
if marker in s and "Schema Validation" not in s:
  s = s.replace(marker, marker + '",>\n          <ValidationPanel orgId={orgId} incidentId={incidentId} onOkChange={(ok)=>{ try { if(ok){ const k=`wf:${orgId}:${incidentId}`; const raw=localStorage.getItem(k); const m=raw?JSON.parse(raw):{}; m["filings"]="DONE"; localStorage.setItem(k, JSON.stringify(m)); } } catch {} }} />\n        <PanelCard title="Packet State', 1)
  inserted = True

if not inserted and "Schema Validation" not in s:
  # fallback: insert before first <Modal open=
  m = re.search(r'\n\s*<Modal\s+open=', s)
  if m:
    block = '\n      <PanelCard title="Schema Validation">\n        <ValidationPanel orgId={orgId} incidentId={incidentId} />\n      </PanelCard>\n'
    s = s[:m.start()] + block + s[m.start():]

p.write_text(s)
print("✅ incident page wired with ValidationPanel")
PY

# --------
# (4) Restart Next
# --------
echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

# --------
# (5) Smoke
# --------
echo "==> smoke api"
curl -fsS "http://127.0.0.1:3000/api/fn/validateIncidentFilingsV1?orgId=org_001&incidentId=inc_TEST" | head -c 220; echo

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "If UI still 500, run:"
echo "  tail -n 120 .logs/next.log"

#!/usr/bin/env bash
set -euo pipefail

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "${FILE}.bak_${TS}"
echo "✅ backup: ${FILE}.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# 1) Ensure React import has useMemo/useEffect/useState
m = re.search(r'^\s*import\s+React\s*,\s*\{\s*([^}]+)\s*\}\s*from\s*"react"\s*;\s*$', s, re.M)
if m:
    parts = [x.strip() for x in m.group(1).split(",") if x.strip()]
    need = {"useMemo","useEffect","useState"}
    merged = list(dict.fromkeys(parts + sorted(list(need - set(parts)))))
    s = re.sub(r'^\s*import\s+React\s*,\s*\{\s*([^}]+)\s*\}\s*from\s*"react"\s*;\s*$',
               'import React, { ' + ", ".join(merged) + ' } from "react";',
               s, flags=re.M)

# 2) Helpers block (emblem + colors + history) only once
if "/*__GWP_UI_HELPERS_V1__*/" not in s:
    helpers = r'''
/*__GWP_UI_HELPERS_V1__*/
type Role = "admin" | "tech" | "viewer";
type StepStatus = "TODO" | "DOING" | "DONE";

type WfHistItem = {
  ts: string;
  stepKey: string;
  from?: StepStatus;
  to: StepStatus;
  mode: "AUTO" | "MANUAL";
};

const AUTO_EMBLEM_STYLE: "flow" | "ai" | "cloud" = "flow";

function autoEmblem(): React.ReactNode {
  const frame: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    borderRadius: 8,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: "color-mix(in oklab, CanvasText 6%, transparent)",
  };

  if (AUTO_EMBLEM_STYLE === "ai") {
    return (
      <span style={frame} aria-label="Auto checks" title="Auto checks">
        <span style={{ fontSize: 11, fontWeight: 950, letterSpacing: 0.4 }}>AI</span>
      </span>
    );
  }

  if (AUTO_EMBLEM_STYLE === "cloud") {
    return (
      <span style={frame} aria-label="Auto checks" title="Auto checks">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.7A3.5 3.5 0 0 0 7 18Z"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
    );
  }

  // flow (default): arrows + nodes
  return (
    <span style={frame} aria-label="Auto checks" title="Auto checks">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M7 8h6a3 3 0 0 1 0 6H8"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M7 8l2-2M7 8l2 2"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M8 14l-2 2M8 14l-2-2"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        <circle cx="17.5" cy="8" r="1.5" fill="currentColor" />
        <circle cx="17.5" cy="14" r="1.5" fill="currentColor" />
      </svg>
    </span>
  );
}

function bannerTone(level: "OK" | "WARN" | "ERR") {
  if (level === "OK") return { bd: "1px solid color-mix(in oklab, lime 24%, transparent)", bg: "color-mix(in oklab, lime 12%, transparent)" };
  if (level === "ERR") return { bd: "1px solid color-mix(in oklab, crimson 26%, transparent)", bg: "color-mix(in oklab, crimson 12%, transparent)" };
  return { bd: "1px solid color-mix(in oklab, orange 26%, transparent)", bg: "color-mix(in oklab, orange 12%, transparent)" };
}

function statusAccent(st: StepStatus): string {
  if (st === "DONE") return "color-mix(in oklab, lime 55%, CanvasText)";
  if (st === "DOING") return "color-mix(in oklab, orange 60%, CanvasText)";
  return "color-mix(in oklab, CanvasText 28%, transparent)";
}

function statusPillStyle(st: StepStatus): React.CSSProperties {
  const bg =
    st === "DONE" ? "color-mix(in oklab, lime 18%, transparent)" :
    st === "DOING" ? "color-mix(in oklab, orange 16%, transparent)" :
    "color-mix(in oklab, CanvasText 6%, transparent)";
  const bd =
    st === "DONE" ? "1px solid color-mix(in oklab, lime 26%, transparent)" :
    st === "DOING" ? "1px solid color-mix(in oklab, orange 24%, transparent)" :
    "1px solid color-mix(in oklab, CanvasText 18%, transparent)";
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: bd,
    background: bg,
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 900,
    cursor: "pointer",
    userSelect: "none",
  };
}

function readHist(key: string): WfHistItem[] {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeHist(key: string, items: WfHistItem[]) {
  try { localStorage.setItem(key, JSON.stringify(items.slice(-25))); } catch {}
}
/*__GWP_UI_HELPERS_V1_END__*/
'''.strip("\n")

    mi = re.search(r'^(?:import[^\n]*\n)+', s, re.M)
    ins = mi.end() if mi else 0
    s = s[:ins] + "\n" + helpers + "\n" + s[ins:]

# 3) Add role prop
s = re.sub(
  r'export\s+default\s+function\s+GuidedWorkflowPanel\s*\(\s*props:\s*\{\s*orgId:\s*string;\s*incidentId:\s*string\s*\}\s*\)',
  'export default function GuidedWorkflowPanel(props: { orgId: string; incidentId: string; role?: Role })',
  s
)

# Ensure role declared
s = re.sub(
  r'const\s*\{\s*orgId\s*,\s*incidentId\s*\}\s*=\s*props\s*;',
  'const { orgId, incidentId } = props;\n  const role: Role = (props as any)?.role || "admin";',
  s
)

# 4) Add histKey + hist state if storageKey exists
if "histKey" not in s and re.search(r'const\s+storageKey\s*=\s*useMemo\(', s):
    s = re.sub(
      r'const\s+storageKey\s*=\s*useMemo\(\s*\(\)\s*=>\s*`wf:\$\{orgId\}:\$\{incidentId\}`\s*,\s*\[orgId,\s*incidentId\]\s*\)\s*;',
      'const storageKey = useMemo(() => `wf:${orgId}:${incidentId}`, [orgId, incidentId]);\n  const histKey = useMemo(() => `wf_hist:${orgId}:${incidentId}`, [orgId, incidentId]);',
      s
    )

if "const [hist," not in s and "histKey" in s:
    s = re.sub(
      r'(const\s+\[localStatus,\s*setLocalStatus\]\s*=\s*useState<[^>]+>\([\s\S]*?\);\s*)',
      r'\1\n  const [hist, setHist] = useState<WfHistItem[]>(() => (typeof window === "undefined" ? [] : readHist(histKey)));',
      s,
      count=1
    )

if "setHist(readHist(histKey))" not in s and "histKey" in s:
    s = s + "\n" + 'useEffect(() => { if (typeof window !== "undefined") setHist(readHist(histKey)); }, [histKey]);\n'

# 5) Patch setStatus to log history + viewer guard (best effort)
if "mode: \"MANUAL\"" not in s and re.search(r'function\s+setStatus\s*\(', s):
    s = re.sub(
      r'function\s+setStatus\s*\(\s*key:\s*string\s*,\s*status:\s*StepStatus\s*\)\s*\{[\s\S]*?\n\s*\}',
      r'''function setStatus(key: string, status: StepStatus) {
    if (role === "viewer") return;
    const k = String(key);
    const prev = (localStatus as any)[k] || "TODO";
    const next = { ...(localStatus as any), [k]: status };
    setLocalStatus(next as any);
    writeLocal(storageKey, next as any);

    const item: WfHistItem = { ts: new Date().toISOString(), stepKey: k, from: prev, to: status, mode: "MANUAL" };
    const nextHist = [...(hist || []), item].slice(-25);
    setHist(nextHist);
    writeHist(histKey, nextHist);
  }''',
      s,
      count=1
    )

# 6) Banner: add emblem to header text (only if we can find "Auto-checks")
s = re.sub(
  r'(<div[^>]*fontWeight:\s*900[^>]*>\s*)(Auto-checks[^<]*)(</div>)',
  r'\1<span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>{autoEmblem()}<span>\2</span></span>\3',
  s,
  flags=re.M
)

# 7) Reduce nested card feel: add left accent on step cards if we see card() usage
s = s.replace(
  '<div key={String(s.key || idx)} style={card()}>',
  '<div key={String(s.key || idx)} style={{ ...card(), borderLeft: `6px solid ${statusAccent(st as any)}` }}>'
)

# 8) Replace pill usage with statusPillStyle for right-side status
s = s.replace('style={pill(true)}', 'style={statusPillStyle(st as any)}')

# 9) Add Revision history block once
if "Revision history (local)" not in s:
    hist_block = r'''
      <details style={{ marginTop: 10, opacity: 0.95 }}>
        <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>
          Revision history (local)
        </summary>
        {hist.length === 0 ? (
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>No actions yet.</div>
        ) : (
          <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
            {hist.slice().reverse().map((h, i) => (
              <div
                key={String(h.ts) + ":" + i}
                style={{
                  border: "1px solid color-mix(in oklab, CanvasText 14%, transparent)",
                  borderRadius: 12,
                  padding: "8px 10px",
                  background: "color-mix(in oklab, CanvasText 3%, transparent)",
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  alignItems: "baseline",
                }}
              >
                <div style={{ fontSize: 12, opacity: 0.9 }}>
                  <span style={{ fontWeight: 950 }}>{h.mode}</span>{" "}
                  <span style={{ opacity: 0.75 }}>step</span>{" "}
                  <span style={{ fontWeight: 950 }}>{h.stepKey}</span>{" "}
                  <span style={{ opacity: 0.75 }}>→</span>{" "}
                  <span style={{ fontWeight: 950 }}>{h.to}</span>
                  {h.from ? <span style={{ opacity: 0.6 }}> (was {h.from})</span> : null}
                </div>
                <div style={{ fontSize: 11, opacity: 0.6 }}>{new Date(h.ts).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </details>
'''.strip("\n")

    pos = s.find("Auto-checks")
    if pos != -1:
        cut = s.find("</div>", pos)
        if cut != -1:
            s = s[:cut+6] + "\n" + hist_block + "\n" + s[cut+6:]
        else:
            s += "\n" + hist_block + "\n"
    else:
        s += "\n" + hist_block + "\n"

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: emblem + color + revision history + role overrides (demo safe)")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke incidents page"
curl -fsS "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" >/dev/null \
  && echo "✅ incidents page OK" \
  || { echo "❌ still failing"; tail -n 180 .logs/next.log; exit 1; }

echo
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/inc_TEST?orgId=org_001"
echo
echo "✅ done"

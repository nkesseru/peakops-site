#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
ts="$(date +%Y%m%d_%H%M%S)"
cp "$FILE" "$FILE.bak_${ts}"
echo "✅ backup: $FILE.bak_${ts}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# ---- helpers ----
def must_find(pattern, text, msg):
  m = re.search(pattern, text, re.M)
  if not m:
    raise SystemExit(msg)
  return m

# 1) Ensure import includes useRef
s = re.sub(
  r'import\s+React,\s*\{\s*([^}]+)\s*\}\s*from\s*"react";',
  lambda m: (lambda parts: f'import React, {{ {", ".join(sorted(set(parts + ["useRef"])))} }} from "react";')(
    [x.strip() for x in m.group(1).split(",") if x.strip()]
  ),
  s,
  count=1
)

# 2) Ensure helper block exists (safeFetchJson + baseline + filing helpers)
if "async function safeFetchJson" not in s:
  sp = s.find("function safeParseJson")
  if sp < 0:
    raise SystemExit("❌ Could not find safeParseJson() in GuidedWorkflowPanel.tsx")
  m = must_find(r'function\s+safeParseJson[\s\S]*?\n\}', s[sp:], "❌ Could not parse safeParseJson() block")
  pos = sp + m.end()

  helper = r'''

async function safeFetchJson(url: string): Promise<
  | { ok: true; status: number; json: any; sample: string }
  | { ok: false; status: number; error: string; sample: string }
> {
  try {
    const r = await fetch(url, { method: "GET" });
    const text = await r.text();
    const sample = (text || "").slice(0, 180).replace(/\s+/g, " ");
    if (!text || !text.trim()) return { ok: false, status: r.status, error: "EMPTY_BODY", sample };

    const parsed = safeParseJson(text);
    if (!parsed.ok) return { ok: false, status: r.status, error: `NON_JSON: ${parsed.error}`, sample };

    return { ok: true, status: r.status, json: parsed.value, sample };
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e?.message || e), sample: "" };
  }
}

function hasBaselineIncidentFields(inc: any): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const req: [string, (x: any) => boolean][] = [
    ["title", (x) => typeof x === "string" && x.trim().length > 0],
    ["startTime", (x) => typeof x === "string" && x.trim().length > 0],
    ["orgId", (x) => typeof x === "string" && x.trim().length > 0],
  ];
  for (const [k, pred] of req) {
    if (!pred(inc?.[k])) missing.push(k);
  }
  return { ok: missing.length === 0, missing };
}

function pickFilingType(d: any): string {
  const t = d?.type || d?.filingType || d?.filing_type;
  return String(t || "").toUpperCase();
}

function filingHasPayload(d: any): boolean {
  const p = d?.payload ?? null;
  return !!(p && typeof p === "object" && !Array.isArray(p));
}
'''
  s = s[:pos] + helper + s[pos:]

# 3) Add auto-check state + runRef
wf_decl = must_find(r'const\s+\[wf,\s*setWf\]\s*=\s*useState<Workflow\s*\|\s*null>\(null\);\s*', s, "❌ missing wf state")
insert_pos = wf_decl.end()

if "autoCheckedAt" not in s:
  s = s[:insert_pos] + r'''

  // --- Real auto-checks (enterprise-safe, visible, non-destructive) ---
  const [autoStatus, setAutoStatus] = useState<Record<string, StepStatus>>({});
  const [autoNotes, setAutoNotes] = useState<string>("");
  const [autoCheckedAt, setAutoCheckedAt] = useState<string>("");
  const [autoLevel, setAutoLevel] = useState<"OK" | "WARN" | "BLOCK">("OK");
  const autoRunRef = useRef(0);
  // --- end auto-checks ---
''' + s[insert_pos:]

# 4) Insert runAutoChecks() after load() if missing
if "async function runAutoChecks" not in s:
  mload = must_find(r'async function load\(\)\s*\{[\s\S]*?\n\s*\}', s, "❌ could not locate load()")
  pos = mload.end()

  s = s[:pos] + r'''

  async function runAutoChecks(): Promise<void> {
    const runId = (autoRunRef.current || 0) + 1;
    autoRunRef.current = runId;

    const now = new Date().toISOString();
    setAutoCheckedAt(now);
    setAutoNotes("");
    setAutoLevel("OK");

    const notes: string[] = [];
    const nextAuto: Record<string, StepStatus> = {};
    let level: "OK" | "WARN" | "BLOCK" = "OK";

    // Helper to mark severity
    const warn = (msg: string) => {
      notes.push(`WARN: ${msg}`);
      if (level === "OK") level = "WARN";
    };
    const block = (msg: string) => {
      notes.push(`BLOCKER: ${msg}`);
      level = "BLOCK";
    };

    try {
      // (1) Intake: incident exists + baseline fields
      {
        const url =
          `/api/fn/getIncidentV1?orgId=${encodeURIComponent(orgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}`;

        const r = await safeFetchJson(url);
        if (!r.ok || r.json?.ok === false) {
          block(`Intake failed (HTTP ${r.status || "?"}): ${r.json?.error || r.error}`);
        } else {
          const inc = r.json?.doc || r.json?.incident || null;
          if (!inc) {
            block("Intake: incident doc missing");
          } else {
            const b = hasBaselineIncidentFields(inc);
            if (b.ok) nextAuto["intake"] = "DONE";
            else warn(`Intake missing: ${b.missing.join(", ")}`);
          }
        }
      }

      // (2) Timeline: events exist
      {
        const url =
          `/api/fn/getTimelineEvents?orgId=${encodeURIComponent(orgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}&limit=1`;
        const r = await safeFetchJson(url);
        if (!r.ok || r.json?.ok === false) {
          warn(`Timeline check failed (HTTP ${r.status || "?"}): ${r.json?.error || r.error}`);
        } else {
          const count = Number(r.json?.count || 0);
          if (count > 0) nextAuto["timeline"] = "DONE";
        }
      }

      // (3) Filings: bundle has DIRS + OE_417 and payloads
      {
        const url =
          `/api/fn/getIncidentBundleV1?orgId=${encodeURIComponent(orgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}`;
        const r = await safeFetchJson(url);
        if (!r.ok || r.json?.ok === false) {
          warn(`Bundle/Filings check failed (HTTP ${r.status || "?"}): ${r.json?.error || r.error}`);
        } else {
          const filings = Array.isArray(r.json?.filings) ? r.json.filings : [];
          const dirs = filings.find((d: any) => pickFilingType(d) === "DIRS");
          const oe   = filings.find((d: any) => pickFilingType(d) === "OE_417");

          const miss: string[] = [];
          if (!dirs) miss.push("DIRS");
          if (!oe) miss.push("OE_417");
          if (dirs && !filingHasPayload(dirs)) miss.push("DIRS.payload");
          if (oe && !filingHasPayload(oe)) miss.push("OE_417.payload");

          if (miss.length === 0) nextAuto["filings"] = "DONE";
          else warn(`Filings missing: ${miss.join(", ")}`);
        }
      }

      // (4) Export: packet endpoint responds (HEAD)
      {
        const url =
          `/api/fn/downloadIncidentPacketZip?orgId=${encodeURIComponent(orgId)}` +
          `&incidentId=${encodeURIComponent(incidentId)}`;
        try {
          const hr = await fetch(url, { method: "HEAD" });
          if (hr.ok) nextAuto["export"] = "DONE";
          else warn(`Packet endpoint not ready (HTTP ${hr.status})`);
        } catch (e: any) {
          warn(`Packet endpoint check failed: ${String(e?.message || e)}`);
        }
      }

    } catch (e: any) {
      block(`Auto-checks crashed: ${String(e?.message || e)}`);
    }

    if (autoRunRef.current != runId) return; // stale

    setAutoStatus(nextAuto);
    setAutoLevel(level);
    setAutoNotes(notes.join(" · "));
  }
''' + s[pos:]

# 5) Ensure steps precedence: manual -> auto -> server
msteps = must_find(r'return\s+base\.map\(\(s\)\s*=>\s*\(\{[\s\S]*?\}\)\s*\);', s, "❌ could not locate steps mapping block")
steps_block = r"""return base.map((s) => {
      const k = String(s.key);
      const manual = localStatus[k];
      const auto = autoStatus[k];
      return {
        ...s,
        status: manual || auto || s.status || "TODO",
      };
    });"""
s = s[:msteps.start()] + steps_block + s[msteps.end():]

# 6) Trigger auto-checks after load completes + on refresh click
s = re.sub(r'(setWf\(workflow\);\s*)', r'\1\n      void runAutoChecks();\n', s, count=1)
s = s.replace(
  '<button onClick={load} disabled={busy} style={pill(false)}>',
  '<button onClick={() => { void load(); void runAutoChecks(); }} disabled={busy} style={pill(false)}>'
)

# 7) Add AUTO banner under header (visible + severity color)
if "AUTO checked:" not in s:
  anchor = "</button>\n      </div>"
  if anchor not in s:
    raise SystemExit("❌ could not find header anchor to inject AUTO banner")

  banner = r'''</button>
      </div>

      <div style={{
        marginTop: 8,
        fontSize: 12,
        opacity: 0.9,
        display: "flex",
        gap: 10,
        alignItems: "baseline",
        flexWrap: "wrap"
      }}>
        <span style={{
          fontWeight: 950,
          padding: "2px 8px",
          borderRadius: 999,
          border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
          background:
            autoLevel === "BLOCK"
              ? "color-mix(in oklab, red 22%, transparent)"
              : autoLevel === "WARN"
                ? "color-mix(in oklab, orange 18%, transparent)"
                : "color-mix(in oklab, CanvasText 8%, transparent)"
        }}>
          AUTO {autoLevel}
        </span>
        <span style={{ opacity: 0.75 }}>
          checked: {autoCheckedAt ? new Date(autoCheckedAt).toLocaleString() : "—"}
        </span>
        {autoNotes ? (
          <span style={{
            color: autoLevel === "BLOCK" ? "crimson" : "inherit",
            fontWeight: autoLevel === "BLOCK" ? 900 : 700
          }}>
            · {autoNotes}
          </span>
        ) : (
          <span style={{ opacity: 0.7 }}>· no issues detected</span>
        )}
      </div>'''
  s = s.replace(anchor, banner + "\n      </div>", 1)

# 8) Make status pill slightly stronger for DOING (optional polish; safe)
if 'level: "NORMAL" | "DOING"' not in s:
  s = re.sub(
    r'function\s+pill\s*\(\s*active:\s*boolean\s*\)\s*:\s*React\.CSSProperties\s*\{',
    'function pill(active: boolean, level: "NORMAL" | "DOING" = "NORMAL"): React.CSSProperties {',
    s,
    count=1
  )
  s = s.replace(
    'background: active\n      ? "color-mix(in oklab, CanvasText 10%, transparent)"\n      : "transparent",',
    'background: active\n      ? (level === "DOING"\n          ? "color-mix(in oklab, CanvasText 16%, transparent)"\n          : "color-mix(in oklab, CanvasText 10%, transparent)")\n      : "transparent",'
  )
  s = s.replace(
    "<span style={pill(true)}>{st}</span>",
    "<span style={pill(true, st === \"DOING\" ? \"DOING\" : \"NORMAL\")}>{st}</span>"
  )

p.write_text(s)
print("✅ GuidedWorkflowPanel patched: real auto-checks + visible severity + safe precedence")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p .logs
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
sleep 2

echo "==> smoke"
curl -fsSI "http://127.0.0.1:3000/admin/incidents/inc_TEST?orgId=org_001" | head -n 10 || true
echo "✅ done"

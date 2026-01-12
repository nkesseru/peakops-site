#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
PROJECT_ID="${3:-peakops-pilot}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

LOGDIR=".logs"
mkdir -p "$LOGDIR" "scripts/dev/_bak"

echo "==> hard-kill ports + stray dev/emulator procs"
for p in 3000 5001 8081 4409 4500 9150; do
  lsof -nP -iTCP:$p -sTCP:LISTEN | awk 'NR>1{print $2}' | xargs -r kill -9 || true
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

GUIDED="next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
cp "$GUIDED" "scripts/dev/_bak/GuidedWorkflowPanel.tsx.bak_${TS}"
echo "✅ backup: scripts/dev/_bak/GuidedWorkflowPanel.tsx.bak_${TS}"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# --- Ensure pill() helper exists ---
if "function pill(" not in s and "const pill" not in s:
    # Insert after first style helper (card/frame) or after imports as fallback
    pill_fn = r'''
function pill(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 999,
    border: "1px solid color-mix(in oklab, CanvasText 18%, transparent)",
    background: active
      ? "color-mix(in oklab, CanvasText 10%, transparent)"
      : "color-mix(in oklab, CanvasText 6%, transparent)",
    color: "CanvasText",
    fontSize: 12,
    fontWeight: 900,
    cursor: "pointer",
    userSelect: "none",
    lineHeight: "16px",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
  };
}
'''.strip("\n") + "\n\n"

    m = re.search(r'function\s+card\(\)', s)
    if m:
        # insert right before card() so it’s near other style helpers
        s = s[:m.start()] + pill_fn + s[m.start():]
    else:
        # insert after "use client" + imports
        m2 = re.search(r'("use client";\s*)', s)
        if m2:
            ins_at = m2.end()
            s = s[:ins_at] + "\n\n" + pill_fn + s[ins_at:]
        else:
            s = pill_fn + s

# --- Ensure exportNow exists inside the component ---
# We'll insert it inside GuidedWorkflowPanel component scope right before `return (`
if "exportNow" not in s or re.search(r'\b(onClick=\{\s*exportNow\s*\}|onClick=\(\)\s*=>\s*exportNow)', s):
    # Find component body
    comp = re.search(r'export\s+default\s+function\s+GuidedWorkflowPanel\s*\([^)]*\)\s*\{', s)
    if not comp:
        raise SystemExit("❌ Could not find GuidedWorkflowPanel() function header.")

    # Insert exportNow only if not already defined as a function/const
    if not re.search(r'\b(async\s+function\s+exportNow\b|const\s+exportNow\s*=)', s):
        # place before `return (` inside component
        ret = re.search(r'\n\s*return\s*\(\s*\n', s)
        if not ret:
            raise SystemExit("❌ Could not find `return (` in GuidedWorkflowPanel to insert exportNow().")

        export_fn = r'''
  async function exportNow() {
    // Safe, read-only export: calls export endpoint (if present), then opens bundle page.
    setBusy(true);
    setErr("");
    try {
      const api =
        `/api/fn/exportIncidentPacketV1?orgId=${encodeURIComponent(orgId)}` +
        `&incidentId=${encodeURIComponent(incidentId)}`;

      // Fire-and-forget: we don’t block UI if backend returns non-JSON
      const r = await fetch(api, { method: "GET" });
      const txt = await r.text().catch(() => "");

      try {
        const j = JSON.parse(txt || "{}");
        if (j?.ok === false) setErr(String(j?.error || "exportIncidentPacketV1 failed"));
      } catch {
        // ignore non-JSON (Next HTML error etc)
      }

      // Always open bundle page (canonical artifact view)
      const bundleUrl =
        `/admin/incidents/${encodeURIComponent(incidentId)}/bundle?orgId=${encodeURIComponent(orgId)}`;
      if (typeof window !== "undefined") {
        window.open(bundleUrl, "_blank", "noopener,noreferrer");
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }
'''.strip("\n") + "\n\n"

        s = s[:ret.start()] + "\n" + export_fn + s[ret.start():]

# --- Make Export button safe even if something weird happens ---
# Replace onClick={exportNow} with onClick={() => void exportNow()}
s = re.sub(r'onClick=\{\s*exportNow\s*\}', r'onClick={() => void exportNow()}', s)

p.write_text(s)
print("✅ patched GuidedWorkflowPanel: ensured pill() + exportNow() + safe onClick")
PY

echo "==> start emulators (functions+firestore)"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
echo "   emu pid: $EMU_PID"

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
echo "==> wait for hello (max ~30s)"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ emulator hello not responding"; tail -n 120 "$LOGDIR/emulators.log"; exit 1; }
echo "✅ emulator ready"

echo "==> start Next"
( cd next-app && pnpm dev --port 3000 > "../$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
sleep 2

BASE_URL="http://127.0.0.1:3000"
INC_URL="$BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
BUNDLE_URL="$BASE_URL/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"

echo "==> smoke incident page"
curl -fsS "$INC_URL" >/dev/null && echo "✅ incident page OK" || { echo "❌ incident page failing"; tail -n 180 "$LOGDIR/next.log"; exit 1; }

echo "==> smoke bundle page"
curl -fsS "$BUNDLE_URL" >/dev/null && echo "✅ bundle page OK" || { echo "❌ bundle page failing"; tail -n 180 "$LOGDIR/next.log"; exit 1; }

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  $INC_URL"
echo "  $BUNDLE_URL"
echo
echo "LOGS:"
echo "  tail -n 120 $LOGDIR/emulators.log"
echo "  tail -n 120 $LOGDIR/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"

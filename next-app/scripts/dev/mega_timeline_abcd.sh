#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   bash scripts/dev/mega_timeline_abcd.sh <PROJECT_ID> <ORG_ID> <INCIDENT_ID> [BASE_URL]
#
# Example:
#   bash scripts/dev/mega_timeline_abcd.sh peakops-pilot org_001 inc_TEST http://127.0.0.1:3000

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
BASE_URL="${4:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Run this from repo root that contains next-app/"
  exit 1
fi

NEXT_DIR="$ROOT/next-app"
FN_DIR="$ROOT/functions_clean"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR" "$ROOT/scripts/dev/_bak"

if [[ ! -d "$FN_DIR" ]]; then
  echo "❌ Missing functions_clean at: $FN_DIR"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
echo "==> Mega Timeline A-D"
echo "ROOT=$ROOT"
echo "PROJECT_ID=$PROJECT_ID"
echo "ORG_ID=$ORG_ID"
echo "INCIDENT_ID=$INCIDENT_ID"
echo "BASE_URL=$BASE_URL"
echo

# -----------------------------------------------------------------------------
# A) Firebase function: generateTimelineV1
# -----------------------------------------------------------------------------
echo "==> (A) Write functions_clean/generateTimelineV1.js"
cp "$FN_DIR/index.js" "$ROOT/scripts/dev/_bak/functions_clean_index_${TS}.js" || true

cat > "$FN_DIR/generateTimelineV1.js" <<'JS'
"use strict";

const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/**
 * Deterministic, demo-safe timeline generator.
 * Writes canonical events into a flat collection "timeline_events"
 * that getTimelineEventsV1 already queries by orgId+incidentId.
 */
function canonicalEvents(nowIso) {
  return [
    {
      id: "t0_created",
      type: "INCIDENT_CREATED",
      title: "Incident created",
      message: "Basic incident record exists.",
      occurredAt: nowIso,
    },
    {
      id: "t1_timeline",
      type: "TIMELINE_GENERATED",
      title: "Timeline generated",
      message: "Events ordered oldest → newest.",
      occurredAt: nowIso,
    },
    {
      id: "t2_filings",
      type: "FILINGS_GENERATED",
      title: "Filings generated",
      message: "DIRS / OE-417 / NORS / SAR / BABA payloads created.",
      occurredAt: nowIso,
    },
    {
      id: "t3_export",
      type: "PACKET_EXPORTED",
      title: "Packet exported",
      message: "ZIP + hashes produced for audit.",
      occurredAt: nowIso,
    },
  ];
}

exports.generateTimelineV1 = onRequest(async (req, res) => {
  try {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).send("");

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    const orgId = String(req.body?.orgId || "");
    const incidentId = String(req.body?.incidentId || "");
    const requestedBy = String(req.body?.requestedBy || "api");

    if (!orgId || !incidentId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    const nowIso = new Date().toISOString();
    const events = canonicalEvents(nowIso);

    // Upsert: one document per event id (stable), keyed by org+incident+event
    // This prevents duplicates across repeated demos.
    const batch = db.batch();
    for (const ev of events) {
      const docId = `${orgId}__${incidentId}__${ev.id}`;
      const ref = db.collection("timeline_events").doc(docId);
      batch.set(
        ref,
        {
          orgId,
          incidentId,
          ...ev,
          createdAt: nowIso,
          updatedAt: nowIso,
          source: "generateTimelineV1",
          requestedBy,
        },
        { merge: true }
      );
    }
    await batch.commit();

    return res.status(200).json({
      ok: true,
      orgId,
      incidentId,
      generatedAt: nowIso,
      created: events.length,
      ids: events.map((e) => e.id),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
JS

echo "✅ wrote $FN_DIR/generateTimelineV1.js"

echo "==> (A2) Ensure functions_clean/index.js exports generateTimelineV1"
node <<'NODE'
const fs = require("fs");
const p = "functions_clean/index.js";
let s = fs.readFileSync(p, "utf8");

if (!s.includes("generateTimelineV1")) {
  // Add require near top if common pattern exists; otherwise append export at bottom.
  if (!s.includes("require(\"./generateTimelineV1") && !s.includes("require('./generateTimelineV1")) {
    s += "\n\n// --- timeline generator ---\n";
    s += "const { generateTimelineV1 } = require('./generateTimelineV1');\n";
    s += "exports.generateTimelineV1 = generateTimelineV1;\n";
  } else if (!s.match(/exports\.generateTimelineV1\s*=/)) {
    s += "\nexports.generateTimelineV1 = generateTimelineV1;\n";
  }
} else {
  // ensure export line exists
  if (!s.match(/exports\.generateTimelineV1\s*=/)) {
    s += "\nexports.generateTimelineV1 = generateTimelineV1;\n";
  }
}

fs.writeFileSync(p, s);
console.log("✅ functions_clean/index.js wired generateTimelineV1");
NODE

# -----------------------------------------------------------------------------
# B) Next API proxy route: /api/fn/generateTimelineV1
# -----------------------------------------------------------------------------
echo
echo "==> (B) Create Next route: $NEXT_DIR/src/app/api/fn/generateTimelineV1/route.ts"
API_DIR="$NEXT_DIR/src/app/api/fn/generateTimelineV1"
API_ROUTE="$API_DIR/route.ts"
mkdir -p "$API_DIR"
cp "$API_ROUTE" "$ROOT/scripts/dev/_bak/generateTimelineV1_route_${TS}.ts" 2>/dev/null || true

cat > "$API_ROUTE" <<'TS'
import { proxyPOST } from "../_lib/fnProxy";

export const runtime = "nodejs";

// Proxies to Firebase function "generateTimelineV1"
export async function POST(req: Request) {
  return proxyPOST(req, "generateTimelineV1");
}
TS

echo "✅ wrote $API_ROUTE"

# -----------------------------------------------------------------------------
# C) UI wiring: GuidedWorkflowPanel gets a "Generate Timeline" button + state
# -----------------------------------------------------------------------------
echo
echo "==> (C) Patch GuidedWorkflowPanel.tsx (safe, idempotent) — add Generate Timeline button + running state"
GWP="$NEXT_DIR/src/app/admin/_components/GuidedWorkflowPanel.tsx"
if [[ ! -f "$GWP" ]]; then
  echo "❌ missing: $GWP"
  exit 1
fi
cp "$GWP" "$ROOT/scripts/dev/_bak/GuidedWorkflowPanel_${TS}.tsx"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/admin/_components/GuidedWorkflowPanel.tsx")
s = p.read_text()

# Ensure we have a local state for timeline generating
if "/*__TIMELINE_GEN_STATE_V1__*/" not in s:
    # insert after other useState declarations inside component (best-effort)
    s = re.sub(
        r'(const\s*\[\s*autoBusy\s*,\s*setAutoBusy\s*\]\s*=\s*useState\([^\)]*\);\s*)',
        r'\1\n  /*__TIMELINE_GEN_STATE_V1__*/\n  const [timelineBusy, setTimelineBusy] = useState(false);\n',
        s,
        count=1
    )

# Helper function inside component to call generator
if "/*__CALL_GENERATE_TIMELINE_V1__*/" not in s:
    s = re.sub(
        r'(async\s+function\s+recheck\(\)\s*\{)',
        r'\1\n\n  /*__CALL_GENERATE_TIMELINE_V1__*/\n  async function generateTimelineNow() {\n    try {\n      setTimelineBusy(true);\n      const r = await fetch(`/api/fn/generateTimelineV1`, {\n        method: \"POST\",\n        headers: { \"Content-Type\": \"application/json\" },\n        body: JSON.stringify({ orgId, incidentId, requestedBy: \"admin_ui\" }),\n      });\n      // force refresh check results afterwards\n      await recheck();\n      return r.ok;\n    } catch {\n      return false;\n    } finally {\n      setTimelineBusy(false);\n    }\n  }\n',
        s,
        count=1
    )

# Add a CTA button in the banner when timeline is missing (look for the banner list item text)
# We'll insert a small button near the "Timeline missing" message if present.
if "/*__TIMELINE_GEN_CTA_V1__*/" not in s:
    # Insert after the line that renders "Timeline missing" note in the banner block
    s = s.replace(
        "Timeline missing: run Generate Timeline.",
        "Timeline missing: run Generate Timeline.\n          /*__TIMELINE_GEN_CTA_V1__*/"
    )

    # Now replace that marker with JSX snippet (best-effort placement inside banner render)
    cta = r'''
          <span style={{ marginLeft: 10, display: "inline-flex", gap: 8, alignItems: "center" }}>
            <button
              onClick={() => void generateTimelineNow()}
              disabled={timelineBusy}
              style={{
                padding: "6px 10px",
                borderRadius: 10,
                border: "1px solid color-mix(in oklab, CanvasText 22%, transparent)",
                background: timelineBusy
                  ? "color-mix(in oklab, CanvasText 8%, transparent)"
                  : "color-mix(in oklab, lime 18%, transparent)",
                fontWeight: 900,
                cursor: timelineBusy ? "not-allowed" : "pointer",
              }}
              title="Generate timeline events now"
            >
              {timelineBusy ? "Generating…" : "Generate Timeline"}
            </button>
            <span style={{ fontSize: 12, opacity: 0.75 }}>
              {timelineBusy ? "Writing events…" : ""}
            </span>
          </span>
'''
    s = s.replace("/*__TIMELINE_GEN_CTA_V1__*/", cta)

p.write_text(s)
print("✅ Patched GuidedWorkflowPanel: timeline generator CTA + state")
PY

# -----------------------------------------------------------------------------
# D) Restart stack + smoke test
# -----------------------------------------------------------------------------
echo
echo "==> (D) Restart emulators + Next and smoke timeline end-to-end"

# Kill common dev ports + old procs
lsof -tiTCP:3000,5001,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "firebase-tools" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

mkdir -p "$LOGDIR"

# Start emulators
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
echo "==> wait for hello"
for i in $(seq 1 120); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ emulator hello not responding"; tail -n 120 "$LOGDIR/emulators.log"; exit 1; }
echo "✅ emulators ready"

# Start Next
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
sleep 2

echo "==> smoke: timeline generator route exists"
GEN_R="$BASE_URL/api/fn/generateTimelineV1"
curl -fsS -X POST "$GEN_R" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"incidentId\":\"$INCIDENT_ID\",\"requestedBy\":\"mega_bash\"}" \
| python3 -m json.tool | head -n 60

echo
echo "==> smoke: timeline events now non-empty"
curl -fsS "$BASE_URL/api/fn/getTimelineEvents?orgId=$ORG_ID&incidentId=$INCIDENT_ID&limit=50" \
| python3 -m json.tool | head -n 120

echo
echo "==> smoke: packet includes timeline/events.json with content"
TMP="/tmp/peak_timeline_${INCIDENT_ID}_${TS}"
mkdir -p "$TMP"
curl -fsS "$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID" -o "$TMP/packet.zip"
unzip -l "$TMP/packet.zip" | grep -E "timeline/events\.json" >/dev/null || { echo "❌ missing timeline/events.json in packet"; exit 1; }
echo "✅ timeline/events.json present in packet.zip"
echo
echo "==> preview timeline/events.json"
unzip -p "$TMP/packet.zip" "timeline/events.json" | head -n 80 || true

echo
echo "✅ DONE A-D"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID?orgId=$ORG_ID"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"

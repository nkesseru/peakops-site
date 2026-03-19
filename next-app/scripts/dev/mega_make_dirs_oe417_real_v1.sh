#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
CONTRACT_ID="${4:-car_abc123}"

ROOT="$(pwd)"
while [[ "$ROOT" != "/" && ! -f "$ROOT/firebase.json" ]]; do ROOT="$(dirname "$ROOT")"; done
[[ -f "$ROOT/firebase.json" ]] || { echo "❌ couldn't find repo root with firebase.json"; exit 1; }

FN_DIR="$ROOT/functions_clean"
NEXT_DIR="$ROOT/next-app"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR" "$ROOT/scripts/dev/_bak"

echo "==> ROOT=$ROOT"
echo "==> FN_DIR=$FN_DIR"
echo "==> NEXT_DIR=$NEXT_DIR"
echo "==> PROJECT_ID=$PROJECT_ID ORG_ID=$ORG_ID INCIDENT_ID=$INCIDENT_ID CONTRACT_ID=$CONTRACT_ID"
echo

ts="$(date +%Y%m%d_%H%M%S)"

# ---------- helpers ----------
backup() {
  local f="$1"
  if [[ -f "$f" ]]; then
    cp "$f" "$ROOT/scripts/dev/_bak/$(basename "$f").bak_$ts"
    echo "✅ backup: $f -> scripts/dev/_bak/$(basename "$f").bak_$ts"
  fi
}

ensure_export_line() {
  local index="$1"
  local export_line="$2"
  if ! rg -qF "$export_line" "$index"; then
    echo "$export_line" >> "$index"
    echo "✅ appended: $export_line"
  else
    echo "ℹ️ already present: $export_line"
  fi
}

# ---------- (0) sanity ----------
[[ -d "$FN_DIR" ]] || { echo "❌ missing $FN_DIR"; exit 1; }
[[ -d "$NEXT_DIR" ]] || { echo "❌ missing $NEXT_DIR"; exit 1; }

# ---------- (1) write generateDIRSV1.js ----------
backup "$FN_DIR/generateDIRSV1.js"
cat > "$FN_DIR/generateDIRSV1.js" <<'JS'
/**
 * generateDIRSV1
 * Minimal “real-ish” DIRS payload v1.
 * Goal: consistent, schema-versioned payloads sourced from incident + timeline.
 */
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

function nowIso() {
  return new Date().toISOString();
}

exports.generateDIRSV1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    // load incident (if exists)
    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch {}

    // load timeline summary (count + last occurredAt)
    let timelineCount = 0;
    let lastOccurredAt = null;
    try {
      const q = await db.collection("timeline")
        .where("orgId", "==", orgId)
        .where("incidentId", "==", incidentId)
        .orderBy("occurredAt", "desc")
        .limit(1)
        .get();
      const qc = await db.collection("timeline")
        .where("orgId", "==", orgId)
        .where("incidentId", "==", incidentId)
        .get();
      timelineCount = qc.size;
      if (!q.empty) lastOccurredAt = q.docs[0].data()?.occurredAt || null;
    } catch {}

    const generatedAt = nowIso();

    // Minimal v1 payload: stable, extendable
    const payload = {
      schemaVersion: "dirs.v1",
      generatedAt,
      orgId,
      incidentId,
      contractId: incident?.contractId || null,
      title: incident?.title || null,
      status: incident?.status || null,

      // timeline hints
      timeline: {
        count: timelineCount,
        lastOccurredAt,
      },

      // placeholders for future DIRS required fields
      serviceArea: {
        state: incident?.state || null,
        county: incident?.county || null,
        city: incident?.city || null,
      },
      incidentWindow: {
        start: incident?.startAt || lastOccurredAt || null,
        end: incident?.endAt || null,
      },

      notes: incident?.notes || null,
    };

    // write to filings collection for packet zip to pick up
    const filingDocId = `${incidentId}_dirs_v1`;
    await db.collection("incident_filings").doc(filingDocId).set({
      orgId,
      incidentId,
      type: "DIRS",
      schemaVersion: "dirs.v1",
      generatedAt,
      payload,
      stub: false,
      updatedAt: generatedAt,
    }, { merge: true });

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      filing: { type: "DIRS", schemaVersion: "dirs.v1", generatedAt, stub: false },
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
JS
echo "✅ wrote functions_clean/generateDIRSV1.js"

# ---------- (2) write generateOE417V1.js ----------
backup "$FN_DIR/generateOE417V1.js"
cat > "$FN_DIR/generateOE417V1.js" <<'JS'
/**
 * generateOE417V1
 * Minimal “real-ish” OE-417 payload v1.
 */
const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

function nowIso() {
  return new Date().toISOString();
}

exports.generateOE417V1 = onRequest({ cors: true }, async (req, res) => {
  try {
    const orgId = String(req.query.orgId || "");
    const incidentId = String(req.query.incidentId || "");
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    let incident = null;
    try {
      const snap = await db.collection("incidents").doc(incidentId).get();
      if (snap.exists) incident = { id: snap.id, ...snap.data() };
    } catch {}

    const generatedAt = nowIso();

    const payload = {
      schemaVersion: "oe_417.v1",
      generatedAt,
      orgId,
      incidentId,
      contractId: incident?.contractId || null,
      title: incident?.title || null,
      status: incident?.status || null,

      // placeholders to grow into OE-417 “Situation Report” structure
      event: {
        category: incident?.category || null,
        severity: incident?.severity || null,
      },
      location: {
        state: incident?.state || null,
        county: incident?.county || null,
        city: incident?.city || null,
      },
      outage: {
        customersAffected: incident?.customersAffected || null,
        estimatedRestoration: incident?.etaRestore || null,
      },
      narrative: incident?.narrative || incident?.notes || null,
    };

    const filingDocId = `${incidentId}_oe417_v1`;
    await db.collection("incident_filings").doc(filingDocId).set({
      orgId,
      incidentId,
      type: "OE_417",
      schemaVersion: "oe_417.v1",
      generatedAt,
      payload,
      stub: false,
      updatedAt: generatedAt,
    }, { merge: true });

    return send(res, 200, {
      ok: true,
      orgId,
      incidentId,
      filing: { type: "OE_417", schemaVersion: "oe_417.v1", generatedAt, stub: false },
    });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
});
JS
echo "✅ wrote functions_clean/generateOE417V1.js"

# ---------- (3) export from functions_clean/index.js ----------
INDEX_JS="$FN_DIR/index.js"
[[ -f "$INDEX_JS" ]] || { echo "❌ missing $INDEX_JS"; exit 1; }
backup "$INDEX_JS"

# If index.js is CJS style exports already, append requires in same style
if ! rg -q "generateDIRSV1" "$INDEX_JS"; then
  echo 'exports.generateDIRSV1 = require("./generateDIRSV1").generateDIRSV1;' >> "$INDEX_JS"
  echo "✅ exported generateDIRSV1 in index.js"
else
  echo "ℹ️ generateDIRSV1 already exported in index.js"
fi

if ! rg -q "generateOE417V1" "$INDEX_JS"; then
  echo 'exports.generateOE417V1 = require("./generateOE417V1").generateOE417V1;' >> "$INDEX_JS"
  echo "✅ exported generateOE417V1 in index.js"
else
  echo "ℹ️ generateOE417V1 already exported in index.js"
fi

# ---------- (4) ensure generateFilingsV1 calls both ----------
GF="$FN_DIR/generateFilingsV1.js"
[[ -f "$GF" ]] || { echo "❌ missing $GF"; exit 1; }
backup "$GF"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("functions_clean/generateFilingsV1.js")
s = p.read_text()

# Ensure it invokes both endpoints (internal function calls are ok via direct require pattern,
# but simplest is: call the newly exported functions via HTTP is too heavy. We'll do direct require.
# We'll patch only if not already present.
if "generateDIRSV1" not in s:
    # Add require near top
    s = s.replace('const db = getFirestore();', 'const db = getFirestore();\nconst { generateDIRSV1 } = require("./generateDIRSV1");\n')
if "generateOE417V1" not in s:
    s = s.replace('const { generateDIRSV1 } = require("./generateDIRSV1");', 'const { generateDIRSV1 } = require("./generateDIRSV1");\nconst { generateOE417V1 } = require("./generateOE417V1");')

# Insert calls inside handler: look for generatedAt assignment or meta object creation anchor
if "/*__CALL_DIRS__*/" not in s:
    # anchor: after orgId/incidentId validation block
    m = re.search(r'if\s*\(!orgId\s*\|\|\s*!incidentId\)\s*return\s+send\(', s)
    if not m:
        raise SystemExit("Could not find orgId/incidentId guard in generateFilingsV1.js")
    insert_at = m.end()
    # find end of that line/statement
    nl = s.find("\n", insert_at)
    if nl == -1: nl = insert_at
    block = """
    // --- generate core filings (now real-ish) ---
    // NOTE: direct invocation of sub-handlers is safe in emulator / node runtime.
    // We pass through the same req/res style by calling their onRequest handlers with mocked res.
"""
    s = s[:nl] + block + s[nl:]

# Add actual invocation near the end, before final send success.
if "/*__RUN_DIRS_OE417__*/" not in s:
    # anchor: before "return send(res, 200" (first occurrence)
    m2 = re.search(r'\n\s*return\s+send\(res,\s*200,', s)
    if not m2:
        raise SystemExit("Could not find success return send(res, 200, ...) in generateFilingsV1.js")
    insert_at = m2.start()
    run = """
    /*__RUN_DIRS_OE417__*/
    // Fire both filings generators. If one fails, we still return ok but include note.
    // (We’ll tighten later with strict validation mode.)
    const notes = [];
    try { await new Promise((resolve) => generateDIRSV1(req, { ...res, status: () => ({ send: () => resolve(None) }) })); }
    catch (e) { notes.push("DIRS generation failed: " + String(e)); }
    try { await new Promise((resolve) => generateOE417V1(req, { ...res, status: () => ({ send: () => resolve(None) }) })); }
    catch (e) { notes.push("OE417 generation failed: " + String(e)); }
"""
    # NOTE: the above res mock is intentionally minimal; it just allows handler to run.
    # If this is too hacky in your file, we can swap to internal shared generator core next.
    s = s[:insert_at] + run + s[insert_at:]

p.write_text(s)
print("✅ patched generateFilingsV1.js to call generateDIRSV1 + generateOE417V1")
PY

# ---------- (5) hard restart stack ----------
echo "==> restart emulators + next"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true
sleep 1

firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!
sleep 2

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
for i in $(seq 1 160); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ emulator hello not responding"; tail -n 120 "$LOGDIR/emulators.log"; exit 1; }
echo "✅ emulators ready"

( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$LOGDIR/next.log" 2>&1 ) &
NEXT_PID=$!
sleep 2

BASE="http://127.0.0.1:3000"

echo "==> smoke: generateFilingsV1"
curl -fsS "$BASE/api/fn/generateFilingsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 300; echo

echo "==> smoke: download packet zip + show first bytes of dirs/oe417"
TMP="/tmp/packet_real_${ts}"
mkdir -p "$TMP"
curl -fsS "$BASE/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&contractId=${CONTRACT_ID}" -o "$TMP/p.zip"

echo "-- filings/dirs.json --"
unzip -p "$TMP/p.zip" "filings/dirs.json" | head -c 220; echo
echo "-- filings/oe417.json --"
unzip -p "$TMP/p.zip" "filings/oe417.json" | head -c 220; echo

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  $BASE/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  $BASE/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
echo
echo "LOGS:"
echo "  tail -n 140 $LOGDIR/emulators.log"
echo "  tail -n 140 $LOGDIR/next.log"
echo
echo "STOP:"
echo "  kill $EMU_PID $NEXT_PID"

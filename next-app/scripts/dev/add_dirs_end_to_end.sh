#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
CONTRACT_ID="${4:-car_abc123}"

# ---- locate repo root (contains next-app/) ----
ROOT="$(pwd)"
while [[ "$ROOT" != "/" && ! -d "$ROOT/next-app" ]]; do
  ROOT="$(dirname "$ROOT")"
done
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ Could not find repo root containing next-app/"
  exit 1
fi
cd "$ROOT"
mkdir -p .logs scripts/dev/_bak
TS="$(date +%Y%m%d_%H%M%S)"

FN_DIR="$ROOT/functions_clean"
NEXT_DIR="$ROOT/next-app"
PACKET_ROUTE="$NEXT_DIR/src/app/api/fn/downloadIncidentPacketZip/route.ts"

echo "==> ROOT=$ROOT"
echo "==> PROJECT_ID=$PROJECT_ID ORG_ID=$ORG_ID INCIDENT_ID=$INCIDENT_ID CONTRACT_ID=$CONTRACT_ID"
echo "==> FN_DIR=$FN_DIR"
echo "==> PACKET_ROUTE=$PACKET_ROUTE"
echo

if [[ ! -d "$FN_DIR" ]]; then
  echo "❌ Missing functions_clean at $FN_DIR"
  exit 1
fi

# -----------------------------
# (1) Add generateDIRSV1.js
# -----------------------------
echo "==> (1) write functions_clean/generateDIRSV1.js"
cp "$FN_DIR/index.js" "scripts/dev/_bak/functions_clean_index_$TS.js" || true
cp "$FN_DIR/generateFilingsV1.js" "scripts/dev/_bak/generateFilingsV1_$TS.js" 2>/dev/null || true

cat > "$FN_DIR/generateDIRSV1.js" <<'JS'
/**
 * generateDIRSV1
 * Creates a real-ish DIRS payload from Incident + Timeline.
 * Safe defaults: only fields we can confidently produce.
 */
const admin = require("firebase-admin");

function send(res, code, obj) {
  res.set("content-type", "application/json");
  res.status(code).send(JSON.stringify(obj));
}

function isoNow() {
  return new Date().toISOString();
}

function safeStr(x) {
  return x == null ? "" : String(x);
}

exports.generateDIRSV1 = async function generateDIRSV1(req, res) {
  try {
    if (!admin.apps.length) admin.initializeApp();
    const db = admin.firestore();

    const orgId = safeStr(req.query.orgId);
    const incidentId = safeStr(req.query.incidentId);
    if (!orgId || !incidentId) return send(res, 400, { ok: false, error: "Missing orgId/incidentId" });

    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    const incident = incSnap.exists ? ({ id: incSnap.id, ...incSnap.data() }) : null;

    // Pull up to 200 timeline events (optional)
    let timeline = [];
    try {
      const tSnap = await incRef.collection("timeline").orderBy("occurredAt", "asc").limit(200).get();
      timeline = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) {}

    // Very conservative “start time” guess:
    // use incident.createdAt (if firestore timestamp) else now
    let startTime = isoNow();
    const createdAt = incident && incident.createdAt;
    if (createdAt && typeof createdAt === "object" && typeof createdAt._seconds === "number") {
      startTime = new Date(createdAt._seconds * 1000).toISOString();
    } else if (typeof createdAt === "string") {
      const t = Date.parse(createdAt);
      if (Number.isFinite(t)) startTime = new Date(t).toISOString();
    }

    // If we have a timeline event with occurredAt, use first occurredAt
    if (timeline.length) {
      const first = timeline[0];
      const occ = first && first.occurredAt;
      if (typeof occ === "string") {
        const t = Date.parse(occ);
        if (Number.isFinite(t)) startTime = new Date(t).toISOString();
      } else if (occ && typeof occ === "object" && typeof occ._seconds === "number") {
        startTime = new Date(occ._seconds * 1000).toISOString();
      }
    }

    // Minimal DIRS payload (we’ll enrich later)
    const payload = {
      schemaVersion: "dirs.v1",
      orgId,
      incidentId,
      contractId: incident?.contractId || null,
      title: incident?.title || "Incident",
      status: "DRAFT",
      eventType: "OUTAGE",
      startTime,
      affectedServices: [],
      estimatedCustomersAffected: null,
      notes: "Auto-generated DIRS stub (v1). Enrich fields later.",
    };

    const filingDoc = {
      type: "DIRS",
      schemaVersion: "dirs.v1",
      orgId,
      incidentId,
      status: "GENERATED",
      present: true,
      generatedAt: isoNow(),
      payload,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Store under incident-scoped filings
    await incRef.collection("filings").doc("dirs").set(filingDoc, { merge: true });

    return send(res, 200, { ok: true, orgId, incidentId, filing: { id: "dirs", ...filingDoc } });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e?.message || e) });
  }
};
JS
echo "✅ wrote functions_clean/generateDIRSV1.js"

# -----------------------------
# (2) Export from functions_clean/index.js (CommonJS)
# -----------------------------
echo "==> (2) ensure functions_clean/index.js exports generateDIRSV1"
node - <<'NODE'
const fs = require("fs");
const p = "functions_clean/index.js";
let s = fs.readFileSync(p, "utf8");

const line = 'exports.generateDIRSV1 = require("./generateDIRSV1").generateDIRSV1;';
if (!s.includes(line)) {
  s += "\n// --- DIRS generator (Phase 2)\n" + line + "\n";
  fs.writeFileSync(p, s);
  console.log("✅ appended export line to functions_clean/index.js");
} else {
  console.log("ℹ️ generateDIRSV1 already exported");
}
NODE

# -----------------------------
# (3) Wire generateFilingsV1 -> call generateDIRSV1
# -----------------------------
echo "==> (3) patch functions_clean/generateFilingsV1.js to call generateDIRSV1"
python3 - <<'PY'
from pathlib import Path
import re

p = Path("functions_clean/generateFilingsV1.js")
s = p.read_text()

if "CALL_GENERATE_DIRSV1" in s:
    print("ℹ️ generateFilingsV1 already wired to generateDIRSV1 (skipping)")
    raise SystemExit(0)

# Ensure require exists
if 'require("./generateDIRSV1")' not in s:
    # Put requires near top
    m = re.search(r"^const\s+admin\s*=.*$", s, flags=re.M)
    if m:
        insert_at = m.end()
        s = s[:insert_at] + '\nconst { generateDIRSV1 } = require("./generateDIRSV1");\n' + s[insert_at:]
    else:
        s = 'const { generateDIRSV1 } = require("./generateDIRSV1");\n' + s

# Insert call inside handler: after orgId/incidentId extracted.
# Look for orgId / incidentId extraction pattern
m = re.search(r"(const\s+orgId\s*=.*\n.*incidentId\s*=.*\n)", s)
if not m:
    # fallback: after first validation of orgId/incidentId
    m = re.search(r"(if\s*\(!orgId\s*\|\|\s*!incidentId\)[^\n]*\n)", s)
    if not m:
        raise SystemExit("❌ Could not find orgId/incidentId anchor in generateFilingsV1.js")

call = r'''
    // CALL_GENERATE_DIRSV1
    // Generate real DIRS payload first (safe + idempotent)
    try {
      // generateDIRSV1 expects req/res; we fake a mini res object and ignore output
      await new Promise((resolve) => {
        const fakeRes = {
          set: () => {},
          status: () => ({ send: () => resolve(null) }),
          send: () => resolve(null),
        };
        generateDIRSV1({ query: { orgId, incidentId } }, fakeRes);
      });
    } catch (e) {
      // Keep generateFilingsV1 resilient: do not fail whole pipeline if DIRS generation fails
    }
'''
insert_at = m.end()
s = s[:insert_at] + call + s[insert_at:]

p.write_text(s)
print("✅ generateFilingsV1 wired to generateDIRSV1")
PY

# -----------------------------
# (4) Patch downloadIncidentPacketZip to prefer incident filing payload for dirs.json
# -----------------------------
echo "==> (4) patch next route to use filing.payload for filings/dirs.json (if present)"
if [[ ! -f "$PACKET_ROUTE" ]]; then
  echo "❌ Missing $PACKET_ROUTE"
  exit 1
fi
cp "$PACKET_ROUTE" "scripts/dev/_bak/downloadIncidentPacketZip_route_$TS.ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

if "PREFER_DIRS_PAYLOAD_V1" in s:
    print("ℹ️ packet zip route already patched for dirs payload (skipping)")
    raise SystemExit(0)

# Find where filings stubs are added. We'll inject a helper that fetches filing docs and uses payload when present.
# We'll add helper near top-level (after imports).
m = re.search(r"(export\s+const\s+runtime\s*=\s*['\"]nodejs['\"];\s*\n)", s)
if not m:
    # fallback: after first import block
    m = re.search(r"(import[\s\S]*?\n\n)", s)
    if not m:
        raise SystemExit("❌ Could not find insert point in route.ts")

helper = r'''
// PREFER_DIRS_PAYLOAD_V1
async function readIncidentFilingPayload(db: any, incidentId: string, filingId: string) {
  try {
    const snap = await db.collection("incidents").doc(incidentId).collection("filings").doc(filingId).get();
    if (!snap.exists) return null;
    const d = snap.data() || null;
    if (!d) return null;
    // Prefer explicit payload, otherwise return null
    return d.payload || null;
  } catch {
    return null;
  }
}
'''
s = s[:m.end()] + helper + s[m.end():]

# Now patch: when creating filings/dirs.json, use readIncidentFilingPayload(..., "dirs")
# We'll do a conservative replace: look for writing "filings/dirs.json" and wrap the bytes creation.
pat = r'files\.push\(\{\s*path:\s*"filings/dirs\.json"\s*,\s*bytes:\s*utf8\(([\s\S]{0,200}?)\)\s*\}\);'
mm = re.search(pat, s)
if mm:
    # Replace existing stub push with a block that resolves payload first
    block = r'''
    // DIRS (prefer real payload if present)
    const dirsPayload = await readIncidentFilingPayload(db, incidentId, "dirs");
    files.push({
      path: "filings/dirs.json",
      bytes: utf8(JSON.stringify(dirsPayload || { _placeholder: "DIRS_STUB" }, null, 2)),
    });
'''
    s = s[:mm.start()] + block + s[mm.end():]
    print("✅ replaced filings/dirs.json stub push with payload-aware push")
else:
    # If we can't find exact push, insert a second write (harmless but duplicates file name in ZIP).
    # Better: abort loudly so we don't create duplicate entries.
    raise SystemExit("❌ Could not find the filings/dirs.json push() line to patch. Search for it and adjust pattern.")

p.write_text(s)
print("✅ packet zip route patched for dirs payload")
PY

# -----------------------------
# (5) Restart stack + smoke tests
# -----------------------------
echo "==> (5) hard kill common ports + stray procs"
lsof -tiTCP:3000,5001,8081,4400,4409,9150 2>/dev/null | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> start emulators"
firebase emulators:start --only functions,firestore --project "$PROJECT_ID" > .logs/emulators.log 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/us-central1"
echo "==> wait for hello"
for i in $(seq 1 160); do
  curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ hello not responding"; tail -n 160 .logs/emulators.log; exit 1; }
echo "✅ emulator ready"

echo "==> seed incident (if you already have seeder script, you can ignore failures)"
# if your existing seed script exists, run it; otherwise continue
if [[ -f "$ROOT/scripts/dev/mega_add_getIncidentBundleV1_and_seed.sh" ]]; then
  FIRESTORE_EMULATOR_HOST="127.0.0.1:8081" PROJECT_ID="$PROJECT_ID" ORG_ID="$ORG_ID" INCIDENT_ID="$INCIDENT_ID" CONTRACT_ID="$CONTRACT_ID" \
    bash "$ROOT/scripts/dev/mega_add_getIncidentBundleV1_and_seed.sh" "$PROJECT_ID" "$ORG_ID" "$INCIDENT_ID" "$CONTRACT_ID" || true
fi

echo "==> start Next"
( cd "$NEXT_DIR" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
NEXT_PID=$!
sleep 2

BASE="http://127.0.0.1:3000"

echo "==> smoke: generateFilingsV1 (should also generate DIRS payload now)"
curl -fsS "$BASE/api/fn/generateFilingsV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 400; echo

echo "==> smoke: download packet zip + verify dirs.json contains schemaVersion dirs.v1"
TMP="/tmp/packet_dirs_smoke_$TS"
mkdir -p "$TMP"
curl -fsS "$BASE/api/fn/downloadIncidentPacketZip?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}&contractId=${CONTRACT_ID}" -o "$TMP/p.zip"
unzip -p "$TMP/p.zip" "filings/dirs.json" | head -c 600; echo
unzip -p "$TMP/p.zip" "filings/dirs.json" | rg -q '"schemaVersion"\s*:\s*"dirs\.v1"' || {
  echo "❌ filings/dirs.json does not contain schemaVersion=dirs.v1"
  exit 1
}
echo "✅ dirs.json looks real (schemaVersion dirs.v1)"

echo
echo "✅ DIRS end-to-end DONE"
echo "OPEN:"
echo "  $BASE/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo "  $BASE/admin/incidents/${INCIDENT_ID}/bundle?orgId=${ORG_ID}"
echo
echo "STOP:"
echo "  kill ${EMU_PID} ${NEXT_PID}"

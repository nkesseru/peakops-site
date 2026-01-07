#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${1:-peakops-pilot}"
ORG_ID="${2:-org_001}"
INCIDENT_ID="${3:-inc_TEST}"
REGION="us-central1"

ROOT="$(pwd)"
LOGDIR="$ROOT/.logs"
mkdir -p "$LOGDIR"

echo "==> Phase2 UI mega boot"
echo "    project=$PROJECT_ID org=$ORG_ID incident=$INCIDENT_ID"

echo "==> (0) Hard-kill ports + stray emulators/next"
lsof -tiTCP:3000,3001,3002,5001,8080,8081,4000,4409,9150 | xargs kill -9 2>/dev/null || true
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

echo "==> (1) Ensure functions_emu scaffold"
mkdir -p functions_emu/dist
cat > functions_emu/package.json <<'JSON'
{
  "name": "functions_emu",
  "private": true,
  "main": "index.js",
  "engines": { "node": ">=20" },
  "dependencies": {
    "firebase-functions": "^6.6.0"
  }
}
JSON

# Install deps if missing
if [ ! -d "functions_emu/node_modules" ]; then
  (cd functions_emu && pnpm i) >/dev/null
fi
# Ensure esbuild available in functions_emu (local, avoids workspace weirdness)
if [ ! -d "functions_emu/node_modules/esbuild" ]; then
  (cd functions_emu && pnpm add -D esbuild) >/dev/null
fi

echo "==> (2) Bundle handlers from functions_clean/*.mjs -> functions_emu/dist/*.cjs"
node - <<'NODE'
const path = require("path");
const ROOT = process.cwd();
const esbuild = require("./functions_emu/node_modules/esbuild");

const SRC = path.join(ROOT, "functions_clean");
const OUT = path.join(ROOT, "functions_emu", "dist");

// Add/remove handlers here.
const files = [
  ["getContractsV1.mjs", "getContractsV1.cjs"],
  ["getContractV1.mjs", "getContractV1.cjs"],
  ["getContractPayloadsV1.mjs", "getContractPayloadsV1.cjs"],
  ["writeContractPayloadV1.mjs", "writeContractPayloadV1.cjs"],
  ["exportContractPacketV1.mjs", "exportContractPacketV1.cjs"],
  // PHASE 2:
  ["getWorkflowV1.mjs", "getWorkflowV1.cjs"],
];

(async () => {
  for (const [src, out] of files) {
    const entry = path.join(SRC, src);
    await esbuild.build({
      entryPoints: [entry],
      outfile: path.join(OUT, out),
      platform: "node",
      format: "cjs",
      bundle: true,
      sourcemap: false,
      logLevel: "silent",
    });
  }
  console.log("✅ bundled:", files.map(x => x[1]).join(", "));
})().catch((e) => { console.error(e); process.exit(1); });
NODE

echo "==> (3) Write functions_emu/index.js (robust default/named resolver)"
cat > functions_emu/index.js <<'JS'
const { onRequest } = require("firebase-functions/v2/https");

function pick(mod) {
  // allow either default export or named function export
  if (typeof mod === "function") return mod;
  if (mod && typeof mod.default === "function") return mod.default;
  // if module has exactly one function export, use it
  if (mod && typeof mod === "object") {
    const fns = Object.values(mod).filter(v => typeof v === "function");
    if (fns.length === 1) return fns[0];
  }
  return null;
}

function req(name, file) {
  const mod = require(file);
  const fn = pick(mod);
  if (!fn) throw new Error(`could not resolve handler for ${name} from ${file}`);
  return fn;
}

exports.hello = onRequest((req, res) => res.json({ ok: true, msg: "hello from functions_emu" }));

exports.getContractsV1         = onRequest(req("getContractsV1",         "./dist/getContractsV1.cjs"));
exports.getContractV1          = onRequest(req("getContractV1",          "./dist/getContractV1.cjs"));
exports.getContractPayloadsV1  = onRequest(req("getContractPayloadsV1",  "./dist/getContractPayloadsV1.cjs"));
exports.writeContractPayloadV1 = onRequest(req("writeContractPayloadV1", "./dist/writeContractPayloadV1.cjs"));
exports.exportContractPacketV1 = onRequest(req("exportContractPacketV1", "./dist/exportContractPacketV1.cjs"));

// Phase 2:
exports.getWorkflowV1          = onRequest(req("getWorkflowV1",          "./dist/getWorkflowV1.cjs"));
JS

echo "==> (4) Write firebase.emu.json (point emulators at functions_emu)"
cat > firebase.emu.json <<'JSON'
{
  "firestore": { "rules": "firestore.rules" },
  "functions": { "source": "functions_emu", "runtime": "nodejs22" }
}
JSON

echo "==> (5) Ensure Next API proxy route /api/fn/getWorkflowV1"
mkdir -p next-app/src/app/api/fn/getWorkflowV1
cat > next-app/src/app/api/fn/getWorkflowV1/route.ts <<'TS'
import { proxyGET } from "../../_lib/fnProxy";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!url.searchParams.get("orgId")) url.searchParams.set("orgId", process.env.NEXT_PUBLIC_DEV_DEFAULT_ORG_ID || "org_001");
  if (!url.searchParams.get("incidentId")) url.searchParams.set("incidentId", "inc_TEST");
  return proxyGET(new Request(url.toString(), { method: "GET", headers: req.headers }), "getWorkflowV1");
}
TS

echo "==> (6) Patch /admin/incidents/[id]/page.tsx to include Workflow Panel (safe insert)"
INC_PAGE="next-app/src/app/admin/incidents/[id]/page.tsx"
if [ -f "$INC_PAGE" ] && ! rg -q "Guided Workflow" "$INC_PAGE"; then
  python3 - <<'PY'
from pathlib import Path
p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# Insert a new PanelCard block near other panels (best-effort anchor)
anchor = '<PanelCard title="Incident Summary">'
idx = s.find(anchor)
if idx == -1:
    # fallback: before return end
    idx = s.rfind("</div>")
    if idx == -1:
        raise SystemExit("Could not find insertion point in incidents page")

block = r'''
        <PanelCard title="Guided Workflow">
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: 10 }}>
            <div style={{ fontWeight: 900 }}>Guided Workflow</div>
            <Button onClick={() => load()} disabled={!!busy}>Refresh</Button>
          </div>
          <div style={{ opacity: 0.8, fontSize: 13, marginBottom: 10 }}>
            Step-by-step actions for this incident (Phase 2).
          </div>
          <pre style={{ margin:0, whiteSpace:"pre-wrap", opacity:0.9 }}>
            {workflow ? JSON.stringify(workflow, null, 2) : "—"}
          </pre>
        </PanelCard>

'''

# Also ensure minimal state + loader exist (best-effort; avoids breaking if you already have these)
if "const [workflow" not in s:
    # add state near other useState hooks
    mark = "const [busy"
    m = s.find(mark)
    if m != -1:
        insert_state = 'const [workflow, setWorkflow] = useState<any>(null);\n'
        s = s[:m] + insert_state + s[m:]

if "getWorkflowV1" not in s:
    # add load() fetch helper near other load helpers
    mark = "async function load()"
    m = s.find(mark)
    if m != -1:
        # piggyback existing load()
        pass
    else:
        # create a dedicated workflow loader after existing postFn helper if present
        mark = "async function postFn"
        m = s.find(mark)
        if m != -1:
            m2 = s.find("}\n", m)
            insert_at = m2+2 if m2 != -1 else m
        else:
            insert_at = 0
        loader = r'''
  async function loadWorkflow() {
    try {
      const url = `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(url);
      const j = await r.json();
      if (!j?.ok) throw new Error(j?.error || "getWorkflowV1 failed");
      setWorkflow(j);
    } catch (e:any) {
      // swallow; page already has banners/errors elsewhere
      console.warn(e?.message || String(e));
    }
  }
'''
        s = s[:insert_at] + loader + s[insert_at:]

# wire refresh button call: prefer loadWorkflow()
s = s.replace("onClick={() => load()}", "onClick={() => loadWorkflow()}")
# insert panel block
s = s[:idx] + block + s[idx:]

p.write_text(s)
print("✅ incidents page patched with Guided Workflow panel")
PY
else
  echo "ℹ️ incidents page already has Guided Workflow (skipping)"
fi

echo "==> (7) Start emulators (functions+firestore) with functions_emu"
firebase emulators:start --only functions,firestore \
  --project "$PROJECT_ID" \
  --config firebase.emu.json \
  > "$LOGDIR/emulators.log" 2>&1 &
EMU_PID=$!

FN_BASE="http://127.0.0.1:5001/${PROJECT_ID}/${REGION}"
for i in $(seq 1 120); do
  if curl -fsS "$FN_BASE/hello" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -fsS "$FN_BASE/hello" >/dev/null 2>&1 || { echo "❌ functions never came up"; tail -n 120 "$LOGDIR/emulators.log"; exit 1; }
echo "✅ functions ready (pid=$EMU_PID)  FN_BASE=$FN_BASE"

echo "==> (8) Start Next (port 3000)"
( cd next-app && pnpm dev --port 3000 > ../.logs/next.log 2>&1 ) &
NEXT_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:3000" >/dev/null 2>&1 || { echo "❌ next never came up"; tail -n 120 "$LOGDIR/next.log"; exit 1; }
echo "✅ next ready (pid=$NEXT_PID)"

echo "==> (9) Smoke getWorkflowV1 via Next"
curl -sS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=${ORG_ID}&incidentId=${INCIDENT_ID}" | head -c 260; echo

echo
echo "✅ STACK UP"
echo "OPEN:"
echo "  http://localhost:3000/admin/incidents/${INCIDENT_ID}?orgId=${ORG_ID}"
echo
echo "LOGS:"
echo "  tail -n 120 .logs/emulators.log"
echo "  tail -n 120 .logs/next.log"
echo
echo "STOP:"
echo "  kill ${EMU_PID} ${NEXT_PID}"

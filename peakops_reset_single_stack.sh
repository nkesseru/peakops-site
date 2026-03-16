#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
NEXT="$ROOT/next-app"
FN="$ROOT/functions_clean"

echo "== 1) kill all stale dev/emulator ports =="
for p in 3001 4000 4002 4400 4401 4412 4500 4501 4502 5002 5004 8082 8087 9150 9154; do
  PIDS="$(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "${PIDS}" ]; then
    kill -9 ${PIDS} 2>/dev/null || true
  fi
done
pkill -f "firebase emulators:start" 2>/dev/null || true
pkill -f "next dev --hostname 127.0.0.1 --port 3001" 2>/dev/null || true
sleep 1

echo "== 2) force app to use ONE functions base only: 5002 =="
cat > "$NEXT/.env.local" <<'ENV'
NEXT_PUBLIC_FUNCTIONS_BASE=http://127.0.0.1:5002/peakops-pilot/us-central1
FUNCTIONS_BASE=http://127.0.0.1:5002/peakops-pilot/us-central1
ENV

echo "== 3) hard-set functionsBase.ts to 5002 primary/fallback =="
cat > "$NEXT/src/lib/functionsBase.ts" <<'TS'
const DEV_FUNCTIONS_BASE = "http://127.0.0.1:5002/peakops-pilot/us-central1";
const DEV_FALLBACK_FUNCTIONS_BASE = "http://127.0.0.1:5002/peakops-pilot/us-central1";
const SESSION_BASE_KEY = "peakops_functions_base_override";
let warnedPortMismatch = false;

function trimTrailingSlash(v: string) {
  return v.replace(/\/+$/, "");
}

function isLocalDev() {
  return process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ENV === "local";
}

export function getEnvFunctionsBase() {
  const envBase = String(process.env.NEXT_PUBLIC_FUNCTIONS_BASE || "").trim();
  return envBase ? trimTrailingSlash(envBase) : "";
}

export function hasEnvBase() {
  return !!getEnvFunctionsBase();
}

export function getFunctionsBase() {
  const envBase = getEnvFunctionsBase();
  if (envBase) return envBase;
  if (isLocalDev() && typeof window !== "undefined") {
    try {
      const ss = String(window.sessionStorage.getItem(SESSION_BASE_KEY) || "").trim();
      if (ss) return trimTrailingSlash(ss);
    } catch {}
  }
  return isLocalDev() ? DEV_FUNCTIONS_BASE : "";
}

export function getFunctionsBaseDebugInfo() {
  const envBase = getEnvFunctionsBase();
  let overrideBase = "";
  if (isLocalDev() && typeof window !== "undefined") {
    try {
      overrideBase = trimTrailingSlash(String(window.sessionStorage.getItem(SESSION_BASE_KEY) || "").trim());
    } catch {}
  }
  const activeBase = getFunctionsBase();
  return { envBase, overrideBase, activeBase };
}

export function getFunctionsBaseFallback(_base: string) {
  return "";
}

export async function verifyFunctionsBase(base: string): Promise<boolean> {
  if (!isLocalDev() || typeof window === "undefined") return false;
  const b = trimTrailingSlash(String(base || ""));
  if (!b) return false;
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), 1200);
  try {
    const res = await fetch(`${b}/hello`, { method: "GET", cache: "no-store", signal: ctrl.signal });
    return !!res?.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(t);
  }
}

export async function rememberFunctionsBase(base: string): Promise<boolean> {
  if (!isLocalDev() || typeof window === "undefined") return false;
  if (hasEnvBase()) return false;
  const b = trimTrailingSlash(String(base || ""));
  if (!b) return false;
  const ok = await verifyFunctionsBase(b);
  if (!ok) return false;
  try {
    window.sessionStorage.setItem(SESSION_BASE_KEY, b);
    return true;
  } catch {
    return false;
  }
}

export function clearRememberedFunctionsBase() {
  if (!isLocalDev() || typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(SESSION_BASE_KEY);
  } catch {}
}

export function probeAndRestoreEnvFunctionsBase(_appliedBase: string, onRestored?: () => void) {
  if (!isLocalDev() || typeof window === "undefined") return;
  try { onRestored?.(); } catch {}
}

export function isLikelyFetchNetworkError(err: unknown, status?: number) {
  if (status && status > 0) return false;
  const msg = String((err as any)?.message || err || "").toLowerCase();
  return msg.includes("failed to fetch") || msg.includes("fetch failed") || msg.includes("network") || msg.includes("load failed");
}

export function warnFunctionsBaseIfSuspicious(base: string) {
  if (!isLocalDev() || warnedPortMismatch || typeof window === "undefined") return;
  const b = trimTrailingSlash(String(base || ""));
  if (!b) return;
  warnedPortMismatch = true;
  if (!b.includes(":5002/")) {
    console.warn(`[functionsBase] using ${b}. Expected local emulator proxy is :5002.`);
  }
}
TS

echo "== 4) hard-set api proxy default to 5002 =="
python3 - <<'PY'
from pathlib import Path
p = Path.home() / "peakops/my-app/next-app/app/api/fn/_proxy.ts"
s = p.read_text()
s = s.replace('"http://127.0.0.1:5004/peakops-pilot/us-central1"', '"http://127.0.0.1:5002/peakops-pilot/us-central1"')
p.write_text(s)
print("patched", p)
PY

echo "== 5) remove stray duplicate evidence button file if it exists =="
rm -f "$NEXT/src/components/evidence/AddEvidenceButton.tsx'" || true

echo "== 6) clear next build cache =="
rm -rf "$NEXT/.next"

echo "== 7) start emulators from functions_clean on ONE stack =="
osascript -e 'tell application "Terminal" to do script "cd '"$FN"' && firebase emulators:start --project peakops-pilot --only functions,firestore"'

echo "Waiting 8 seconds for emulators..."
sleep 8

echo "== 8) seed demo incident into firestore emulator 8082 =="
cd "$FN"
FIRESTORE_EMULATOR_HOST=127.0.0.1:8082 node - <<'NODE'
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp({ projectId: "peakops-pilot" });
const db = admin.firestore();

(async () => {
  await db.collection("incidents").doc("inc_demo").set({
    orgId: "riverbend-electric",
    incidentId: "inc_demo",
    title: "Riverbend Electric Demo Incident",
    status: "open",
    createdAt: new Date(),
    updatedAt: new Date(),
  }, { merge: true });

  const snap = await db.collection("incidents").doc("inc_demo").get();
  console.log("exists after seed:", snap.exists);
  console.log("data:", snap.exists ? snap.data() : null);
})();
NODE

echo "== 9) verify function directly on 5002 =="
curl -s "http://127.0.0.1:5002/peakops-pilot/us-central1/getIncidentV1?orgId=riverbend-electric&incidentId=inc_demo"
echo
echo

echo "== 10) start next app on 3001 =="
osascript -e 'tell application "Terminal" to do script "cd '"$ROOT"' && pnpm dev"'

echo
echo "✅ done"
echo "Open after both windows finish booting:"
echo "  http://127.0.0.1:3001/api/fn/getIncidentV1?orgId=riverbend-electric&incidentId=inc_demo"
echo "  http://127.0.0.1:3001/incidents/inc_demo"
echo "  http://127.0.0.1:3001/incidents/inc_demo/add-evidence?orgId=riverbend-electric"

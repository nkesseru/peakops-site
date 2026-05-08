const DEV_FUNCTIONS_BASE = "http://127.0.0.1:5004/peakops-pilot/us-central1";
const DEV_FALLBACK_FUNCTIONS_BASE = "http://127.0.0.1:5004/peakops-pilot/us-central1";
const SESSION_BASE_KEY = "peakops_functions_base_override";
let warnedPortMismatch = false;

function trimTrailingSlash(v: string) {
  return v.replace(/\/+$/, "");
}

function normalizeLocalFunctionsBase(v: string) {
  const b = trimTrailingSlash(String(v || "").trim());
  if (!b || !isLocalDev()) return b;
  return b
    .replace("://127.0.0.1:5001/", "://127.0.0.1:5004/")
    .replace("://localhost:5001/", "://localhost:5004/");
}

function isLocalDev() {
  return process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ENV === "local";
}

// PEAKOPS_FUNCTIONS_BASE_RESOLVE_V1 (2026-05-08) — Slice Start Job 1.1.
// Match the env-resolution order used by app/api/fn/_proxy.ts (Slice 17
// hotfix a085f7e). Vercel Production has NEXT_PUBLIC_PEAKOPS_FN_BASE
// set as the canonical name; older deploys / local dev may carry
// NEXT_PUBLIC_FUNCTIONS_BASE. Reading them in this order means every
// consumer of getFunctionsBase() — IncidentClient.refresh(),
// IncidentClient.markArrived(), and similar guards elsewhere — picks
// up the production value and stops short-circuiting their own data
// loads / mutations. Without this, production refresh() bails at
// `if (!base) return` and the detail page never fetches the incident
// or its jobs, which is what produced "Untitled incident" + the
// missing arrival timestamp + the "Task uqxWDo" fallback in the
// Slice 17C First Job production smoke.
export function getEnvFunctionsBase() {
  const envBase = String(
    process.env.NEXT_PUBLIC_PEAKOPS_FN_BASE ||
    process.env.NEXT_PUBLIC_FUNCTIONS_BASE ||
    "",
  ).trim();
  return envBase ? normalizeLocalFunctionsBase(envBase) : "";
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
      if (ss) return normalizeLocalFunctionsBase(ss);
    } catch {}
  }
  return isLocalDev() ? DEV_FUNCTIONS_BASE : "";
}

export function getFunctionsBaseDebugInfo() {
  const envBase = getEnvFunctionsBase();
  let overrideBase = "";
  if (isLocalDev() && typeof window !== "undefined") {
    try {
      overrideBase = normalizeLocalFunctionsBase(String(window.sessionStorage.getItem(SESSION_BASE_KEY) || "").trim());
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
  const b = normalizeLocalFunctionsBase(String(base || ""));
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
  const b = normalizeLocalFunctionsBase(String(base || ""));
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
  if (!b.includes(":5004/")) {
    console.warn(`[functionsBase] using ${b}. Expected local emulator proxy is :5004.`);
  }
}

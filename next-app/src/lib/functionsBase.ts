const DEV_FUNCTIONS_BASE = "http://127.0.0.1:5004/peakops-pilot/us-central1";
const DEV_FALLBACK_FUNCTIONS_BASE = "http://127.0.0.1:5004/peakops-pilot/us-central1";
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

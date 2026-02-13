const DEV_FUNCTIONS_BASE = "http://127.0.0.1:5002/peakops-pilot/us-central1";

function trimTrailingSlash(v: string) {
  return v.replace(/\/+$/, "");
}

function isLocalDev() {
  return process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_ENV === "local";
}

export function getFunctionsBase() {
  const envBase = String(process.env.NEXT_PUBLIC_FUNCTIONS_BASE || "").trim();
  if (!envBase) return isLocalDev() ? DEV_FUNCTIONS_BASE : "";

  let out = trimTrailingSlash(envBase);

  if (isLocalDev()) {
    // Keep browser/emulator host consistent and avoid stale 5001 defaults.
    out = out.replace("localhost", "127.0.0.1").replace(/:5001(?=\/|$)/, ":5002");
  }

  return out;
}


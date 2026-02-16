import { getFunctionsBase } from "@/lib/functionsBase";

export type HealthSection =
  | "Environment"
  | "Functions"
  | "Storage/Uploads"
  | "HEIC Stack"
  | "Demo Data";

export type HealthCheck = {
  name: string;
  section: HealthSection;
  ok: boolean;
  severity: "green" | "yellow" | "red";
  details: string;
  latencyMs: number;
};

export type HealthReport = {
  ranAt: string;
  config: {
    functionsBase: string;
    nodeEnv: string;
    nextPublicEnv: string;
    localLike: boolean;
    useSignedPut: boolean;
  };
  checks: HealthCheck[];
  summary: {
    total: number;
    ok: number;
    warn: number;
    fail: number;
  };
};

const DEMO_ORG_ID = "riverbend-electric";
const DEMO_INCIDENT_ID = "inc_demo";

type TimedResult<T> = { ok: true; latencyMs: number; data: T } | { ok: false; latencyMs: number; error: string };

async function timedJson<T>(url: string, init?: RequestInit, timeoutMs = 8000): Promise<TimedResult<T>> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...(init || {}), signal: controller.signal });
    const txt = await res.text();
    const latencyMs = Date.now() - started;
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status} ${txt.slice(0, 220)}` };
    try {
      return { ok: true, latencyMs, data: (txt ? JSON.parse(txt) : {}) as T };
    } catch {
      return { ok: false, latencyMs, error: "Invalid JSON response" };
    }
  } catch (e: any) {
    const latencyMs = Date.now() - started;
    return { ok: false, latencyMs, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeHeicHealth(functionsBase: string): Promise<TimedResult<any>> {
  const post = await timedJson<any>(`${functionsBase}/heicHealthV1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (post.ok) return post;
  return timedJson<any>(`${functionsBase}/heicHealthV1`);
}

function makeCheck(input: Omit<HealthCheck, "severity"> & { severity?: HealthCheck["severity"] }): HealthCheck {
  return {
    ...input,
    severity: input.severity || (input.ok ? "green" : "red"),
  };
}

export async function runHealthChecks(): Promise<HealthReport> {
  const functionsBase = getFunctionsBase();
  const nodeEnv = String(process.env.NODE_ENV || "");
  const nextPublicEnv = String(process.env.NEXT_PUBLIC_ENV || "");
  const localLike = nodeEnv !== "production" || nextPublicEnv === "local";
  const useSignedPut = String(process.env.NEXT_PUBLIC_USE_SIGNED_PUT || "").trim() === "1";

  const checks: HealthCheck[] = [];

  checks.push(
    makeCheck({
      name: "Runtime config",
      section: "Environment",
      ok: !!functionsBase,
      details: `functionsBase=${functionsBase || "<empty>"}; NODE_ENV=${nodeEnv || "<empty>"}; NEXT_PUBLIC_ENV=${nextPublicEnv || "<empty>"}`,
      latencyMs: 0,
    })
  );

  checks.push(
    makeCheck({
      name: "Upload mode",
      section: "Storage/Uploads",
      ok: true,
      severity: useSignedPut ? "yellow" : "green",
      details: localLike
        ? (useSignedPut
          ? "Local dev uses signed PUT first (proxy fallback enabled)."
          : "Local dev uses deterministic proxy upload by default.")
        : "Production-like mode uses signed PUT.",
      latencyMs: 0,
    })
  );

  if (!functionsBase) {
    const summary = {
      total: checks.length,
      ok: checks.filter((c) => c.severity === "green").length,
      warn: checks.filter((c) => c.severity === "yellow").length,
      fail: checks.filter((c) => c.severity === "red").length,
    };
    return {
      ranAt: new Date().toISOString(),
      config: { functionsBase, nodeEnv, nextPublicEnv, localLike, useSignedPut },
      checks,
      summary,
    };
  }

  const hello = await timedJson<{ ok?: boolean; msg?: string }>(`${functionsBase}/hello`);
  checks.push(
    makeCheck({
      name: "Functions hello",
      section: "Functions",
      ok: hello.ok && !!hello.data,
      details: hello.ok ? `ok=true msg=${String(hello.data?.msg || "")}` : hello.error,
      latencyMs: hello.latencyMs,
    })
  );

  const listUrl = `${functionsBase}/listEvidenceLocker?orgId=${encodeURIComponent(DEMO_ORG_ID)}&incidentId=${encodeURIComponent(DEMO_INCIDENT_ID)}&limit=25`;
  const list = await timedJson<{ ok?: boolean; count?: number; docs?: any[] }>(listUrl);
  const demoCount = list.ok
    ? (typeof list.data?.count === "number" ? list.data.count : Array.isArray(list.data?.docs) ? list.data.docs.length : 0)
    : 0;
  const hasSeedHeic = list.ok && Array.isArray(list.data?.docs) && list.data.docs.some((d: any) => String(d?.id || "") === "ev_demo_heic_001");
  checks.push(
    makeCheck({
      name: "listEvidenceLocker",
      section: "Functions",
      ok: list.ok && list.data?.ok === true,
      details: list.ok ? `ok=${String(list.data?.ok)} count=${demoCount}` : list.error,
      latencyMs: list.latencyMs,
    })
  );

  const demoSeeded = list.ok && list.data?.ok === true && demoCount >= 5 && hasSeedHeic;
  checks.push(
    makeCheck({
      name: "Demo seed integrity",
      section: "Demo Data",
      ok: demoSeeded,
      severity: demoSeeded ? "green" : "yellow",
      details: demoSeeded
        ? `count=${demoCount}; found ev_demo_heic_001=true`
        : `Expected count>=5 and ev_demo_heic_001 present. got count=${demoCount} heicSeed=${String(hasSeedHeic)}. Run scripts/dev/seed_demo_incident.sh`,
      latencyMs: list.latencyMs,
    })
  );

  const heicDebug = await timedJson<any>(`${functionsBase}/debugHeicConversionV1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orgId: DEMO_ORG_ID,
      incidentId: DEMO_INCIDENT_ID,
      dryRun: true,
    }),
  });
  const heicReason = heicDebug.ok ? String(heicDebug.data?.reason || "") : "";
  const heicSelected = heicDebug.ok ? String(heicDebug.data?.selectedEvidenceId || "") : "";
  const heicOk = heicDebug.ok && (
    (heicDebug.data?.ok === true && !!heicSelected) ||
    heicReason === "no_heic_evidence_found"
  );
  const heicSeverity: HealthCheck["severity"] =
    heicDebug.ok && heicReason === "no_heic_evidence_found" ? "yellow" : (heicOk ? "green" : "red");
  checks.push(
    makeCheck({
      name: "debugHeicConversionV1",
      section: "HEIC Stack",
      ok: heicOk,
      severity: heicSeverity,
      details: heicDebug.ok
        ? (heicReason === "no_heic_evidence_found"
          ? "no_heic_evidence_found (expected if HEIC sample not provided in seed script)"
          : `ok=${String(heicDebug.data?.ok)} selectedEvidenceId=${heicSelected || "<empty>"}`)
        : heicDebug.error,
      latencyMs: heicDebug.latencyMs,
    })
  );

  const heic = await probeHeicHealth(functionsBase);
  checks.push(
    makeCheck({
      name: "heicHealthV1",
      section: "HEIC Stack",
      ok: heic.ok && heic.data?.ok === true,
      severity: heic.ok && heic.data?.ok === true ? "green" : "red",
      details: heic.ok
        ? `ok=${String(heic.data?.ok)} sharp=${String(heic.data?.runtime?.sharpVersion || "")} heif-convert=${String(!!heic.data?.runtime?.heifConvert)} sips=${String(!!heic.data?.runtime?.sips)}`
        : heic.error,
      latencyMs: heic.latencyMs,
    })
  );

  const uploadProbe = await timedJson<any>(`${functionsBase}/createEvidenceUploadUrlV1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orgId: DEMO_ORG_ID,
      incidentId: DEMO_INCIDENT_ID,
      sessionId: "ses_health_probe",
      originalName: "health_probe.jpg",
      contentType: "image/jpeg",
    }),
  });
  const uploadOk =
    uploadProbe.ok &&
    uploadProbe.data?.ok === true &&
    !!String(uploadProbe.data?.bucket || "").trim() &&
    !!String(uploadProbe.data?.uploadUrl || "").trim();
  let uploadHost = "";
  if (uploadProbe.ok) {
    try {
      uploadHost = new URL(String(uploadProbe.data?.uploadUrl || "")).hostname;
    } catch {
      uploadHost = "";
    }
  }
  const uploadHostOk = uploadHost === "storage.googleapis.com";
  checks.push(
    makeCheck({
      name: "Storage upload readiness",
      section: "Storage/Uploads",
      ok: uploadOk && uploadHostOk,
      details: uploadProbe.ok
        ? `ok=${String(uploadProbe.data?.ok)} bucket=${String(uploadProbe.data?.bucket || "<empty>")} uploadHost=${uploadHost || "<invalid>"} proxyDefault=${String(!useSignedPut)}`
        : uploadProbe.error,
      latencyMs: uploadProbe.latencyMs,
    })
  );

  const summary = {
    total: checks.length,
    ok: checks.filter((c) => c.severity === "green").length,
    warn: checks.filter((c) => c.severity === "yellow").length,
    fail: checks.filter((c) => c.severity === "red").length,
  };

  return {
    ranAt: new Date().toISOString(),
    config: { functionsBase, nodeEnv, nextPublicEnv, localLike, useSignedPut },
    checks,
    summary,
  };
}

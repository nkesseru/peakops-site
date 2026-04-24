"use client";

import { isHeicEvidence } from "./isHeicEvidence";

export type StartFieldSessionResp = {
  ok: boolean;
  sessionId?: string;
  id?: string;
  error?: string;
};

export type CreateUploadUrlResp = {
  ok: boolean;
  uploadUrl: string;
  uploadMethod?: "PUT" | "POST";
  storagePath: string;
  bucket?: string;
  contentType?: string;
  expiresAt?: string;
  error?: string;
};

export type AddEvidenceResp = {
  ok: boolean;
  evidenceId?: string;
  error?: string;
};

export type UploadEvidenceArgs = {
  functionsBase: string; // e.g. http://127.0.0.1:5004/peakops-pilot/us-central1
  techUserId: string;

  orgId: string;
  incidentId: string;

  phase: string;
  labels: string[];

  gps?: { lat: number; lng: number; acc?: number };
  notes?: string;

  file: File;
  sessionId?: string;
  jobId?: string;

  onStatus?: (s: string) => void;
};

function isLocalDev(): boolean {
  const envLocal = process.env.NEXT_PUBLIC_ENV === "local" || process.env.NODE_ENV !== "production";
  try {
    const h = String((globalThis as any)?.location?.hostname || "");
    return envLocal || h === "127.0.0.1" || h === "localhost";
  } catch {
    return envLocal;
  }
}

// PEAKOPS_EMULATOR_FUNCTIONS_BASE_V1
// Authoritative signal for "the upload proxy is safe to call". We key off the
// actual Cloud Functions base the app is pointed at — NOT the browser
// hostname — because a developer can (and does) run the UI on localhost while
// NEXT_PUBLIC_FUNCTIONS_BASE=https://us-central1-<project>.cloudfunctions.net.
// In that case the functions are production, uploadEvidenceProxyV1 returns
// 403 dev_only_endpoint, and the client must take the direct-signed-URL path.
function isEmulatorFunctionsBase(): boolean {
  const base = String(process.env.NEXT_PUBLIC_FUNCTIONS_BASE || "").trim();
  if (!base) return false;
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost";
  } catch {
    return false;
  }
}

async function postJson<T>(url: string, body: any): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const txt = await res.text().catch(() => "");
  let parsed: any = {};
  try {
    parsed = txt ? JSON.parse(txt) : {};
  } catch {
    throw new Error(`POST ${url} -> ${res.status} non-json: ${txt.slice(0, 200)}`);
  }
  if (!res.ok || parsed?.ok === false) {
    throw new Error(`POST ${url} -> ${res.status} ${txt.slice(0, 300)}`);
  }
  return parsed as T;
}

/**
 * Upload bytes directly to the uploadUrl returned by createEvidenceUploadUrlV1.
 * In emulator we’ve seen uploadMethod=POST (storage upload API) or PUT (signed URL style).
 */
async function uploadBytesToUploadUrl(opts: {
  uploadUrl: string;
  uploadMethod?: string;
  file: File;
  proxyArgs?: {
    orgId: string;
    incidentId: string;
    sessionId: string;
    storagePath: string;
    bucket?: string;
    contentType?: string;
    originalName?: string;
  };
}): Promise<void> {
  const method = String(opts.uploadMethod || "PUT").toUpperCase();
  const ct = opts.file.type || "application/octet-stream";

  // PEAKOPS_UPLOAD_PROXY_DEV_GATE_V2
  // The uploadEvidenceProxyV1 endpoint is dev-only (returns 403
  // dev_only_endpoint when deployed to production). Guarantee the proxy
  // branch can only fire when BOTH:
  //   (a) the Cloud Functions base points at an emulator (localhost / 127.0.0.1),
  //       i.e. we're actually routing function calls to the local emulator, AND
  //   (b) the backend returned an emulator-shaped Storage uploadUrl.
  // The earlier heuristic checked window.location.hostname, which wrongly
  // treated "UI served from localhost while pointed at prod Functions" as
  // local dev — that configuration is common during staging smoke tests and
  // was the reason the proxy kept getting called in prod. Now it hinges on
  // NEXT_PUBLIC_FUNCTIONS_BASE, which is the only signal that actually tells
  // us which backend we're talking to.
  const emulatorFunctionsBase = isEmulatorFunctionsBase();
  const isLocalStorageEmulatorUrl =
    /127\.0\.0\.1:9199/i.test(String(opts.uploadUrl || "")) ||
    /localhost:9199/i.test(String(opts.uploadUrl || ""));

  if (isLocalStorageEmulatorUrl && !emulatorFunctionsBase) {
    throw new Error(
      `Upload URL points at the Storage emulator (${opts.uploadUrl}) but ` +
      `NEXT_PUBLIC_FUNCTIONS_BASE is not an emulator endpoint. Verify that ` +
      `createEvidenceUploadUrlV1 is returning real signed URLs in production ` +
      `and that NEXT_PUBLIC_FUNCTIONS_BASE is set correctly for this environment.`
    );
  }

  if (emulatorFunctionsBase && isLocalStorageEmulatorUrl && opts.proxyArgs) {
    const q = new URLSearchParams({
      orgId: String(opts.proxyArgs.orgId || ""),
      incidentId: String(opts.proxyArgs.incidentId || ""),
      sessionId: String(opts.proxyArgs.sessionId || ""),
      storagePath: String(opts.proxyArgs.storagePath || ""),
      bucket: String(opts.proxyArgs.bucket || ""),
      contentType: String(opts.proxyArgs.contentType || ct),
      originalName: String(opts.proxyArgs.originalName || opts.file.name || "upload.bin"),
    });

    const res = await fetch(`/api/fn/uploadEvidenceProxyV1?${q.toString()}`, {
      method: "POST",
      headers: { "content-type": ct },
      body: opts.file,
      cache: "no-store",
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`uploadEvidenceProxyV1 -> ${res.status} ${txt.slice(0, 300)}`);
    }
    return;
  }

  const res = await fetch(opts.uploadUrl, {
    method: method === "POST" ? "POST" : "PUT",
    headers: { "content-type": ct },
    body: opts.file,
    cache: "no-store",
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`uploadUrl ${method} -> ${res.status} ${txt.slice(0, 300)}`);
  }
}

export async function uploadEvidence(args: UploadEvidenceArgs): Promise<AddEvidenceResp> {
  const {
    functionsBase,
    techUserId,
    orgId,
    incidentId,
    phase,
    labels,
    gps,
    notes,
    file,
    onStatus,
    jobId,
  } = args;

  const localDev = isLocalDev();

  const startFreshSession = async (): Promise<string> => {
    const sess = await postJson<StartFieldSessionResp>(`/api/fn/startFieldSessionV1`, {
      orgId,
      incidentId,
      techUserId,
      actorUid: "dev-admin",
      actorRole: "admin",
    });
    const sid = String(sess.sessionId || sess.id || "").trim();
    if (!sid) throw new Error(`startFieldSessionV1 missing sessionId: ${JSON.stringify(sess)}`);
    return sid;
  };

  const isSessionMissing = (err: any): boolean => {
    const msg = String(err?.message || err || "").toLowerCase();
    return msg.includes("session not found");
  };

  // 1) Ensure we have a sessionId
    let activeSessionId = String(args.sessionId || "").trim();

console.warn("[uploadEvidence] step=start-session", {
  orgId,
  incidentId,
  fileName: file?.name,
  incomingSessionId: activeSessionId,
});

onStatus?.("Starting field session…");
  if (!activeSessionId) {
    activeSessionId = await startFreshSession();
    console.warn("[uploadEvidence] created fresh sessionId", { sessionId: activeSessionId });
  }

  // 2) Get uploadUrl + storagePath (retry once if session is stale)
  const requestUploadUrl = async (sidToUse: string): Promise<CreateUploadUrlResp> => {
    return await postJson<CreateUploadUrlResp>(`/api/fn/createEvidenceUploadUrlV1`, {
      orgId,
      incidentId,
      sessionId: sidToUse,
      fileName: file.name || "upload.bin",
      originalName: file.name || "upload.bin",
      contentType: file.type || "application/octet-stream",
    });
  };

  console.warn("[uploadEvidence] step=request-upload-url", { orgId, incidentId, incomingSessionId: activeSessionId, fileName: file?.name, contentType: file?.type });
  onStatus?.("Requesting upload URL…");
  let createResp: CreateUploadUrlResp;
  try {
    createResp = await requestUploadUrl(activeSessionId);
  } catch (e: any) {
    if (isSessionMissing(e)) {
      onStatus?.("Refreshing session…");
      activeSessionId = await startFreshSession();
      console.warn("[uploadEvidence] refreshed sessionId", { refreshedSessionId: activeSessionId });
      createResp = await requestUploadUrl(activeSessionId);
    } else {
      throw e;
    }
  }

  console.warn("[uploadEvidence] createResp", createResp);
  const uploadUrl = String(createResp.uploadUrl || "").trim();
  const storagePath = String(createResp.storagePath || "").trim();
  const bucket = String(createResp.bucket || "").trim();

  if (!uploadUrl || !storagePath) {
    throw new Error(`createEvidenceUploadUrlV1 invalid: ${JSON.stringify(createResp)}`);
  }

  // 3) Upload bytes
  console.warn("[uploadEvidence] step=upload-bytes", { uploadMethod: createResp.uploadMethod, storagePath: createResp.storagePath, bucket: createResp.bucket });
  onStatus?.("Uploading…");
  await uploadBytesToUploadUrl({
    uploadUrl,
    uploadMethod: createResp.uploadMethod,
    file,
    proxyArgs: {
      orgId,
      incidentId,
      sessionId: activeSessionId,
      storagePath,
      bucket,
      contentType: file.type || "application/octet-stream",
      originalName: file.name || "upload.bin",
    },
  });

  // 4) Register evidence (retry once if session went stale between upload + register)
  const postAddEvidence = async (sidToUse: string): Promise<AddEvidenceResp> => {
    return await postJson<AddEvidenceResp>(`/api/fn/addEvidenceV1`, {
      orgId,
      incidentId,
      sessionId: sidToUse,
      phase,
      labels,
      gps,
      contentType: file.type || "application/octet-stream",
      storagePath,
      bucket,
      notes: notes || "",
      originalName: file.name || "upload.bin",
      jobId: String(jobId || "").trim() || null,
      actorUid: "dev-admin",
      actorRole: "admin",
    });
  };

  console.warn("[uploadEvidence] step=add-evidence", { orgId, incidentId, incomingSessionId: activeSessionId, storagePath, bucket, fileName: file?.name, jobId });
  onStatus?.("Securing evidence…");
  let addResp: AddEvidenceResp;
  try {
    addResp = await postAddEvidence(activeSessionId);
  } catch (e: any) {
    if (isSessionMissing(e)) {
      onStatus?.("Refreshing session…");
      activeSessionId = await startFreshSession();
      console.warn("[uploadEvidence] refreshed sessionId", { refreshedSessionId: activeSessionId });
      addResp = await postAddEvidence(activeSessionId);
    } else {
      throw e;
    }
  }

  if (localDev && isHeicEvidence({ contentType: file.type, originalName: file.name, storagePath })) {
    // leave disabled unless you’ve stabilized HEIC end-to-end
  }

  console.warn("[uploadEvidence] success", { evidenceId: addResp?.evidenceId, finalSessionId: activeSessionId, registration: addResp });
  onStatus?.("Secured ✅");
  return addResp;
}

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

  const isLocalStorageEmulatorUrl =
    /127\.0\.0\.1:9199/i.test(String(opts.uploadUrl || "")) ||
    /localhost:9199/i.test(String(opts.uploadUrl || ""));

  if (isLocalStorageEmulatorUrl && opts.proxyArgs) {
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

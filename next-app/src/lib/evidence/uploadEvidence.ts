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
  functionsBase: string; // e.g. http://127.0.0.1:5002/peakops-pilot/us-central1
  techUserId: string;

  orgId: string;
  incidentId: string;

  phase: string; // "inspection"
  labels: string[];

  gps?: { lat: number; lng: number; acc?: number };
  notes?: string;

  file: File;
  sessionId?: string;
  jobId?: string;

  onStatus?: (s: string) => void;
};

function isLocalDev() {
  const envLocal = process.env.NEXT_PUBLIC_ENV === "local" || process.env.NODE_ENV !== "production";
  try {
    const h = String(globalThis?.location?.hostname || "");
    return envLocal || h === "127.0.0.1" || h === "localhost";
  } catch {
    return envLocal;
  }
}

function useSignedPutInLocalDev() {
  return String(process.env.NEXT_PUBLIC_USE_SIGNED_PUT || "").trim() === "1";
}

async function postJson<T>(url: string, body: any): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e: any) {
    throw new Error(`POST ${url} -> network error: ${String(e?.message || e)}`);
  }
  const txt = await res.text();
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${txt}`);
  return JSON.parse(txt) as T;
}

async function verifyObjectInStorage({
  functionsBase,
  orgId,
  incidentId,
  storagePath,
  bucket,
}: {
  functionsBase: string;
  orgId: string;
  incidentId: string;
  storagePath: string;
  bucket: string;
}) {
  const out = await postJson<{ ok?: boolean; url?: string; error?: string }>(
    `${functionsBase}/createEvidenceReadUrlV1`,
    { orgId, incidentId, storagePath, bucket, expiresSec: 120 }
  );
  if (!out?.ok || !out?.url) {
    throw new Error(`verify failed: createEvidenceReadUrlV1 bucket=${bucket} path=${storagePath} -> ${JSON.stringify(out)}`);
  }

  const verifyRes = await fetch(out.url, { method: "GET" });
  if (!verifyRes.ok) {
    const txt = await verifyRes.text().catch(() => "");
    throw new Error(`storage object missing bucket=${bucket} path=${storagePath} -> ${verifyRes.status} ${txt}`);
  }
}

function redactUploadUrl(input: string) {
  try {
    const u = new URL(String(input || ""));
    const redacted = new URL(u.toString());
    ["X-Goog-Signature", "X-Amz-Signature", "signature", "sig"].forEach((k) => {
      if (redacted.searchParams.has(k)) redacted.searchParams.set(k, "REDACTED");
    });
    return {
      redactedUrl: redacted.toString(),
      protocol: u.protocol || "",
      hostname: u.hostname || "",
    };
  } catch {
    return { redactedUrl: String(input || ""), protocol: "", hostname: "" };
  }
}

async function uploadViaDevProxy({
  functionsBase,
  orgId,
  incidentId,
  sessionId,
  storagePath,
  bucket,
  file,
}: {
  functionsBase: string;
  orgId: string;
  incidentId: string;
  sessionId: string;
  storagePath: string;
  bucket: string;
  file: File;
}) {
  const fd = new FormData();
  fd.append("orgId", orgId);
  fd.append("incidentId", incidentId);
  fd.append("sessionId", sessionId);
  fd.append("storagePath", storagePath);
  fd.append("bucket", bucket);
  fd.append("contentType", file.type || "application/octet-stream");
  fd.append("originalName", file.name || "upload");
  fd.append("file", file, file.name || "upload");
  const res = await fetch(`${functionsBase}/uploadEvidenceProxyV1`, {
    method: "POST",
    body: fd,
  });
  const txt = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`uploadEvidenceProxyV1 -> ${res.status} ${txt}`);
  try {
    return JSON.parse(txt);
  } catch {
    return { ok: true };
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
    jobId,
    onStatus,
  } = args;

  // 1) Ensure we have a session
  onStatus?.("Starting field session…");
  let sessionId = args.sessionId;

  if (!sessionId) {
    const sess = await postJson<StartFieldSessionResp>(`${functionsBase}/startFieldSessionV1`, {
      orgId,
      incidentId,
      phase,
      techUserId,
      gps,
    });

    if (!sess.ok) throw new Error(`startFieldSessionV1 not ok: ${JSON.stringify(sess)}`);
    sessionId = sess.sessionId || sess.id;
    if (!sessionId) throw new Error(`startFieldSessionV1 missing sessionId: ${JSON.stringify(sess)}`);
  }

  // 2) Create signed URL
  onStatus?.("Requesting upload URL…");
  const createResp = await postJson<CreateUploadUrlResp>(`${functionsBase}/createEvidenceUploadUrlV1`, {
    orgId,
    incidentId,
    sessionId,
    contentType: file.type || "application/octet-stream",
    originalName: file.name || "upload.bin",
  });

  if (!createResp.ok || !createResp.uploadUrl || !createResp.storagePath) {
    throw new Error(`createEvidenceUploadUrlV1 invalid: ${JSON.stringify(createResp)}`);
  }
  const uploadBucket = String(createResp.bucket || "").trim();
  if (!uploadBucket) {
    throw new Error(`createEvidenceUploadUrlV1 missing bucket for storagePath=${createResp.storagePath}`);
  }
  const localDev = isLocalDev();
  const u = redactUploadUrl(createResp.uploadUrl);
  console.info("[uploadEvidence] signed upload URL", {
    url: u.redactedUrl,
    protocol: u.protocol,
    hostname: u.hostname,
    bucket: uploadBucket,
    storagePath: createResp.storagePath,
  });
  if (localDev) {
    onStatus?.(`Upload URL ${u.redactedUrl}`);
  }

  // 3) Upload bytes
  onStatus?.("Uploading…");
  let finalBucket = uploadBucket;
  let finalStoragePath = createResp.storagePath;
  if (localDev) {
    const preferSignedPut = useSignedPutInLocalDev();
    if (preferSignedPut) {
      onStatus?.("Uploading via signed PUT…");
      try {
        const putRes = await fetch(createResp.uploadUrl, {
          method: "PUT",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!putRes.ok) {
          const errTxt = await putRes.text().catch(() => "");
          throw new Error(`PUT signed URL -> ${putRes.status} ${errTxt}`);
        }
      } catch (e: any) {
        console.warn("[uploadEvidence] signed PUT failed in local dev; falling back to proxy", {
          error: String(e?.message || e),
          bucket: uploadBucket,
          storagePath: createResp.storagePath,
        });
        onStatus?.("Signed PUT failed, retrying via dev proxy…");
        const proxyOut = await uploadViaDevProxy({
          functionsBase,
          orgId,
          incidentId,
          sessionId,
          storagePath: createResp.storagePath,
          bucket: uploadBucket,
          file,
        });
        if (!proxyOut?.ok) throw new Error(`uploadEvidenceProxyV1 failed: ${JSON.stringify(proxyOut)}`);
        finalBucket = String(proxyOut.bucket || uploadBucket).trim();
        finalStoragePath = String(proxyOut.storagePath || createResp.storagePath).trim();
        if (!finalBucket || !finalStoragePath) {
          throw new Error(`uploadEvidenceProxyV1 missing bucket/path: ${JSON.stringify(proxyOut)}`);
        }
      }
    } else {
      onStatus?.("Uploading via dev proxy…");
      const proxyOut = await uploadViaDevProxy({
        functionsBase,
        orgId,
        incidentId,
        sessionId,
        storagePath: createResp.storagePath,
        bucket: uploadBucket,
        file,
      });
      if (!proxyOut?.ok) throw new Error(`uploadEvidenceProxyV1 failed: ${JSON.stringify(proxyOut)}`);
      finalBucket = String(proxyOut.bucket || uploadBucket).trim();
      finalStoragePath = String(proxyOut.storagePath || createResp.storagePath).trim();
      if (!finalBucket || !finalStoragePath) {
        throw new Error(`uploadEvidenceProxyV1 missing bucket/path: ${JSON.stringify(proxyOut)}`);
      }
    }
  } else {
    const putRes = await fetch(createResp.uploadUrl, {
      method: "PUT",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    if (!putRes.ok) {
      const errTxt = await putRes.text().catch(() => "");
      throw new Error(`PUT signed URL -> ${putRes.status} ${errTxt}`);
    }
  }

  // Dev safeguard: confirm uploaded object is actually reachable via signed read URL.
  if (localDev) {
    onStatus?.("Verifying storage object…");
    try {
      await verifyObjectInStorage({
        functionsBase,
        orgId,
        incidentId,
        storagePath: finalStoragePath,
        bucket: finalBucket,
      });
    } catch (e: any) {
      throw new Error(`Upload not in storage bucket=${finalBucket} path=${finalStoragePath}`);
    }
  }

  // 4) Register evidence
  onStatus?.("Securing evidence…");
  const addResp = await postJson<AddEvidenceResp>(`${functionsBase}/addEvidenceV1`, {
    orgId,
    incidentId,
    sessionId,
    phase,
    labels,
    gps,
    contentType: file.type,
    storagePath: finalStoragePath,
    bucket: finalBucket,
    notes: notes || "",
    originalName: file.name || "upload.bin",
    jobId: String(jobId || "").trim() || null,
  });

  if (!addResp.ok) {
    throw new Error(`addEvidenceV1 not ok: ${JSON.stringify(addResp)}`);
  }

  // Deterministic demo behavior: run queued conversion once right after HEIC upload in dev.
  if (localDev && isHeicEvidence({ contentType: file.type, originalName: file.name, storagePath: finalStoragePath })) {
    onStatus?.("Running HEIC conversion job…");
    const runOut = await postJson<{ ok?: boolean; error?: string }>(`${functionsBase}/runConversionJobsV1`, {
      incidentId,
      evidenceId: addResp.evidenceId || "",
      limit: 1,
    });
    if (!runOut?.ok) {
      throw new Error(`runConversionJobsV1 failed: ${JSON.stringify(runOut)}`);
    }
  }

  onStatus?.("Secured ✔️");
  return addResp;
}

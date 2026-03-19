function toStr(v) {
  return String(v || "").trim();
}

function buildFallbackBucket(projectId) {
  const pid = toStr(projectId);
  if (!pid) return "";
  return `${pid}.firebasestorage.app`;
}

function resolveEvidenceBucket({ file = {}, req = null, env = process.env, projectId = "" } = {}) {
  const checks = [];

  const fromFileBucket = toStr(file.bucket);
  checks.push(`file.bucket=${fromFileBucket || "(empty)"}`);
  if (fromFileBucket) {
    return { ok: true, bucket: fromFileBucket, source: "file.bucket", checked: checks };
  }

  const fromDerivativeBucket = toStr(file.derivativeBucket);
  checks.push(`file.derivativeBucket=${fromDerivativeBucket || "(empty)"}`);
  if (fromDerivativeBucket) {
    return { ok: true, bucket: fromDerivativeBucket, source: "file.derivativeBucket", checked: checks };
  }

  const fromReqBucket = toStr(req?.body?.bucket) || toStr(req?.query?.bucket);
  checks.push(`req.bucket=${fromReqBucket || "(empty)"}`);
  if (fromReqBucket) {
    return { ok: true, bucket: fromReqBucket, source: "req.bucket", checked: checks };
  }

  const fromFirebaseStorageBucket = toStr(env?.FIREBASE_STORAGE_BUCKET);
  checks.push(`env.FIREBASE_STORAGE_BUCKET=${fromFirebaseStorageBucket || "(empty)"}`);
  if (fromFirebaseStorageBucket) {
    return { ok: true, bucket: fromFirebaseStorageBucket, source: "env.FIREBASE_STORAGE_BUCKET", checked: checks };
  }

  const fromStorageBucket = toStr(env?.STORAGE_BUCKET);
  checks.push(`env.STORAGE_BUCKET=${fromStorageBucket || "(empty)"}`);
  if (fromStorageBucket) {
    return { ok: true, bucket: fromStorageBucket, source: "env.STORAGE_BUCKET", checked: checks };
  }

  const pid =
    toStr(projectId) ||
    toStr(env?.GCLOUD_PROJECT) ||
    toStr(env?.FIREBASE_PROJECT_ID) ||
    toStr(env?.PROJECT_ID);
  checks.push(`projectId=${pid || "(empty)"}`);
  const fallbackBucket = buildFallbackBucket(pid);
  checks.push(`fallback=${fallbackBucket || "(empty)"}`);
  if (fallbackBucket) {
    return { ok: true, bucket: fallbackBucket, source: "project_fallback", checked: checks };
  }

  return {
    ok: false,
    error: `bucket missing; checked: ${checks.join(" | ")}`,
    checked: checks,
  };
}

module.exports = { resolveEvidenceBucket };


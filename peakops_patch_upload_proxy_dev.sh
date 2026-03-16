#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
FILE="$ROOT/next-app/src/lib/evidence/uploadEvidence.ts"
TS="$(date +%Y%m%d_%H%M%S)"

cp "$FILE" "$FILE.bak_$TS"

python3 <<'PY'
from pathlib import Path

p = Path.home() / "peakops/my-app/next-app/src/lib/evidence/uploadEvidence.ts"
s = p.read_text()

old_fn = r'''async function uploadBytesToUploadUrl(opts: {
  uploadUrl: string;
  uploadMethod?: string;
  file: File;
}): Promise<void> {
  const method = String(opts.uploadMethod || "PUT").toUpperCase();
  const ct = opts.file.type || "application/octet-stream";

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
}'''

new_fn = r'''async function uploadBytesToUploadUrl(opts: {
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
}'''

if old_fn not in s:
    raise SystemExit("Could not find uploadBytesToUploadUrl block.")

s = s.replace(old_fn, new_fn, 1)

old_call = r'''  await uploadBytesToUploadUrl({
    uploadUrl,
    uploadMethod: createResp.uploadMethod,
    file,
  });'''

new_call = r'''  await uploadBytesToUploadUrl({
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
  });'''

if old_call not in s:
    raise SystemExit("Could not find uploadBytesToUploadUrl call site.")

s = s.replace(old_call, new_call, 1)

p.write_text(s)
print("Patched uploadEvidence.ts")
PY

echo
echo "== verify patch =="
rg -n "uploadEvidenceProxyV1|isLocalStorageEmulatorUrl|proxyArgs" "$FILE"

echo
echo "== restart next =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN || true)"
if [ -n "${PIDS:-}" ]; then
  kill -9 $PIDS
fi

rm -rf "$ROOT/next-app/.next"

echo
echo "Patch complete."
echo "Now restart:"
echo "  cd ~/peakops/my-app && pnpm dev"

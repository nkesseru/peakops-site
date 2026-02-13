export function normalizeContentType(contentType?: string | null): string {
  const raw = String(contentType || "").trim().toLowerCase();
  if (!raw || raw === "application/octet-stream") return "";
  return raw;
}

function hasHeicExtAnywhere(value?: string | null): boolean {
  return /\.(heic|heif)(?:$|[^a-z0-9])/i.test(String(value || ""));
}

export function isHeicEvidence(file: {
  contentType?: string | null;
  originalName?: string | null;
  storagePath?: string | null;
}): boolean {
  const contentType = normalizeContentType(file?.contentType);
  const originalName = String(file?.originalName || "").trim();
  const storagePath = String(file?.storagePath || "").trim();
  return (
    /heic|heif/i.test(contentType) ||
    /\.(heic|heif)$/i.test(originalName) ||
    hasHeicExtAnywhere(storagePath) ||
    /heic/i.test(originalName)
  );
}

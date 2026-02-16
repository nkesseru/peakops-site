function normalizeContentType(contentType) {
  const raw = String(contentType || "").trim().toLowerCase();
  if (!raw || raw === "application/octet-stream") return "";
  return raw;
}

function hasHeicExtAnywhere(value) {
  return /\.(heic|heif)(?:$|[^a-z0-9])/i.test(String(value || ""));
}

function isHeicEvidence(file = {}) {
  const contentType = normalizeContentType(file.contentType);
  const originalName = String(file.originalName || "").trim();
  const storagePath = String(file.storagePath || "").trim();
  const noExtName = !!originalName && !/\.[a-z0-9]{2,8}$/i.test(originalName);
  const looksLikeCameraName = /IMG_/i.test(originalName);
  const uploadPath = /\/uploads\//i.test(storagePath);
  return (
    /heic|heif/i.test(contentType) ||
    /\.(heic|heif)$/i.test(originalName) ||
    hasHeicExtAnywhere(storagePath) ||
    /heic/i.test(originalName) ||
    (!contentType && noExtName && uploadPath && looksLikeCameraName)
  );
}

module.exports = {
  normalizeContentType,
  isHeicEvidence,
};

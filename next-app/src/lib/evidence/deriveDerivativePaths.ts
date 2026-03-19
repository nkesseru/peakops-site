export function deriveDerivativePaths(args: {
  storagePath?: string | null;
  originalName?: string | null;
}) {
  const storagePath = String(args?.storagePath || "").trim();
  const originalName = String(args?.originalName || "").trim();
  const hasHeicExt = /\.(heic|heif)$/i.test(storagePath) || (!storagePath && /\.(heic|heif)$/i.test(originalName));
  let basePath = storagePath;
  if (/\.(heic|heif)$/i.test(storagePath)) {
    basePath = storagePath.replace(/\.(heic|heif)$/i, "");
  } else if (!/\.[a-z0-9]{2,8}$/i.test(storagePath) && hasHeicExt) {
    basePath = storagePath;
  }
  return {
    previewPath: basePath ? `${basePath}__preview.jpg` : "",
    thumbPath: basePath ? `${basePath}__thumb.webp` : "",
  };
}


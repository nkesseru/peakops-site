"use client";

// PR 137B-2 — client-side HEIC → JPEG conversion at capture time.
//
// Iron rule: this MUST NOT block evidence capture. Every failure mode
// (no internet → WASM won't load; decode throws; decode hangs)
// returns the original File unmodified so the upload pipeline still
// has bytes to ship. The caller marks the queued item as
// `originalRetained` and surfaces "Couldn't preview · original kept"
// in the tile.
//
// Library: heic-to (~3 MB WASM, dynamic-imported only when a HEIC
// file is picked, browser-cached after first hit). Bundle delta on
// the main chunk: 0 bytes.

const CONVERT_TIMEOUT_MS = 6000;

export type HeicConvertReason =
  | "not-heic"
  | "load-timeout"
  | "decode-timeout"
  | "decode-error";

export type HeicConvertResult = {
  file: File;
  converted: boolean;
  reason?: HeicConvertReason;
};

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  tag: HeicConvertReason
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err: any = new Error(`timeout:${tag}`);
      err.tag = tag;
      reject(err);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function looksLikeHeic(file: File): boolean {
  const name = String(file?.name || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  return /\.(heic|heif)$/i.test(name) || /heic|heif/.test(type);
}

function swapExtToJpg(name: string): string {
  const stripped = name.replace(/\.(heic|heif)$/i, "");
  return (stripped || "photo") + ".jpg";
}

export async function maybeConvertHeicToJpeg(
  file: File
): Promise<HeicConvertResult> {
  if (!looksLikeHeic(file)) {
    return { file, converted: false, reason: "not-heic" };
  }

  try {
    const mod: any = await withTimeout(
      import("heic-to"),
      CONVERT_TIMEOUT_MS,
      "load-timeout"
    );
    const heicTo = mod?.heicTo ?? mod?.default;
    if (typeof heicTo !== "function") {
      return { file, converted: false, reason: "decode-error" };
    }
    const jpegBlob: Blob = await withTimeout(
      heicTo({ blob: file, type: "image/jpeg", quality: 0.85 }),
      CONVERT_TIMEOUT_MS,
      "decode-timeout"
    );
    return {
      file: new File([jpegBlob], swapExtToJpg(file.name), {
        type: "image/jpeg",
      }),
      converted: true,
    };
  } catch (e: any) {
    const tag: HeicConvertReason =
      e?.tag === "load-timeout" || e?.tag === "decode-timeout"
        ? e.tag
        : "decode-error";
    return { file, converted: false, reason: tag };
  }
}

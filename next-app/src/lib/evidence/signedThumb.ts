"use client";

export type EvidenceImageRefKind = "thumbnailPath" | "thumbPath" | "previewPath" | "original";

export type EvidenceImageRef = {
  kind: EvidenceImageRefKind;
  bucket: string;
  storagePath: string;
};

type MintInput = {
  orgId: string;
  incidentId: string;
  bucket: string;
  storagePath: string;
  expiresSec?: number;
};

type MintResult = {
  ok: boolean;
  url?: string;
  error?: string;
  status?: number;
  details?: any;
  mintHttp?: number;
  mintError?: string;
};

// --- Mint cache (dev/runtime) ---
// Prevents re-mint storms hammering /api/fn/createEvidenceReadUrlV1.
const __PEAKOPS_MINT_CACHE: Record<string, { url: string; at: number }> = {};
const __PEAKOPS_MINT_TTL_MS = 30_000; // short so refresh can still work

export function getThumbExpiresSec(): number {
  // Default 15m; can be overridden via NEXT_PUBLIC_THUMB_EXPIRES_SEC
  const raw = String(process.env.NEXT_PUBLIC_THUMB_EXPIRES_SEC || "").trim();
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= 30 && n <= 86400) return Math.floor(n);
  return 900;
}

export function logThumbEvent(event: string, details: any = {}): void {
  if (process.env.NODE_ENV === "production") return;
  try {
    // eslint-disable-next-line no-console
    console.log(`[thumb-debug] ${event}`, details);
  } catch {
    // ignore
  }
}

function _pickEvidenceMedia(ev: any): {
  bucket: string;
  thumbnailPath: string;
  thumbPath: string;
  previewPath: string;
  originalPath: string;
} {
  const pickStr = (...vals: any[]) =>
    vals
      .map((v) => String(v ?? "").trim())
      .find((v) => !!v) || "";

  const getDot = (obj: any, path: string) => {
    try {
      return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
    } catch {
      return undefined;
    }
  };

  const bucket = pickStr(
    getDot(ev, "file.derivatives.thumb.bucket"),
    ev?.file?.derivatives?.thumb?.bucket,
    getDot(ev, "file.derivatives.thumbBucket"),
    ev?.file?.derivatives?.thumbBucket,
    getDot(ev, "file.thumbBucket"),
    ev?.file?.thumbBucket,
    getDot(ev, "file.thumbnailBucket"),
    ev?.file?.thumbnailBucket,
    getDot(ev, "file.derivatives.preview.bucket"),
    ev?.file?.derivatives?.preview?.bucket,
    getDot(ev, "file.previewBucket"),
    ev?.file?.previewBucket,
    getDot(ev, "file.bucket"),
    ev?.file?.bucket,
    getDot(ev, "bucket"),
    ev?.bucket
  );

  const thumbnailPath = pickStr(
    getDot(ev, "file.thumbnailPath"),
    ev?.file?.thumbnailPath
  );

  const thumbPath = pickStr(
    getDot(ev, "file.derivatives.thumb.storagePath"),
    ev?.file?.derivatives?.thumb?.storagePath,
    getDot(ev, "file.thumbPath"),
    ev?.file?.thumbPath
  );

  const previewPath = pickStr(
    getDot(ev, "file.derivatives.preview.storagePath"),
    ev?.file?.derivatives?.preview?.storagePath,
    getDot(ev, "file.previewPath"),
    ev?.file?.previewPath,
    getDot(ev, "file.convertedJpgPath"),
    ev?.file?.convertedJpgPath
  );

  const originalPath = pickStr(
    getDot(ev, "file.storagePath"),
    ev?.file?.storagePath,
    getDot(ev, "file.path"),
    ev?.file?.path,
    getDot(ev, "storagePath"),
    ev?.storagePath
  );

  return { bucket, thumbnailPath, thumbPath, previewPath, originalPath };
}

export function getBestEvidenceTileRef(ev: any): EvidenceImageRef | null {
  const { bucket, thumbnailPath, thumbPath, previewPath, originalPath } = _pickEvidenceMedia(ev);
  const chosenPath = thumbnailPath || thumbPath || previewPath || originalPath;

  if (!bucket || !chosenPath) {
    logThumbEvent("ref_missing_tile", {
      id: String(ev?.id || ev?.evidenceId || ""),
      bucket,
      chosenPath,
    });
    return null;
  }

  const kind: EvidenceImageRefKind =
    thumbnailPath ? "thumbnailPath" :
    thumbPath ? "thumbPath" :
    previewPath ? "previewPath" :
    "original";

  return { kind, bucket, storagePath: chosenPath };
}

export function getBestEvidencePreviewRef(ev: any): EvidenceImageRef | null {
  const { bucket, previewPath, originalPath } = _pickEvidenceMedia(ev);
  const chosenPath = previewPath || originalPath;

  if (!bucket || !chosenPath) {
    logThumbEvent("ref_missing_preview", {
      id: String(ev?.id || ev?.evidenceId || ""),
      bucket,
      chosenPath,
    });
    return null;
  }

  const kind: EvidenceImageRefKind =
    previewPath ? "previewPath" : "original";

  return { kind, bucket, storagePath: chosenPath };
}

export function getBestEvidenceImageRef(ev: any): EvidenceImageRef | null {
  return getBestEvidenceTileRef(ev);
}

export async function mintEvidenceReadUrl(
  input: MintInput,
  headers?: Record<string, string>
): Promise<MintResult> {
  // ✅ cache key must only use in-scope values
  const expiresSec = Number(input.expiresSec || getThumbExpiresSec());
  const cacheKey = [input.orgId, input.incidentId, input.bucket, input.storagePath, String(expiresSec)].join("::");

  const hit = __PEAKOPS_MINT_CACHE[cacheKey];
  if (hit && (Date.now() - hit.at) < __PEAKOPS_MINT_TTL_MS) {
    return { ok: true, url: hit.url, status: 200, mintHttp: 200, mintError: "cache_hit" };
  }

  try {
    const body = {
      orgId: input.orgId,
      incidentId: input.incidentId,
      bucket: input.bucket,
      storagePath: input.storagePath,
      expiresSec,
    };

    const res = await fetch("/api/fn/createEvidenceReadUrlV1", {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers || {}) },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const txt = await res.text().catch(() => "");
    let out: any = {};
    try {
      out = txt ? JSON.parse(txt) : {};
    } catch {
      return {
        ok: false,
        error: "upstream_non_json",
        status: res.status,
        details: { raw: txt.slice(0, 300) },
        mintHttp: res.status,
        mintError: "upstream_non_json",
      };
    }

    const mintedUrl = String(out?.url || "").trim();
    if (!res.ok || out?.ok !== true || !mintedUrl) {
      return {
        ok: false,
        error: String(out?.error || "read_url_failed"),
        status: res.status,
        details: out?.details ?? out,
        mintHttp: res.status,
        mintError: String(out?.error || "read_url_failed"),
      };
    }

    // cache-bust to avoid stale image cache
    const sep = mintedUrl.includes("?") ? "&" : "?";
    const finalUrl = `${mintedUrl}${sep}v=${Date.now()}`;

    __PEAKOPS_MINT_CACHE[cacheKey] = { url: finalUrl, at: Date.now() };

    return {
      ok: true,
      url: finalUrl,
      status: res.status,
      details: out?.details ?? null,
      mintHttp: res.status,
      mintError: "",
    };
  } catch (e: any) {
    return { ok: false, error: "network_or_parse_error", status: 0, details: String(e?.message || e), mintHttp: 0, mintError: "network_or_parse_error" };
  }
}

export async function probeMintedThumbUrl(
  url: string
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(url, { method: "GET" });
    return { ok: res.ok, status: res.status, error: res.ok ? undefined : `http_${res.status}` };
  } catch (e: any) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

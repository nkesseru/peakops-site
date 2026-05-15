"use client";

import { authedFetch } from "@/lib/apiClient";

export type EvidenceImageRefKind = "thumbnailPath" | "thumbPath" | "previewPath" | "original";

export type EvidenceImageRef = {
  kind: EvidenceImageRefKind;
  bucket: string;
  storagePath: string;
};

type MintInput = {
  orgId: string;
  incidentId: string;
  // Optional; ignored inside mintEvidenceReadUrl but passed by every
  // call site in IncidentClient.tsx. Declared here so TypeScript's
  // excess-property check doesn't reject the call.
  evidenceId?: string;
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

    // PEAKOPS_MINT_AUTH_V1 (2026-05-15)
    // The mint endpoint is a PeakOps API call gated by Cloud Function
    // auth — wrap in authedFetch so it carries a Firebase ID token.
    // The resulting signed GCS URL is fetched separately (see
    // probeMintedThumbUrl below) WITHOUT authedFetch, because adding
    // an Authorization header to a signed URL voids the signature.
    const res = await authedFetch("/api/fn/createEvidenceReadUrlV1", {
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

    // PEAKOPS_NO_POST_SIGN_CACHEBUST_V1 (2026-05-15)
    // Do NOT append a cache-busting query param here. GCS V4 signed
    // URLs include every query parameter in the canonicalized signing
    // string; appending `&v=...` after signing makes GCS compute a
    // different signature than the one in the URL → SignatureDoesNotMatch.
    // The in-memory mint cache above (30s TTL) already dedupes
    // back-to-back mints, and the signed URL itself carries
    // `X-Goog-Expires` so the URL changes naturally each TTL window.
    const finalUrl = mintedUrl;

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

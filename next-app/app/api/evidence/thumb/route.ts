export const runtime = "nodejs";

type ReadUrlResult = {
  ok: boolean;
  error?: string;
  details?: any;
  url?: string;
  readRespStatus: number;
  readRespText: string;
  readRespJson: any;
};

function extensionContentType(storagePath: string): string {
  const p = String(storagePath || "").toLowerCase();
  if (p.endsWith(".png")) return "image/png";
  if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
  if (p.endsWith(".webp")) return "image/webp";
  if (p.endsWith(".gif")) return "image/gif";
  return "";
}

function inferContentType(storagePath: string, upstreamCt: string): string {
  const extType = extensionContentType(storagePath);
  const ct = String(upstreamCt || "").trim();
  const lower = ct.toLowerCase();
  if (lower.startsWith("image/")) return ct;
  if (extType) return extType;
  if (ct) return ct;
  return "application/octet-stream";
}

function detectMagic(
  bytes: Uint8Array,
  storagePath: string,
  contentType: string
): { ok: boolean; expected?: string; got?: string } {
  const extType = extensionContentType(storagePath);
  const lowerCt = String(contentType || "").toLowerCase();
  const isPng = extType === "image/png" || lowerCt.includes("image/png");
  const isJpg = extType === "image/jpeg" || lowerCt.includes("image/jpeg") || lowerCt.includes("image/jpg");
  const isWebp = extType === "image/webp" || lowerCt.includes("image/webp");

  if (isPng) {
    const expected = "89504e470d0a1a0a";
    const got = Buffer.from(bytes.slice(0, 8)).toString("hex");
    return { ok: got.toLowerCase() === expected, expected, got };
  }
  if (isJpg) {
    const expected = "ffd8ff";
    const got = Buffer.from(bytes.slice(0, 3)).toString("hex");
    return { ok: got.toLowerCase() === expected, expected, got };
  }
  if (isWebp) {
    const riff = Buffer.from(bytes.slice(0, 4)).toString("hex");
    const webp = Buffer.from(bytes.slice(8, 12)).toString("hex");
    const got = `${riff}:${webp}`;
    const expected = "52494646:57454250";
    return { ok: riff.toLowerCase() === "52494646" && webp.toLowerCase() === "57454250", expected, got };
  }
  return { ok: true };
}

async function getReadUrl(input: {
  origin: string;
  orgId: string;
  incidentId: string;
  bucket: string;
  storagePath: string;
}): Promise<ReadUrlResult> {
  const { origin, orgId, incidentId, bucket, storagePath } = input;
  let readResp: Response;
  try {
    readResp = await fetch(`${origin}/api/fn/createEvidenceReadUrlV1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId, incidentId, bucket, storagePath, expiresSec: 600 }),
      cache: "no-store",
    });
  } catch (e: any) {
    return {
      ok: false,
      error: "read_url_proxy_fetch_failed",
      details: { message: String(e?.message || e) },
      readRespStatus: 500,
      readRespText: "",
      readRespJson: {},
    };
  }

  let readRespText = "";
  let readRespJson: any = {};
  try {
    readRespText = await readResp.text();
    readRespJson = readRespText ? JSON.parse(readRespText) : {};
  } catch {
    readRespJson = { ok: false, error: readRespText || "invalid_read_url_response" };
  }

  if (!readResp.ok || !readRespJson?.ok || !readRespJson?.url) {
    return {
      ok: false,
      error: readRespJson?.error || "read_url_failed",
      details: readRespJson?.details || null,
      readRespStatus: readResp.status || 500,
      readRespText,
      readRespJson,
    };
  }

  return {
    ok: true,
    url: String(readRespJson.url),
    readRespStatus: readResp.status,
    readRespText,
    readRespJson,
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgId = String(url.searchParams.get("orgId") || "").trim();
  const incidentId = String(url.searchParams.get("incidentId") || "").trim();
  const bucket = String(url.searchParams.get("bucket") || "").trim();
  const storagePath = String(url.searchParams.get("storagePath") || "").trim();
  const kind = String(url.searchParams.get("kind") || "original").trim();
  const debug = String(url.searchParams.get("debug") || "") === "1";

  if (!orgId || !incidentId || !bucket || !storagePath) {
    return Response.json(
      { ok: false, error: "missing_params", details: { orgId, incidentId, bucket, storagePath, kind } },
      { status: 400 }
    );
  }

  const readUrl = await getReadUrl({
    origin: url.origin,
    orgId,
    incidentId,
    bucket,
    storagePath,
  });

  if (!readUrl.ok || !readUrl.url) {
    return Response.json(
      {
        ok: false,
        error: readUrl.error || "read_url_failed",
        kind,
        bucket,
        storagePath,
        details: readUrl.details || null,
        upstreamReadUrl: {
          status: readUrl.readRespStatus,
          body: readUrl.readRespText || null,
        },
      },
      { status: readUrl.readRespStatus || 500 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(readUrl.url, { method: "GET", cache: "no-store", redirect: "follow" });
  } catch (e: any) {
    return Response.json(
      {
        ok: false,
        error: "upstream_fetch_failed",
        kind,
        bucket,
        storagePath,
        details: { message: String(e?.message || e) },
      },
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    let upstreamBody = "";
    try {
      upstreamBody = await upstream.text();
    } catch {}
    return Response.json(
      {
        ok: false,
        error: "upstream_non_2xx",
        status: upstream.status,
        kind,
        bucket,
        storagePath,
        upstreamReadUrl: {
          status: readUrl.readRespStatus,
          body: readUrl.readRespText || null,
        },
        upstreamFetch: {
          status: upstream.status,
          body: upstreamBody || null,
        },
        first32:
          process.env.NODE_ENV !== "production" && upstreamBody
            ? Buffer.from(upstreamBody).subarray(0, 32).toString("hex")
            : undefined,
      },
      { status: upstream.status || 502 }
    );
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  const upstreamCt = String(upstream.headers.get("content-type") || "").trim();
  const contentType = inferContentType(storagePath, upstreamCt);
  const magic = detectMagic(new Uint8Array(buf), storagePath, contentType);

  if (!magic.ok) {
    const out: any = {
      ok: false,
      error: "bad_image_bytes",
      kind,
      bucket,
      storagePath,
      ct: contentType,
      size: buf.byteLength,
      magic: { expected: magic.expected, got: magic.got },
      upstreamReadUrl: {
        status: readUrl.readRespStatus,
        body: readUrl.readRespText || null,
      },
      upstreamFetch: { status: upstream.status },
    };
    if (process.env.NODE_ENV !== "production") {
      out.first32 = buf.subarray(0, 32).toString("hex");
    }
    return Response.json(out, { status: 502 });
  }

  if (debug) {
    return Response.json(
      {
        ok: true,
        kind,
        bucket,
        storagePath,
        ct: contentType,
        size: buf.byteLength,
        magic: { expected: magic.expected || null, got: magic.got || null },
        upstreamReadUrl: {
          status: readUrl.readRespStatus,
          body: readUrl.readRespText || null,
        },
        upstreamFetch: { status: upstream.status },
      },
      { status: 200 }
    );
  }

  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("cache-control", "private, max-age=300");
  headers.set("content-length", String(buf.byteLength));
  headers.set("x-peakops-thumbproxy", "ok");
  headers.set("x-peakops-thumbct", contentType);
  headers.set("x-peakops-thumbsize", String(buf.byteLength));
  return new Response(buf, { status: 200, headers });
}

export async function HEAD(req: Request) {
  const url = new URL(req.url);
  const orgId = String(url.searchParams.get("orgId") || "").trim();
  const incidentId = String(url.searchParams.get("incidentId") || "").trim();
  const bucket = String(url.searchParams.get("bucket") || "").trim();
  const storagePath = String(url.searchParams.get("storagePath") || "").trim();

  if (!orgId || !incidentId || !bucket || !storagePath) {
    return new Response(null, { status: 400, headers: { "x-peakops-thumbproxy": "head" } });
  }

  const readUrl = await getReadUrl({
    origin: url.origin,
    orgId,
    incidentId,
    bucket,
    storagePath,
  });

  if (!readUrl.ok || !readUrl.url) {
    return new Response(null, {
      status: readUrl.readRespStatus || 500,
      headers: {
        "x-peakops-thumbproxy": "head",
        "x-peakops-thumb-error": String(readUrl.error || "read_url_failed"),
      },
    });
  }

  let upstream: Response;
  try {
    upstream = await fetch(readUrl.url, { method: "HEAD", cache: "no-store", redirect: "follow" });
  } catch {
    return new Response(null, {
      status: 502,
      headers: {
        "x-peakops-thumbproxy": "head",
        "x-peakops-thumb-error": "upstream_fetch_failed",
      },
    });
  }

  const headers = new Headers();
  const ct = String(upstream.headers.get("content-type") || inferContentType(storagePath, ""));
  headers.set("content-type", ct || "application/octet-stream");
  const cl = upstream.headers.get("content-length");
  if (cl) headers.set("content-length", cl);
  headers.set("cache-control", "private, max-age=300");
  headers.set("x-peakops-thumbproxy", "head");
  headers.set("x-peakops-thumbct", headers.get("content-type") || "application/octet-stream");
  return new Response(null, { status: upstream.status, headers });
}

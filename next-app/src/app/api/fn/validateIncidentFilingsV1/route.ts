import { proxyGET } from "../_lib/fnProxy";

export const runtime = "nodejs";

/**
 * validateIncidentFilingsV1 (UI helper)
 * - Loads incident bundle (filings)
 * - Validates DIRS + OE_417 payloads
 * - Returns compact JSON suitable for UI
 *
 * NOTE: This route does NOT call Firebase directly.
 * It calls your existing Next fn routes so it works in emulator/prod equally.
 */
function isIso(s: any) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}

function validateDirs(p: any) {
  const errs: string[] = [];
  if ((p?.filingType || "") !== "DIRS") errs.push("filingType must be 'DIRS'");
  if (typeof p?.incidentId !== "string" || !p.incidentId) errs.push("incidentId required (string)");
  if (typeof p?.orgId !== "string" || !p.orgId) errs.push("orgId required (string)");
  if (!isIso(p?.startTime)) errs.push("startTime required (ISO string)");

  const ot = String(p?.outageType || "");
  const allowed = new Set(["WIRELINE","WIRELESS","BROADBAND","OTHER"]);
  if (!allowed.has(ot)) errs.push("outageType required (WIRELINE/WIRELESS/BROADBAND/OTHER)");

  const nar = String(p?.narrative || "");
  if (nar.trim().length < 10) errs.push("narrative required (>=10 chars)");

  const ac = p?.affectedCount;
  if (typeof ac !== "number" || ac < 0) errs.push("affectedCount required (number >=0)");

  if (typeof p?.location !== "object" || !p.location) errs.push("location required (object)");
  return errs;
}

function validateOE417(p: any) {
  const errs: string[] = [];
  if ((p?.filingType || "") !== "OE_417") errs.push("filingType must be 'OE_417'");
  if (typeof p?.incidentId !== "string" || !p.incidentId) errs.push("incidentId required (string)");
  if (typeof p?.orgId !== "string" || !p.orgId) errs.push("orgId required (string)");
  if (!isIso(p?.startTime)) errs.push("startTime required (ISO string)");

  const et = String(p?.eventType || "");
  if (!et) errs.push("eventType required (string)");

  const imp = String(p?.impact || "");
  const allowed = new Set(["PARTIAL_SERVICE","TOTAL_OUTAGE","DEGRADED","OTHER"]);
  if (!allowed.has(imp)) errs.push("impact required (PARTIAL_SERVICE/TOTAL_OUTAGE/DEGRADED/OTHER)");

  const nar = String(p?.narrative || "");
  if (nar.trim().length < 10) errs.push("narrative required (>=10 chars)");

  return errs;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const orgId = url.searchParams.get("orgId") || "org_001";
  const incidentId = url.searchParams.get("incidentId") || "";

  if (!incidentId) {
    return new Response(JSON.stringify({ ok: false, error: "Missing incidentId" }), { status: 400 });
  }

  // pull incident bundle via Next fn route (works in emulator/prod)
  const origin = url.origin;
  const bUrl = `${origin}/api/fn/getIncidentBundleV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
  const bRes = await fetch(bUrl);
  const bTxt = await bRes.text();

  let bundle: any = null;
  try { bundle = JSON.parse(bTxt); } catch {}

  const filings = Array.isArray(bundle?.filings) ? bundle.filings : [];
  const pickType = (d: any) => String(d?.type || d?.filingType || "").toUpperCase();
  const byType: Record<string, any> = {};
  for (const f of filings) byType[pickType(f)] = f;

  const dirsPayload = byType["DIRS"]?.payload || byType["DIRS"] || {};
  const oePayload = byType["OE_417"]?.payload || byType["OE_417"] || {};

  const dirsErrs = validateDirs(dirsPayload);
  const oeErrs = validateOE417(oePayload);

  const out = {
    ok: dirsErrs.length === 0 && oeErrs.length === 0,
    orgId,
    incidentId,
    generatedAt: new Date().toISOString(),
    results: {
      DIRS: { valid: dirsErrs.length === 0, errors: dirsErrs },
      OE_417: { valid: oeErrs.length === 0, errors: oeErrs },
    }
  };

  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

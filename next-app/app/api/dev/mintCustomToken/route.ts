// PEAKOPS_DEV_MINT_CUSTOM_TOKEN_V1 (2026-05-06)
//
// Phase 1 Slice 10: dev-only endpoint that issues an EMULATOR-ONLY
// custom token for an arbitrary uid. Used by /dev/login to sign
// the browser into a uid that matches a seeded demo-org member doc
// (dev-admin, supe_smoke, etc.).
//
// CRITICAL SAFETY DESIGN: the issued token is intentionally an
// `alg: "none"` JWT. Firebase's Auth Emulator accepts these for
// signInWithCustomToken because emulators don't require real
// signatures. Production Firebase Auth REJECTS them — the real
// Identity Toolkit validates that the token is signed by a
// configured Firebase service account. Concretely: a token issued
// here cannot be exchanged for a session against production Auth
// even if it leaks. That is the entire reason this route does NOT
// call firebase-admin's createCustomToken (which would sign with
// the prod service-account key whenever applicationDefault loads
// production credentials).
//
// Hard guards:
//   1. Returns 404 in production unless the request is explicitly
//      `?dev=1` AND NODE_ENV is not "production". (We never serve
//      this in real production, full stop.)
//   2. Refuses to mint unless FIREBASE_AUTH_EMULATOR_HOST or
//      FIRESTORE_EMULATOR_HOST is set in the server env. That's
//      the marker that this Node process is in emulator mode.
//      Together with the hardened firebaseAdmin.ts (Slice 10),
//      production credentials are not even loaded in this mode.
//   3. Restricts the requested uid to a hardcoded allow-list of
//      demo seed uids. Custom tokens for arbitrary uids are not a
//      capability anyone should have outside emulator-only flows.
//
// Run with FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 and the local
// Auth Emulator listening on that port.

import { NextResponse } from "next/server";

export const runtime = "nodejs";

const ALLOWED_DEMO_UIDS: ReadonlySet<string> = new Set([
  "dev-admin",
  "tech_web",
  "supe_smoke",
  "field_smoke",
  "viewer_smoke",
]);

function devGateOpen(req: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  try {
    const url = new URL(req.url);
    return url.searchParams.get("dev") === "1";
  } catch {
    return false;
  }
}

function emulatorEnvActive(): boolean {
  return Boolean(
    String(process.env.FIREBASE_AUTH_EMULATOR_HOST || "").trim() ||
      String(process.env.FIRESTORE_EMULATOR_HOST || "").trim(),
  );
}

function roleForUid(uid: string): "admin" | "supervisor" | "field" | "viewer" {
  if (uid === "supe_smoke") return "supervisor";
  if (uid === "field_smoke") return "field";
  if (uid === "viewer_smoke") return "viewer";
  return "admin";
}

function b64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Mint an emulator-only Firebase custom token. The token uses
 * `alg: "none"` and carries no signature — production Firebase Auth
 * rejects it; the local Auth Emulator accepts it. This is the same
 * trick Slice 8's rules tests used to simulate authenticated
 * Firestore requests, applied here to client-side signInWithCustomToken.
 */
function mintEmulatorOnlyCustomToken(uid: string): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      // Standard custom-token audience the Identity Toolkit checks.
      aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
      // Issuer/subject deliberately not set to a real service
      // account — emulator only ever sees this token.
      iss: "peakops-dev-emulator",
      sub: "peakops-dev-emulator",
      iat: now,
      exp: now + 3600,
      uid,
      // Mirror the prod auth claim shape so the existing useAuth
      // hook and any orgIds-claim-aware consumers continue to work.
      // demo-org is the only org these uids belong to.
      claims: {
        orgIds: ["demo-org"],
        role: roleForUid(uid),
      },
    }),
  );
  // alg: "none" → empty signature segment, but the trailing dot is
  // required for a valid JWT serialization.
  return `${header}.${payload}.`;
}

export async function POST(req: Request): Promise<Response> {
  if (!devGateOpen(req)) {
    return new Response(null, { status: 404 });
  }
  if (!emulatorEnvActive()) {
    return NextResponse.json(
      {
        ok: false,
        error: "emulator_required",
        detail:
          "FIREBASE_AUTH_EMULATOR_HOST or FIRESTORE_EMULATOR_HOST must be set on the dev server.",
      },
      { status: 503 },
    );
  }

  let body: { uid?: string } = {};
  try {
    body = (await req.json()) as { uid?: string };
  } catch {
    return NextResponse.json(
      { ok: false, error: "bad_request", detail: "Body must be JSON" },
      { status: 400 },
    );
  }

  const uid = String(body.uid || "").trim();
  if (!uid) {
    return NextResponse.json(
      { ok: false, error: "uid_required" },
      { status: 400 },
    );
  }
  if (!ALLOWED_DEMO_UIDS.has(uid)) {
    return NextResponse.json(
      {
        ok: false,
        error: "uid_not_allowed",
        detail: `Only seeded demo uids are accepted. Allowed: ${Array.from(ALLOWED_DEMO_UIDS).join(", ")}`,
      },
      { status: 403 },
    );
  }

  try {
    const token = mintEmulatorOnlyCustomToken(uid);
    return NextResponse.json({ ok: true, uid, token, emulatorOnly: true });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "mint_failed",
        detail: String((e as Error)?.message || e),
      },
      { status: 500 },
    );
  }
}

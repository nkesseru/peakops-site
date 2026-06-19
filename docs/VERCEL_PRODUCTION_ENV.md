# Vercel Production Environment Variables

**Audience:** the engineer configuring `peakops-stormwatch` on Vercel
ahead of the Slice 17 internal alpha deploy.
**Status:** living document; reflects Slice 17B.
**Source slices:** 10, 11, 14, 15, 16, 17, 17B.
**Hosting target:** Vercel project `peakops-stormwatch`
(`team_RL6m2oM27LU5ATZbpy30axJB`), built from `next-app/`.
**Firebase target:** `peakops-pilot`.

This document is the single source of truth for the production env
shape. The Vercel dashboard is the runtime source of values, but the
NAMES and POLICY here are authoritative.

---

## Public (browser) variables

These are inlined into the client bundle at build time (Next.js
`NEXT_PUBLIC_*` convention). They are not secrets — anyone who loads
the app can read them. They MUST be set; missing values throw at
`firebaseClient.ts:56-58`.

| Variable | Production value (peakops-pilot) | Why |
|---|---|---|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | (peakops-pilot Web API key) | Firebase Web SDK init |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `peakops-pilot.firebaseapp.com` | Magic-link sign-in domain |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | `peakops-pilot` | Browser SDK project id |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | `peakops-pilot.firebasestorage.app` | Slice 15 canonical bucket family |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | (peakops-pilot value) | FCM, currently unused but set for parity |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | (peakops-pilot Web App ID) | Firebase Web SDK init |
| `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` | (Analytics property; optional) | Analytics; safe to omit |
| `NEXT_PUBLIC_PEAKOPS_FN_BASE` | `https://us-central1-peakops-pilot.cloudfunctions.net` | Used by `app/api/fn/[...path]/route.ts:5` to forward proxied calls to the deployed Cloud Functions. **Without this, `/api/fn/*` falls back to `127.0.0.1:5004` and 502s in production.** |

Public variables that MUST be **unset / absent** in Production
(setting them flips the browser bundle to emulator mode):

| Variable | Why this would break production |
|---|---|
| `NEXT_PUBLIC_USE_FIREBASE_EMULATORS` | Enables `connectAuthEmulator` / `connectFirestoreEmulator` / `connectStorageEmulator` calls on every page load. Browser would attempt 127.0.0.1:9099/8087/9199 connections. |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID_EMULATOR` | Slice 10.1 override; flips browser SDK to `peakops-demo`. |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET_EMULATOR` | Same, for storage bucket. |
| `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` / `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST` / `NEXT_PUBLIC_FIREBASE_STORAGE_EMULATOR_HOST` | Override default emulator hosts. |
| `NEXT_PUBLIC_FUNCTIONS_BASE` | Dev override for `127.0.0.1:5004`. Production uses `NEXT_PUBLIC_PEAKOPS_FN_BASE`. |

---

## Server (Vercel-only) variables

These are NOT exposed to the browser. They run in Next.js API routes
and Server Components only.

### Canonical production credential

| Variable | Value shape | Sensitivity |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Entire service-account JSON, pasted verbatim (one Vercel env var, not three). | **Sensitive** — mark in Vercel UI. |

Read by `next-app/lib/firebaseAdmin.ts:loadServiceAccountFromEnv()`.
Behavior:

1. If `FIREBASE_SERVICE_ACCOUNT_JSON` is present, parse the JSON,
   pull `project_id`, `client_email`, `private_key`, normalize
   `\n` escaping inside `private_key`, validate the PEM header,
   and initialize firebase-admin via `cert(...)`.
2. If absent, fall back to `applicationDefault()` (the previous
   behavior — safe for any environment that already wires ADC via
   `GOOGLE_APPLICATION_CREDENTIALS` file path or `FIREBASE_CONFIG`).
3. If parsing fails or required fields are missing, throw a named
   error (no secret bytes echoed). Possible failure messages:
   - `FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON`
   - `FIREBASE_SERVICE_ACCOUNT_JSON parsed to a non-object`
   - `FIREBASE_SERVICE_ACCOUNT_JSON missing project_id`
   - `FIREBASE_SERVICE_ACCOUNT_JSON missing client_email`
   - `FIREBASE_SERVICE_ACCOUNT_JSON missing private_key`
   - `FIREBASE_SERVICE_ACCOUNT_JSON private_key missing PEM header`

How to set it on Vercel:

1. Open https://vercel.com/<team>/peakops-stormwatch/settings/environment-variables.
2. Click "Add New".
3. Name: `FIREBASE_SERVICE_ACCOUNT_JSON`. Environment: **Production**
   only (do NOT add to Preview or Development unless you want
   preview deployments authenticated against `peakops-pilot`).
4. Value: paste the entire JSON contents of the
   `peakops-pilot` service-account key file. Do not transform the
   contents — pasting the raw JSON works. The runtime parser handles
   the `\n` -> `\n` round-trip if Vercel re-escapes.
5. Toggle "Sensitive" so the value cannot be read back from the
   dashboard or build logs.
6. Save. Trigger a fresh production deployment for the new env to
   take effect (Vercel's runtime env is read on cold start; an
   existing warm deployment will not pick up the change until it
   recycles).

After the first successful deploy, verify by:

- The deploy succeeds with no `[firebaseAdmin]` errors in the build
  or function logs.
- `/api/fn/listIncidentsV1?orgId=<owner-orgId>` returns 200 (which
  proves the bearer token verification path is initialized).
- The Cloud Functions logs show `authz_ok` lines for the proxied
  callable (proves the upstream path is also healthy).

### Legacy variables — DO NOT delete yet

These may currently be set on Vercel from earlier deployments. They
are NOT read by the active `next-app/` code path:

| Variable | Status |
|---|---|
| `FIREBASE_PRIVATE_KEY` | Not read by next-app. Likely dead config from an earlier Pages-router setup. **Do not delete until Slice 17 production smoke confirms the new credential path works.** |
| `FIREBASE_CLIENT_EMAIL` | Same. |
| `FIREBASE_PROJECT_ID` (server-side, not the public version) | Same. |
| `FIREBASE_SA_JSON_BASE64` | Not read by next-app. The Slice 17B parser only honors `FIREBASE_SERVICE_ACCOUNT_JSON`. If you have base64-encoded vars set, they're inert. |
| `GOOGLE_APPLICATION_CREDENTIALS` | If set to a file path, `applicationDefault()` will use it as a fallback. Leave alone until verified. |

The Slice 16 audit produced an exact retirement plan; see Slice 16
final report § 7 ("Vercel env cleanup plan"). Summary: do not touch
legacy vars until production has been running cleanly with
`FIREBASE_SERVICE_ACCOUNT_JSON` for ≥24h.

### Other server vars

| Variable | Production value | Why |
|---|---|---|
| `FUNCTIONS_BASE` | `https://us-central1-peakops-pilot.cloudfunctions.net` | Server-side companion of the public `NEXT_PUBLIC_PEAKOPS_FN_BASE`. |

Server vars that MUST be **unset / absent**:

| Variable | Why |
|---|---|
| `FIREBASE_AUTH_EMULATOR_HOST` | Setting this triggers `firebaseAdmin.ts` line 96 to skip credential loading entirely (emulator mode). Production token verification fails. |
| `FIRESTORE_EMULATOR_HOST` | Same. |
| `FIREBASE_STORAGE_EMULATOR_HOST` | Same. |
| `GCLOUD_PROJECT=peakops-demo` | If carried over from a dev shell, would override projectId to the demo namespace. Leave unset and let credentials supply the projectId. |
| Any value containing `127.0.0.1` | Indicates a leaked emulator URL. |
| Any value containing `peakops-demo` | Indicates the local emulator project name leaked into prod env. |

---

## Verification checklist (run before any production deploy)

For the operator with Vercel dashboard access:

- [ ] Production tab lists all variables with names matching the
      "Public (browser) variables" table above. Required public vars
      present; emulator-only public vars absent.
- [ ] `FIREBASE_SERVICE_ACCOUNT_JSON` is present in Production with
      Sensitive toggled.
- [ ] No `*EMULATOR*` variant appears in Production.
- [ ] No value contains `peakops-demo`.
- [ ] No value contains `127.0.0.1`.
- [ ] Legacy `FIREBASE_PRIVATE_KEY` / `FIREBASE_CLIENT_EMAIL` /
      `FIREBASE_PROJECT_ID` may still be present — that is fine for
      now. Do NOT delete them in this slice.
- [ ] If `GOOGLE_APPLICATION_CREDENTIALS` is set, the file it points
      at exists in the Vercel build output — otherwise unset it.

The full pre-deploy checklist lives in
`docs/INTERNAL_ALPHA_DEPLOY_CHECKLIST.md` § 1; this document is the
focused server-credential subset.

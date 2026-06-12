# Local Emulator Auth Runbook

**Audience:** anyone driving Chrome QA against the local Firebase emulator
suite under the Phase 1 Slice 8 default-deny Firestore rules.
**Status:** living document; reflects Slices 4 – 15.

## Storage bucket conventions

- **Production canonical**: `${projectId}.firebasestorage.app`
  (e.g. `peakops-pilot.firebasestorage.app`). All upload paths land
  here after Slice 15 (`uploadEvidenceProxyV1.js`).
- **Read fallback**: `createEvidenceReadUrlV1.js` walks both
  `firebasestorage.app` and `appspot.com` candidates. Historical
  objects uploaded to the legacy `appspot.com` family before Slice 15
  remain readable.
- **Emulator parity**: the local emulator's Storage REST shape
  predates the `firebasestorage.app` family and tends to address
  objects under the legacy `appspot.com` name. The
  `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET_EMULATOR` override stays at
  `peakops-demo.appspot.com` for that reason — it's an emulator
  quirk, not a misalignment.

The Slice 8 rules require that the signed-in browser uid have an active
member doc at `orgs/{orgId}/members/{uid}`. Production Firebase Auth uids
will never match a seeded uid in the local emulator. This runbook walks
through the dev-flow that closes that gap.

---

## Why this exists

After Slice 8:
- Direct client reads of `orgs/{orgId}/...`, `incidents/...`, etc. require
  `signedIn() && isActiveMember(orgId)`.
- Direct client writes are denied for everything except `users/{uid}/...`,
  member admin, vendor admin, and a narrow onboarding paths.
- Lifecycle writes route through `_authz.js`-gated callables.

The browser dev flow needs:
- A signed-in Firebase Auth uid that matches a seeded member doc.
- A way to sign in WITHOUT touching production Firebase Auth.
- A way to talk to a Firestore that has the seed.

Slice 10 + 10.1 wire this up:
- Auth Emulator on port 9099.
- `connectAuthEmulator` / `connectFirestoreEmulator` /
  `connectStorageEmulator` opt-in from `firebaseClient.ts`.
- `peakops-demo` as the local emulator project, overriding the production
  `peakops-pilot` project id when emulator mode is on.
- `/dev/login` page that issues an emulator-only unsigned JWT and signs
  the browser in as one of five seeded actors.

---

## Prerequisites

Verify in `next-app/.env.local`:

```
NEXT_PUBLIC_USE_FIREBASE_EMULATORS=1
NEXT_PUBLIC_FIREBASE_PROJECT_ID_EMULATOR=peakops-demo
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET_EMULATOR=peakops-demo.appspot.com
NEXT_PUBLIC_FUNCTIONS_BASE=http://127.0.0.1:5004/peakops-demo/us-central1
FUNCTIONS_BASE=http://127.0.0.1:5004/peakops-demo/us-central1
GCLOUD_PROJECT=peakops-demo
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
FIRESTORE_EMULATOR_HOST=127.0.0.1:8087
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199
```

Production-pilot fields (`NEXT_PUBLIC_FIREBASE_API_KEY`,
`NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, etc.) stay as-is — they remain the
fallback for non-emulator builds.

---

## Step 1 — Stop any running emulator that lacks Auth

If a Firebase emulator is already running but was started without `auth`,
stop it. The new `firebase.json` lists Auth on port 9099, so a fresh
`emulators:start` will bring it up.

```bash
# Identify the running emulator hub
lsof -tiTCP:5004 -sTCP:LISTEN
# Kill the process group (the PID printed above)
kill <pid>
```

The emulator's in-memory state goes away. Next steps re-seed.

---

## Step 2 — Start the emulator suite with Auth + project = peakops-demo

```bash
cd /Users/kesserumini/peakops/my-app
firebase emulators:start --project peakops-demo --only functions,firestore,storage,auth
```

Expected ports:
- Auth        127.0.0.1:9099
- Firestore   127.0.0.1:8087
- Storage     127.0.0.1:9199
- Functions   127.0.0.1:5004

Look for `✔  All emulators ready!` in the output.

---

## Step 3 — Seed demo memberships

Two seeders, both dry-run by default. Run each with `--apply`.

```bash
cd next-app
FIRESTORE_EMULATOR_HOST=127.0.0.1:8087 \
FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199 \
GOOGLE_APPLICATION_CREDENTIALS="" \
  npx tsx scripts/seedDemoMembership.ts --apply

FIRESTORE_EMULATOR_HOST=127.0.0.1:8087 \
GOOGLE_APPLICATION_CREDENTIALS="" \
  npx tsx scripts/seedDemoRoleMembers.ts --apply
```

After both runs, `orgs/demo-org/members/` should contain five docs,
each with `status: "active"`. The first script writes `dev-admin` and
`tech_web` (both admin); the second adds `supe_smoke` (supervisor),
`field_smoke` (field), `viewer_smoke` (viewer).

### Step 3.5 — Seed canonical lifecycle fixtures

Three demo incidents that browser QA exercises across the lifecycle:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8087 \
GOOGLE_APPLICATION_CREDENTIALS="" \
  npx tsx scripts/seedDemoLifecycleFixtures.ts --apply
```

This writes:

- `inc_20260429_064006_ming4g` — Field Job approved/ready-to-close
- `inc_20260429_071222_n3ss11` — Supervisor Review (closed)
- `inc_20260429_080946_qcetdv` — Summary awaiting-supervisor-approval

Each fixture seeds the top-level `incidents/{id}` doc, the per-org
mirror at `orgs/demo-org/incidents/{id}`, one `jobs/{jobId}` child
with the state appropriate to the phase, and a minimal timeline
trail. Photos are deliberately not seeded (real Storage objects are
heavier than this slice's scope); the photo rail will render as
"no photos yet" rather than "Unavailable" overlays.

Pass `--force` to overwrite an existing fixture instead of skipping.

The seed scripts auto-detect emulator mode whenever any of
`FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`, or
`FIREBASE_STORAGE_EMULATOR_HOST` is set — production firebase-admin
never carries those vars, so the safety check trusts them. You no
longer need to set `GCLOUD_PROJECT` inline (Slice 11). If you do,
the script still respects it; just unnecessary.

`GOOGLE_APPLICATION_CREDENTIALS=""` blanks any stray gcloud creds
from your shell, ensuring firebase-admin can't accidentally try to
authenticate against real Firebase. The emulator-host vars route
all writes to the local emulator regardless.

---

## Step 4 — Restart the Next.js dev server

The dev server picks up `.env.local` on save in modern Next.js, but the
`firebaseClient.ts` initialization runs once at module import. To be safe:

```bash
# Identify the running dev server (port 3001)
lsof -tiTCP:3001 -sTCP:LISTEN
kill <pid>

cd next-app
pnpm run dev:local
```

In the dev console you should see:

```
[firebaseClient] connected to local emulators {
  projectId: 'peakops-demo',
  auth: '127.0.0.1:9099',
  firestore: '127.0.0.1:8087',
  storage: '127.0.0.1:9199',
}
```

If `projectId` shows `peakops-pilot`, the `_EMULATOR` env vars aren't
loading — re-check `.env.local` and that the dev server actually
restarted.

---

## Step 5 — Sign in via /dev/login

Open `http://127.0.0.1:3001/dev/login`.

Page should display:
- Eyebrow: `Dev only · emulator`
- Project chip: `project: peakops-demo` (green)
- Five buttons (dev-admin / tech_web / supe_smoke / field_smoke / viewer_smoke)

Click `Dev Admin (admin)` to sign in as the highest-privilege actor.
Behind the scenes:
1. POST `/api/dev/mintCustomToken {"uid":"dev-admin"}` returns an
   `alg: "none"` JWT.
2. The client calls `signInWithCustomToken(auth, token)` against the
   Auth Emulator (which accepts unsigned tokens).
3. `auth.currentUser.uid` becomes `dev-admin`.
4. The page routes to `/incidents?orgId=demo-org`.

If you see `permission-denied` errors after this, the most likely cause
is a missing member doc — re-run Step 3.

---

## Step 6 — Walk the lifecycle UI

With a signed-in member, the Slice 8 rules permit reads. Open in order:

- `/incidents?orgId=demo-org` — Mission Control list
- click any incident → loads `IncidentClient.tsx`
- Field tab → `/incidents/{id}/field`
- Review tab → `/incidents/{id}/review`
- Summary tab → `/incidents/{id}/summary`
- `/settings/vendors?orgId=demo-org` — vendor admin
- `/settings/team?orgId=demo-org` — member admin

For each, expected behavior:
- Reads succeed (rules allow active member).
- Direct writes (vendor/member admin pages) succeed for owner/admin only.
- Lifecycle writes route through callables — already authz-gated.

To switch role without losing context: click the role pill on /dev/login
again (e.g., sign in as `viewer_smoke` to verify viewer is read-only,
then back to `dev-admin`).

---

## Step 7 — Verify a callable

Quick spot-check that authz still composes correctly. With `dev-admin`
signed in, open the browser console and run:

```js
// Active vendor must already be seeded.
fetch("/api/fn/assignVendorToJobV1", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    orgId: "demo-org",
    incidentId: "<a real incidentId from Mission Control>",
    jobId: "<a real jobId>",
    vendorId: "v_smoke_active",
    actorUid: "dev-admin",
  }),
}).then((r) => r.json()).then(console.log);
```

Expected: `{ ok: true, vendorId: "v_smoke_active", vendorName: "Smoke Vendor Active" }`.

Sign out and sign in as `viewer_smoke`, repeat. Expected: 403
`permission-denied`. The callable's `_authz.js` gate (Slice 9) does the
denial; this verifies the gate fires correctly when the browser uid
maps to the seeded role.

---

## Tear-down

```bash
kill $(lsof -tiTCP:5004 -sTCP:LISTEN) 2>/dev/null   # emulator
kill $(lsof -tiTCP:3001 -sTCP:LISTEN) 2>/dev/null   # next dev
```

Emulator state is in-memory only and disappears on shutdown. Re-seed via
Step 3 next time.

---

## Common pitfalls

- **`projectId: peakops-pilot` in the firebase-client log** → emulator mode
  isn't on, or the project override env var isn't set. Re-check `.env.local`
  and restart the dev server.
- **`permission-denied` on every read** → signed-in uid doesn't match a
  member doc. Sign in via `/dev/login` instead of `/login`. Confirm the
  member doc exists in the emulator UI at
  `http://127.0.0.1:4000/firestore`.
- **Mint endpoint returns `503 emulator_required`** → server-side env
  vars aren't loaded. Restart the dev server after editing `.env.local`.
- **Mint endpoint returns `403 uid_not_allowed`** → the requested uid
  isn't in the seed allow-list. The list is hardcoded in
  `app/api/dev/mintCustomToken/route.ts`. Update both the seed scripts
  and that allow-list together if you need to add an actor.
- **Functions base 502/timeout** → `NEXT_PUBLIC_FUNCTIONS_BASE` not set
  to the emulator URL. Check `.env.local`.

---

## What this runbook does NOT do

- It does not start the production deploy. `firebase deploy` against
  `peakops-pilot` is unrelated; this runbook is local-emulator-only.
- It does not seed Storage. Storage emulator runs but no objects are
  pre-loaded; the lifecycle flow uploads on demand via callables.
- It does not seed incidents. Mission Control's "Create incident" UI or
  the createIncidentV1 callable creates them as you exercise the flow.
  For pre-seeded fixtures (used in earlier emulator smoke runs), see
  the inline `node -e` blocks in slice notes.

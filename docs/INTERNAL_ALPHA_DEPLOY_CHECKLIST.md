# PeakOps Internal Alpha Deploy Checklist

**Audience:** the engineer driving the first internal-alpha deployment of
PeakOps to production Firebase project `peakops-pilot`.
**Status:** living document; reflects Slice 16.
**Scope:** internal alpha only. Not public launch, not external customer
onboarding, not a multi-tenant rollout. The narrowest path between the
local emulator demo and one internal pilot org running real-but-internal
incidents.
**Source slices:** 1–16.

---

## 0. Pre-flight invariants

These statements MUST be true before you begin. If any are false, stop
and resolve before deploying.

- [ ] `main` is at the head commit you intend to ship; `git status`
      is clean, no uncommitted edits.
- [ ] `firestore.rules` is the Slice 8/9 default-deny rules file (no
      `match /{document=**} { allow read, write: if true }` fallback).
- [ ] `functions_clean/index.js` exports `bootstrapPilotOrgV1` and the
      Slice 9 `assignVendorToJobV1`.
- [ ] You have a service-account JSON for `peakops-pilot` available
      at `./sa.json` or via `FIREBASE_SERVICE_ACCOUNT_JSON` env (used
      by `setClaims.cjs` and `setInternalAdminClaim.cjs`).
- [ ] No emulator process is bound to host ports the deploy will use
      (`firebase deploy` shells out to gcloud, not a local emulator).

---

## 1. Required environment variables (production)

The Vercel / Cloud-Run / hosting environment that serves the Next.js
app MUST have these, and ONLY these, set for Firebase wiring:

```
NEXT_PUBLIC_FIREBASE_API_KEY=<peakops-pilot api key>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=peakops-pilot.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=peakops-pilot
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=peakops-pilot.firebasestorage.app
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=<...>
NEXT_PUBLIC_FIREBASE_APP_ID=<...>
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=<...>
NEXT_PUBLIC_PEAKOPS_FN_BASE=https://us-central1-peakops-pilot.cloudfunctions.net
```

The following MUST be **unset / absent** in the production build env
(NEXT_PUBLIC_* values are baked into the client bundle at build time):

| Variable | Why it must be unset |
|---|---|
| `NEXT_PUBLIC_USE_FIREBASE_EMULATORS` | Setting this to `1` would point the browser at the emulator suite. The flag is gated separately on `NODE_ENV !== "production"` for the dev-login page, but the Firebase client itself uses this var directly to decide whether to call `connectAuthEmulator` etc. Keeping it unset is the production guarantee. |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID_EMULATOR` | Override that flips the browser to `peakops-demo`. Unset in prod. |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET_EMULATOR` | Same, for storage bucket. Unset in prod. |
| `NEXT_PUBLIC_FUNCTIONS_BASE` | Reserved for the dev `127.0.0.1:5004/...` override. Unset in prod (production uses `NEXT_PUBLIC_PEAKOPS_FN_BASE`). |
| `FUNCTIONS_BASE` | Server-side companion of the same. Unset in prod. |
| `FIREBASE_AUTH_EMULATOR_HOST` | Server-side. Setting this triggers `firebaseAdmin.ts` to skip applicationDefault() — production must use real ADC, so unset in prod. |
| `FIRESTORE_EMULATOR_HOST` | Same posture. |
| `FIREBASE_STORAGE_EMULATOR_HOST` | Same posture. |
| `GCLOUD_PROJECT=peakops-demo` | If you carry this over from a dev shell, firebaseAdmin will mis-identify the project. Should resolve from ADC instead. |

**Verification:** before each production deploy, run
`vercel env pull .env.production.snapshot` (or your hosting platform's
equivalent) and grep for `EMULATOR`, `_EMULATOR`, `127.0.0.1`,
`peakops-demo`. Any hit is a blocker.

---

## 2. Firebase project confirmation

- [ ] `firebase use --add` lists `peakops-pilot` as the active project.
- [ ] `firebase projects:list` confirms you have access to the
      production project.
- [ ] `gcloud auth list` shows the human or service account you intend
      to deploy as.
- [ ] **The production project is NOT `peakops-demo`.** `peakops-demo`
      is the local-emulator project namespace and exists only for
      seeding; deploying functions/rules to it is a no-op at best
      and at worst hides production drift.

---

## 3. Functions deploy

```bash
# From repo root.
firebase use peakops-pilot
firebase deploy --only functions --project peakops-pilot
```

Watch for:
- [ ] All callables listed in `functions_clean/index.js` deploy
      successfully (look for `[functions_clean] loaded <name>`
      followed by no `[functions_clean] skipped`).
- [ ] `bootstrapPilotOrgV1` is in the deployed list.
- [ ] `assignVendorToJobV1` is in the deployed list.
- [ ] `uploadEvidenceProxyV1` is in the deployed list AND remembers
      the Slice 15 alignment (uploads land in `firebasestorage.app`).
- [ ] No deploy emits a CORS or runtime version warning.

If a deploy fails partway, **do not retry blindly**. The previous
slice rollouts are already deployed — partial overwrite leaves you
in an unknown state. Diff `firebase functions:list` against the
expected list and re-deploy only the missing names.

---

## 4. Firestore rules deploy

```bash
firebase deploy --only firestore:rules --project peakops-pilot
```

Verification (must all be true post-deploy):
- [ ] Rules console at https://console.firebase.google.com/project/peakops-pilot/firestore/rules
      shows the Slice 8/9 default-deny ruleset.
- [ ] Last line of the deployed rules has NO catch-all
      `allow read, write: if true` fallback.
- [ ] `match /orgs/{orgId}/{...}` matches require `isActiveMember(orgId)`.
- [ ] `match /incidents/{incidentId}` and friends require
      `isActiveMember(incidentOwnerOrgId(incidentId))`.

---

## 5. Storage bucket confirmation

- [ ] Bucket `peakops-pilot.firebasestorage.app` exists in the
      Storage console.
- [ ] `firebase deploy --only storage --project peakops-pilot` ran
      and the storage rules are at the latest committed version.
- [ ] Bucket has lifecycle rules consistent with retention plan
      (out of scope for this slice — note any drift here).
- [ ] `peakops-pilot.appspot.com` legacy bucket: if it exists with
      historical objects, leave it alone. The read path walks both
      families (Slice 15). Do NOT delete legacy objects.

---

## 6. Internal admin claim

Before you can call `bootstrapPilotOrgV1` against production, the
calling Firebase Auth user needs the `peakopsInternalAdmin: true`
custom claim. Use the Slice 16 script, NOT the existing
`setClaims.cjs` (which sets `{ orgId, role }` for end users, not
the internal-admin gate).

```bash
# From repo root.
# Dry-run first:
node setInternalAdminClaim.cjs --target-email=<your-email>@peakops.io

# Apply (will print a confirmation banner with projectId + uid):
node setInternalAdminClaim.cjs --target-email=<your-email>@peakops.io --apply

# After applying, sign out and back in to /login so the new ID
# token carries peakopsInternalAdmin=true.
```

- [ ] Script confirmed projectId is `peakops-pilot` (NOT `peakops-demo`).
- [ ] Operator signed out + back in after grant.
- [ ] Verified the claim by calling
      `auth.currentUser.getIdTokenResult(true).then(r => r.claims)`
      in the browser console — `peakopsInternalAdmin: true` is present.

To revoke when the deploy is done:
```bash
node setInternalAdminClaim.cjs --target-email=<your-email>@peakops.io --revoke --apply
```

---

## 7. Bootstrap the first pilot org

The `bootstrapPilotOrgV1` callable creates `orgs/{orgId}` plus
`orgs/{orgId}/members/{ownerUid}` atomically. See
docs/INTERNAL_ALPHA_BOOTSTRAP_SMOKE.md (or section 8 below) for the
exact body shape.

**Decision: call the cloud function URL directly, NOT the
`/api/fn/bootstrapPilotOrgV1` proxy.** The Next.js
`enforceOrgAndProxy` requires the caller's ID-token claims to
include the requested `orgId`, but the bootstrap caller does NOT
yet have membership in the org being created — that's the whole
point. Calling the cloud function URL bypasses the orgId-claim
gate while still requiring the `peakopsInternalAdmin` claim
enforced inside the function.

```bash
# Get a fresh ID token from the signed-in admin browser session:
#   const t = await firebase.auth().currentUser.getIdToken(true);
#   copy(t)
# Then paste below as $ID_TOKEN.

curl -X POST \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "orgId":     "peakops-internal-alpha",
    "orgName":   "PeakOps Internal Alpha",
    "ownerUid":  "<internal-admin-firebase-uid>",
    "ownerEmail":"<owner-email>@peakops.io",
    "orgType":   "operator",
    "industry":  "utilities",
    "timezone":  "America/Los_Angeles"
  }' \
  https://us-central1-peakops-pilot.cloudfunctions.net/bootstrapPilotOrgV1
```

Expected response:
```json
{
  "ok": true,
  "orgId": "peakops-internal-alpha",
  "ownerUid": "<...>",
  "ownerRole": "owner",
  "bootstrappedAt": "2026-05-...",
  "repaired": false
}
```

- [ ] Response had `ok: true`.
- [ ] Firestore console shows `orgs/peakops-internal-alpha` doc with
      `kind: "customer"`, `status: "active"`, `ownerUserId: <uid>`.
- [ ] Firestore console shows
      `orgs/peakops-internal-alpha/members/<ownerUid>` with
      `role: "owner"`, `status: "active"`.
- [ ] Audit doc at
      `orgs/peakops-internal-alpha/audit/bootstrap_<timestamp>`
      records `mode: "production"` and the caller uid.

If the response is `{ ok: false, error: "permission-denied" }`, the
internal-admin claim isn't present. Re-check section 6.
If it's `{ ok: false, error: "owner_uid_mismatch" }`, an org with
that id already exists with a different owner. Pick a new orgId.
If it's `{ ok: false, error: "demo_org_not_allowed" }`, you used
`demo-org` as the orgId. Don't.

---

## 8. Mint owner orgIds claim

After bootstrap, the owner has a member doc but does NOT yet have
the `orgIds` / `role` Firebase Auth custom claim. Without it,
every `/api/fn/*` call from the owner's browser fails 403 at
`enforceOrgAndProxy` (which checks `decoded.orgIds.includes(orgId)`).

Use the existing `setClaims.cjs`:

```bash
# Note the order: <UID> <ORG_ID> <role>
node setClaims.cjs <ownerUid> peakops-internal-alpha owner
```

- [ ] Claim minted successfully.
- [ ] Owner re-signed-in (`signOut` + magic link, OR
      `getIdToken(true)` from the browser console).
- [ ] Browser console shows
      `currentUser.getIdTokenResult().then(r => r.claims)` returns
      `{ orgIds: ["peakops-internal-alpha"], role: "owner", ... }`.

---

## 9. Smoke test URLs

With the owner signed in and claims minted, walk the lifecycle:

| Step | URL | Expected |
|---|---|---|
| Magic-link login | `https://<deploy-host>/login` | Reaches the welcome panel; magic link arrives in inbox. |
| Mission Control | `https://<deploy-host>/incidents?orgId=peakops-internal-alpha` | Empty list (no incidents yet) without a 401/403. |
| Create incident | Mission Control "Create incident" button | New `incidents/{id}` and `orgs/.../incidents/{id}` mirror docs land. |
| Field tab | `/incidents/<id>/field` | Loads the field rail; can assign vendor (Slice 9 callable). |
| Vendor admin | `/settings/vendors?orgId=peakops-internal-alpha` | Loads as owner. Can add vendor. |
| Member admin | `/settings/team?orgId=peakops-internal-alpha` | Loads as owner. Can invite a teammate. |
| Review tab | `/incidents/<id>/review` | Loads. Photo rail empty until evidence is added. |
| Summary tab | `/incidents/<id>/summary` | Loads. Approval gates respect role. |
| Settings/Profile | `/settings` | Loads user profile under the new uid. |

For each, confirm in the browser network tab:
- [ ] `/api/fn/*` requests carry `Authorization: Bearer <token>`.
- [ ] No 401/403 unless the role is supposed to fail (e.g.
      viewer-only attempting an approve).

---

## 10. Observability checks

- [ ] Cloud Functions logs (Firebase console → Functions → Logs)
      show `authz_ok` lines on real callables, including
      `{ fn, orgId, uid, role, requiredRoles }`.
- [ ] No unexpected `authz_denied` lines for the owner.
- [ ] No `permission-denied` from the rules audit
      (`Firestore → Audit log` if enabled). If rules audit isn't
      enabled, skip — that's a separate observability slice.
- [ ] Browser console is silent — no Firestore client errors,
      no thrown promises from `authedFetch`.

---

## 11. Rollback plan

If anything in §3–§9 fails irrecoverably:

1. **Functions roll back:**
   `firebase functions:rollback --project peakops-pilot` reverts
   to the previous deploy. If you have no previous deploy
   (truly first deploy), drop the new functions individually
   from the Firebase console — there's nothing to roll back to.

2. **Rules roll back:**
   The Firebase console keeps a version history at
   `Firestore → Rules → History`. Click an earlier version, then
   "Publish" to revert. Default-deny is the desired safe state;
   if you accidentally ship an `allow ... if true` rule, revert
   IMMEDIATELY — that fallback is the worst possible production
   state.

3. **Bootstrap rollback:**
   The bootstrap callable does NOT have an undo path. If you
   bootstrapped the wrong orgId, manually delete
   `orgs/{orgId}` plus its `members` and `audit` subcollections
   from the Firestore console. The callable is idempotent on
   re-run, so you can then bootstrap the correct orgId. Do NOT
   leave a half-deleted org around — that's an "orphan org"
   state the architecture explicitly forbids.

4. **Claim rollback:**
   `node setInternalAdminClaim.cjs --target-email=<...> --revoke --apply`
   removes `peakopsInternalAdmin`.
   `node setClaims.cjs <uid> "" ""` will set empty `orgId`/`role`
   but does NOT delete other claims; for clean revocation use the
   Firebase Admin SDK directly with `setCustomUserClaims(uid, null)`.

5. **Catastrophic rollback:**
   If production rules end up in a state that allows broad reads
   or writes, the safe move is to re-deploy the most recent
   committed Slice 8/9 rules from `firestore.rules` at HEAD. The
   in-repo rules file is the authoritative source.

---

## 12. Sign-off

- [ ] All checkboxes above are checked OR explicitly marked N/A
      with a one-line reason next to them in this file.
- [ ] Production smoke recorded in
      `docs/INTERNAL_ALPHA_DEPLOY_NOTES.md` (date, owner uid,
      orgId, what was tested, anything anomalous).
- [ ] Internal-admin claim revoked from the deployer at end of
      session unless they're staying as the alpha contact.

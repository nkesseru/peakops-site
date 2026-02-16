# PeakOps One True Stack

Canonical runtime contract:

- Frontend: `next-app`
- Functions: `functions_clean`
- Firebase config: root `firebase.json`

Anything else (root `app/`, root `components/`, `functions/`, alternate firebase config files) is non-canonical and should not be used for demo boot.

## Local Environment Contract

Use `next-app/.env.local` (template at `next-app/.env.local.example`):

```bash
NEXT_PUBLIC_ENV=local
NEXT_PUBLIC_FUNCTIONS_BASE=http://127.0.0.1:5002/peakops-pilot/us-central1
NEXT_PUBLIC_TECH_USER_ID=tech_web
# Optional: enable direct signed PUT in local dev (default is proxy fallback path)
# NEXT_PUBLIC_USE_SIGNED_PUT=1
```

## Start Commands (Canonical)

1. Start emulators:

```bash
firebase emulators:start --project peakops-pilot --config firebase.json --only functions,firestore,ui
```

2. Seed deterministic demo data (incident + evidence):

```bash
scripts/dev/seed_demo_incident.sh
```

3. Start Next app:

```bash
cd next-app
pnpm run dev:local
```

3.5. Enable direct browser PUT to signed GCS URLs (one-time per bucket):

```bash
cd ..
scripts/dev/set_bucket_cors.sh
```

Dev mode choices:
- Simplest local dev (default): leave `NEXT_PUBLIC_USE_SIGNED_PUT` unset; uploads use `uploadEvidenceProxyV1`.
- Production-like local dev: set `NEXT_PUBLIC_USE_SIGNED_PUT=1` and run `scripts/dev/set_bucket_cors.sh`; signed PUT is used first, with automatic proxy fallback on failure.

4. Run smoke test:

```bash
cd ..
scripts/dev/smoke.sh
```

## Demo Bootstrap (Deterministic)

Use this flow to guarantee seeded demo data every time:

1. Start emulators:

```bash
firebase emulators:start --project peakops-pilot --config firebase.json --only functions,firestore,ui
```

2. Seed demo incident + evidence:

```bash
scripts/dev/seed_demo_incident.sh
```

3. Start Next (separate terminal):

```bash
cd next-app
pnpm run dev:local
```

4. Run smoke checks:

```bash
cd ..
scripts/dev/smoke.sh
```

## Drift Guardrails

- Run repo doctor before major edits:

```bash
scripts/dev/repo_doctor.sh
```

- Before demos, enforce strict drift checks:

```bash
scripts/dev/repo_doctor.sh --strict
```

## Health Dashboard

Use the health dashboard to verify runtime health before demos:

1. Start emulators + Next app.
2. Open `http://127.0.0.1:3001/admin/health`.
3. Click `Run Checks` to refresh checks for Environment, Functions, Storage/Uploads, HEIC Stack, and Demo Data readiness.

- Enable repo hook guardrails once per clone:

```bash
git config core.hooksPath .githooks
```

- Scan for leaked private keys:

```bash
scripts/dev/secret_scan.sh
```

- Smoke test validates:
  - emulator and next ports are listening
  - `next-app/.env.local` points at local functions emulator
  - `listEvidenceLocker` responds with `{ ok: true }` and `count > 0` for seeded demo incident

## Notes

- `firebase.json` is the single source of emulator ports.
- If local experimentation is needed, use `archive/local-only/` for scratch artifacts.
- Avoid adding new runtime entrypoints outside canonical folders.

## Signed PUT CORS Verification

1. Get a signed upload URL:

```bash
BASE="http://127.0.0.1:5002/peakops-pilot/us-central1"
curl -s -X POST "${BASE}/createEvidenceUploadUrlV1" \
  -H 'content-type: application/json' \
  -d '{"orgId":"riverbend-electric","incidentId":"inc_demo","sessionId":"ses_demo","originalName":"cors_test.jpg","contentType":"image/jpeg"}' \
  | jq
```

2. Browser test (from `http://127.0.0.1:3001` devtools):

```js
await fetch(uploadUrl, {
  method: "PUT",
  headers: { "content-type": "image/jpeg" },
  body: new Blob(["cors-ok"], { type: "image/jpeg" })
})
```

3. Curl test (expect HTTP 200/201):

```bash
curl -i -X PUT "$UPLOAD_URL" \
  -H 'content-type: image/jpeg' \
  --data-binary 'cors-ok'
```

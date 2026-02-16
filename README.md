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
```

## Start Commands (Canonical)

1. Start emulators:

```bash
firebase emulators:start --project peakops-pilot --config firebase.json --only functions,firestore,ui
```

2. Start Next app:

```bash
cd next-app
pnpm run dev:local
```

3. Run smoke test:

```bash
cd ..
scripts/dev/smoke.sh
```

## Drift Guardrails

- Run repo doctor before major edits:

```bash
scripts/dev/repo_doctor.sh
```

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
  - `listEvidenceLocker` responds with `{ ok: true }`

## Notes

- `firebase.json` is the single source of emulator ports.
- If local experimentation is needed, use `archive/local-only/` for scratch artifacts.
- Avoid adding new runtime entrypoints outside canonical folders.

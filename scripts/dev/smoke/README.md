# PeakOps production smoke

Headless Playwright smoke that drives the live https://app.peakops.app
as a signed-in operator and asserts the demo path renders correctly.

## What it checks

| Page | Asserts |
|---|---|
| `/dashboard` | KPI labels `In Progress · Total Records · Active · Accepted`; hero card pill reads `Customer Accepted`; no stale `Needs Review` |
| `/incidents/{hero}` | Top pill `Customer Accepted`; no `Awaiting customer review`, `Add proof`, `Capture proof`, `Proof package incomplete` |
| `/incidents/{hero}/review` | `Nothing is waiting for your review.` + `View Summary`; no `Send Back`, `Approve & Lock Selected Job`, `status=complete/review` |
| `/incidents/{hero}/summary` | Top pill `Customer Accepted`; no all-caps Customer Acceptance badges (`UP TO DATE`, etc.) |
| `/records` | Filter chips `All · In Progress · Active · Accepted`; no `Pending approval` |

Plus on every page: red console errors are captured and reported; a
full-page screenshot is written to `screenshots/<page>.png`.

## Setup (one-time)

```bash
cd scripts/dev/smoke
npm install                 # ~30 sec, installs playwright
npx playwright install chromium   # ~60 sec, downloads browser binary (only if not cached)
```

## Capture auth state (one-time per session lifetime)

The app sits behind RequireAuth → /login redirect, so the smoke needs
a real signed-in session. Run once to capture it:

```bash
npm run login
```

A headed Chromium opens. Log in, land on /dashboard, return to the
terminal, press Enter. `.auth.json` is written. Re-run when your
session expires (Firebase refresh-token TTL).

## Run the smoke

```bash
npm run smoke
```

Exits `0` on all-pass, `1` on any fail, `2` if `.auth.json` is missing.
Console output: per-page PASS/FAIL with expected/forbidden text
diagnostics, console-error tally, screenshot paths.

## Update for new demo state

Two things to edit when the hero record or demo expectations change:

- `smoke.mjs` constants near the top: `ORG`, `HERO_INCIDENT`, `BASE`.
- The `checkPage(...)` call list at the bottom: `expected` and
  `forbidden` arrays per page.

## What is and isn't covered

✓ Page renders past auth
✓ HTTP status 200
✓ Expected lifecycle labels visible somewhere in body text
✓ Forbidden stale labels absent from body text
✓ Console-error count per page
✓ Full-page visual evidence captured

✗ Pixel-perfect layout regressions (use a visual diff tool for that)
✗ Hover/click interactions beyond initial render
✗ Backend / Cloud Functions behavior (use the e2e smoke scripts in
  the parent `scripts/dev/` folder for that — they drive real prod
  data through the function endpoints)
✗ Cross-browser compatibility (Chromium only; sufficient for demo
  readiness signal)

# PeakOps Customer Activation Playbook

**Audience:** Customer Success person (CS), Solutions Engineer, anyone running pilot activations. Not engineering-only.
**Goal:** Activate a customer pilot end-to-end without the founder. Founder only steps in at the Day 30 decision gate.
**Last updated:** 2026-06-22 (post Chunk 3B-2)

This playbook covers a single customer pilot from contract signature through 30-day decision gate. Repeat in parallel for multiple customers — they don't interfere.

---

## Prerequisites (one-time setup for the CS person)

These you set up once before running your first activation. After that they don't change.

### 1. Service-account credentials
You need read access to `peakops-pilot` Firestore + Firebase Auth to provision orgs and check pilot health.

- Get a copy of the service-account JSON file from the founder (`.secrets/sa.json` on the repo). Store it locally; never commit it.
- Set `GOOGLE_APPLICATION_CREDENTIALS` to point at it, OR put it at `.secrets/sa.json` in your repo checkout.

### 2. A Firebase ID token with `peakopsInternalAdmin:true` claim
Required to call `createOrgV1` + `inviteOrgMemberV1`. Two ways to get one:

**Option A — Founder pre-mints a CS service account.** Founder runs:
```bash
node setInternalAdminClaim.cjs --target-email=<your-cs-email@…> --apply
```
You then sign in to the PeakOps app at `https://app.peakops.app` with that account and grab the ID token from the browser's DevTools (Application → IndexedDB → firebase → … → idToken). Export it: `export FIREBASE_ID_TOKEN="<paste>"`.

**Option B — Use the smoke script's token-minting flow.** Requires service-account JSON; see `scripts/dev/smoke/verify_chunk3b1_deploy.mjs` for the pattern (`createCustomToken` + Identity Toolkit exchange).

### 3. Repo checkout
The activation script lives at `scripts/activateCustomerOrg.cjs`. Pull the latest `main`.

### 4. Welcome email templates
In `docs/customer-emails/`. Read once so you know the placeholders.

---

## The five-day cadence at a glance

| Day | What you do | Who's involved | Time |
|---|---|---|---|
| **0** | Contract signed (founder hands off) | Founder → CS | — |
| **1** | Run activate script, send welcome email, verify admin signed in | CS, customer admin | 30–60 min |
| **3** | Customer captures first real test record under your light supervision | CS, customer field crew | 30 min |
| **7** | Day-7 check-in email + light review of captured records | CS, customer admin | 20 min |
| **14** | Day-14 health check (silent unless issues) | CS | 10 min |
| **30** | Decision gate: extend / expand / pause | Founder + CS + customer | 60 min |

---

## Day 0 — Sales hands off

The founder closes the contract. Before they hand off to you, confirm with them:

- [ ] **Customer name** (free-text, will be slugified to the orgId)
- [ ] **Industry**: one of `telecom` / `utilities` / `municipality` / `contractor` / `other` (telecom is the only one with a pre-built starter template; others will require manual template setup later — flag to founder)
- [ ] **Admin contact**: name + email
- [ ] **Initial teammate roster**: list of `email:role` pairs (roles = `admin` / `supervisor` / `field` / `viewer`)
- [ ] **Customer's primary timezone** (IANA format, e.g. `America/New_York`)
- [ ] **30-day success criteria**: what does "this pilot worked" look like for THIS customer? (record count, specific workflow, regulatory filing, etc.) — write it down somewhere durable.

If anything is missing, ask the founder before activation.

---

## Day 1 — Activate

### Step 1: Run the activation script (dry-run first)

```bash
cd /Users/kesserumini/peakops/my-app
node scripts/activateCustomerOrg.cjs \
  --name="Butler America Telecom" \
  --industry=telecom \
  --admin-email="sarah.butler@butleramerica.com" \
  --admin-name="Sarah Butler" \
  --timezone="America/New_York" \
  --teammate="field1@butleramerica.com:field" \
  --teammate="sup1@butleramerica.com:supervisor"
```

This runs in **DRY-RUN** mode (no writes). It prints what it would do. Inspect the output for:
- Correct `Derived orgId` (no surprises — should look like the slugified customer name)
- All teammate emails listed with the right roles
- Industry shows correctly

### Step 2: Run with `--apply`

Add `--apply` to the same command. Watch the output. Expected outcome:
- `createOrgV1 returns ok:true`
- `firstLoginUrl` populated (starts with `https://peakops-pilot.firebaseapp.com/__/auth/action?...`)
- For each teammate: `inviteOrgMemberV1 returns ok:true` with their own `magicLink`
- Final summary table with the org ID and every magic link
- Email template at the bottom — copy that

### Step 3: Email the customer admin

Open `docs/customer-emails/01-welcome.md` in the repo. Copy it into your email client. Replace placeholders:
- `{{customerName}}` → from the script's email template output (the admin's display name, or the customer org name)
- `{{firstLoginUrl}}` → the URL from the script output for the admin's email

Send it.

### Step 4: For each teammate

Send each teammate their **own** magic link from the script output. Use a simple variant of the welcome email — just lead with "you've been invited by your administrator to the PeakOps workspace; click below to sign in for the first time."

Subject suggestion: `You've been invited to {{customer-org-name}}'s PeakOps workspace`

### Step 5: Verify the admin signed in successfully

Within 24 hours, check Firebase Auth in the Firebase Console:
- Navigate to: **https://console.firebase.google.com/project/peakops-pilot/authentication/users**
- Search for the admin's email
- Confirm "Last sign-in" is populated (not "—")

If they haven't signed in within 48 hours, send a follow-up email asking if they need help.

---

## Day 3 — Light supervision on first real record

Schedule a 30-minute call with the customer admin. Have them:

1. Open `app.peakops.app/dashboard`
2. Click **+ New field record**
3. Fill in: title, customer, archetype (`fiber_splice_verification` for telecom), location, priority
4. Save → opens the new incident
5. Click **Start field session** → **Mark arrived** → upload 4+ proof items → **Submit field session**
6. Switch to a supervisor account → review → **Approve & lock**
7. **Close incident** → **Export packet**
8. Download the ZIP — verify the cover page says `"Generated by {customer-org-name} · powered by PeakOps"` (NOT just "PeakOps" — Chunk 3B-2 branding fix)

If steps 1–8 complete without you having to escalate to the founder, the activation is healthy. If anything broke, capture screenshots and notify founder via Slack.

**Pre-built template check:** the customer should see a populated "Required proof" checklist on the incident overview (arrival photo, before, after, equipment label, GPS) — that came from the starter template auto-seeded at org creation. If it's empty, the seed failed silently; flag to founder.

---

## Day 7 — Check-in email

Open `docs/customer-emails/02-day-7-checkin.md`. Two variants in the template:
- **Variant A**: customer has captured records → "looks great, here's what I see, any questions?"
- **Variant B**: customer has zero records → "I noticed nothing's been captured yet — let's talk."

Pick the right variant. Fill placeholders:
- `{{recordCount}}` → from a quick Firestore query (`gh` count or via Firebase Console: orgs/{orgId}/incidents)
- `{{exampleRecordTitle}}` → if variant A, name one of their records

Send it.

---

## Day 14 — Silent health check

You don't email the customer at Day 14 unless there's a problem. Just check the dashboard for the org:

```
https://app.peakops.app/dashboard?orgId={orgId}
```

- [ ] Are records being captured? (Active + In Progress + Accepted should sum to > 0)
- [ ] Has any record been Accepted by the customer's customer-side reviewer? (Accepted count > 0)
- [ ] Are there any rejection-recovery cases? (`/recovery` page)

If everything looks normal, do nothing. If you see ZERO records, send a Variant B-style check-in immediately (don't wait for Day 30).

---

## Day 30 — Decision gate (founder rejoins)

Schedule a 60-minute call with **founder + customer admin**. Bring to the call:

1. **Quantitative summary**:
   - Total records captured
   - Total Accepted (signed customer review packets)
   - Total Rejected → Recovered (recovery case auto-handling worked)
   - Any incidents stuck for > 7 days
2. **Qualitative summary** from your check-ins:
   - What worked
   - What broke or confused them
   - What they're asking for next
3. **The success-criteria document** from Day 0

Together, decide one of:

- **Extend pilot** (another 30 days, same scope) — most common when the customer needs more confidence
- **Expand pilot** (add a second workflow, or invite more teammates) — best outcome
- **Convert to paid** (founder owns this conversation)
- **Pause pilot** — least common; capture the reason in writing

Update the `customer-pilot-log` (wherever you track this — Notion, Google Sheet, etc.) with the outcome and next checkpoint date.

---

## What the founder still owns (escalation paths)

These are the things you **escalate to founder** rather than handle yourself:

| Situation | Why founder owns it |
|---|---|
| Customer asks for a custom archetype (not in `telecom`/`utilities`/`municipality`/`contractor`/`other`) | Requires code change + deploy. Founder decides whether to do it now vs. force-fit to `custom`. |
| Customer asks for non-DIRS / non-OE-417 compliance rules | Rulepacks are static JSON files in `functions_clean/_complianceRulepacks/`. Requires engineering. |
| Customer reports lost magic link or revoked review link | Founder runs `teamRecoveryV1` callable or uses Firebase Console to mint a fresh link. |
| Customer asks for an org-level notification policy change | No org-level toggle exists today. Founder may patch or you tell the customer "per-user opt-in only." |
| Anything that touches Firestore data directly | Founder owns all manual Firestore writes. Never edit via Console yourself unless founder explicitly walks you through it for a specific customer issue. |
| Pilot conversion to paid contract | Founder owns the commercial conversation. |
| Any signal of data integrity issues (missing records, evidence not in packet, wrong customer's data appearing) | **Immediately escalate.** Don't troubleshoot solo. |

---

## Cross-references

- **`scripts/activateCustomerOrg.cjs --help`** — full activation-script CLI surface
- **`docs/customer-emails/`** — the three email templates (welcome, day-7 check-in, day-30 decision)
- **`docs/checkpoints/chunk3a-customer-activation-audit.md`** — the audit that justified this playbook's existence
- **`docs/checkpoints/chunk3b1-founder-cli-replacement.md`** — what the activate script does mechanically
- **`docs/checkpoints/chunk3b2-activation-polish.md`** — starter template + branding details
- **`docs/checkpoints/chunk1-trust-foundation.md`** — security posture (storage rules, token TTL, audit logging)
- **`docs/checkpoints/chunk2-workflow-completion.md`** — the workflow features the customer will use end-to-end
- **`docs/SALES_STORY.md`** — what the founder told the customer before contract signature

---

## If you have to walk this back

If a customer pulls out mid-pilot, you need to know how to deactivate. **Do not delete the Firestore data** — pilot records often have audit obligations. Instead:

1. Suspend the org: set `orgs/{orgId}.status` to `"suspended"` (via Firestore Console — escalate to founder if you're not comfortable with this).
2. Disable all team Auth users in Firebase Auth Console (Auth → user → ⋮ → Disable account).
3. Keep magic links revokable (no automated revoke today; founder handles via Console if needed).
4. Update the customer-pilot-log entry with the outcome and reason.
5. After 90 days with no reactivation request, founder decides whether to archive or delete.

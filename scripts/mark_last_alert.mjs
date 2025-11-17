import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function parseArgs() {
  const out = { rule: null, regulator: null, throttleMin: 60, dryRun: true };
  const argv = process.argv.slice(2);
  for (let i=0;i<argv.length;i++) {
    const a = argv[i];
    if (a === '--rule') out.rule = argv[++i];
    else if (a === '--regulator') out.regulator = argv[++i];
    else if (a === '--throttle') out.throttleMin = parseInt(argv[++i],10);
    else if (a === '--apply') out.dryRun = false;
    else if (a === '--dry') out.dryRun = true;
  }
  if (!out.rule) {
    console.error('❌ Required: --rule <RULE_NAME>');
    process.exit(2);
  }
  return out;
}
const minutesAgoISO = (min) => new Date(Date.now() - min*60*1000).toISOString();

initializeApp({ credential: applicationDefault(), projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT });
const db = getFirestore();

(async () => {
  const opts = parseArgs();
  const nowISO = new Date().toISOString();
  const throttleCutoffISO = minutesAgoISO(opts.throttleMin);

  let q = db.collection('submissions').where('status', 'in', ['DRAFT','PREFLIGHT_FAIL','PREFLIGHT_PASS']);
  if (opts.regulator) q = q.where('regulator', '==', opts.regulator);

  const snap = await q.get();
  let scanned=0, updated=0, skipped=0, errors=0;

  for (const doc of snap.docs) {
    scanned++;
    const s = doc.data() || {};
    const laAt = s.last_alert?.at ? Date.parse(s.last_alert.at) : 0;
    const cutoff = Date.parse(throttleCutoffISO);
    if (laAt && laAt > cutoff) { skipped++; continue; }

    const patch = { last_alert: { rule: opts.rule, at: nowISO } };
    if (opts.dryRun) { updated++; continue; }

    try { await doc.ref.set(patch, { merge: true }); updated++; }
    catch(e){ errors++; console.error(`⚠️  Failed ${doc.id}:`, String(e)); }
  }

  console.log(JSON.stringify({ ok:true, dryRun:opts.dryRun, rule:opts.rule, regulator:opts.regulator||null,
    throttleMin:opts.throttleMin, scanned, updated, skipped, errors, now:nowISO, cutoff:throttleCutoffISO }, null, 2));
  process.exit(errors ? 1 : 0);
})().catch(e => { console.error('❌ Fatal:', e); process.exit(1); });

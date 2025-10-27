import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { loadRulePack, validatePayload } from '../src/rules/loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// init admin for the smoke test
const svcPath = path.join(__dirname, '..', 'serviceAccount.json');
const svc = JSON.parse(fs.readFileSync(svcPath, 'utf8'));
initializeApp({ credential: cert(svc) });
getFirestore(); // ensure ready

// sample DIRS payload that should PASS the math checks
const payload = {
  cell_sites_served: 10,
  cell_sites_out: 5,
  out_due_to_power: 2,
  out_due_to_transport: 2,
  out_due_to_damage: 1
};

const extras = { activation_status: 'deactivated' };

(async () => {
  const pack = await loadRulePack('FCC_DIRS', new Date());
  const res = validatePayload(pack, payload, extras);
  console.log('RulePack version:', pack.version_id);
  console.log('Preflight:', res);
})();

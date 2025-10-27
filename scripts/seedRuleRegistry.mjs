import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const svcPath = path.join(__dirname, '..', 'serviceAccount.json');

if (!fs.existsSync(svcPath)) {
  console.error('Missing serviceAccount.json in project root. Aborting.');
  process.exit(1);
}
const serviceAccount = JSON.parse(fs.readFileSync(svcPath, 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const registrySeed = {
  FCC_DIRS: {
    active_version: '2025.02',
    description: 'FCC DIRS reporting rules (February 2025)',
    versions: {
      '2025.02': {
        regulator: 'FCC_DIRS',
        version_id: '2025.02',
        effective_start: '2025-02-01',
        effective_end: null,
        cfr_refs: [
          { citation: '47 CFR §4.18', as_of: '2025-02-12', url: 'https://www.ecfr.gov/current/title-47/section-4.18' }
        ],
        feature_flags: { final_report_required: true },
        codelist_refs: ['FCC_DIRS_fields@2025.02'],
        schema_uri: 'gs://peakops/rules/FCC_DIRS/2025.02/schema.json',
        pack_hash: 'sha256:replace_with_your_hash_here',
        // store JSONLogic as a string to keep Firestore happy
        validators: [
          {
            name: 'dirs-math-bounds',
            type: 'jsonlogic',
            severity: 'block',
            logic_json: JSON.stringify({
              and: [
                { "<=": [ { var: "out_due_to_power" }, { var: "cell_sites_out" } ] },
                { "<=": [ { var: "out_due_to_transport" }, { var: "cell_sites_out" } ] },
                { "<=": [ { var: "out_due_to_damage" }, { var: "cell_sites_out" } ] },
                { "<=": [ { var: "cell_sites_out" }, { var: "cell_sites_served" } ] }
              ]
            })
          },
          {
            name: 'final-required-on-deactivation',
            type: 'flag',
            severity: 'warn',
            expr: "activation_status == 'deactivated' ? flags.final_report_required : true"
          }
        ]
      }
    }
  },
  DOE_OE417: {
    active_version: '2027.05',
    description: 'DOE OE-417 incident reporting rules (May 2027)',
    versions: {
      '2027.05': {
        regulator: 'DOE_OE417',
        version_id: '2027.05',
        effective_start: '2023-08-30',
        effective_end: null,
        cfr_refs: [
          { citation: 'OMB 1901-0288 (OE-417 form & instructions)', as_of: '2023-08-30', url: 'https://www.energy.gov/oe-417' }
        ],
        feature_flags: {},
        codelist_refs: ['DOE_OE417_causes@2027.05', 'DOE_OE417_timezones@2027.05'],
        schema_uri: 'gs://peakops/rules/DOE_OE417/2027.05/schema.json',
        pack_hash: 'sha256:replace_with_your_hash_here',
        validators: [
          {
            name: 'oe417-timezone',
            type: 'jsonlogic',
            severity: 'block',
            logic_json: JSON.stringify({
              in: [ { var: 'timezone' }, ['Eastern','Central','Mountain','Pacific','Alaska','Hawaii','Atlantic','Chamorro'] ]
            })
          }
        ]
      }
    }
  },
  OMB_OF2211: {
    active_version: '2024.05',
    description: 'OMB OF-2211 waiver request rules (May 2024)',
    versions: {
      '2024.05': {
        regulator: 'OMB_OF2211',
        version_id: '2024.05',
        effective_start: '2024-05-01',
        effective_end: null,
        cfr_refs: [
          { citation: '2 CFR Part 184 (Build America, Buy America)', as_of: '2024-05-01', url: 'https://www.ecfr.gov/current/title-2/section-184.5' }
        ],
        feature_flags: {},
        codelist_refs: ['OF2211_product_categories@2024.05'],
        schema_uri: 'gs://peakops/rules/OMB_OF2211/2024.05/schema.json',
        pack_hash: 'sha256:replace_with_your_hash_here',
        validators: [
          { name: 'baba-nonavailability-quotes', type: 'jsonlogic', severity: 'block', logic_json: JSON.stringify({ ">=": [ { var: "quotes_count" }, 3 ] }) },
          { name: 'baba-unreasonable-cost', type: 'jsonlogic', severity: 'block', logic_json: JSON.stringify({ ">": [ { var: "project_cost_increase_pct" }, 25 ] }) }
        ]
      }
    }
  }
};

async function seed() {
  for (const [reg, data] of Object.entries(registrySeed)) {
    const regRef = db.collection('rules_registry').doc(reg);
    await regRef.set({ active_version: data.active_version, description: data.description }, { merge: true });
    for (const [verId, ver] of Object.entries(data.versions)) {
      await regRef.collection('versions').doc(verId).set(ver, { merge: true });
    }
  }
  console.log('✅ Full rules seeded (safe JSON)');
}
seed().catch(err => { console.error('❌ Failed to seed rule registry:', err); process.exit(1); });

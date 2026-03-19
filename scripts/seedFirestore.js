const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const ORGS = ['demo-org'];
const NOW = Timestamp.now();

function d(p){ return db.doc(p); }
function c(p){ return db.collection(p); }

async function seedOrg(orgId){
  const ops = [];

  // org root
  ops.push(d(`orgs/${orgId}`).set({
    name: 'Demo Utility Co.',
    status: 'active',
    created_at: NOW,
    _schemaVersion: '2025.10.29',
  }, { merge: true }));

  // users
  ops.push(d(`orgs/${orgId}/users/admin`).set({
    email: 'nick@pioneercomclean.com',
    role: 'owner',
    created_at: NOW,
    active: true,
  }, { merge: true }));

  // global rule packs / codelists
  ops.push(d(`rule_packs/DOE_OE417_2027.05`).set({
    regulator: 'DOE_OE417',
    version_id: '2027.05',
    pack_hash: 'sha256:replace_with_your_hash_here',
    cfr_refs: [{
      citation: 'OMB 1901-0288 (OE-417 form & instructions)',
      as_of: '2023-08-30',
      url: 'https://www.energy.gov/oe-417'
    }],
    codelists: ['DOE_OE417_causes@2027.05','DOE_OE417_timezones@2027.05'],
    created_at: NOW,
  }, { merge: true }));

  ops.push(d(`codelists/DOE_OE417_causes@2027.05`).set({
    name: 'DOE_OE417_causes',
    version: '2027.05',
    items: ['Severe Weather','Vandalism','Equipment Failure','Cyber Event','Other'],
    created_at: NOW,
  }, { merge: true }));

  ops.push(d(`codelists/DOE_OE417_timezones@2027.05`).set({
    name: 'DOE_OE417_timezones',
    version: '2027.05',
    items: ['Pacific','Mountain','Central','Eastern','Alaska','Hawaii-Aleutian'],
    created_at: NOW,
  }, { merge: true }));

  // OE-417 submission (under org)
  const oe417Id = 'GyyJEwNpjKb6V4y0lUWP';
  ops.push(d(`orgs/${orgId}/submissions/${oe417Id}`).set({
    regulator: 'DOE_OE417',
    org_id: orgId,
    payload: {
      start: '2025-10-27T10:00',
      timezone: 'Pacific',
      county: 'Spokane',
      fips: '53063',
      mw: '250',
      cust: '42000',
      cause: 'Severe Weather',
      impact: 'Partial Loss of Load',
      actions: 'Manual Switching',
      narr: 'Wind event caused partial outages; crews rolling, manual switching engaged.'
    },
    preflight: { passed: true, errors: [], warnings: [] },
    rule_pack: {
      regulator: 'DOE_OE417',
      version_id: '2027.05',
      pack_hash: 'sha256:replace_with_your_hash_here',
      cfr_refs: [{
        citation: 'OMB 1901-0288 (OE-417 form & instructions)',
        as_of: '2023-08-30',
        url: 'https://www.energy.gov/oe-417'
      }],
      codelists: ['DOE_OE417_causes@2027.05','DOE_OE417_timezones@2027.05']
    },
    status: 'draft',
    created_at: NOW,
    _schemaVersion: '2025.10.29',
  }, { merge: true }));

  // FCC DIRS stub
  ops.push(d(`orgs/${orgId}/dirs_reports/dirs_demo_001`).set({
    org_id: orgId,
    incident_start: '2025-10-27T09:58',
    timezone: 'Pacific',
    region: 'Spokane County, WA',
    impact: { sites_down: 4, percent_affected: 3.2 },
    cause: 'Severe Weather',
    status: 'draft',
    created_at: NOW,
    regulator: 'FCC_DIRS',
    _schemaVersion: '2025.10.29',
  }, { merge: true }));

  // BABA/SAR procurement + attestation
  const procId = 'proc_demo_001';
  ops.push(d(`orgs/${orgId}/procurements/${procId}`).set({
    org_id: orgId,
    project_id: 'grid-hardening-2025',
    description: 'Switchgear + conductor upgrade package',
    vendor_name: 'Northwest Grid Supply LLC',
    domestic_content_pct: 88.5,
    classification: 'iron_steel_manufactured',
    waiver_status: 'none',
    sar_required: true,
    modules: ['BABA','SAR'],
    created_at: NOW,
    _schemaVersion: '2025.10.29',
  }, { merge: true }));

  ops.push(d(`orgs/${orgId}/procurements/${procId}/attestations/attestation_demo_001`).set({
    type: 'Supplier Attestation',
    form_version: 'SAR-2.0',
    signed_by: 'Jane Supplier, VP Compliance',
    signed_at: NOW,
    files: [{ evidence_id: 'evi_demo_001' }],
    status: 'received',
    _schemaVersion: '2025.10.29',
  }, { merge: true }));

  // Evidence Locker
  ops.push(d(`orgs/${orgId}/evidence/evi_demo_001`).set({
    kind: 'pdf',
    purpose: 'BABA/SAR attestation backup',
    sha256: 'replace_me',
    size_bytes: 123456,
    storage_path: 'gs://peakops-pilot-evidence/evi_demo_001.pdf',
    related: [{ type: 'procurement', ref: `orgs/${orgId}/procurements/${procId}` }],
    created_at: NOW,
    _schemaVersion: '2025.10.29',
  }, { merge: true }));

  // Daily snapshot
  ops.push(d(`orgs/${orgId}/snapshots_daily/2025-10-27`).set({
    oe417_submissions: 1,
    dirs_reports: 1,
    procurement_attestations: 1,
    issues: 0,
    created_at: NOW,
    _schemaVersion: '2025.10.29',
  }, { merge: true }));

  // logs
  ops.push(c(`orgs/${orgId}/system_logs`).add({
    level: 'info', event: 'seed_complete_start', actor: 'seed-script', at: NOW,
  }));

  await Promise.all(ops);
  await c(`orgs/${orgId}/system_logs`).add({
    level: 'info', event: 'seed_complete_end', actor: 'seed-script', at: Timestamp.now(),
  });
}

(async () => {
  for (const orgId of ORGS) {
    console.log('Seeding org:', orgId);
    await seedOrg(orgId);
  }
  console.log('✔ Firestore seed complete.');
  process.exit(0);
})();

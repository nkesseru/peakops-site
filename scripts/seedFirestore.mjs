import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const NOW = Timestamp.now();
const ORG = 'demo-org';

const d = p => db.doc(p);

async function main() {
  const ops = [];

  // Globals
  ops.push(d('rule_packs/DOE_OE417_2027.05').set({
    regulator: 'DOE_OE417',
    version_id: '2027.05',
    pack_hash: 'sha256:replace_with_your_hash_here',
    codelists: ['DOE_OE417_causes@2027.05', 'DOE_OE417_timezones@2027.05'],
    created_at: NOW,
  }, { merge: true }));

  ops.push(d('codelists/DOE_OE417_causes@2027.05').set({
    name: 'DOE_OE417_causes', version: '2027.05',
    items: ['Severe Weather','Vandalism','Equipment Failure','Cyber Event','Other'],
    created_at: NOW,
  }, { merge: true }));

  ops.push(d('codelists/DOE_OE417_timezones@2027.05').set({
    name: 'DOE_OE417_timezones', version: '2027.05',
    items: ['Pacific','Mountain','Central','Eastern','Alaska','Hawaii-Aleutian'],
    created_at: NOW,
  }, { merge: true }));

  // Org root + user
  ops.push(d(`orgs/${ORG}`).set({
    name: 'Demo Utility Co.', status: 'active', created_at: NOW, _schemaVersion: '2025.10.29',
  }, { merge: true }));

  ops.push(d(`orgs/${ORG}/users/admin`).set({
    email: 'nick@pioneercomclean.com', role: 'owner', active: true, created_at: NOW,
  }, { merge: true }));

  // OE-417 (org-scoped)
  const subId = 'GyyJEwNpjKb6V4y0lUWP';
  ops.push(d(`orgs/${ORG}/submissions/${subId}`).set({
    regulator: 'DOE_OE417', org_id: ORG,
    payload: {
      start: '2025-10-27T10:00', timezone: 'Pacific', county: 'Spokane',
      fips: '53063', mw: '250', cust: '42000', cause: 'Severe Weather',
      impact: 'Partial Loss of Load', actions: 'Manual Switching',
      narr: 'Wind event caused partial outages; crews rolling, manual switching engaged.',
    },
    preflight: { passed: true, errors: [], warnings: [] },
    rule_pack: { regulator: 'DOE_OE417', version_id: '2027.05' },
    status: 'draft', created_at: NOW, _schemaVersion: '2025.10.29',
  }, { merge: true }));

  // FCC DIRS
  ops.push(d(`orgs/${ORG}/dirs_reports/dirs_demo_001`).set({
    org_id: ORG, incident_start: '2025-10-27T09:58', timezone: 'Pacific',
    region: 'Spokane County, WA', impact: { sites_down: 4, percent_affected: 3.2 },
    cause: 'Severe Weather', status: 'draft', regulator: 'FCC_DIRS',
    created_at: NOW, _schemaVersion: '2025.10.29',
  }, { merge: true }));

  // BABA/SAR procurement + attestation
  const procId = 'proc_demo_001';
  ops.push(d(`orgs/${ORG}/procurements/${procId}`).set({
    org_id: ORG, project_id: 'grid-hardening-2025',
    description: 'Switchgear + conductor upgrade package',
    vendor_name: 'Northwest Grid Supply LLC', domestic_content_pct: 88.5,
    classification: 'iron_steel_manufactured', waiver_status: 'none',
    sar_required: true, modules: ['BABA','SAR'], created_at: NOW,
    _schemaVersion: '2025.10.29',
  }, { merge: true }));

  ops.push(d(`orgs/${ORG}/procurements/${procId}/attestations/attestation_demo_001`).set({
    type: 'Supplier Attestation', form_version: 'SAR-2.0', signed_by: 'Jane Supplier, VP Compliance',
    signed_at: NOW, files: [{ evidence_id: 'evi_demo_001' }], status: 'received',
    _schemaVersion: '2025.10.29',
  }, { merge: true }));

  // Evidence
  ops.push(d(`orgs/${ORG}/evidence/evi_demo_001`).set({
    kind: 'pdf', purpose: 'BABA/SAR attestation backup', sha256: 'replace_me',
    size_bytes: 123456, storage_path: 'gs://peakops-pilot-evidence/evi_demo_001.pdf',
    related: [{ type: 'procurement', ref: `orgs/${ORG}/procurements/${procId}` }],
    created_at: NOW, _schemaVersion: '2025.10.29',
  }, { merge: true }));

  // Snapshot
  ops.push(d(`orgs/${ORG}/snapshots_daily/2025-10-27`).set({
    oe417_submissions: 1, dirs_reports: 1, procurement_attestations: 1, issues: 0,
    created_at: NOW, _schemaVersion: '2025.10.29',
  }, { merge: true }));

  await Promise.all(ops);
  console.log('✔ Seeded globals and org-scoped collections');
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});

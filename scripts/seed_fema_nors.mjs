import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import crypto from 'crypto';
initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const H = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');

async function writePack(p) {
  const id = `${p.regulator}@${p.version_id}`;
  const required_fields = JSON.stringify(p.required_fields || []);
  const json_logic_rules = JSON.stringify(p.json_logic_rules || []);
  const pack = {
    regulator: p.regulator, version_id: p.version_id, active: true,
    cfr_refs: p.cfr_refs || [],
    required_fields, json_logic_rules,
    export: p.export || {},
    pack_hash: H(required_fields + json_logic_rules)
  };
  await db.collection('rulepacks').doc(id).set(pack, { merge: true });
  console.log('✅ seeded', id);
}

/** FEMA PA (Public Assistance) – Documentation bundle skeleton
 * Goal: assemble auditable package for PA reimbursement periods.
 * “project.*” and “work.*” fields are intentionally generic and expandable.
 */
await writePack({
  regulator: 'FEMA_PA',
  version_id: '2025.01',
  cfr_refs: ['44 CFR Part 206'],
  required_fields: [
    { path:'payload.applicant.duns',           type:'string'  },
    { path:'payload.applicant.legal_name',     type:'string'  },
    { path:'payload.disaster_number',          type:'string'  },
    { path:'payload.project.category',         type:'string'  },  // e.g., A–G
    { path:'payload.project.description',      type:'string'  },
    { path:'payload.period.start',             type:'date'    },
    { path:'payload.period.end',               type:'date'    },
    { path:'payload.work.labor_hours',         type:'number'  },
    { path:'payload.work.equipment_hours',     type:'number'  },
    { path:'payload.costs.total_usd',          type:'number'  }
  ],
  json_logic_rules: [
    { name:'nonnegative-costs', rule:{ ">=": [ {"var":"payload.costs.total_usd"}, 0 ] } },
    { name:'period-order',      rule:{ "<=": [ {"var":"payload.period.start"}, {"var":"payload.period.end"} ] } }
  ],
  export: {
    // You can render a PDF cover + CSV detail list later
    pdf_template: 'fema_pa_summary_v2025_01.pug',
    csv_template: 'fema_pa_lines_v2025_01.csv'
  }
});

/** FCC NORS (Network Outage Reporting System) – basic single-event skeleton
 * Start with single-event requireds (you can extend w/ tech-specific sets).
 */
await writePack({
  regulator: 'FCC_NORS',
  version_id: '2025.02',
  cfr_refs: ['47 CFR Part 4 (NORS)'],
  required_fields: [
    { path:'payload.outage_start',            type:'datetime' },
    { path:'payload.duration_minutes',        type:'integer'  },
    { path:'payload.affected_customers',      type:'integer'  },
    { path:'payload.technology',              type:'string'   }, // e.g., wireline/wireless/VoIP
    { path:'payload.cause',                   type:'string'   },
    { path:'payload.psap_affected',           type:'boolean'  }
  ],
  json_logic_rules: [
    { name:'duration>=0',        rule:{ ">=": [ {"var":"payload.duration_minutes"}, 0 ] } },
    { name:'customers>=0',       rule:{ ">=": [ {"var":"payload.affected_customers"}, 0 ] } }
  ],
  export: {
    json_template: { nors:{ start:'{{payload.outage_start}}', dur:'{{payload.duration_minutes}}' } }
  }
});

console.log('✅ FEMA_PA and FCC_NORS seeded.');

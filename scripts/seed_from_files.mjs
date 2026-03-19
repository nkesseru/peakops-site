import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const dir = path.resolve('rulepacks');

const h = (s) => 'sha256:' + crypto.createHash('sha256').update(s).digest('hex');

for (const f of fs.readdirSync(dir).filter(x=>x.endsWith('.json'))) {
  const p = JSON.parse(fs.readFileSync(path.join(dir,f), 'utf8'));
  const id = `${p.regulator}@${p.version_id}`;
  const required_fields = JSON.stringify(p.required_fields || []);
  const json_logic_rules = JSON.stringify(p.json_logic_rules || []);
  const pack = {
    regulator: p.regulator, version_id: p.version_id, active: p.active ?? true,
    cfr_refs: p.cfr_refs || [], required_fields, json_logic_rules,
    export: p.export || {}, pack_hash: h(required_fields + json_logic_rules)
  };
  await db.collection('rulepacks').doc(id).set(pack, { merge:true });
  console.log('✅ seeded', id);
}

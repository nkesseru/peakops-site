import { useEffect, useMemo, useState } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';

// TODO: paste your Firebase Web config (Project settings → Web app)
const firebaseConfig = {
  // apiKey: "...",
  // authDomain: "...",
  // projectId: "peakops-pilot",
  // storageBucket: "...",
  // messagingSenderId: "...",
  // appId: "..."
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

type Job = {
  id: string;
  orgId: string;
  wo?: { id: string; scope?: string; carrierId?: string };
  status?: string;
  preflight?: { dispatcherDone?: boolean; techDone?: boolean };
  compliance?: { progress?: { required?: number; ok?: number }; ready?: boolean };
  assignedTechs?: string[];
  siteId?: string;
  window?: { start?: any; end?: any };
};

export default function MissionControlPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [assignTechId, setAssignTechId] = useState("");

  useEffect(() => {
    const q = query(
      collection(db, 'jobs'),
      where('orgId', '==', 'butler_pilot'),
      orderBy('window.start')
    );
    const unsub = onSnapshot(q, snap => {
      const arr: Job[] = [];
      snap.forEach(d => arr.push({ id: d.id, ...(d.data() as any) }));
      setJobs(arr);
    });
    return () => unsub();
  }, []);

  const rows = useMemo(() => jobs, [jobs]);

  const Chip = ({ ok, text }: { ok: boolean; text: string }) => (
    <span style={{
      padding: '3px 8px', borderRadius: 999, border: `1px solid ${ok ? '#21e6b6' : '#ffcf5a'}`,
      color: ok ? '#21e6b6' : '#ffcf5a', fontSize: 12, marginRight: 6
    }}>{text}</span>
  );

  const assign = async () => {
    if (!selected || !assignTechId.trim()) return;
    const res = await fetch('/api/jobs/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: selected.wo?.id || selected.id, techId: assignTechId.trim() })
    });
    if (!res.ok) alert('Assign failed');
    else setAssignTechId('');
  };

  const markDispatcherPreflight = async () => {
    if (!selected) return;
    const res = await fetch('/api/jobs/preflight-dispatcher', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: selected.wo?.id || selected.id })
    });
    if (!res.ok) alert('Pre-Flight update failed');
  };

  return (
    <main style={{ padding: 24, fontFamily: 'ui-sans-serif, system-ui' }}>
      <h2>Mission Control — Butler</h2>
      <table cellPadding={8} style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ textAlign:'left', borderBottom:'1px solid #eee' }}>
          <th>WO</th><th>Scope</th><th>Status</th><th>Chips</th><th>Assigned</th></tr></thead>
        <tbody>
          {rows.map(j=>{
            const pf = !!(j.preflight?.dispatcherDone && j.preflight?.techDone);
            const prog = j.compliance?.progress; const compOk = !!j.compliance?.ready;
            const pct = prog ? `${prog.ok ?? 0}/${prog.required ?? 12}` : '0/12';
            return (
              <tr key={j.id} onClick={()=>setSelected(j)} style={{ cursor:'pointer', borderBottom:'1px solid #f3f4f6' }}>
                <td>{j.wo?.id || j.id}</td>
                <td>{j.wo?.scope || '-'}</td>
                <td>{j.status}</td>
                <td><Chip ok={pf} text={`Pre-Flight ${pf?'Ready':'Missing'}`} />
                    <Chip ok={compOk} text={`Compliance ${pct}`} /></td>
                <td>{j.assignedTechs?.join(', ') || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {selected && (
        <div style={{
          position:'fixed', top:0, right:0, width:420, height:'100vh',
          background:'#fff', borderLeft:'1px solid #eee', padding:16, boxShadow:'-10px 0 24px rgba(0,0,0,.05)'
        }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <h3 style={{ margin:0 }}>WO {selected.wo?.id || selected.id}</h3>
            <button onClick={()=>setSelected(null)} style={{ border:'1px solid #ddd', padding:'6px 10px', borderRadius:8 }}>Close</button>
          </div>
          <div style={{ marginTop:8, color:'#666' }}>
            <div>Scope: {selected.wo?.scope || '-'}</div>
            <div>Site: {selected.siteId || '-'}</div>
            <div>Status: {selected.status}</div>
          </div>

          <div style={{ marginTop:16 }}>
            <h4>Actions</h4>
            <div style={{ marginBottom:10 }}>
              <label>Assign TechId</label>
              <div>
                <input value={assignTechId} onChange={(e)=>setAssignTechId(e.target.value)}
                       placeholder="e.g. tech_177" style={{ padding:6, border:'1px solid #ddd', borderRadius:6 }} />
                <button onClick={assign}
                        style={{ marginLeft:8, padding:'6px 10px', border:'1px solid #21e6b6', color:'#21e6b6', borderRadius:8 }}>
                  Assign
                </button>
              </div>
            </div>
            <div>
              <button onClick={markDispatcherPreflight}
                      style={{ padding:'6px 10px', border:'1px solid #555', borderRadius:8 }}>
                Mark Dispatcher Pre-Flight Done
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

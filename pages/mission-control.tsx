import { useEffect, useState } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, collection, query, where, orderBy, onSnapshot } from 'firebase/firestore';

const firebaseConfig = {
  // TODO: paste your Firebase Web app config here (NOT the admin key)
  // apiKey: "...",
  // authDomain: "...",
  // projectId: "peakops-pilot",
  // storageBucket: "...",
  // messagingSenderId: "...",
  // appId: "..."
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

type Job = { id: string; orgId: string; wo?: { id: string; scope?: string }; status?: string; preflight?: any; compliance?: any; };

export default function MissionControl() {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    const q = query(collection(db,'jobs'), where('orgId','==','butler_pilot'), orderBy('window.start'));
    return onSnapshot(q, snap => {
      const arr: Job[] = []; snap.forEach(d => arr.push({ id: d.id, ...(d.data() as any) })); setJobs(arr);
    });
  }, []);
  return (
    <main style={{ padding: 24, fontFamily: 'ui-sans-serif, system-ui' }}>
      <h2>Mission Control — Butler</h2>
      <ul>{jobs.map(j => <li key={j.id}>{j.wo?.id || j.id} — {j.wo?.scope || '-'}</li>)}</ul>
    </main>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { auth, db } from '@/lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import {
  doc, getDoc, setDoc,
  collection, query, where, getDocs
} from 'firebase/firestore';

type Job = {
  id: string;
  title: string;
  status: string;
  site?: { name?: string };
};

export default function Dashboard() {
  const [user, setUser] = useState<any>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) { location.href = '/login'; return; }
      setUser(u);

      // 1) Ensure the user doc exists; if missing, create with default org
      const uref = doc(db, 'users', u.uid);
      let usnap = await getDoc(uref);
      if (!usnap.exists()) {
        // TODO: replace 'demo-org' with a real org assignment later
        await setDoc(uref, {
          orgId: 'demo-org',
          role: 'admin',
          email: u.email ?? '',
          name: u.displayName ?? '',
          createdAt: new Date().toISOString(),
        }, { merge: true });
        usnap = await getDoc(uref);
      }

      const uOrg = usnap.data()?.orgId as string | undefined;
      if (!uOrg) { setLoading(false); return; }
      setOrgId(uOrg);

      // 2) Query jobs for this org
      const q = query(collection(db, 'jobs'), where('orgId', '==', uOrg));
      const snap = await getDocs(q);
      const rows = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as Job[];
      setJobs(rows);
      setLoading(false);
    });
    return () => unsub();
  }, []);

  if (!user) return null;

  return (
    <main className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Jobs {orgId ? `· ${orgId}` : ''}</h1>
      </div>

      {loading ? (
        <div className="rounded-2xl border p-6 bg-white/70 backdrop-blur">Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="rounded-2xl border p-6 bg-white/70 backdrop-blur">No jobs yet.</div>
      ) : (
        <ul className="space-y-3">
          {jobs.map((j) => (
            <li key={j.id} className="rounded-2xl border p-4 bg-white/70 backdrop-blur flex justify-between">
              <div>
                <div className="font-semibold">{j.title}</div>
                <div className="text-sm text-gray-500">{j.site?.name}</div>
              </div>
              <div className="text-sm px-3 py-1 rounded-xl bg-gray-100">{j.status}</div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

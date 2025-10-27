'use client';
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';

import { auth, db } from '@/lib/firebaseClient';  // ✅ client SDK
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';

type JobStatus = 'draft'|'scheduled'|'in_progress'|'closeout_ready'|'done';
const STAGES: JobStatus[] = ['draft','scheduled','in_progress','closeout_ready','done'];

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [job, setJob] = useState<any>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) { router.replace('/login'); return; }
      if (!id) return;
      const ref = doc(db, 'jobs', id);
      const snap = await getDoc(ref);
      if (!snap.exists()) { router.replace('/dashboard'); return; }
      setJob({ id, ...snap.data() });
    });
    return () => unsub();
  }, [id, router]);

  if (!job) return <main className="p-8">Loading…</main>;
  const cur = STAGES.indexOf(job.status as JobStatus);

  return (
    <main className="p-8 space-y-6">
      <div className="rounded-2xl border p-6 bg-white/70 backdrop-blur">
        <div className="text-sm text-gray-500 mb-1">
          <Link href="/dashboard" className="underline">Jobs</Link> / {job.id}
        </div>
        <h1 className="text-2xl font-semibold">{job.title}</h1>
        <div className="text-sm text-gray-500">{job.site?.name}</div>
        {job.window?.start && <div className="text-sm text-gray-500">Window: {job.window.start}–{job.window.end}</div>}
      </div>

      <div className="rounded-2xl border p-4 bg-white/70 backdrop-blur flex gap-2 flex-wrap">
        {STAGES.map((s, idx) => {
          const active = idx === cur, done = idx < cur;
          return (
            <div key={s}
              className={[
                'px-3 py-1 rounded-xl text-sm border capitalize',
                active ? 'bg-[#10C4C4]/20 border-[#10C4C4] font-semibold' :
                done   ? 'bg-black/5 border-black/10' :
                         'bg-black/3 border-black/10'
              ].join(' ')}
            >{s.replaceAll('_',' ')}</div>
          );
        })}
      </div>

      <div className="rounded-2xl border p-6 bg-white/70 backdrop-blur">
        <div className="text-lg font-semibold mb-2">Evidence</div>
        <p className="text-sm text-gray-600">Uploader coming next.</p>
      </div>
    </main>
  );
}

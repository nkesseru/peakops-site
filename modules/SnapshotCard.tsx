'use client';
import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebaseClient';

type Snap = {
  shiftsScheduled?: number;
  shiftsCompleted?: number;
  dcrCompletionPct?: number;
  flags?: number;
  at?: any;
};

export default function SnapshotCard({ orgId }: { orgId: string }) {
  const [snap, setSnap] = useState<Snap | null>(null);

  useEffect(() => {
    const ref = doc(db, `organizations/${orgId}/snapshots/daily`);
    return onSnapshot(ref, d => setSnap(d.exists() ? (d.data() as Snap) : null));
  }, [orgId]);

  return (
    <div className="rounded-lg border p-4">
      <h2 className="font-medium mb-2">Daily Snapshot</h2>
      {!snap ? (
        <p className="text-sm text-gray-500">No snapshot yet.</p>
      ) : (
        <ul className="text-sm space-y-1">
          <Row label="Shifts Scheduled" value={snap.shiftsScheduled ?? 0} />
          <Row label="Shifts Completed" value={snap.shiftsCompleted ?? 0} />
          <Row label="DCR Completion" value={`${snap.dcrCompletionPct ?? 0}%`} />
          <Row label="Flags Today" value={snap.flags ?? 0} />
        </ul>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: number | string }) {
  return (
    <li className="flex justify-between">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </li>
  );
}

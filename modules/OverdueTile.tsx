'use client';

import { useEffect, useState } from 'react';
import {
  collection,
  query,
  where,
  onSnapshot,
  type Query,
  type QuerySnapshot,
  type DocumentData,
} from 'firebase/firestore';
import { db } from '@/lib/firebaseClient';

type Filters = { start?: string; end?: string; crewId?: string };

export default function OverdueTile({
  orgId,
  filters,
}: {
  orgId: string;
  filters?: Filters;
}) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const now = new Date();

    // base: scheduled before now, not yet done/canceled
    let qry: Query<DocumentData> = query(
      collection(db, `organizations/${orgId}/jobs`),
      where('scheduledStart', '<', now),
      where('status', 'in', ['draft', 'scheduled', 'in_progress', 'closeout_ready'])
    );

    if (filters?.crewId) {
      qry = query(qry, where('crewId', '==', filters.crewId));
    }
    if (filters?.start) {
      qry = query(qry, where('scheduledStart', '>=', new Date(filters.start)));
    }
    if (filters?.end) {
      qry = query(qry, where('scheduledStart', '<=', new Date(filters.end)));
    }

    return onSnapshot(
      qry,
      (snap: QuerySnapshot<DocumentData>) => setCount(snap.size)
    );
  }, [orgId, filters?.crewId, filters?.start, filters?.end]);

  return (
    <div className="rounded-lg border p-4">
      <h2 className="font-medium mb-1">Overdue Jobs</h2>
      <div className="text-2xl font-semibold tabular-nums">{count}</div>
      <p className="text-xs text-gray-500 mt-1">Scheduled before now, not completed</p>
    </div>
  );
}

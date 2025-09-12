'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where, type DocumentData } from 'firebase/firestore';
import { db } from '@/lib/firebaseClient';

export type DashboardFilterValue = {
  start?: string;  // yyyy-mm-dd
  end?: string;    // yyyy-mm-dd
  crewId?: string; // undefined = all crews
};

type Props = {
  orgId: string;
  value: DashboardFilterValue;
  onChange: (next: DashboardFilterValue) => void;
};

type Crew = { id: string; name?: string };

export default function DashboardFilters({ orgId, value, onChange }: Props) {
  const [crews, setCrews] = useState<Crew[]>([]);
  const [loading, setLoading] = useState(true);

  // Org-scoped crews
  useEffect(() => {
    if (!orgId) return;

    setLoading(true);
    const q = query(collection(db, 'crews'), where('orgId', '==', orgId));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: Crew[] = snap.docs.map(d => ({ id: d.id, ...(d.data() as DocumentData) }));
        setCrews(list);
        setLoading(false);
      },
      () => setLoading(false)
    );

    return () => unsub();
  }, [orgId]);

  // Helpers to keep updates tidy
  const setStart = (s?: string) => onChange({ ...value, start: s || undefined });
  const setEnd   = (s?: string) => onChange({ ...value, end:   s || undefined });
  const setCrew  = (id?: string) => onChange({ ...value, crewId: id || undefined });

  const selectedCrewLabel = useMemo(
    () => crews.find(c => c.id === value.crewId)?.name ?? 'All crews',
    [crews, value.crewId]
  );

  return (
    <div className="rounded-lg border p-3 flex flex-wrap gap-3 items-center">
      {/* Start */}
      <div className="flex items-center gap-2">
        <label className="text-sm">Start</label>
        <input
          type="date"
          className="border rounded px-2 py-1 text-sm"
          value={value.start ?? ''}
          onChange={(e) => setStart(e.target.value)}
        />
      </div>

      {/* End */}
      <div className="flex items-center gap-2">
        <label className="text-sm">End</label>
        <input
          type="date"
          className="border rounded px-2 py-1 text-sm"
          value={value.end ?? ''}
          onChange={(e) => setEnd(e.target.value)}
        />
      </div>

      {/* Crew */}
      <div className="flex items-center gap-2">
        <label className="text-sm">Crew</label>
        <select
          className="border rounded px-2 py-1 text-sm"
          value={value.crewId ?? ''}
          onChange={(e) => setCrew(e.target.value || undefined)}
          disabled={loading}
        >
          <option value="">All crews</option>
          {crews.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? c.id}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

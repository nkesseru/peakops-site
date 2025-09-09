'use client';
import { useEffect, useState } from 'react';
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebaseClient';

type Flag = {
  id: string;
  severity?: 'yellow' | 'red' | 'green' | string;
  reason?: string;
  createdAt?: any;
};

export default function FlagsFeed({ orgId }: { orgId: string }) {
  const [items, setItems] = useState<Flag[]>([]);

  useEffect(() => {
    const q = query(
      collection(db, `organizations/${orgId}/flags`),
      orderBy('createdAt', 'desc'),
      limit(10)
    );
    return onSnapshot(q, snap =>
      setItems(snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })))
    );
  }, [orgId]);

  return (
    <div className="rounded-lg border p-4">
      <h2 className="font-medium mb-2">Latest Flags</h2>
      {items.length === 0 ? (
        <p className="text-sm text-gray-500">No flags yet.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {items.map(it => (
            <li key={it.id} className="flex items-start gap-2">
              <SeverityDot severity={it.severity} />
              <span>{it.reason ?? 'Flag raised'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SeverityDot({ severity }: { severity?: string }) {
  const cls =
    severity === 'red'
      ? 'bg-red-600'
      : severity === 'yellow'
      ? 'bg-yellow-500'
      : severity === 'green'
      ? 'bg-green-600'
      : 'bg-gray-400';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls} mt-1`} />;
}

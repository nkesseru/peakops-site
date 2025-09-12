'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  query as q,
  where,
  onSnapshot,
  type Query,
  type QueryConstraint,
  type QuerySnapshot,
  type DocumentData,
} from 'firebase/firestore';
import { db } from '@/lib/firebaseClient';

type Filters = { start?: string; end?: string; crewId?: string };

const STAGES = [
  'draft',
  'scheduled',
  'in_progress',
  'closeout_ready',
  'done',
] as const;

function stageLabel(s: string) {
  switch (s) {
    case 'in_progress':
      return 'In Progress';
    case 'closeout_ready':
      return 'Closeout Ready';
    default:
      return s[0].toUpperCase() + s.slice(1).replace('_', ' ');
  }
}

/**
 * Build a Firestore query for a specific stage + optional filters.
 * Kept as a pure helper to avoid any accidental implicit-any in callbacks.
 */
function buildStageQuery(orgId: string, stage: string, filters?: Filters): Query<DocumentData> {
  const base = collection(db, `organizations/${orgId}/jobs`);
  const constraints: QueryConstraint[] = [where('status', '==', stage)];

  if (filters?.crewId) {
    constraints.push(where('crewId', '==', filters.crewId));
  }
  if (filters?.start) {
    constraints.push(where('scheduledStart', '>=', new Date(filters.start)));
  }
  if (filters?.end) {
    constraints.push(where('scheduledStart', '<=', new Date(filters.end)));
  }

  return q(base, ...constraints);
}

export default function JobsByStage({
  orgId,
  filters,
}: {
  orgId: string;
  filters?: Filters;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});

  // Stabilize stage queries so the effect only re-subscribes when needed.
  const stageQueries = useMemo(
    () =>
      STAGES.map((s) => ({
        stage: s,
        query: buildStageQuery(orgId, s, filters),
      })),
    [orgId, filters?.crewId, filters?.start, filters?.end]
  );

  useEffect(() => {
    // Subscribe to each stage query; update counts as snapshots arrive.
    const unsubs = stageQueries.map(({ stage, query }) =>
      onSnapshot(query, (snap: QuerySnapshot<DocumentData>) => {
        setCounts((prev) => ({ ...prev, [stage]: snap.size }));
      })
    );
    return () => unsubs.forEach((u) => u());
  }, [stageQueries]);

  return (
    <div className="rounded-lg border p-4">
      <h2 className="font-medium mb-2">Jobs by Stage</h2>
      <ul className="space-y-1 text-sm">
        {STAGES.map((s) => (
          <li key={s} className="flex justify-between">
            <span>{stageLabel(s)}</span>
            <span className="tabular-nums">{counts[s] ?? 0}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

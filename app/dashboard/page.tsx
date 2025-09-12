// app/dashboard/page.tsx
import { db } from '@/lib/firebaseAdmin';

type JobCount = { status: string; count: number };
type FlagDoc = { id: string; status?: string; severity?: string | number; message?: string; type?: string; createdAt?: any };

const STATUSES = ['draft','scheduled','in_progress','closeout_ready','done'] as const;

export default async function DashboardPage() {
  const orgId = process.env.NEXT_PUBLIC_TEST_ORG_ID; // TEMP until claims/session are wired

  if (!orgId) {
    return (
      <main style={{ padding: 24 }}>
        <h1>Mission Control</h1>
        <p style={{ color: 'crimson', marginTop: 8 }}>
          No orgId set. Configure <code>NEXT_PUBLIC_TEST_ORG_ID</code> in env, or finish the claims/session wiring.
        </p>
      </main>
    );
  }

  // --- Jobs by status (run in parallel)
  const jobCounts: JobCount[] = await Promise.all(
    STATUSES.map(async (s) => {
      const snap = await db
        .collection('jobs')
        .where('orgId', '==', orgId)
        .where('status', '==', s)
        .count()
        .get();
      return { status: s, count: snap.data().count };
    })
  );

  // --- Latest flags
  const flagsSnap = await db
    .collection('flags')
    .where('orgId', '==', orgId)
    .orderBy('status')
    .orderBy('severity', 'desc')
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();

  const flags: FlagDoc[] = flagsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));

  return (
    <main style={{ padding: 24 }}>
      <h1>Mission Control</h1>

      <section style={{ marginTop: 16 }}>
        <h2>Jobs by Stage</h2>
        <ul>
          {jobCounts.map((j) => (
            <li key={j.status}>
              {j.status}: {j.count}
            </li>
          ))}
        </ul>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2>Latest Flags</h2>
        <ul>
          {flags.length === 0 && <li>No flags</li>}
          {flags.map((f) => (
            <li key={f.id}>
              [{f.status ?? '—'}/{f.severity ?? '—'}] {f.message ?? f.type ?? f.id}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

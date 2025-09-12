import { NextResponse } from 'next/server';
import { db, Timestamp, FieldValue } from '../../../lib/firebaseAdmin';

export async function GET() {
  try {
    const ref = db.doc('organizations/peakops-telecom-pilot/_admin_health/ping');
    await ref.set({ last: Timestamp.now() }, { merge: true });
    const snap = await ref.get();
    return NextResponse.json({
      ok: true,
      lastWrite: snap.data()?.last?.toDate?.() ?? null,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

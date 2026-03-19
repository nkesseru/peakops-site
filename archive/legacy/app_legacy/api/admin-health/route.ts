import { NextResponse } from 'next/server';
import { db, Timestamp } from '@/lib/firebaseAdmin';

export const runtime = 'nodejs';

export async function GET() {
  await db.collection('__admin_health').doc('ping').set(
    { ts: Timestamp.now(), ok: true },
    { merge: true }
  );
  return NextResponse.json({ ok: true });
}

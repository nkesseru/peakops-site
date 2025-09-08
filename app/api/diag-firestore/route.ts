import { NextResponse } from 'next/server';
import { db } from '../../../lib/firebaseAdmin';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const id = `vercel_ping_${Date.now()}`;
    await db.collection('_ping').doc(id).set({ ts: new Date().toISOString() });
    return NextResponse.json({ ok: true, wrote: id });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}

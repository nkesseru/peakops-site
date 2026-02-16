import { NextResponse } from 'next/server';
import { db } from '@/lib/firebaseAdmin';

export async function GET() {
  // touch Firestore
  const ping = db.collection('system_logs').doc('health').collection('events').doc();
  await ping.set({ t: new Date().toISOString(), ok: true });
  return NextResponse.json({ ok: true });
}

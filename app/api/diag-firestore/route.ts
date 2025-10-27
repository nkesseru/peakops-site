import { NextResponse } from 'next/server';
import { db } from '@/lib/firebaseAdmin';

export const runtime = 'nodejs';

export async function GET() {
  const snap = await db.collection('jobs').limit(1).get();
  return NextResponse.json({ jobsCount: snap.size });
}

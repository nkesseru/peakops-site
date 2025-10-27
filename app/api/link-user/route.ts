import { NextResponse } from 'next/server';
import { adminAuth, db } from '@/lib/firebaseAdmin';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const authz = req.headers.get('authorization') || '';
    const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
    const decoded = await adminAuth.verifyIdToken(token);

    const { orgId, role } = await req.json();
    if (!orgId || !role) return NextResponse.json({ ok: false, error: 'missing fields' }, { status: 400 });

    await db.collection('users').doc(decoded.uid).set({ orgId, role }, { merge: true });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'error' }, { status: 401 });
  }
}

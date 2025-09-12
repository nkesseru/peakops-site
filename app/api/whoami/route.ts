// app/api/whoami/route.ts
import { NextResponse } from 'next/server';
import { getAuth } from 'firebase-admin/auth';
import { db } from '@/lib/firebaseAdmin';

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return NextResponse.json({ error: 'No bearer token' }, { status: 401 });

    const decoded = await getAuth().verifyIdToken(token);
    const { uid, orgId, role } = { uid: decoded.uid, orgId: (decoded as any).orgId, role: (decoded as any).role };

    return NextResponse.json({ uid, orgId, role });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'verify failed' }, { status: 401 });
  }
}

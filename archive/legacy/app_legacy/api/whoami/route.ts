// app/api/whoami/route.ts
import { NextResponse } from 'next/server';
import { adminAuth, adminDb } from '@/lib/firebaseAdmin';

export const runtime = 'nodejs'; // IMPORTANT: Admin SDK needs Node runtime (not edge)

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return NextResponse.json({ error: 'No bearer token' }, { status: 401 });

    // Verify Firebase ID token
    const decoded = await adminAuth.verifyIdToken(token);

    // Optional: fetch user profile (orgId/role) from Firestore
    const userSnap = await adminDb.doc(`users/${decoded.uid}`).get();
    const userData = userSnap.exists ? userSnap.data() : {};
    const orgId = (userData as any)?.orgId ?? (decoded as any)?.orgId ?? null;
    const role  = (userData as any)?.role  ?? (decoded as any)?.role  ?? null;

    return NextResponse.json({ uid: decoded.uid, orgId, role }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'verify failed' }, { status: 401 });
  }
}

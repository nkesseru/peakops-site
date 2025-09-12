import { NextResponse } from 'next/server';
import { adminAuth, db } from '@/lib/firebaseAdmin';

export async function POST(req: Request) {
  try {
    // Expect: Authorization: Bearer <Firebase ID token>
    const authz = req.headers.get('authorization') || '';
    const [, idToken] = authz.split(' ');
    if (!idToken) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

    const { orgId, role } = await req.json();
    if (!orgId || !role) return NextResponse.json({ ok: false, error: 'orgId and role required' }, { status: 400 });

    const decoded = await adminAuth.verifyIdToken(idToken);
    const uid = decoded.uid;

    // Persist user record inside org (nice for lists)
    await db.doc(`organizations/${orgId}/users/${uid}`).set(
      {
        uid,
        email: decoded.email ?? null,
        role,
        active: true,
        linkedAt: new Date(),
      },
      { merge: true }
    );

    // Set custom claims (orgId + role). NOTE: these are cached in the client JWT until refreshed.
    await adminAuth.setCustomUserClaims(uid, { orgId, role });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

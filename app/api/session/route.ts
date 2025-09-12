// app/api/session/route.ts
import { NextResponse } from 'next/server';
import { getAuth } from 'firebase-admin/auth';

export async function POST(req: Request) {
  const { idToken } = await req.json().catch(() => ({}));
  if (!idToken) return NextResponse.json({ error: 'Missing idToken' }, { status: 400 });

  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    const orgId = (decoded as any).orgId || null;
    const role  = (decoded as any).role  || null;
    if (!orgId) return NextResponse.json({ error: 'No orgId in claims' }, { status: 403 });

    const res = NextResponse.json({ ok: true, orgId, role });
    const opts = { httpOnly: true, secure: true, sameSite: 'lax' as const, path: '/', maxAge: 60 * 60 * 24 };
    res.cookies.set('po_org',  orgId, opts);
    res.cookies.set('po_role', role ?? '', opts);
    return res;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'verify failed' }, { status: 401 });
  }
}

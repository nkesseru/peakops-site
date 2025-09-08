import { NextResponse } from 'next/server';
import { db } from '../../../lib/firebaseAdmin';

export const runtime = 'nodejs';

const redact = (s?: string) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : undefined);

export async function GET() {
  try {
    const wroteId = `health_${Date.now()}`;
    await db.collection('_admin_health').doc(wroteId).set({ ts: new Date().toISOString() });

    const [orgsSnap, flagsSnap] = await Promise.all([
      db.collection('orgs').limit(1).get(),
      db.collection('flags').limit(1).get(),
    ]);

    return NextResponse.json({
      ok: true,
      checks: {
        wroteDoc: wroteId,
        canReadOrgs: !orgsSnap.empty,
        canReadFlags: !flagsSnap.empty
      },
      envs: {
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: redact(process.env.FIREBASE_CLIENT_EMAIL || undefined),
        privateKeyPresent:
          !!process.env.FIREBASE_SA_JSON_BASE64 || !!process.env.FIREBASE_PRIVATE_KEY
      }
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}

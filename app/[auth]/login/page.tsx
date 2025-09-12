'use client';

import { useEffect, useState } from 'react';
import { auth, googleProvider } from '@/lib/firebaseClient';
import { signInWithPopup, onAuthStateChanged } from 'firebase/auth';
import Link from 'next/link';

export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return () => unsub();
  }, []);

  async function handleGoogle() {
    try {
      setBusy(true);
      setErr(null);

      // 1) Google popup
      await signInWithPopup(auth, googleProvider);

      // 2) Refresh token so custom claims are present
      const idToken = await auth.currentUser!.getIdToken(true);

      // 3) Send token to server to set cookies (po_org/po_role)
      await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken })
      });

      // 4) Go to dashboard
      window.location.href = '/dashboard';
    } catch (e: any) {
      setErr(e?.message ?? 'Login failed');
      setBusy(false);
    }
  }

  if (user) {
    return (
      <div style={{ padding: 24 }}>
        <h1>Welcome</h1>
        <p>Signed in as {user.email}</p>
        <Link href="/dashboard">Go to Dashboard →</Link>
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>Sign in to PeakOps</h1>
      <button onClick={handleGoogle} disabled={busy}>
        {busy ? 'Signing in…' : 'Continue with Google'}
      </button>
      {err && <p style={{ color: 'crimson', marginTop: 8 }}>{err}</p>}
    </div>
  );
}

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
      await signInWithPopup(auth, googleProvider);   // ← use googleProvider
      await auth.currentUser?.getIdToken(true);
      window.location.href = '/dashboard';
    } catch (e: any) {
      setErr(e?.message ?? 'Login failed');
    } finally {
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
      {err && <p style={{ color: 'crimson' }}>{err}</p>}
    </div>
  );
}

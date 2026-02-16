'use client';

import { signInWithPopup } from 'firebase/auth';
import { auth, provider } from '@/lib/firebaseClient';

export default function LoginClient() {
  const handleLogin = async () => {
    try { await signInWithPopup(auth, provider); }
    catch (e) { console.error(e); }
  };

  return (
    <main style={{ padding: 24 }}>
      <h1>Login</h1>
      <button onClick={handleLogin}>Continue with Google</button>
    </main>
  );
}

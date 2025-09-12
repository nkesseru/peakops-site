'use client';
import { auth, provider } from '@/lib/firebase';
import { signInWithPopup } from 'firebase/auth';

export default function Login() {
  async function signin() { await signInWithPopup(auth, provider); location.href='/dashboard'; }
  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="p-10 rounded-2xl border bg-white/70 backdrop-blur">
        <h1 className="text-2xl font-semibold mb-4">PeakOps Portal</h1>
        <button onClick={signin} className="px-5 py-3 rounded-2xl bg-[#10C4C4] font-semibold">
          Continue with Google
        </button>
      </div>
    </main>
  );
}

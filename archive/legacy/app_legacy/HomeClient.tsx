'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/firebaseClient';            // ✅ NEW client SDK
import { onAuthStateChanged } from 'firebase/auth';

export default function HomeClient() {
  const router = useRouter();
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      router.replace(u ? '/dashboard' : '/login');
    });
    return () => unsub();
  }, [router]);
  return null;
}

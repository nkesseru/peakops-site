'use client';
import { useEffect, useState } from 'react';
import { auth } from '@/lib/firebaseClient';
import { useRouter } from 'next/navigation';
import { getIdTokenResult } from 'firebase/auth';

export function useAuthGuard() {
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  const [claims, setClaims] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return auth.onAuthStateChanged(async (u) => {
      if (!u) {
        setUser(null);
        setClaims(null);
        setLoading(false);
        router.replace('/[auth]/login');
        return;
      }
      const token = await getIdTokenResult(u, true);
      setUser(u);
      setClaims(token.claims || {});
      setLoading(false);
    });
  }, [router]);

  return { user, claims, loading };
}

'use client';
import { ReactNode } from 'react';
import { useAuthGuard } from '@/lib/hooks/useAuthGuard';

export default function Protected({ children, roles }: { children: ReactNode; roles?: string[] }) {
  const { user, claims, loading } = useAuthGuard();
  if (loading) return <div className="p-10">Loading…</div>;
  if (!user) return null; // redirect handled by hook
  if (roles && !roles.includes(String(claims?.role ?? ''))) {
    return <div className="p-10">No access.</div>;
  }
  return <>{children}</>;
}

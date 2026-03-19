// app/admin/AdminClient.tsx  (CLIENT)

'use client';
import { useState } from 'react';
import { auth } from '@/lib/firebaseClient';

export default function AdminClient() {
  const u = auth.currentUser;
  const [busy, setBusy] = useState<'admin'|'dispatcher'|'tech'|null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function link(role: 'admin' | 'dispatcher' | 'tech') {
    try {
      setMsg(null);
      if (!auth.currentUser) {
        setMsg('Sign in first'); return;
      }
      setBusy(role);
      const token = await auth.currentUser.getIdToken();
      const res = await fetch('/api/link-user', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ orgId: 'peakops-telecom-pilot', role }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || 'Link failed');
      setMsg(`Linked as ${role}`);
    } catch (e:any) {
      setMsg(e?.message || 'Link failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="p-8 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-sm text-gray-500">
          {u ? <>Signed in as <span className="font-medium">{u.email}</span></> : 'Not signed in'}
        </p>
      </header>

      <div className="flex flex-wrap gap-3">
        <button
          className="btn btn-primary"
          disabled={!!busy}
          onClick={() => link('admin')}
        >
          {busy === 'admin' ? 'Linking…' : 'Link as Admin'}
        </button>

        <button
          className="btn btn-glass"
          disabled={!!busy}
          onClick={() => link('dispatcher')}
        >
          {busy === 'dispatcher' ? 'Linking…' : 'Link as Dispatcher'}
        </button>

        <button
          className="btn btn-glass"
          disabled={!!busy}
          onClick={() => link('tech')}
        >
          {busy === 'tech' ? 'Linking…' : 'Link as Tech'}
        </button>
      </div>

      {msg && <div className="p text-[14px]">{msg}</div>}
    </main>
  );
}

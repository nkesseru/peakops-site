'use client';
import Protected from '@/components/Protected';
import { auth } from '@/lib/firebaseClient';

export default function AdminInvite() {
  async function link(role: 'admin' | 'dispatcher' | 'tech') {
    const u = auth.currentUser;
    if (!u) return alert('Sign in first');
    const token = await u.getIdToken();
    const res = await fetch('/api/link-user', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ orgId: 'peakops-telecom-pilot', role }),
    });
    const data = await res.json();
    if (!data.ok) return alert('Link failed: ' + data.error);
    await u.getIdToken(true);
    alert(`Linked as ${role}`);
  }

  return (
    <Protected roles={['admin']}>
      <main className="p-6 space-y-3">
        <h1 className="text-xl font-semibold">Invite / Role Link</h1>
        <div className="flex gap-2">
          <button className="border px-3 py-1" onClick={() => link('admin')}>Make Admin</button>
          <button className="border px-3 py-1" onClick={() => link('dispatcher')}>Make Dispatcher</button>
          <button className="border px-3 py-1" onClick={() => link('tech')}>Make Tech</button>
        </div>
      </main>
    </Protected>
  );
}

'use client';
import { auth } from '@/lib/firebaseClient';

export default function LinkToOrgButton() {
  async function link() {
    const u = auth.currentUser;
    if (!u) return alert('Please sign in first.');
    const token = await u.getIdToken(/* forceRefresh */ true);

    const res = await fetch('/api/link-user', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        orgId: 'peakops-telecom-pilot',
        role: 'admin', // change per user or move to /admin invite page
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.ok) {
      console.error(data);
      alert('Failed to link user: ' + (data?.error ?? res.statusText));
      return;
    }

    // Refresh JWT so custom claims are present immediately
    await u.getIdToken(true);
    location.href = '/dashboard';
  }

  return (
    <button onClick={link} className="underline text-sm">
      Link me to PeakOps (admin)
    </button>
  );
}

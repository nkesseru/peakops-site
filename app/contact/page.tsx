'use client';
import { useState } from 'react';
import { Container } from '@/components/Container';
import { GlassCard } from '@/components/GlassCard';

export default function ContactPage() {
  const [loading, setLoading] = useState(false);
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null); setOk(false); setLoading(true);

    const fd = new FormData(e.currentTarget);
    const payload: Record<string, any> = {};
    fd.forEach((v, k) => { payload[k] = v; });

    try {
      const res = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setLoading(false);
      if (res.ok) setOk(true); else setErr((await res.text()) || 'Failed to submit');
    } catch (e: any) {
      setLoading(false);
      setErr(e?.message || 'Failed to submit');
    }
  }

  return (
    <Container>
      <h1 className="h1 mb-6">Talk to PeakOps</h1>
      <GlassCard>
        <form onSubmit={onSubmit} className="grid gap-4 max-w-xl">
          <input name="website" className="hidden" tabIndex={-1} autoComplete="off" />
          <input name="name" placeholder="Full name" required className="btn-glass round-24 px-4 py-3" />
          <input name="email" placeholder="Email" type="email" required className="btn-glass round-24 px-4 py-3" />
          <input name="company" placeholder="Company" className="btn-glass round-24 px-4 py-3" />
          <input name="phone" placeholder="Phone" className="btn-glass round-24 px-4 py-3" />
          <textarea name="message" placeholder="What are you solving?" rows={4} className="btn-glass round-24 px-4 py-3" />
          <input type="hidden" name="source" value="peakops.app/contact" />
          <button disabled={loading} className="btn btn-primary">{loading ? 'Sending…' : 'Send'}</button>
          {ok && <div className="p text-[14px]">Thanks! We’ll reach out shortly.</div>}
          {err && <div className="p text-[14px]" style={{color:'tomato'}}>{err}</div>}
        </form>
      </GlassCard>
    </Container>
  );
}

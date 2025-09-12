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
    const form = new FormData(e.currentTarget);
    const payload = Object.fromEntries(form.entries());
    const res = await fetch('/api/lead', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    setLoading(false);
    if (res.ok) setOk(true); else setErr((await res.text()) || 'Failed to submit');
  }

  return (
    <Container>
      <h1 className="h1 mb-6">Talk to PeakOps</h1>
      <GlassCard>
        <form onSubmit={onSubmit} className="grid gap-4 max-w-xl">
          <input name="name" placeholder="Full name" required className="btn-glass round-24 px-4 py-3" />
          <input name="email" placeholder="Email" type="email" required className="btn-glass round-24 px-4 py-3" />
          <input name="company" placeholder="Company" className="btn-glass round-24 px-4 py-3" />
          <input name="phone" placeholder="Phone" className="btn-glass round-24 px-4 py-3" />
          <textarea name="message" placeholder="What are you solving?" rows={4} className="btn-glass round-24 px-4 py-3" />
          <button disabled={loading} className="btn btn-primary">{loading ? 'Sending…' : 'Send'}</button>
          {ok && <div className="p text-[14px]">Thanks! We’ll reach out shortly.</div>}
          {err && <div className="p text-[14px]" style={{color:'tomato'}}>{err}</div>}
        </form>
      </GlassCard>
    </Container>
  );
}ø


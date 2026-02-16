import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, email, phone, company, message } = body || {};

    if (!name || !email) {
      return new NextResponse('Missing name or email', { status: 400 });
    }

    const url = process.env.GHL_WEBHOOK_URL;
    if (!url) return new NextResponse('Server not configured', { status: 500 });

    // Forward to GHL (or any CRM)
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'peakops.app',
        name, email, phone, company, message,
        createdAt: new Date().toISOString()
      })
    });

    if (!r.ok) {
      const text = await r.text();
      return new NextResponse(`Upstream error: ${text}`, { status: 502 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return new NextResponse(e?.message || 'Unknown error', { status: 500 });
  }
}

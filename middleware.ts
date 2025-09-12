import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const host = req.headers.get('host') ?? '';
  if (host.startsWith('telecom.peakops.app') && req.nextUrl.pathname === '/') {
    return NextResponse.redirect(new URL('/telecom', req.url));
  }
  return NextResponse.next();
}

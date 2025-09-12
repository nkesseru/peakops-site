import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const isLogin = req.nextUrl.pathname.startsWith('/[auth]/login');
  // later: check a real session cookie here
  if (!isLogin && req.nextUrl.pathname.startsWith('/dashboard')) {
    // TODO: when session cookie is in place, only redirect if missing
    return NextResponse.next();
  }
  return NextResponse.next();
}
export const config = { matcher: ['/dashboard/:path*'] };

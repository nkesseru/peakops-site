// app/login/page.tsx
export const revalidate = 0;              
export const dynamic = 'force-dynamic';   
export const runtime = 'nodejs';

import LoginClient from './LoginClient';

export default function LoginPage() {
  return <LoginClient />;
}

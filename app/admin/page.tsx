// app/admin/page.tsx  (SERVER)
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

import AdminClient from './AdminClient';

export default function AdminPage() {
  return <AdminClient />;
}

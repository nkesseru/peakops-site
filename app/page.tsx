// app/page.tsx (SERVER)
export const dynamic = 'force-dynamic';

import HomeClient from './HomeClient';

export default function Home() {
  return <HomeClient />;
}

export const dynamic = "force-dynamic"; // ⛔ no static export for "/"
export const runtime = "nodejs";        // use Node runtime, not Edge

import HomeClient from "@/components/HomeClient";

export default function Home() {
  return <HomeClient />;
}

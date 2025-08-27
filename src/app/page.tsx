export const runtime = "nodejs";
export const dynamic = "force-dynamic";
import HelloClient from "@/components/HelloClient";

export default function Home() {
  return (
    <section className="p-10">
      <h1 className="text-4xl font-bold">PeakOps Starter ✅</h1>
      <HelloClient />
    </section>
  );
}

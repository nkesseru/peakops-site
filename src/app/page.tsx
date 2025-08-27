export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <section className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-10">
      <h1 className="text-4xl font-bold">PeakOps Starter ✅</h1>
      <p className="text-gray-600">No server fetch on this page.</p>
    </section>
  );
}

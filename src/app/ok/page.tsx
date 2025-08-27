export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// "use client";  // not needed, but harmless if you add it

export default function OkPage() {
  return (
    <section className="p-10">
      <h1 className="text-3xl font-bold">/ok is up ✅</h1>
      <p>No server fetch anywhere on this route.</p>
    </section>
  );
}


export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function OkPage() {
  return (
    <section className="p-10">
      <h1 className="text-3xl font-bold">/ok is up ✅</h1>
      <p>No server fetch, no imports, no CSS.</p>
    </section>
  );
}

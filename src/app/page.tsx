"use client";  // <-- forces this page to run only on the client

export default function Home() {
  return (
    <section className="p-10">
      <h1 className="text-4xl font-bold">PeakOps Starter ✅</h1>
      <p>This page is client-only, so SSR cannot fetch.</p>
    </section>
  );
}

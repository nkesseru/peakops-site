import Button from "@/components/Button";
import { getBaseUrl } from "@/lib/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Home() {
  let message = "unavailable";
  try {
    const res = await fetch(`${getBaseUrl()}/api/hello`, {
      cache: "no-store",
      next: { revalidate: 0 },
    });
    if (res.ok) {
      const data = await res.json();
      message = data.message ?? "ok";
    }
  } catch (e) {
    console.error("HOME /api/hello fetch failed:", e);
  }

  return (
    <section className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-10">
      <h1 className="text-4xl font-bold">Hello Alias + Layout ✅</h1>
      <p className="text-gray-600">
        API says: <span className="font-mono">{message}</span>
      </p>
      <Button />
    </section>
  );
}

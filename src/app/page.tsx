import Button from "@/components/Button";
import { getBaseUrl } from "@/lib/url";

export default async function Home() {
  let message = "unavailable";
  try {
    const res = await fetch(`${getBaseUrl()}/api/hello`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      message = data.message ?? "ok";
    }
  } catch { /* swallow to avoid SSR crash */ }

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

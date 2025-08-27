import Button from "@/components/Button";
import { headers } from "next/headers";

export default async function Home() {
  // Build the correct absolute URL for both local dev and Vercel
  const host = headers().get("host")!;
  const protocol = process.env.VERCEL ? "https" : "http";
  const res = await fetch(`${protocol}://${host}/api/hello`, { cache: "no-store" });
  const data = await res.json();

  return (
    <section className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-10">
      <h1 className="text-4xl font-bold">Hello Alias + Layout ✅</h1>
      <p className="text-gray-600">
        API says: <span className="font-mono">{data.message}</span>
      </p>
      <Button />
    </section>
  );
}

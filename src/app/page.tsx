import Button from "@/components/Button";
import { getHello } from "@/lib/api/hello";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Home() {
  const { message } = await getHello(); // ✅ no network, no base URL

  return (
    <section className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-10">
      <h1 className="text-4xl font-bold">Hello Alias + Layout ✅</h1>
      <p className="text-gray-600">API says: <span className="font-mono">{message}</span></p>
      <Button />
    </section>
  );
}

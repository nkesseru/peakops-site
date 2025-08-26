import Button from "@/components/Button";

export default async function Home() {
  const res = await fetch("http://localhost:3000/api/hello", { cache: "no-store" });
  const data = await res.json();

  return (
    <section className="flex min-h-[70vh] flex-col items-center justify-center gap-6 p-10">
      <h1 className="text-4xl font-bold">Hello Alias + Layout ✅</h1>
      <p className="text-gray-600">API says: <span className="font-mono">{data.message}</span></p>
      <Button />
    </section>
  );
}

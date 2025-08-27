import { getBaseUrl } from "@/lib/url";

async function check(path: string, timeoutMs = 2500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${getBaseUrl()}${path}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(t);
    return { path, ok: res.ok, status: res.status };
  } catch (e) {
    clearTimeout(t);
    return { path, ok: false, status: 0 };
  }
}

export default async function Status() {
  const [hello, ping, health] = await Promise.all([
    check("/api/hello"),
    check("/api/ping"),
    check("/api/health"),
  ]);

  const items = [hello, ping, health];

  return (
    <section className="max-w-xl mx-auto p-6">
      <h1 className="text-3xl font-bold mb-4">System Status</h1>
      <ul className="space-y-2">
        {items.map((i) => (
          <li key={i.path} className="flex items-center justify-between rounded border p-3">
            <span className="font-mono">{i.path}</span>
            <span className={i.ok ? "text-green-600" : "text-red-600"}>
              {i.ok ? `OK (${i.status})` : "DOWN"}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-gray-500 mt-4">
        This page does live pings server-side with timeouts and no cache.
      </p>
    </section>
  );
}

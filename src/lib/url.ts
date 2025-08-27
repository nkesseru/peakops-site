import { headers } from "next/headers";

/** Build an absolute URL that works on both localhost (dev) and Vercel (prod). */
export function getBaseUrl() {
  // On the server, Next provides request headers
  const h = headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = process.env.VERCEL ? "https" : (h.get("x-forwarded-proto") ?? "http");
  return `${proto}://${host}`;
}

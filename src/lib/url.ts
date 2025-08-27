// safe baseUrl helper (no localhost in prod)
export function getBaseUrl() {
  if (typeof window !== "undefined") {
    // Client-side
    return "";
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL;
  }
  // Default dev fallback
  return "http://localhost:3000";
}

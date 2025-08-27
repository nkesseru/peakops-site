// Safe base URL helper — no localhost in production
export function getBaseUrl() {
  if (typeof window !== "undefined") {
    // Running in the browser, relative fetch works
    return "";
  }
  if (process.env.VERCEL_URL) {
    // Vercel provides this automatically (no protocol)
    return `https://${process.env.VERCEL_URL}`;
  }
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    // Optional: set this in Vercel env if you want a custom domain
    return process.env.NEXT_PUBLIC_SITE_URL;
  }
  // Development fallback only
  return "http://localhost:3000";
}

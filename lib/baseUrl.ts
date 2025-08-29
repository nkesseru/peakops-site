export function getBaseUrl() {
  // Prefer explicit site URL
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  // Vercel server env provides this (no protocol)
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  // Only in true local dev use localhost
  return "http://localhost:3000";
}

/** Build an absolute base URL that works locally & on Vercel without request context. */
export function getBaseUrl() {
  // Vercel provides VERCEL_URL without protocol, e.g. "peakops-next.vercel.app"
  const vercel = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null;
  const explicit = process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || null;
  const local = 'http://localhost:3000';
  return explicit || vercel || local;
}

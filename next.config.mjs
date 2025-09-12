/** @type {import('next').NextConfig} */
const nextConfig = {
  // IMPORTANT: do NOT set output: 'export'
  // Ensure server/edge routes can run:
  experimental: {}
};

export default nextConfig;
// If using next.config.js, use: module.exports = nextConfig;

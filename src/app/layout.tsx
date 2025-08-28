export const dynamic = "force-dynamic";  // ⛔ stop static prerender
export const runtime = "nodejs";         // run on Node, not Edge

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

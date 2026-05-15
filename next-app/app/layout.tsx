import "./globals.css";
import { Suspense } from "react";
import DiagnosticsPanel from "../components/DiagnosticsPanel";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, backgroundColor: "#000", color: "#fff" }}>
        {children}
        {/* PEAKOPS_DIAGNOSTICS_PANEL_V1: gated by ?debug=1 in URL;
            returns null and runs zero auth hooks when the flag is absent.
            Wrapped in Suspense because DiagnosticsPanel uses
            useSearchParams(), which Next.js requires inside a
            suspense boundary when mounted on statically-prerendered
            routes (e.g., /admin/health). */}
        <Suspense fallback={null}>
          <DiagnosticsPanel />
        </Suspense>
      </body>
    </html>
  );
}

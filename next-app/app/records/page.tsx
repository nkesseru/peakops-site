import { Suspense } from "react";
import RecordsClient from "./RecordsClient";

export default function RecordsPage() {
  // Wrapped in Suspense because RecordsClient calls useSearchParams
  // (for the ?filter= URL persistence). Next.js requires the
  // boundary for any client component that reads search params on
  // a route that participates in static prerender.
  return (
    <Suspense fallback={null}>
      <RecordsClient />
    </Suspense>
  );
}

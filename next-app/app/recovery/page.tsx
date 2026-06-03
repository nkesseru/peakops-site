// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
// /recovery — operator queue route. Wraps the client component with
// the standard Suspense boundary (mirrors PR 119b/123/126b pattern
// for Next 16 useSearchParams).

import { Suspense } from "react";
import RecoveryListClient from "./RecoveryListClient";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <RecoveryListClient />
    </Suspense>
  );
}

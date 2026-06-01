// PEAKOPS_TEMPLATES_EDITOR_V1 (PR 119b)
// /admin/templates — list view. Server component wraps the client.
//
// PR 120b hotfix — TemplatesListClient uses useSearchParams() which
// Next 16 requires inside a Suspense boundary for prerender to
// succeed. Same shape as ../new and ../[templateKey].
import { Suspense } from "react";
import TemplatesListClient from "./TemplatesListClient";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <TemplatesListClient />
    </Suspense>
  );
}

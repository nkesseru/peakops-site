// PEAKOPS_CUSTOMER_REVIEW_UI_V1 (PR 126b)
//
// /review/[token] — the only customer-facing route in PeakOps.
//
// Public: no auth, no Firebase login, no cookie gate. The token in the
// URL IS the credential. Middleware (next-app/middleware.ts) matcher
// scopes to /admin/:path* only — /review/* falls through without any
// allowlist change required.
//
// Next 16: params is async; await before passing into the client.
//
// No Suspense boundary needed here — the client component uses its
// own loading state (no useSearchParams).

import CustomerReviewClient from "./CustomerReviewClient";

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return <CustomerReviewClient token={String(token || "").trim()} />;
}

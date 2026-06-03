// PEAKOPS_RECOVERY_UI_V1 (PR 127b)
// /recovery/[caseId] — case detail route.

import { Suspense } from "react";
import RecoveryCaseClient from "./RecoveryCaseClient";

export default async function Page({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  return (
    <Suspense fallback={null}>
      <RecoveryCaseClient caseId={String(caseId || "").trim()} />
    </Suspense>
  );
}

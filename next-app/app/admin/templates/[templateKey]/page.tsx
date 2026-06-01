// PEAKOPS_TEMPLATES_EDITOR_V1 (PR 119b)
// /admin/templates/[templateKey] — edit mode. templateKey from route
// params; orgId from query.
//
// PR 120b hotfix — Next 16 requires useSearchParams() to be wrapped
// in a Suspense boundary. Same fix shape as ../new/page.tsx.
"use client";

import { Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import TemplateEditorClient from "../_components/TemplateEditorClient";

function EditTemplateContent() {
  const params = useParams();
  const sp = useSearchParams();
  const templateKey = String(params?.templateKey || "").trim();
  let orgId = String(sp?.get("orgId") || "").trim();
  if (!orgId && typeof window !== "undefined") {
    try { orgId = String(localStorage.getItem("peakops_orgId") || "").trim(); } catch { /* */ }
  }
  return <TemplateEditorClient orgId={orgId} templateKey={templateKey} createMode={false} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <EditTemplateContent />
    </Suspense>
  );
}

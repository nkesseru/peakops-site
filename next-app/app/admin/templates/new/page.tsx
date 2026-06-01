// PEAKOPS_TEMPLATES_EDITOR_V1 (PR 119b)
// /admin/templates/new — create mode. Reads orgId from query.
//
// PR 120b hotfix — Next 16 requires useSearchParams() to be wrapped
// in a Suspense boundary. Without one, static prerender fails on
// this route (build error: "useSearchParams() should be wrapped in
// a suspense boundary"). The orgId resolution is the only thing
// that needs the search params; everything else can wait in the
// fallback. fallback={null} is fine because TemplateEditorClient
// renders its own RequireAuth loading state.
"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import TemplateEditorClient from "../_components/TemplateEditorClient";

function NewTemplateContent() {
  const sp = useSearchParams();
  let orgId = String(sp?.get("orgId") || "").trim();
  if (!orgId && typeof window !== "undefined") {
    try { orgId = String(localStorage.getItem("peakops_orgId") || "").trim(); } catch { /* */ }
  }
  return <TemplateEditorClient orgId={orgId} createMode={true} />;
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <NewTemplateContent />
    </Suspense>
  );
}

// PEAKOPS_TEMPLATES_EDITOR_V1 (PR 119b)
// /admin/templates/[templateKey] — edit mode. templateKey from route
// params; orgId from query.
"use client";

import { useParams, useSearchParams } from "next/navigation";
import TemplateEditorClient from "../_components/TemplateEditorClient";

export default function Page() {
  const params = useParams();
  const sp = useSearchParams();
  const templateKey = String(params?.templateKey || "").trim();
  let orgId = String(sp?.get("orgId") || "").trim();
  if (!orgId && typeof window !== "undefined") {
    try { orgId = String(localStorage.getItem("peakops_orgId") || "").trim(); } catch { /* */ }
  }
  return <TemplateEditorClient orgId={orgId} templateKey={templateKey} createMode={false} />;
}

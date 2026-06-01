// PEAKOPS_TEMPLATES_EDITOR_V1 (PR 119b)
// /admin/templates/new — create mode. Reads orgId from query.
"use client";

import { useSearchParams } from "next/navigation";
import TemplateEditorClient from "../_components/TemplateEditorClient";

export default function Page() {
  const sp = useSearchParams();
  let orgId = String(sp?.get("orgId") || "").trim();
  if (!orgId && typeof window !== "undefined") {
    try { orgId = String(localStorage.getItem("peakops_orgId") || "").trim(); } catch { /* */ }
  }
  return <TemplateEditorClient orgId={orgId} createMode={true} />;
}

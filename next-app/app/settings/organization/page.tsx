// PEAKOPS_ORG_SETTINGS_V1 (2026-05-11) — Slice Branding 1.0.
// Server wrapper for the /settings/organization route. Follows the
// same RequireAuth + Suspense pattern as /settings, so an
// unauthenticated visitor sees the standard auth-gate shell instead
// of any org-level UI.
import { Suspense } from "react";
import RequireAuth from "@/components/RequireAuth";
import OrganizationClient from "./OrganizationClient";

export default function OrganizationSettingsPage() {
  return (
    <Suspense fallback={null}>
      <RequireAuth>
        <OrganizationClient />
      </RequireAuth>
    </Suspense>
  );
}

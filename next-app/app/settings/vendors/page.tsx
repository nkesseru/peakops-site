// PEAKOPS_VENDOR_SETTINGS_V1 (2026-05-04)
// Server wrapper for /settings/vendors. Suspense boundary required
// because SettingsVendorsClient calls useSearchParams() (orgId
// preservation on the back link, same pattern as /settings and
// /settings/team).
import { Suspense } from "react";
import RequireAuth from "@/components/RequireAuth";
import SettingsVendorsClient from "./SettingsVendorsClient";

export default function SettingsVendorsPage() {
  return (
    <Suspense fallback={null}>
      <RequireAuth>
        <SettingsVendorsClient />
      </RequireAuth>
    </Suspense>
  );
}

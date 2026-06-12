// PEAKOPS_USER_SETTINGS_V1 (2026-05-04)
// Server wrapper for the /settings route. The client component
// handles auth-gating, data load, and the form — same pattern other
// authenticated pages in this app use. Suspense boundary required
// because SettingsClient calls useSearchParams() (to preserve orgId
// on the Back link); without it, Next 14+ aborts the static
// prerender for the page.
import { Suspense } from "react";
import RequireAuth from "@/components/RequireAuth";
import SettingsClient from "./SettingsClient";

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <RequireAuth>
        <SettingsClient />
      </RequireAuth>
    </Suspense>
  );
}

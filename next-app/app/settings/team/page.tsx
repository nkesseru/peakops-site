// PEAKOPS_TEAM_SETTINGS_V1 (2026-05-04)
// Server wrapper for /settings/team. Suspense boundary required
// because SettingsTeamClient calls useSearchParams() (orgId
// preservation on the back link, same pattern as /settings).
import { Suspense } from "react";
import RequireAuth from "@/components/RequireAuth";
import SettingsTeamClient from "./SettingsTeamClient";

export default function SettingsTeamPage() {
  return (
    <Suspense fallback={null}>
      <RequireAuth>
        <SettingsTeamClient />
      </RequireAuth>
    </Suspense>
  );
}

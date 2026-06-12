// PEAKOPS_SETTINGS_PROFILE_ROUTE_V1 (2026-05-04)
// Alias route for /settings/profile. The Profile tab in the settings
// nav was already styled with `aria-current="page"` and `href="#"`
// in SettingsClient — but several places in the app linked to
// `/settings/profile` directly, which 404'd. Rather than a redirect
// that flashes the URL, this renders the same SettingsClient as
// `/settings`, so deep-linking works either way and the active-tab
// state stays correct.
//
// Suspense boundary required for the same reason as `/settings` —
// SettingsClient calls `useSearchParams()`, and Next 14+ refuses
// to prerender a route whose body reads search params without
// being explicitly wrapped.
import { Suspense } from "react";
import SettingsClient from "../SettingsClient";

export default function SettingsProfilePage() {
  return (
    <Suspense fallback={null}>
      <SettingsClient />
    </Suspense>
  );
}

// PEAKOPS_ONBOARDING_V1 (2026-05-06)
// Server wrapper for the /onboarding route. Mirrors the
// /settings + /incidents pattern: thin server file holding the
// Suspense boundary so the client component can call
// useSearchParams() (we read ?step=, ?orgId=, ?industry= for
// deep-linking into a specific step) without aborting the static
// prerender.
import { Suspense } from "react";
import OnboardingClient from "./OnboardingClient";

export default function OnboardingPage() {
  return (
    <Suspense fallback={null}>
      <OnboardingClient />
    </Suspense>
  );
}

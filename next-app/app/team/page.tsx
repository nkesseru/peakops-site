// PEAKOPS_TEAM_SETTINGS_V2 (2026-05-04)
// Convenience alias: /team → /settings/team. Server-side redirect so
// the user never sees an intermediate render. orgId query param is
// preserved when present; if it's not on the URL, the destination
// page resolves it from localStorage / claims (it's set up to do
// that already — same priority chain as /settings/team itself).
import { redirect } from "next/navigation";

export default async function TeamRedirectPage({
  searchParams,
}: {
  // Next 15+ async searchParams shape.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params?.orgId;
  const orgId = String(Array.isArray(raw) ? raw[0] : raw || "").trim();
  const target = orgId
    ? `/settings/team?orgId=${encodeURIComponent(orgId)}`
    : "/settings/team";
  redirect(target);
}

import TeamClient from "./TeamClient";

// PEAKOPS_RAPID_ACCESS_RECOVERY_V1 (PR 49)
// Server-component shell. The real work — gating by Firebase claim,
// fetching the roster, and the recovery panel — lives in the client
// component so it can use useAuth() + authedFetch.
//
// URL contract:
//   /team?orgId=<orgId>
// orgId is required; the client surfaces a clear "select an org"
// state when it's missing rather than 500ing.

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ orgId?: string }>;
}) {
  const params = await searchParams;
  const orgId = String(params?.orgId || "").trim();
  return <TeamClient orgId={orgId} />;
}

import NotesClient from "./NotesClient";

// PEAKOPS_NOTES_ORGID_URL_V1
// orgId is URL-sourced, matching every other incident surface. Previously this
// page hardcoded `orgId="org_001"`, which silently overrode the real org on
// save/load/redirect — the save worked on the wrong org's doc, the redirect
// landed on /incidents/<id>?orgId=org_001, and the incident page fired
// getIncidentV1 against org_001 and got 409 org_mismatch. No default here —
// if URL has no ?orgId=, the downstream client falls through to its own
// getIncidentNotesV1 error handling rather than silently targeting a wrong org.
export default async function NotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ incidentId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { incidentId } = await params;
  const sp = searchParams ? await searchParams : {};
  const raw = sp?.orgId;
  const orgId = String(Array.isArray(raw) ? raw[0] : (raw || "")).trim();
  return <NotesClient incidentId={incidentId} orgId={orgId} />;
}

import JobDetailClient from "./JobDetailClient";

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ incidentId?: string; orgId?: string }>;
}) {
  const { jobId } = await params;
  const sp = await searchParams;
  return (
    <JobDetailClient
      jobId={jobId}
      initialIncidentId={String(sp?.incidentId || "")}
      initialOrgId={String(sp?.orgId || "")}
    />
  );
}

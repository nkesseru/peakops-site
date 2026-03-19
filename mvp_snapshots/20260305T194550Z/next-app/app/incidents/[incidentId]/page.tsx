import IncidentClient from "./IncidentClient";

export default async function IncidentPage({
  params,
}: {
  params: Promise<{ incidentId: string }>;
}) {
  const { incidentId } = await params;
  return <IncidentClient incidentId={incidentId} />;
}

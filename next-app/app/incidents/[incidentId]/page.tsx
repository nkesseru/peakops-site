import RequireAuth from "@/components/RequireAuth";
import IncidentClient from "./IncidentClient";

export default async function IncidentPage({
  params,
}: {
  params: Promise<{ incidentId: string }>;
}) {
  const { incidentId } = await params;
  return (
    <RequireAuth>
      <IncidentClient incidentId={incidentId} />
    </RequireAuth>
  );
}

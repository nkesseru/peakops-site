import RequireAuth from "@/components/RequireAuth";
import SummaryClient from "./SummaryClient";

export default async function SummaryPage({ params }: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await params;
  return (
    <RequireAuth>
      <SummaryClient incidentId={incidentId} />
    </RequireAuth>
  );
}


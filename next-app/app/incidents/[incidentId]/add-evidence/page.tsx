import AddEvidenceClient from "./AddEvidenceClient";

export default async function Page({
  params,
}: {
  params: Promise<{ incidentId: string }>;
}) {
  const { incidentId } = await params;
  return <AddEvidenceClient incidentId={incidentId} />;
}

import NotesClient from "./NotesClient";

export default async function NotesPage({ params }: { params: Promise<{ incidentId: string }> }) {
  const { incidentId } = await params;
  return <NotesClient incidentId={incidentId} orgId="org_001" />;
}

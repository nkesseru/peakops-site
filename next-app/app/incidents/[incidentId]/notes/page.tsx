import NotesClient from "./NotesClient";

export default async function NotesPage({
  params,
  searchParams,
}: {
  params: Promise<{ incidentId: string }>;
  searchParams: Promise<{ orgId?: string | string[] }>;
}) {
  const { incidentId } = await params;
  const sp = await searchParams;
  const raw = Array.isArray(sp.orgId) ? sp.orgId[0] : sp.orgId;
  const orgId = String(raw || "").trim();

  if (!orgId) {
    return (
      <main className="min-h-screen bg-black text-white">
        <div className="p-6 space-y-3">
          <h1 className="text-lg font-semibold">Notes unavailable</h1>
          <p className="text-sm text-gray-300">
            This page needs an <code className="px-1 py-0.5 rounded bg-white/10">orgId</code> in the URL.
            Open Notes from the Incident page, or include{" "}
            <code className="px-1 py-0.5 rounded bg-white/10">?orgId=&lt;your-org-id&gt;</code> in the URL.
          </p>
        </div>
      </main>
    );
  }

  return <NotesClient incidentId={incidentId} orgId={orgId} />;
}

import AddAddendumClient from "./AddAddendumClient";

export default async function AddAddendumPage({
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
        <div className="p-6 space-y-3 max-w-2xl mx-auto">
          <h1 className="text-lg font-semibold">Addendum filing unavailable</h1>
          <p className="text-sm text-gray-300">
            This page needs an <code className="px-1 py-0.5 rounded bg-white/10">orgId</code> in the URL.
            Open it from the Summary page&apos;s sealed-record panel.
          </p>
        </div>
      </main>
    );
  }

  return <AddAddendumClient incidentId={incidentId} orgId={orgId} />;
}

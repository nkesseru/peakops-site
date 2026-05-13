import RequireAuth from "@/components/RequireAuth";
import ReviewClient from "./ReviewClient";

export default async function Page({ params }: { params: any }) {
  const p: any = await params;
  return (
    <RequireAuth>
      <ReviewClient incidentId={p.incidentId} />
    </RequireAuth>
  );
}


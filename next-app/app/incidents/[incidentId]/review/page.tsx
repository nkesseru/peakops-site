import ReviewClient from "./ReviewClient";

export default async function Page({ params }: { params: any }) {
  const p: any = await params;
  return <ReviewClient incidentId={p.incidentId} />;
}


"use client";

import { useRouter } from "next/navigation";

export default function AddEvidenceButton({ incidentId }: { incidentId: string }) {
  const router = useRouter();

  return (
    <button
      onClick={() => router.push(`/incidents/${incidentId}/add-evidence`)}
      className="
        w-full py-5 rounded-xl
        bg-blue-600 active:bg-blue-700
        text-lg font-semibold
        flex items-center justify-center
        gap-2
      "
    >
      ➕ Add Evidence
    </button>
  );
}

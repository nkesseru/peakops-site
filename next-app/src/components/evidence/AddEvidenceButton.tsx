"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function AddEvidenceButton({
  incidentId,
  orgId,
}: {
  incidentId: string;
  orgId: string;
}) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const startSessionAndGo = () => {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[add-evidence]", {
        step: "click",
        disabled: busy,
        hasInput: false,
        isUserGesture: true,
        ts: Date.now(),
      });
    }
    if (busy) return;
    setBusy(true);
    try {
      const q = `?orgId=${encodeURIComponent(String(orgId || "").trim())}`;
      router.push(`/incidents/${incidentId}/add-evidence${q}`);
      if (process.env.NODE_ENV !== "production") {
        console.warn("[add-evidence]", { step: "navigate", ts: Date.now() });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={startSessionAndGo}
      disabled={busy}
      title="Add evidence (starts a field session if needed)"
      className={
        "px-4 py-2 rounded-xl text-sm font-semibold border transition " +
        (busy
          ? "bg-white/5 border-white/10 text-gray-400 cursor-wait"
          : "bg-white/8 border-white/12 text-white hover:bg-white/12")
      }
    >
      Add evidence
    </button>
  );
}

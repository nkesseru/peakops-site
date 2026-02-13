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

  const startSessionAndGo = async () => {
    if (busy) return;
    setBusy(true);

    try {
      const base = (process.env.NEXT_PUBLIC_FUNCTIONS_BASE || "").trim();
      if (!base) throw new Error("Missing NEXT_PUBLIC_FUNCTIONS_BASE");

      const techUserId = (process.env.NEXT_PUBLIC_TECH_USER_ID || "tech_web").trim();

      const res = await fetch(`${base}/startFieldSessionV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          incidentId,
          createdBy: "ui",
          techUserId,
        }),
      });

      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out?.ok || !out?.sessionId) {
        throw new Error(out?.error || `Could not start field session (${res.status})`);
      }

      const sid = String(out.sessionId || "").trim();
      if (!sid) throw new Error("startFieldSessionV1 returned no sessionId");

      try { localStorage.setItem("peakops_active_session_" + String(incidentId || ""), sid); } catch {}

      router.push(`/incidents/${incidentId}/add-evidence?sid=${encodeURIComponent(sid)}`);
    } catch (e: any) {
      console.error(e);
      alert(e?.message || "Could not start field session");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
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

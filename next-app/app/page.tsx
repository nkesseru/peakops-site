"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const DEMO_INCIDENT_ID = "inc_demo";

function inferRecentIncidentId(): string {
  try {
    const direct = String(localStorage.getItem("peakops_last_incident_id") || "").trim();
    if (direct) return direct;

    const fromSessionKey = Object.keys(localStorage)
      .filter((k) => k.startsWith("peakops_active_session_"))
      .map((k) => k.replace("peakops_active_session_", "").trim())
      .find(Boolean);
    return String(fromSessionKey || "").trim();
  } catch {
    return "";
  }
}

export default function HomePage() {
  const router = useRouter();
  const isDev = process.env.NODE_ENV !== "production";
  const [incidentId, setIncidentId] = useState("");

  const devTarget = useMemo(() => {
    const inferred = inferRecentIncidentId();
    return inferred || DEMO_INCIDENT_ID;
  }, []);

  useEffect(() => {
    if (!isDev) return;
    router.replace(`/incidents/${encodeURIComponent(devTarget)}`);
  }, [isDev, devTarget, router]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const id = String(incidentId || "").trim();
    if (!id) return;
    router.push(`/incidents/${encodeURIComponent(id)}`);
  }

  if (isDev) {
    return (
      <main style={{ padding: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Opening Incident…</h1>
        <p style={{ opacity: 0.75, marginTop: 8 }}>
          Redirecting to <code>{devTarget}</code>
        </p>
      </main>
    );
  }

  return (
    <main style={{ padding: 20, maxWidth: 680 }}>
      <h1 style={{ marginTop: 0 }}>Open an Incident</h1>
      <p style={{ opacity: 0.8 }}>
        Paste an incident ID to open the field incident page.
      </p>
      <form onSubmit={onSubmit} style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={incidentId}
          onChange={(e) => setIncidentId(e.target.value)}
          placeholder="inc_..."
          style={{ flex: 1, padding: "8px 10px" }}
        />
        <button type="submit" style={{ padding: "8px 12px" }}>
          Open
        </button>
      </form>
    </main>
  );
}

"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

const EXAMPLES = [
  "inc_20260211_121658_26f47b",
  "inc_TEST",
];

export default function IncidentsIndexPage() {
  const router = useRouter();
  const [incidentId, setIncidentId] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const id = String(incidentId || "").trim();
    if (!id) return;
    router.push(`/incidents/${encodeURIComponent(id)}`);
  }

  return (
    <main style={{ padding: 20, maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>Incidents</h1>
      <p style={{ opacity: 0.8 }}>Paste an incident ID to open a specific incident.</p>
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

      <div style={{ marginTop: 14 }}>
        <div style={{ opacity: 0.75, marginBottom: 6 }}>Examples</div>
        {EXAMPLES.map((id) => (
          <div key={id}>
            <a href={`/incidents/${encodeURIComponent(id)}`}>{id}</a>
          </div>
        ))}
      </div>
    </main>
  );
}

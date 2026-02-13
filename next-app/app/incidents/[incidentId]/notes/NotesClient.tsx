"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getFunctionsBase } from "@/lib/functionsBase";

async function postJson<T>(url: string, body: any): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status} ${txt}`);
  return JSON.parse(txt) as T;
}

export default function NotesClient({ incidentId, orgId }: { incidentId: string; orgId: string }) {
  const router = useRouter();
  const functionsBase = getFunctionsBase();

  const [incidentNotes, setIncidentNotes] = useState("");
  const [siteNotes, setSiteNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setMsg("Loading…");
        const out: any = await postJson(`${functionsBase}/getIncidentNotesV1`, { orgId, incidentId });
        if (!alive) return;
        if (!out?.ok) throw new Error(out?.error || "load failed");
        setIncidentNotes(String(out?.incidentNotes || ""));
        setSiteNotes(String(out?.siteNotes || ""));
        setMsg("");
      } catch (e: any) {
        if (!alive) return;
        setMsg((e && (e.message || String(e))) || "load failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, [functionsBase, orgId, incidentId]);

  async function save(updatedBy: string = "ui") {
    setSaving(true);
    setMsg("");
    try {
      const out: any = await postJson(`${functionsBase}/saveIncidentNotesV1`, {
        orgId,
        incidentId,
        incidentNotes,
        siteNotes,
        updatedBy,
      });
      if (!out?.ok) throw new Error(out?.error || "save failed");
      // PEAKOPS_NOTES_SAVED_HOOK: tells incident page instantly (optimistic readiness)
      try {
        localStorage.setItem("peakops_notes_saved_" + String(incidentId), String(Date.now()));
      } catch {}
      setMsg("Saved ✓")
      // OPTIMISTIC NOTES_SAVED timeline event
      try {
        const evt = {
          id: "opt_notes_" + Date.now(),
          type: "NOTES_SAVED",
          occurredAt: { _seconds: Math.floor(Date.now() / 1000) },
          source: "ui",
        };
        (window as any).__PEAKOPS_ADD_TIMELINE__?.(evt);
      } catch {}
;
      setTimeout(() => setMsg(""), 1800);
    } catch (e: any) {
      setMsg((e && (e.message || String(e))) || "save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-black text-white">

      <div className="sticky top-0 z-20 bg-black/80 backdrop-blur border-b border-white/10 px-4 py-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-gray-200">Notes</div>
        <button
          type="button"
          className="text-xs px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-gray-200 hover:bg-white/10"
          onClick={() => window.history.back()}
        >
          ← Back to Incident
        </button>
      </div>

      <div className="p-4 space-y-4">
        <button
          className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-sm"
          onClick={() => router.back()}
        >
          ← Back
        </button>
      </div>

      <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
        <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">Incident Notes</div>
        <textarea
          className="w-full min-h-[160px] bg-black/30 border border-white/10 rounded-xl p-3 text-sm outline-none"
          placeholder="What happened? Key decisions, summary, impact..."
          value={incidentNotes}
          onChange={(e) => setIncidentNotes(e.target.value)}
        />
      </section>

      <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
        <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">Site Notes</div>
        <textarea
          className="w-full min-h-[160px] bg-black/30 border border-white/10 rounded-xl p-3 text-sm outline-none"
          placeholder="Access info, hazards, panel location, gate codes, customer instructions..."
          value={siteNotes}
          onChange={(e) => setSiteNotes(e.target.value)}
        />
      </section>

      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-400">{msg || " "}</div>
        <button
          className="px-4 py-2 rounded-xl bg-white/8 border border-white/12 hover:bg-white/10 disabled:opacity-50"
          onClick={() => save("ui_manual")}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </main>
  );
}

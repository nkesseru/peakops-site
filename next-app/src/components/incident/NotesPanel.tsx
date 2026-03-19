"use client";

import { useEffect, useRef, useState } from "react";

type NotesResp = {
  ok: boolean;
  incidentNotes?: string;
  siteNotes?: string;
  updatedAtMs?: number;
  error?: string;
};

export default function NotesPanel({
  orgId,
  incidentId,
  functionsBase,
}: {
  orgId: string;
  incidentId: string;
  functionsBase: string;
}) {
  const [open, setOpen] = useState(false);
  const [incidentNotes, setIncidentNotes] = useState("");
  const [siteNotes, setSiteNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAtMs, setSavedAtMs] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const tRef = useRef<number | null>(null);

  const api = (path: string) => `${functionsBase}/${path}`.replace(/\/+$/, "");

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

  async function load() {
    if (!functionsBase) return;
    try {
      const out = await postJson<NotesResp>(api("getIncidentNotesV1"), { orgId, incidentId });
      if (!out?.ok) return;
      setIncidentNotes(out.incidentNotes || "");
      setSiteNotes(out.siteNotes || "");
      if (out.updatedAtMs) setSavedAtMs(out.updatedAtMs);
    } catch {
      // non-fatal
    }
  }

  async function save(updatedBy = "ui") {
    if (!functionsBase) return;
    setErr(null);
    setSaving(true);
    try {
      const out = await postJson<NotesResp>(api("saveIncidentNotesV1"), {
        orgId,
        incidentId,
        incidentNotes,
        siteNotes,
        updatedBy,
      });
      if (!out?.ok) throw new Error(out?.error || "save failed");
      setSavedAtMs(Date.now());
    } catch (e: any) {
      setErr((e && (e.message || String(e))) || "save failed");
    } finally {
      setSaving(false);
    }
  }

  // Load notes once when opened first time
  useEffect(() => {
    if (!open) return;
    if (loadedRef.current) return;
    loadedRef.current = true;
    load();
  }, [open]);

  // Autosave (debounced) while panel is open
  useEffect(() => {
    if (!open) return;
    // don't autosave empty/empty
    if (!incidentNotes && !siteNotes) return;

    if (tRef.current) window.clearTimeout(tRef.current);
    tRef.current = window.setTimeout(() => {
      save("ui_autosave");
    }, 900);

    return () => {
      if (tRef.current) window.clearTimeout(tRef.current);
    };
  }, [open, incidentNotes, siteNotes]);

  const savedLabel =
    savedAtMs ? `Saved ${Math.max(0, Math.floor((Date.now() - savedAtMs) / 1000))}s ago` : "—";

  return (
    <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-400">Notes</div>
          <div className="text-xs text-gray-500">Incident summary + site access/hazards.</div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-gray-500">{saving ? "Saving…" : savedLabel}</span>
          <button
            className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-gray-200 hover:bg-white/10 active:translate-y-[1px] transition"
            onClick={() => setOpen((v) => !v)}
            type="button"
          >
            {open ? "Hide" : "＋ Notes"}
          </button>
        </div>
      </div>

      {open ? (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-xl bg-black/40 border border-white/10 p-3">
            <div className="text-xs text-gray-400 mb-2">Incident notes</div>
            <textarea
              className="w-full min-h-[120px] bg-transparent text-sm text-gray-100 outline-none resize-y"
              placeholder="What happened? Key decisions, summary, impact..."
              value={incidentNotes}
              onChange={(e) => setIncidentNotes(e.target.value)}
              onBlur={() => save("ui_blur")}
            />
          </div>

          <div className="rounded-xl bg-black/40 border border-white/10 p-3">
            <div className="text-xs text-gray-400 mb-2">Site notes</div>
            <textarea
              className="w-full min-h-[120px] bg-transparent text-sm text-gray-100 outline-none resize-y"
              placeholder="Access info, hazards, panel location, gate codes, customer instructions..."
              value={siteNotes}
              onChange={(e) => setSiteNotes(e.target.value)}
              onBlur={() => save("ui_blur")}
            />
          </div>

          <div className="md:col-span-2 flex items-center justify-between">
            <div className="text-xs text-gray-500">
              {err ? <span className="text-red-300">Save failed: {err}</span> : "Autosaves while open."}
            </div>
            <button
              className="px-3 py-2 rounded-xl bg-white/5 border border-white/10 text-gray-200 hover:bg-white/10 disabled:opacity-50"
              onClick={() => save("ui_manual")}
              disabled={saving}
              type="button"
            >
              Save now
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

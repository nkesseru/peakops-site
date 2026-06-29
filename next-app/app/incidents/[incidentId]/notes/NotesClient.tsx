"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/apiClient";
import { SealedRecordPanel } from "@/components/sealedRecord/SealedRecordPanel";

async function postJson<T>(url: string, body: any): Promise<T> {
  const res = await authedFetch(url, {
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

  const [incidentNotes, setIncidentNotes] = useState("");
  const [siteNotes, setSiteNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>("");
  // PR 136B — persistent "Notes saved ✓ Ready to submit?" panel.
  // Replaces the prior 1800ms transient toast which non-technical
  // operators were missing entirely, leaving them stranded with no
  // next-step guidance after Save. The panel offers a one-tap
  // return to the incident page (where the Submit button lives in
  // the bottom dock).
  const [savedReadyToSubmit, setSavedReadyToSubmit] = useState(false);
  // PEAKOPS_SEALED_RECORD_UX_V1 (2026-05-18, PR 42)
  // incidentStatus drives the pre-emptive sealed UI; sealedAfterMutation
  // covers the reactive case where the record gets sealed mid-edit and
  // the save call returns 409. clipboardOk briefly confirms successful
  // clipboard write after the recovery action fires.
  const [incidentStatus, setIncidentStatus] = useState<string>("");
  const [sealedAfterMutation, setSealedAfterMutation] = useState(false);
  const [clipboardOk, setClipboardOk] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setMsg("Loading…");
        const res = await authedFetch(
  `/api/fn/getIncidentNotesV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`,
  { cache: "no-store" }
);
const txt = await res.text().catch(() => "");
if (!res.ok) throw new Error(`GET /api/fn/getIncidentNotesV1 -> ${res.status} ${txt}`);
const out: any = txt ? JSON.parse(txt) : {};
if (!alive) return;
if (!out?.ok) throw new Error(out?.error || "load failed");
setIncidentNotes(String(out?.notes?.incidentNotes || ""));
setSiteNotes(String(out?.notes?.siteNotes || ""));
setMsg("");
      } catch (e: any) {
        if (!alive) return;
        setMsg((e && (e.message || String(e))) || "load failed");
      }
    })();
    return () => {
      alive = false;
    };
  }, [orgId, incidentId]);

  // PEAKOPS_SEALED_RECORD_UX_V1 (2026-05-18, PR 42)
  // Pre-emptive incident-status fetch. Parallel to the notes fetch
  // above; failure is non-fatal — the reactive 409 path still covers
  // the case where the record gets sealed mid-session.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!orgId || !incidentId) return;
      try {
        const res = await authedFetch(
          `/api/fn/getIncidentV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const txt = await res.text().catch(() => "");
        const out: any = txt ? JSON.parse(txt) : {};
        if (!alive) return;
        const s = String(out?.doc?.status || "").toLowerCase();
        if (s) setIncidentStatus(s);
      } catch {
        // tolerate
      }
    })();
    return () => {
      alive = false;
    };
  }, [orgId, incidentId]);

  function copyUnsavedNotesToClipboard() {
    const composed = [
      incidentNotes ? `[Incident notes]\n${incidentNotes}` : "",
      siteNotes ? `[Site notes]\n${siteNotes}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!composed) {
      setClipboardOk(false);
      return;
    }
    try {
      void navigator.clipboard?.writeText(composed);
      setClipboardOk(true);
      setTimeout(() => setClipboardOk(false), 3500);
    } catch {
      setClipboardOk(false);
    }
  }

  async function save(updatedBy: string = "ui") {
    setSaving(true);
    setMsg("");
    try {
      const out: any = await postJson(`/api/fn/saveIncidentNotesV1`, {
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
      // PR 136B — switch from a 1800ms transient "Saved ✓" toast to a
      // persistent panel with a clear next-step CTA back to the
      // incident page (where Submit lives in the bottom dock).
      // The msg row is cleared so it doesn't collide visually with
      // the new banner.
      setMsg("");
      setSavedReadyToSubmit(true);
    } catch (e: any) {
      const m = (e && (e.message || String(e))) || "save failed";
      // PEAKOPS_SEALED_RECORD_UX_V1 (2026-05-18, PR 42)
      // Reactive 409: flip into sealed state so the supervisor sees
      // the calm operational explanation + the "Copy unsaved notes"
      // recovery action rather than a raw "save failed" message.
      // Typed text remains in component state; the clipboard helper
      // composes both notes fields.
      if (/incident_closed/i.test(m) || / 409 /.test(m)) {
        setSealedAfterMutation(true);
        setMsg("");
        return;
      }
      setMsg(m);
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

        {/* PEAKOPS_SEALED_RECORD_UX_V1 (2026-05-18, PR 42)
            Sealed-record banner. Renders above the (now read-only)
            note textareas when incident.status === "closed" or after
            a reactive 409. Existing notes content stays visible so
            supervisors / auditors can still read what was captured.
            The "Copy unsaved notes" recovery only renders for the
            mid-edit case since pre-emptive sealing means the
            textareas were never editable. */}
        {(() => {
          const isSealed = incidentStatus === "closed" || sealedAfterMutation;
          if (!isSealed) return null;
          return (
            <SealedRecordPanel
              variant="notesBanner"
              title={sealedAfterMutation ? "Notes locked mid-edit" : "Notes locked after closure"}
              body={
                sealedAfterMutation
                  ? "This record was sealed while you were editing. Your changes weren't saved. Copy them for inclusion in the addendum if needed."
                  : "This operational record has been finalized. Use an addendum to attach post-closure clarification."
              }
              orgId={orgId}
              incidentId={incidentId}
              recovery={
                sealedAfterMutation
                  ? { label: clipboardOk ? "Copied ✓" : "Copy unsaved notes", onClick: copyUnsavedNotesToClipboard }
                  : undefined
              }
            />
          );
        })()}
      </div>

      <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
        <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">Incident Notes</div>
        <textarea
          className={
            "w-full min-h-[160px] bg-black/30 border border-white/10 rounded-xl p-3 text-sm outline-none " +
            ((incidentStatus === "closed" || sealedAfterMutation) ? "opacity-70 cursor-not-allowed" : "")
          }
          placeholder="What happened? Key decisions, summary, impact..."
          value={incidentNotes}
          onChange={(e) => { setIncidentNotes(e.target.value); if (savedReadyToSubmit) setSavedReadyToSubmit(false); }}
          readOnly={incidentStatus === "closed" || sealedAfterMutation}
          aria-readonly={incidentStatus === "closed" || sealedAfterMutation}
        />
      </section>

      <section className="rounded-2xl bg-white/5 border border-white/10 p-4">
        <div className="text-xs uppercase tracking-wide text-gray-400 mb-2">Site Notes</div>
        <textarea
          className={
            "w-full min-h-[160px] bg-black/30 border border-white/10 rounded-xl p-3 text-sm outline-none " +
            ((incidentStatus === "closed" || sealedAfterMutation) ? "opacity-70 cursor-not-allowed" : "")
          }
          placeholder="Access info, hazards, panel location, gate codes, customer instructions..."
          value={siteNotes}
          onChange={(e) => { setSiteNotes(e.target.value); if (savedReadyToSubmit) setSavedReadyToSubmit(false); }}
          readOnly={incidentStatus === "closed" || sealedAfterMutation}
          aria-readonly={incidentStatus === "closed" || sealedAfterMutation}
        />
      </section>

      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-400">{msg || " "}</div>
        {/* Save button hidden when record is sealed — sealed banner
            already shows the addendum CTA + optional clipboard
            recovery. */}
        {(incidentStatus === "closed" || sealedAfterMutation) ? null : (
          <button
            className="px-4 py-2 rounded-xl bg-white/8 border border-white/12 hover:bg-white/10 disabled:opacity-50"
            onClick={() => save("ui_manual")}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>

      {/* PR 136B — persistent post-save "ready to submit?" panel.
          Replaces the prior 1800ms transient toast that non-technical
          first-timers were missing entirely. Surfaces a one-tap
          return to the incident page (where Submit for approval
          lives in the bottom dock). Auto-dismisses on edit so the
          panel doesn't go stale while the operator is typing fresh
          changes. Render guarded against the sealed state because
          a sealed record can't be submitted anyway. */}
      {savedReadyToSubmit && !(incidentStatus === "closed" || sealedAfterMutation) ? (
        <section
          data-testid="notes-saved-ready-panel"
          className="rounded-2xl border border-emerald-400/30 bg-emerald-500/[0.07] p-4 mt-3 space-y-3"
        >
          <div className="flex items-start gap-3">
            <span aria-hidden className="text-emerald-300 text-[20px] leading-none mt-0.5">✓</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-emerald-50">
                Notes saved — ready to submit?
              </div>
              <p className="text-[12px] text-emerald-200/85 mt-1 leading-relaxed">
                Your notes are recorded. The next step is the Submit for approval button on the incident page.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            <a
              data-testid="notes-saved-return-button"
              href={`/incidents/${incidentId}${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`}
              className="block w-full py-3 rounded-xl text-[13px] font-semibold text-black bg-white hover:bg-white/90 text-center transition"
            >
              Return to incident → submit
            </a>
            <button
              type="button"
              data-testid="notes-saved-dismiss"
              onClick={() => setSavedReadyToSubmit(false)}
              className="block w-full py-3 rounded-xl text-[13px] font-semibold text-white border border-white/15 bg-white/[0.04] hover:bg-white/[0.10] text-center transition"
            >
              Keep editing notes
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}

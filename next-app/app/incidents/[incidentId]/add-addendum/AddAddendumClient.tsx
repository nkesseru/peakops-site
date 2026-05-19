"use client";

/**
 * PEAKOPS_ADDENDUM_CLIENT_V1 (2026-05-19, PR 43)
 *
 * Addendum filing flow. Only valid against a CLOSED operational
 * record — verifies status on load and renders a calm informational
 * panel if the user navigates here against an open record.
 *
 * Form fields (per locked PR 43 decisions):
 *   - reason       enum: clarification | customer_followup | audit_support | other
 *   - note         required, max 500 chars, non-empty after trim
 *   - file         optional, single file (image/* or PDF)
 *
 * On submit:
 *   1. If a file is selected: POST /api/fn/createAddendumUploadUrlV1
 *      → PUT bytes to signed URL → keep returned { bucket, storagePath }
 *   2. POST /api/fn/createAddendumV1 with reason/note/file metadata
 *   3. On success, navigate to /incidents/[id]/summary with a hint
 *      query param so the Summary can flash a confirmation chip
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/apiClient";

type Reason = "clarification" | "customer_followup" | "audit_support" | "other";

const REASONS: { value: Reason; label: string }[] = [
  { value: "clarification", label: "Clarification" },
  { value: "customer_followup", label: "Customer follow-up" },
  { value: "audit_support", label: "Audit support" },
  { value: "other", label: "Other" },
];

function makeAddendumIdHint() {
  return "add_" + Date.now() + "_" + Math.random().toString(16).slice(2, 8);
}

export default function AddAddendumClient({
  incidentId,
  orgId,
}: {
  incidentId: string;
  orgId: string;
}) {
  const router = useRouter();

  const [incidentStatus, setIncidentStatus] = useState<string>("");
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [reason, setReason] = useState<Reason>("clarification");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const [statusMsg, setStatusMsg] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!orgId || !incidentId) {
        setLoadingStatus(false);
        return;
      }
      try {
        const res = await authedFetch(
          `/api/fn/getIncidentV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`,
          { cache: "no-store" }
        );
        const txt = await res.text().catch(() => "");
        const out: any = txt ? JSON.parse(txt) : {};
        if (!alive) return;
        const s = String(out?.doc?.status || "").toLowerCase();
        setIncidentStatus(s);
      } catch {
        // tolerate — server will still gate
      } finally {
        if (alive) setLoadingStatus(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [orgId, incidentId]);

  const noteTrimmed = note.trim();
  const noteValid = noteTrimmed.length > 0 && noteTrimmed.length <= 500;
  const canSubmit = noteValid && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setErrMsg("");
    setStatusMsg("");

    let fileMeta: {
      bucket: string;
      storagePath: string;
      contentType: string;
      originalName: string;
      sizeBytes: number;
    } | null = null;

    try {
      if (file) {
        setStatusMsg("Uploading attachment…");
        const addendumIdHint = makeAddendumIdHint();
        // Mint upload URL
        const mintRes = await authedFetch(`/api/fn/createAddendumUploadUrlV1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orgId,
            incidentId,
            addendumIdHint,
            fileName: file.name || "attachment.bin",
            contentType: file.type || "application/octet-stream",
          }),
        });
        const mintTxt = await mintRes.text().catch(() => "");
        const mintOut: any = mintTxt ? JSON.parse(mintTxt) : {};
        if (!mintRes.ok || !mintOut?.ok) {
          throw new Error(mintOut?.detail || mintOut?.error || `mint_failed_${mintRes.status}`);
        }

        // Upload bytes to signed URL (no authedFetch — signed URLs would
        // be invalidated by an Authorization header).
        const uploadMethod = String(mintOut.uploadMethod || "PUT").toUpperCase();
        const uploadRes = await fetch(mintOut.uploadUrl, {
          method: uploadMethod,
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!uploadRes.ok) {
          throw new Error(`upload_failed_${uploadRes.status}`);
        }

        fileMeta = {
          bucket: String(mintOut.bucket || ""),
          storagePath: String(mintOut.storagePath || ""),
          contentType: file.type || "application/octet-stream",
          originalName: file.name || "attachment.bin",
          sizeBytes: file.size,
        };
      }

      // Commit the addendum doc
      setStatusMsg(file ? "Filing addendum…" : "Filing addendum…");
      const commitRes = await authedFetch(`/api/fn/createAddendumV1`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          incidentId,
          reason,
          note: noteTrimmed,
          file: fileMeta,
        }),
      });
      const commitTxt = await commitRes.text().catch(() => "");
      const commitOut: any = commitTxt ? JSON.parse(commitTxt) : {};
      if (!commitRes.ok || !commitOut?.ok) {
        throw new Error(commitOut?.detail || commitOut?.error || `commit_failed_${commitRes.status}`);
      }

      setStatusMsg("Addendum filed ✓");
      // Navigate to Summary with a hint param so the dossier can
      // flash a quiet confirmation chip (Summary handling can land
      // in PR 44).
      setTimeout(() => {
        router.push(
          `/incidents/${encodeURIComponent(incidentId)}/summary?orgId=${encodeURIComponent(orgId)}&addendumFiled=1`
        );
      }, 600);
    } catch (e: any) {
      const m = String((e && (e.message || e)) || "addendum_failed");
      setErrMsg(m);
      setStatusMsg("");
    } finally {
      setSubmitting(false);
    }
  }

  // Loading skeleton (briefly visible while we fetch incident.status)
  if (loadingStatus) {
    return (
      <main className="min-h-screen bg-black text-white py-12 px-4">
        <div className="max-w-2xl mx-auto">
          <div className="text-[12px] text-gray-500">Loading…</div>
        </div>
      </main>
    );
  }

  // Open-incident guardrail — server will also reject. Calmer to
  // explain here rather than let the user fill out the form.
  if (incidentStatus && incidentStatus !== "closed") {
    return (
      <main className="min-h-screen bg-black text-white py-12 px-4">
        <div className="max-w-2xl mx-auto">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8 space-y-3">
            <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-gray-400">
              Operational record active
            </div>
            <div className="text-2xl font-semibold leading-tight tracking-tight text-white">
              This record is still active
            </div>
            <div className="text-[14px] text-gray-300 leading-relaxed">
              Addenda apply only to closed operational records. Use the normal
              evidence and notes flows while this record is active.
            </div>
            <div className="flex items-center gap-3 flex-wrap pt-1">
              <button
                type="button"
                className="px-4 py-2 rounded-lg text-[13px] font-medium border border-white/10 bg-white/[0.03] text-gray-300 hover:bg-white/[0.06] transition"
                onClick={() =>
                  router.push(
                    `/incidents/${encodeURIComponent(incidentId)}/summary?orgId=${encodeURIComponent(orgId)}`
                  )
                }
              >
                ← Back to summary
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black text-white py-12 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
            Sealed operational record
          </div>
          <h1 className="text-2xl font-semibold leading-tight tracking-tight text-white">
            File supplemental addendum
          </h1>
          <p className="text-[14px] text-gray-300 leading-relaxed max-w-prose">
            This addendum will be attached to the closed operational record
            as supplemental context. It does not modify the original field
            record.
          </p>
        </div>

        <section className="rounded-xl border border-white/10 bg-white/[0.03] p-5 space-y-5">
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-gray-400 mb-2">
              Reason <span className="text-amber-300/80">*</span>
            </label>
            <select
              className="w-full bg-black/40 border border-white/15 rounded-lg p-3 text-sm text-gray-100 outline-none"
              value={reason}
              onChange={(e) => setReason(e.target.value as Reason)}
              disabled={submitting}
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value} className="bg-black">
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-gray-400 mb-2">
              Note <span className="text-amber-300/80">*</span>
              <span className="ml-2 text-gray-500 normal-case tracking-normal">
                ({noteTrimmed.length}/500)
              </span>
            </label>
            <textarea
              className="w-full min-h-[140px] bg-black/40 border border-white/15 rounded-lg p-3 text-sm text-gray-100 outline-none"
              placeholder="What additional context does this addendum capture? Plain language is fine."
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              disabled={submitting}
            />
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-gray-400 mb-2">
              File (optional)
            </label>
            <input
              type="file"
              accept="image/*,.pdf,.heic,.heif"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              disabled={submitting}
              className="block text-[12px] text-gray-300 file:mr-3 file:px-3 file:py-1.5 file:rounded file:border file:border-white/15 file:bg-white/5 file:text-gray-200 file:text-[12px] hover:file:bg-white/10"
            />
            {file ? (
              <div className="mt-1.5 text-[11px] text-gray-400">
                {file.name} · {(file.size / 1024).toFixed(1)} KB
              </div>
            ) : null}
          </div>

          <div className="text-[11px] text-gray-500 leading-relaxed border-t border-white/[0.06] pt-3">
            Filing this addendum is logged with your identity, the timestamp,
            and the operational record&apos;s seal state at the moment of
            filing.
          </div>
        </section>

        {errMsg ? (
          <div
            role="alert"
            className="rounded-lg border border-red-400/20 bg-red-500/[0.05] p-3 text-[12px] text-red-200/90"
          >
            {errMsg}
          </div>
        ) : null}
        {statusMsg ? (
          <div role="status" aria-live="polite" className="text-[12px] text-gray-400 italic">
            {statusMsg}
          </div>
        ) : null}

        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            className="px-4 py-2 rounded-lg text-[13px] font-medium border border-amber-300/30 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25 transition disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {submitting ? "Filing…" : "File addendum"}
          </button>
          <button
            type="button"
            className="px-4 py-2 rounded-lg text-[13px] font-medium border border-white/10 bg-white/[0.03] text-gray-300 hover:bg-white/[0.06] transition"
            onClick={() =>
              router.push(
                `/incidents/${encodeURIComponent(incidentId)}/summary?orgId=${encodeURIComponent(orgId)}`
              )
            }
            disabled={submitting}
          >
            Cancel
          </button>
        </div>
      </div>
    </main>
  );
}

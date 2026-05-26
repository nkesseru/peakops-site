"use client";

/**
 * PEAKOPS_NEW_INCIDENT_FORM_V2 (PR 82 — Work Package Archetypes)
 *
 * Curated archetype-picker rewrite of the proof-workflow create
 * surface. v1 (PR 70) was a 9-section radio-grid form. v2 leads
 * with five rich archetype cards (purpose + required-proof
 * checklist + packet-use tag), then keeps the remaining form
 * fields below for title, location, customer, etc.
 *
 * Voice direction (per PR 81 spec):
 *   - "Start a field record" — operator-action wording rather than
 *     "New operational record" (object-noun wording)
 *   - "Choose the type of proof package you need to assemble" —
 *     frames the act of creation as packet assembly, not data entry
 *   - Cards lead with archetype identity; required-proof + packet-
 *     use copy lives on the card so the static
 *     "Required for Acceptance" panel from PR 71 retires (its
 *     content is now per-archetype, contained on each card)
 *
 * Flow unchanged from PR 70 onwards:
 *   1. Pick an archetype, fill title (required) + optional details
 *   2. POST /api/fn/createIncidentV1 (auth + org enforced by proxy)
 *   3. On 201: router.push(`/incidents/{id}?orgId=...&next=capture-proof`)
 *
 * Removed in v2:
 *   - Work type radio. Archetype now carries the operational
 *     classification on its own. Backend still accepts workType
 *     if sent, we just stop sending it. Existing records with
 *     workType keep their values.
 *   - Static "Required for Acceptance" amber card. Replaced by
 *     the per-archetype required-proof line inside each card.
 */

import { FormEvent, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import RequireAuth from "@/components/RequireAuth";
import AppTopBar from "@/components/AppTopBar";
import { useAuth } from "@/hooks/useAuth";
import { authedFetch } from "@/lib/apiClient";
import {
  ARCHETYPE_DETAILS,
  ARCHETYPE_LABELS,
  ARCHETYPE_VALUES,
  type Archetype,
  CUSTOMER_MAX,
  EMPTY_DRAFT,
  EXT_WO_MAX,
  LOCATION_MAX,
  NOTES_MAX,
  type NewIncidentDraft,
  PACKET_PURPOSE_LABELS,
  PACKET_PURPOSE_VALUES,
  type PacketPurpose,
  PRIORITY_LABELS,
  PRIORITY_VALUES,
  type Priority,
  TITLE_MAX,
  TITLE_MIN,
  buildCreatePayload,
  isDraftSubmittable,
  validateDraft,
} from "@/lib/incidents/newIncidentDraft";

export default function NewIncidentClient() {
  return (
    <RequireAuth>
      <Body />
    </RequireAuth>
  );
}

function Body() {
  const sp = useSearchParams();
  const { claims } = useAuth();

  const urlOrgId = String(sp?.get("orgId") || "").trim();
  const claimOrgId = (claims?.orgIds || [])[0] || "";
  const orgId = urlOrgId || claimOrgId;

  if (!orgId) {
    return <MissingOrgPanel />;
  }
  return <Form orgId={orgId} />;
}

function MissingOrgPanel() {
  const router = useRouter();
  return (
    <main className="min-h-screen bg-black text-white">
      <AppTopBar />
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 space-y-5">
        <div className="rounded-2xl border border-amber-300/25 bg-amber-500/[0.05] p-5 sm:p-6 space-y-3">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
            Field record
          </div>
          <div className="text-xl font-semibold text-white">
            Select an organization
          </div>
          <p className="text-[14px] text-gray-300 leading-relaxed">
            Starting a field record requires an active organization. Open
            this page from a workspace link or visit the Team page to
            choose one.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => router.push("/team")}
              className="px-3 py-1.5 rounded-full text-[12px] font-medium border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10] hover:text-white transition-colors"
            >
              Open Team
            </button>
            <button
              type="button"
              onClick={() => router.push("/dashboard")}
              className="px-3 py-1.5 rounded-full text-[12px] text-gray-400 hover:text-gray-100 transition-colors"
            >
              ← Back to dashboard
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

function Form({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<NewIncidentDraft>(EMPTY_DRAFT);
  const [packetPurpose, setPacketPurpose] = useState<PacketPurpose>("");
  const [touched, setTouched] = useState<Partial<Record<keyof NewIncidentDraft, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string>("");

  const errors = useMemo(() => validateDraft(draft), [draft]);
  const submittable = isDraftSubmittable(draft);

  const update = <K extends keyof NewIncidentDraft>(key: K, value: NewIncidentDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const blur = (key: keyof NewIncidentDraft) => () => setTouched((t) => ({ ...t, [key]: true }));
  const showError = (key: keyof NewIncidentDraft): string =>
    touched[key] && errors[key] ? errors[key]! : "";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setTouched({
      title: true,
      archetype: true,
      priority: true,
      location: true,
      customer: true,
      externalWorkOrderId: true,
      notes: true,
    });
    if (!submittable) return;

    setSubmitting(true);
    setServerError("");
    try {
      const res = await authedFetch("/api/fn/createIncidentV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildCreatePayload(draft, orgId)),
      });
      const txt = await res.text().catch(() => "");
      let out: { ok?: boolean; incidentId?: string; error?: string } = {};
      try {
        out = txt ? JSON.parse(txt) : {};
      } catch {
        out = {};
      }
      if (!res.ok || !out?.ok || !out?.incidentId) {
        throw new Error(out?.error || `Create failed (HTTP ${res.status})`);
      }
      const id = encodeURIComponent(String(out.incidentId));
      const qs = `?orgId=${encodeURIComponent(orgId)}&next=capture-proof`;
      router.push(`/incidents/${id}${qs}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setServerError(msg);
      setSubmitting(false);
    }
  }

  const notesCount = draft.notes.length;

  return (
    <main className="min-h-screen bg-black text-white">
      <AppTopBar />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10 space-y-8">
        <header className="space-y-2">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
            Field record
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold leading-tight tracking-tight text-white">
            Start a field record
          </h1>
          <p className="text-[14px] text-gray-400 leading-relaxed max-w-prose">
            Choose the type of proof package you need to assemble.
          </p>
        </header>

        <form onSubmit={onSubmit} className="space-y-8" noValidate>
          {/* PEAKOPS_ARCHETYPE_CARD_GRID_V1 (PR 82)
              Curated archetype picker. Cards are radio-equivalent —
              clicking the card body selects the archetype. The hidden
              <input type="radio"> keeps the form-control semantics
              accessible. Selected card gets a brighter border + filled
              indicator dot. */}
          <fieldset className="space-y-3">
            <legend className="text-[11px] uppercase tracking-[0.14em] font-semibold text-gray-300">
              Work package archetype
              <span className="text-amber-300/80 ml-1">*</span>
            </legend>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {ARCHETYPE_VALUES.map((value) => {
                const checked = draft.archetype === value;
                const detail = ARCHETYPE_DETAILS[value];
                return (
                  <label
                    key={value}
                    className={
                      // PEAKOPS_SELECTED_ARCHETYPE_POLISH_V1 (PR 84)
                      // Deeper amber tone on the chosen card so the
                      // "this is the workflow you're assembling"
                      // signal lands. Unselected cards stay calm.
                      "relative block rounded-xl border px-4 py-4 sm:px-5 sm:py-5 cursor-pointer transition-colors " +
                      (checked
                        ? "border-amber-300/60 bg-amber-500/[0.08]"
                        : "border-white/10 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]")
                    }
                  >
                    <input
                      type="radio"
                      name="archetype"
                      value={value}
                      checked={checked}
                      onChange={() => {
                        update("archetype", value as Archetype);
                        setTouched((t) => ({ ...t, archetype: true }));
                      }}
                      className="sr-only"
                    />
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-[14px] font-semibold text-white leading-snug">
                          {ARCHETYPE_LABELS[value]}
                        </div>
                        {checked ? (
                          // PEAKOPS_SELECTED_ARCHETYPE_POLISH_V1 (PR 84)
                          // "Selected" tag replaces the bare dot on
                          // the chosen card so the chosen workflow
                          // reads clearly without animation or
                          // wizard-UI energy.
                          <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] font-semibold text-amber-100 bg-amber-500/20 border border-amber-300/40 rounded-full px-2 py-0.5">
                            Selected
                          </span>
                        ) : (
                          <span
                            aria-hidden="true"
                            className="shrink-0 mt-0.5 w-3.5 h-3.5 rounded-full border border-white/25 bg-transparent"
                          />
                        )}
                      </div>
                      <p className="text-[12px] text-gray-300 leading-relaxed">
                        {detail.purpose}
                      </p>
                      <div className="space-y-1.5">
                        <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-gray-400">
                          Required proof
                        </div>
                        <ul className="space-y-1 text-[12px] text-gray-200">
                          {detail.requiredProof.map((item) => (
                            <li key={item} className="flex items-start gap-2">
                              <span aria-hidden="true" className="text-emerald-300/70 mt-0.5">
                                ✓
                              </span>
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase tracking-[0.14em] font-semibold text-gray-400">
                          Packet use
                        </div>
                        <div className="text-[12px] text-gray-300">
                          {detail.packetUse}
                        </div>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            {showError("archetype") ? (
              <div className="text-[12px] text-red-300">{showError("archetype")}</div>
            ) : null}
          </fieldset>

          <Field
            label="Record title"
            required
            hint={`${TITLE_MIN}–${TITLE_MAX} characters`}
            error={showError("title")}
          >
            <input
              type="text"
              value={draft.title}
              onChange={(e) => update("title", e.target.value)}
              onBlur={blur("title")}
              maxLength={TITLE_MAX}
              className="w-full bg-black/40 border border-white/15 rounded-lg px-3 py-2.5 text-[14px] text-gray-100 outline-none focus:border-white/30"
              placeholder="Pole 14B — visual + load inspection"
            />
          </Field>

          <Field
            label="Location or site"
            hint={`Optional · ≤${LOCATION_MAX} chars`}
            error={showError("location")}
          >
            <input
              type="text"
              value={draft.location}
              onChange={(e) => update("location", e.target.value)}
              onBlur={blur("location")}
              maxLength={LOCATION_MAX}
              className="w-full bg-black/40 border border-white/15 rounded-lg px-3 py-2.5 text-[14px] text-gray-100 outline-none focus:border-white/30"
              placeholder="Riverbend Substation, NW corner"
            />
          </Field>

          <Field
            label="Customer / agency / project"
            hint={`Optional · ≤${CUSTOMER_MAX} chars`}
            error={showError("customer")}
          >
            <input
              type="text"
              value={draft.customer}
              onChange={(e) => update("customer", e.target.value)}
              onBlur={blur("customer")}
              maxLength={CUSTOMER_MAX}
              className="w-full bg-black/40 border border-white/15 rounded-lg px-3 py-2.5 text-[14px] text-gray-100 outline-none focus:border-white/30"
              placeholder="City of Riverbend — Stormwater Division"
            />
          </Field>

          <Field
            label="External work order ID"
            hint={`Optional · letters, digits, _ and - · ≤${EXT_WO_MAX} chars`}
            error={showError("externalWorkOrderId")}
          >
            <input
              type="text"
              value={draft.externalWorkOrderId}
              onChange={(e) => update("externalWorkOrderId", e.target.value)}
              onBlur={blur("externalWorkOrderId")}
              maxLength={EXT_WO_MAX}
              className="w-full bg-black/40 border border-white/15 rounded-lg px-3 py-2.5 text-[14px] text-gray-100 outline-none focus:border-white/30 font-mono"
              placeholder="WO-2026-04812"
            />
          </Field>

          <RadioSection
            label="Packet purpose"
            hint="What is this packet for?"
            name="packetPurpose"
            value={packetPurpose}
            onChange={(v) => setPacketPurpose(v as PacketPurpose)}
            options={PACKET_PURPOSE_VALUES.map((v) => ({
              value: v,
              label: PACKET_PURPOSE_LABELS[v],
            }))}
          />

          <RadioSection
            label="Priority"
            name="priority"
            value={draft.priority}
            onChange={(v) => update("priority", v as Priority)}
            options={PRIORITY_VALUES.map((v) => ({ value: v, label: PRIORITY_LABELS[v] }))}
          />

          <Field
            label="Brief notes"
            hint={`Optional · ${notesCount}/${NOTES_MAX}`}
            error={showError("notes")}
          >
            <textarea
              value={draft.notes}
              onChange={(e) => update("notes", e.target.value)}
              onBlur={blur("notes")}
              maxLength={NOTES_MAX}
              rows={3}
              className="w-full bg-black/40 border border-white/15 rounded-lg px-3 py-2.5 text-[14px] text-gray-100 outline-none focus:border-white/30 resize-y"
              placeholder="Routine annual inspection. Photograph all hardware, load attachments, clearances."
            />
          </Field>

          <div className="border-t border-white/10 pt-5 space-y-4">
            <div className="text-[11px] uppercase tracking-[0.16em] text-gray-500">
              Once opened, your next step is proof capture.
            </div>

            {serverError ? (
              <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] px-3 py-2 text-[13px] text-red-100">
                <div className="font-semibold">Could not create record</div>
                <div className="mt-0.5 text-red-200/90 break-words">{serverError}</div>
              </div>
            ) : null}

            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="submit"
                disabled={submitting || !submittable}
                className="px-4 py-2 rounded-full text-[13px] font-medium bg-white text-black hover:bg-white/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Creating…" : "Create field record"}
              </button>
              <button
                type="button"
                onClick={() => router.push("/dashboard")}
                disabled={submitting}
                className="px-3 py-1.5 rounded-full text-[12px] text-gray-400 hover:text-gray-100 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}

function Field({
  label,
  hint,
  required,
  error,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label className="text-[11px] uppercase tracking-[0.14em] font-semibold text-gray-300">
          {label}
          {required ? <span className="text-amber-300/80 ml-1">*</span> : null}
        </label>
        {hint ? <span className="text-[11px] text-gray-500">{hint}</span> : null}
      </div>
      {children}
      {error ? <div className="text-[12px] text-red-300">{error}</div> : null}
    </div>
  );
}

function RadioSection<T extends string>({
  label,
  name,
  value,
  onChange,
  options,
  required,
  error,
  hint,
}: {
  label: string;
  name: string;
  value: T | "";
  onChange: (v: T | "") => void;
  options: Array<{ value: T; label: string }>;
  required?: boolean;
  error?: string;
  hint?: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[11px] uppercase tracking-[0.14em] font-semibold text-gray-300">
        {label}
        {required ? <span className="text-amber-300/80 ml-1">*</span> : null}
        {hint ? (
          <span className="ml-2 text-[11px] font-normal tracking-normal text-gray-500 normal-case">
            {hint}
          </span>
        ) : null}
      </legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {options.map((opt) => {
          const checked = value === opt.value;
          return (
            <label
              key={opt.value}
              className={
                "flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] cursor-pointer transition-colors " +
                (checked
                  ? "border-white/30 bg-white/[0.06] text-gray-100"
                  : "border-white/10 bg-white/[0.02] text-gray-400 hover:text-gray-100 hover:border-white/20")
              }
            >
              <input
                type="radio"
                name={name}
                value={opt.value}
                checked={checked}
                onChange={() => onChange(opt.value)}
                className="accent-white"
              />
              {opt.label}
            </label>
          );
        })}
      </div>
      {error ? <div className="text-[12px] text-red-300">{error}</div> : null}
    </fieldset>
  );
}

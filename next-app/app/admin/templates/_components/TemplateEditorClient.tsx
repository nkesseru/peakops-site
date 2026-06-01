"use client";

// PEAKOPS_TEMPLATES_EDITOR_V1 (PR 119b)
//
// Shared editor form for the customer / org-wide acceptance template
// editor. Mounted by:
//   - /admin/templates/new        (createMode = true)
//   - /admin/templates/[key]      (createMode = false; loads existing)
//
// Visual treatment per scope: simple, boring, operational. No
// wizards, no conditional sections, no rich editors. Flat vertical
// form with three repeated "string list" editors (required/optional/
// criteria) and a structured acceptance-checks editor.
//
// All saves route through /api/fn/saveOrgTemplateV1 (admin-gated
// server-side; the client-side role gate is defense-in-depth).

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import AppTopBar from "@/components/AppTopBar";
import RequireAuth from "@/components/RequireAuth";
import { ARCHETYPE_VALUES, ARCHETYPE_LABELS, type Archetype } from "@/lib/incidents/newIncidentDraft";

const ADMIN_ROLES = new Set(["owner", "admin"]);

const CHECK_TYPES = [
  "requires_minimum_proof_count",
  "requires_supervisor_approval",
  "requires_at_least_one_gps_proof",
  "requires_field_notes",
  "requires_incident_closure",
] as const;
type CheckType = (typeof CHECK_TYPES)[number];

type AcceptanceCheck = {
  type: CheckType;
  tier: "required" | "encouraged";
  label?: string;
  description?: string;
  params?: { minCount?: number };
};

type TemplateDoc = {
  templateKey?: string;
  archetype: Archetype | "";
  customerSlug: string;
  customerLabel: string;
  requiredProof: string[];
  // PR 120b — parallel to requiredProof; same length invariant
  // enforced by addRequiredProofItem / removeRequiredProofItem.
  // Empty entries mean "no Reason: line" for that slot. Persisted
  // by saveOrgTemplateV1 (PR 120a sanitize + ≤500-char cap).
  requiredProofDescriptions: string[];
  optionalProof: string[];
  acceptanceCriteria: string[];
  acceptanceChecks: AcceptanceCheck[];
  version?: number;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
};

type Props = {
  orgId: string;
  templateKey?: string;       // present in edit mode
  createMode: boolean;
};

function emptyDoc(): TemplateDoc {
  return {
    archetype: "",
    customerSlug: "",
    customerLabel: "",
    requiredProof: [""],
    requiredProofDescriptions: [""],   // PR 120b — parallel array, same length
    optionalProof: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
  };
}

function defaultCheck(): AcceptanceCheck {
  return { type: "requires_supervisor_approval", tier: "required" };
}

export default function TemplateEditorClient({ orgId, templateKey, createMode }: Props) {
  return (
    <RequireAuth>
      <main className="min-h-screen bg-black text-white">
        <AppTopBar />
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
          <EditorBody orgId={orgId} templateKey={templateKey} createMode={createMode} />
        </div>
      </main>
    </RequireAuth>
  );
}

function EditorBody({ orgId, templateKey, createMode }: Props) {
  const router = useRouter();
  const { user, claims } = useAuth();
  const role = String(claims?.role || "").toLowerCase();
  const isAdmin = ADMIN_ROLES.has(role);
  const actorUid = String(user?.uid || "").trim();

  const [doc, setDoc] = useState<TemplateDoc>(emptyDoc());
  const [loading, setLoading] = useState(!createMode);
  const [loadErr, setLoadErr] = useState<string>("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string>("");
  const [changeNote, setChangeNote] = useState<string>("");

  // PR 125a/b — Load existing doc (edit mode only) via getOrgTemplateV1.
  // Returns the FULL doc (arrays + reasons + provenance), unlike the
  // earlier PR 119b load path which used listOrgTemplatesV1 summaries
  // and seeded empty arrays. Hard-errors on failure with a retry
  // button — we deliberately do NOT fall back to a blank-array shape,
  // since that was the surface of the original re-hydration bug.
  useEffect(() => {
    if (createMode || !templateKey) return;
    let cancelled = false;
    setLoading(true);
    setLoadErr("");
    (async () => {
      try {
        const url = `/api/fn/getOrgTemplateV1?orgId=${encodeURIComponent(orgId)}&templateKey=${encodeURIComponent(templateKey)}`;
        const res = await authedFetch(url, { cache: "no-store" });
        const out: {
          ok?: boolean;
          error?: string;
          template?: {
            templateKey: string;
            archetype: string;
            customerSlug: string;
            customerLabel: string;
            requiredProof: string[];
            requiredProofDescriptions: string[];
            optionalProof: string[];
            acceptanceCriteria: string[];
            acceptanceChecks: AcceptanceCheck[];
            version: number;
            createdAt?: string | null;
            createdBy?: string;
            updatedAt?: string | null;
            updatedBy?: string;
          };
        } = await res.json().catch(() => ({}));

        if (res.status === 404) {
          if (!cancelled) {
            setLoadErr(`Template "${templateKey}" not found in this org.`);
            setLoading(false);
          }
          return;
        }
        if (!res.ok || !out.ok || !out.template) {
          throw new Error(out.error || `getOrgTemplateV1 failed (${res.status})`);
        }

        const t = out.template;
        // Pad descriptions to match requiredProof length so the
        // parallel-array invariant holds in the editor state even if
        // a legacy doc was stored without descriptions.
        const reqLabels = Array.isArray(t.requiredProof) ? t.requiredProof.slice() : [];
        const reqDescs = Array.isArray(t.requiredProofDescriptions) ? t.requiredProofDescriptions.slice() : [];
        while (reqDescs.length < reqLabels.length) reqDescs.push("");
        if (reqDescs.length > reqLabels.length) reqDescs.length = reqLabels.length;

        if (!cancelled) {
          setDoc({
            templateKey: t.templateKey,
            archetype: (t.archetype || "") as Archetype,
            customerSlug: t.customerSlug || "",
            customerLabel: t.customerLabel || "",
            requiredProof: reqLabels.length > 0 ? reqLabels : [""],
            requiredProofDescriptions: reqLabels.length > 0 ? reqDescs : [""],
            optionalProof: Array.isArray(t.optionalProof) ? t.optionalProof.slice() : [],
            acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria.slice() : [],
            acceptanceChecks: Array.isArray(t.acceptanceChecks) ? t.acceptanceChecks.slice() : [],
            version: t.version,
            createdAt: t.createdAt || undefined,
            createdBy: t.createdBy,
            updatedAt: t.updatedAt || undefined,
            updatedBy: t.updatedBy,
          });
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setLoadErr(`Failed to load template: ${e?.message || e}`);
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, templateKey, createMode, loadAttempt]);

  const isOrgWide = !doc.customerLabel.trim();

  const setArchetype = (v: string) => setDoc((d) => ({ ...d, archetype: v as Archetype }));
  const setCustomerLabel = (v: string) => setDoc((d) => ({ ...d, customerLabel: v }));
  const setScope = (orgWide: boolean) => {
    if (orgWide) setDoc((d) => ({ ...d, customerLabel: "", customerSlug: "" }));
  };

  function setStringList(field: "requiredProof" | "optionalProof" | "acceptanceCriteria", idx: number, value: string) {
    setDoc((d) => {
      const next = d[field].slice();
      next[idx] = value;
      return { ...d, [field]: next };
    });
  }

  // PR 120b — parallel-array setters for requiredProof + descriptions.
  // The label and reason move together at the same index so the
  // server-side invariant (descriptions.length === requiredProof.length)
  // is always met before save. Add/remove always touches both arrays.
  function setRequiredProofLabel(idx: number, value: string) {
    setDoc((d) => {
      const next = d.requiredProof.slice();
      next[idx] = value;
      return { ...d, requiredProof: next };
    });
  }
  function setRequiredProofDescription(idx: number, value: string) {
    setDoc((d) => {
      const next = d.requiredProofDescriptions.slice();
      // Pad to current requiredProof length so a description set
      // before the label edit doesn't drift the parallel arrays.
      while (next.length < d.requiredProof.length) next.push("");
      next[idx] = value;
      return { ...d, requiredProofDescriptions: next };
    });
  }
  function addRequiredProofItem() {
    setDoc((d) => ({
      ...d,
      requiredProof: [...d.requiredProof, ""],
      requiredProofDescriptions: [...d.requiredProofDescriptions, ""],
    }));
  }
  function removeRequiredProofItem(idx: number) {
    setDoc((d) => ({
      ...d,
      requiredProof: d.requiredProof.filter((_, i) => i !== idx),
      requiredProofDescriptions: d.requiredProofDescriptions.filter((_, i) => i !== idx),
    }));
  }
  function addStringListItem(field: "requiredProof" | "optionalProof" | "acceptanceCriteria") {
    setDoc((d) => ({ ...d, [field]: [...d[field], ""] }));
  }
  function removeStringListItem(field: "requiredProof" | "optionalProof" | "acceptanceCriteria", idx: number) {
    setDoc((d) => ({ ...d, [field]: d[field].filter((_, i) => i !== idx) }));
  }

  function setCheck(idx: number, patch: Partial<AcceptanceCheck>) {
    setDoc((d) => {
      const next = d.acceptanceChecks.slice();
      next[idx] = { ...next[idx], ...patch };
      return { ...d, acceptanceChecks: next };
    });
  }
  function addCheck() {
    setDoc((d) => ({ ...d, acceptanceChecks: [...d.acceptanceChecks, defaultCheck()] }));
  }
  function removeCheck(idx: number) {
    setDoc((d) => ({ ...d, acceptanceChecks: d.acceptanceChecks.filter((_, i) => i !== idx) }));
  }

  const canSave = useMemo(() => {
    if (saving) return false;
    if (!doc.archetype) return false;
    const filled = doc.requiredProof.map((s) => s.trim()).filter(Boolean);
    if (filled.length === 0) return false;
    if (!isOrgWide && !doc.customerLabel.trim()) return false;
    return true;
  }, [doc, saving, isOrgWide]);

  async function onSave() {
    setSaving(true);
    setSaveErr("");
    try {
      // PR 120b — filter label + description as PAIRS so the parallel
      // arrays stay aligned by index when empty labels get dropped.
      // saveOrgTemplateV1 server-side also pads/truncates as a final
      // defense, but doing the pairing here keeps the operator's
      // intent intact.
      const reqPairs = doc.requiredProof.map((label, i) => ({
        label: String(label || "").trim(),
        description: String(doc.requiredProofDescriptions[i] || "").trim(),
      })).filter((p) => p.label.length > 0);
      const requiredProofClean = reqPairs.map((p) => p.label);
      const requiredProofDescriptionsClean = reqPairs.map((p) => p.description);

      const body = {
        actorUid,
        orgId,
        // PR 125b — Edit path uses explicit templateKey from the loaded
        // doc so the server anchors save to the exact identity that
        // was edited. Create mode omits the field so the server
        // derives templateKey from archetype + customerLabel as
        // before. This is what eliminates the identity-drift bug
        // where editing Template A could save into Template B.
        ...(createMode || !doc.templateKey ? {} : { templateKey: doc.templateKey }),
        archetype: doc.archetype,
        customerLabel: isOrgWide ? "" : doc.customerLabel.trim(),
        requiredProof: requiredProofClean,
        // Only include the array when at least one entry has text —
        // keeps the doc lean for templates that don't author reasons
        // (saveOrgTemplateV1 omits the field anyway in that case;
        // sending [] avoids an unnecessary write attempt).
        ...(requiredProofDescriptionsClean.some((s) => s.length > 0)
          ? { requiredProofDescriptions: requiredProofDescriptionsClean }
          : {}),
        optionalProof: doc.optionalProof.map((s) => s.trim()).filter(Boolean),
        acceptanceCriteria: doc.acceptanceCriteria.map((s) => s.trim()).filter(Boolean),
        acceptanceChecks: doc.acceptanceChecks,
        changeNote: changeNote.trim() || undefined,
      };
      const res = await authedFetch("/api/fn/saveOrgTemplateV1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out: { ok?: boolean; error?: string; detail?: string; templateKey?: string; version?: number } = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) {
        throw new Error(out.error || `Save failed (${res.status})`);
      }
      // Navigate back to the list on success.
      const qs = `?orgId=${encodeURIComponent(orgId)}`;
      router.push(`/admin/templates${qs}`);
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!isAdmin) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.04] p-6">
        <div className="text-sm text-gray-300">
          You don&apos;t have access to template authoring. This page is owner/admin only.
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="text-[12px] text-gray-500 italic">Loading template…</div>;
  }
  if (loadErr) {
    return (
      <div className="rounded-xl border border-red-300/25 bg-red-500/[0.05] p-5 space-y-3">
        <div className="text-sm text-red-200">{loadErr}</div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-[12px] px-3 py-1.5 rounded-full border border-white/15 bg-white/[0.06] text-gray-100 hover:bg-white/[0.12]"
            onClick={() => setLoadAttempt((n) => n + 1)}
          >
            Retry
          </button>
          <button
            type="button"
            className="text-[12px] text-gray-400 hover:text-gray-100"
            onClick={() => router.push(`/admin/templates?orgId=${encodeURIComponent(orgId)}`)}
          >
            Back to list
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
          {createMode ? "New template" : `Edit template · v${doc.version ?? "?"}`}
        </div>
        <h1 className="text-xl font-semibold leading-tight tracking-tight text-white">
          {createMode
            ? "Configure acceptance requirements"
            : (doc.customerLabel ? `${ARCHETYPE_LABELS[doc.archetype as Archetype] || doc.archetype} — ${doc.customerLabel}` : `${ARCHETYPE_LABELS[doc.archetype as Archetype] || doc.archetype} (org-wide)`)}
        </h1>
        {!createMode && (
          <div className="text-[11px] text-gray-500">
            templateKey: <span className="font-mono">{doc.templateKey}</span>
            {doc.updatedBy ? <span> · last edit by {doc.updatedBy}</span> : null}
            {doc.updatedAt ? <span> at {doc.updatedAt}</span> : null}
          </div>
        )}
      </header>

      {/* Archetype + scope */}
      <section className="space-y-3">
        <label className="block text-[12px] text-gray-300">
          Archetype
          <select
            className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2 disabled:opacity-50"
            value={doc.archetype}
            onChange={(e) => setArchetype(e.target.value)}
            disabled={!createMode /* archetype is the doc-id half — immutable on edit */}
          >
            <option value="">— pick an archetype —</option>
            {ARCHETYPE_VALUES.map((a) => (
              <option key={a} value={a}>{ARCHETYPE_LABELS[a] || a}</option>
            ))}
          </select>
        </label>

        <div className="space-y-2">
          <div className="text-[12px] text-gray-300">Scope</div>
          <div className="flex items-center gap-4">
            <label className="text-[12px] text-gray-200 flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                checked={!isOrgWide}
                onChange={() => setDoc((d) => ({ ...d, customerLabel: d.customerLabel || "New Customer" }))}
                disabled={!createMode}
              />
              Customer-specific
            </label>
            <label className="text-[12px] text-gray-200 flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                checked={isOrgWide}
                onChange={() => setScope(true)}
                disabled={!createMode}
              />
              Org-wide
            </label>
          </div>
          {!isOrgWide && (
            <input
              type="text"
              className="w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2 disabled:opacity-50"
              placeholder="Customer name (e.g., Comcast Restoration)"
              value={doc.customerLabel}
              onChange={(e) => setCustomerLabel(e.target.value)}
              disabled={!createMode}
            />
          )}
        </div>
      </section>

      {/* Required proof — PR 120b uses RequiredProofEditor so each
          item carries a label + optional Reason textarea. The Reason
          flows into incident.requirements.requiredProofDescriptions
          at incident creation (PR 120a) and renders as a "Reason:"
          line on Summary / Proof Capture / AcceptanceReadinessPanel. */}
      <RequiredProofEditor
        labels={doc.requiredProof}
        descriptions={doc.requiredProofDescriptions}
        onLabelChange={setRequiredProofLabel}
        onDescriptionChange={setRequiredProofDescription}
        onAdd={addRequiredProofItem}
        onRemove={removeRequiredProofItem}
      />

      {/* Optional proof */}
      <StringListEditor
        title="Optional proof"
        subtitle="Items that strengthen the packet but aren&apos;t strictly required."
        values={doc.optionalProof}
        onChange={(i, v) => setStringList("optionalProof", i, v)}
        onAdd={() => addStringListItem("optionalProof")}
        onRemove={(i) => removeStringListItem("optionalProof", i)}
      />

      {/* Acceptance criteria (prose, display-only) */}
      <StringListEditor
        title="Acceptance criteria (prose)"
        subtitle="Customer-facing acceptance language. Displayed only — not evaluated. For deterministic checks, use Acceptance checks below."
        values={doc.acceptanceCriteria}
        onChange={(i, v) => setStringList("acceptanceCriteria", i, v)}
        onAdd={() => addStringListItem("acceptanceCriteria")}
        onRemove={(i) => removeStringListItem("acceptanceCriteria", i)}
      />

      {/* Acceptance checks (deterministic) */}
      <section className="space-y-3">
        <div className="space-y-1">
          <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
            Acceptance checks (deterministic)
          </div>
          <div className="text-[11px] text-gray-500 leading-relaxed">
            Drive Acceptance Readiness. Each check has a type (one of 5 evaluators) plus an optional
            customer-facing label and description.
          </div>
        </div>

        {doc.acceptanceChecks.length === 0 && (
          <div className="text-[12px] text-gray-500 italic">No acceptance checks yet.</div>
        )}
        {doc.acceptanceChecks.map((c, i) => (
          <div key={i} className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2.5">
            <div className="grid grid-cols-2 gap-3">
              <label className="text-[11px] text-gray-300">
                Type
                <select
                  className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-2 py-1.5"
                  value={c.type}
                  onChange={(e) => setCheck(i, { type: e.target.value as CheckType })}
                >
                  {CHECK_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="text-[11px] text-gray-300">
                Tier
                <select
                  className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-2 py-1.5"
                  value={c.tier}
                  onChange={(e) => setCheck(i, { tier: e.target.value as "required" | "encouraged" })}
                >
                  <option value="required">Required</option>
                  <option value="encouraged">Encouraged</option>
                </select>
              </label>
            </div>
            <label className="block text-[11px] text-gray-300">
              Label (optional, ≤200 chars)
              <input
                type="text"
                className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-2 py-1.5"
                placeholder="Customer-facing label (e.g., 'Comcast QA signoff')"
                maxLength={200}
                value={c.label || ""}
                onChange={(e) => setCheck(i, { label: e.target.value })}
              />
            </label>
            <label className="block text-[11px] text-gray-300">
              Description (optional, ≤500 chars)
              <textarea
                className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-2 py-1.5 min-h-[60px]"
                placeholder="Longer-form explanation (e.g., contract reference)"
                maxLength={500}
                value={c.description || ""}
                onChange={(e) => setCheck(i, { description: e.target.value })}
              />
            </label>
            {c.type === "requires_minimum_proof_count" && (
              <label className="block text-[11px] text-gray-300">
                Minimum proof count
                <input
                  type="number"
                  min={1}
                  className="mt-1 w-full sm:w-32 text-sm bg-black/40 border border-white/15 rounded-lg px-2 py-1.5"
                  value={c.params?.minCount ?? 1}
                  onChange={(e) => setCheck(i, { params: { minCount: Math.max(1, Number(e.target.value) || 1) } })}
                />
              </label>
            )}
            <div className="flex justify-end">
              <button
                type="button"
                className="text-[11px] text-gray-400 hover:text-red-300"
                onClick={() => removeCheck(i)}
              >
                Remove check
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="text-[12px] px-3 py-1.5 rounded-full border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10]"
          onClick={addCheck}
        >
          + Add check
        </button>
      </section>

      {/* Change note + save */}
      <section className="space-y-3 pt-4 border-t border-white/10">
        <label className="block text-[12px] text-gray-300">
          Change note (optional — appears in admin audit log)
          <textarea
            className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2 min-h-[60px]"
            placeholder="What did you change in this save?"
            maxLength={500}
            value={changeNote}
            onChange={(e) => setChangeNote(e.target.value)}
          />
        </label>

        {saveErr && (
          <div className="rounded-lg border border-red-300/25 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-200">
            {saveErr}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            className={
              "px-4 py-2 rounded-full text-[12px] font-semibold transition " +
              (canSave
                ? "bg-white text-black hover:bg-white/90"
                : "bg-white/10 text-gray-500 cursor-not-allowed")
            }
            onClick={onSave}
            disabled={!canSave}
            title={!doc.archetype ? "Pick an archetype" : (doc.requiredProof.filter((s) => s.trim()).length === 0 ? "Add at least one required-proof item" : (saving ? "Saving…" : "Save changes"))}
          >
            {saving ? "Saving…" : (createMode ? "Create template" : `Save (→ v${(doc.version ?? 0) + 1})`)}
          </button>
          <button
            type="button"
            className="text-[12px] text-gray-400 hover:text-gray-100"
            onClick={() => router.push(`/admin/templates?orgId=${encodeURIComponent(orgId)}`)}
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

// PEAKOPS_TEMPLATE_PROVENANCE_V1 (PR 120b)
// Richer editor used for the requiredProof section: each item carries
// a label input + optional Reason textarea, kept on parallel arrays.
// The acceptanceChecks editor handles its own label/description per
// item separately (PR 119b); StringListEditor stays in use for
// optionalProof + acceptanceCriteria where no per-item rationale is
// needed.
function RequiredProofEditor({
  labels,
  descriptions,
  onLabelChange,
  onDescriptionChange,
  onAdd,
  onRemove,
}: {
  labels: string[];
  descriptions: string[];
  onLabelChange: (idx: number, value: string) => void;
  onDescriptionChange: (idx: number, value: string) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
          Required proof
        </div>
        <div className="text-[11px] text-gray-500 leading-relaxed">
          Items the packet must contain to feel acceptance-ready. At least one is required.
          Add a Reason to explain WHY the requirement exists — the operator and
          customer both see this text on every record built from this template.
        </div>
      </div>
      {labels.length === 0 && (
        <div className="text-[12px] text-gray-500 italic">No items yet.</div>
      )}
      {labels.map((label, i) => (
        <div key={i} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="flex-1 text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2"
              placeholder="Required proof item (e.g., GPS capture)"
              maxLength={200}
              value={label}
              onChange={(e) => onLabelChange(i, e.target.value)}
            />
            <button
              type="button"
              className="text-[11px] text-gray-400 hover:text-red-300 px-2"
              onClick={() => onRemove(i)}
              title="Remove this item"
            >
              ×
            </button>
          </div>
          <label className="block text-[11px] text-gray-300">
            Reason (optional, ≤500 chars)
            <textarea
              className="mt-1 w-full text-sm bg-black/40 border border-white/15 rounded-lg px-2 py-1.5 min-h-[44px]"
              placeholder="Why is this required? (e.g., Customer requires proof of site presence.)"
              maxLength={500}
              value={descriptions[i] || ""}
              onChange={(e) => onDescriptionChange(i, e.target.value)}
            />
          </label>
        </div>
      ))}
      <button
        type="button"
        className="text-[12px] px-3 py-1.5 rounded-full border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10]"
        onClick={onAdd}
      >
        + Add item
      </button>
    </section>
  );
}

function StringListEditor({
  title,
  subtitle,
  values,
  onChange,
  onAdd,
  onRemove,
}: {
  title: string;
  subtitle: string;
  values: string[];
  onChange: (idx: number, value: string) => void;
  onAdd: () => void;
  onRemove: (idx: number) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <div className="text-[12px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">{title}</div>
        <div className="text-[11px] text-gray-500 leading-relaxed">{subtitle}</div>
      </div>
      {values.length === 0 && (
        <div className="text-[12px] text-gray-500 italic">No items yet.</div>
      )}
      {values.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            className="flex-1 text-sm bg-black/40 border border-white/15 rounded-lg px-3 py-2"
            placeholder="Item"
            maxLength={200}
            value={v}
            onChange={(e) => onChange(i, e.target.value)}
          />
          <button
            type="button"
            className="text-[11px] text-gray-400 hover:text-red-300 px-2"
            onClick={() => onRemove(i)}
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-[12px] px-3 py-1.5 rounded-full border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10]"
        onClick={onAdd}
      >
        + Add item
      </button>
    </section>
  );
}

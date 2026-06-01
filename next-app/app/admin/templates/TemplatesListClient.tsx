"use client";

// PEAKOPS_TEMPLATES_EDITOR_V1 (PR 119b)
//
// List view for /admin/templates. Admin/owner only (server enforces
// via listOrgTemplatesV1; client-side gate is defense-in-depth +
// avoids leaking the unauthorized UI).
//
// Visual treatment per scope: simple, boring, operational. One row
// per template. Click → edit page.

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authedFetch } from "@/lib/apiClient";
import { useAuth } from "@/hooks/useAuth";
import AppTopBar from "@/components/AppTopBar";
import RequireAuth from "@/components/RequireAuth";
import { ARCHETYPE_LABELS, type Archetype } from "@/lib/incidents/newIncidentDraft";

const ADMIN_ROLES = new Set(["owner", "admin"]);

type TemplateSummary = {
  templateKey: string;
  archetype: string;
  customerSlug: string;
  customerLabel: string;
  requiredProofCount: number;
  optionalProofCount: number;
  acceptanceCriteriaCount: number;
  acceptanceChecksCount: number;
  version: number;
  createdAt: string | null;
  createdBy: string;
  updatedAt: string | null;
  updatedBy: string;
};

export default function TemplatesListClient() {
  return (
    <RequireAuth>
      <main className="min-h-screen bg-black text-white">
        <AppTopBar />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10">
          <ListBody />
        </div>
      </main>
    </RequireAuth>
  );
}

function ListBody() {
  const router = useRouter();
  const sp = useSearchParams();
  const { claims } = useAuth();
  const role = String(claims?.role || "").toLowerCase();
  const isAdmin = ADMIN_ROLES.has(role);

  const orgId = useMemo(() => {
    const q = String(sp?.get("orgId") || "").trim();
    if (q) return q;
    try {
      const v = String(localStorage.getItem("peakops_orgId") || "").trim();
      if (v) return v;
    } catch { /* */ }
    return "";
  }, [sp]);

  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    if (!isAdmin || !orgId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch(
          `/api/fn/listOrgTemplatesV1?orgId=${encodeURIComponent(orgId)}`,
          { cache: "no-store" },
        );
        const out: { ok?: boolean; templates?: TemplateSummary[]; error?: string } = await res.json().catch(() => ({}));
        if (!res.ok || !out.ok) {
          throw new Error(out.error || `Failed to load templates (${res.status})`);
        }
        if (!cancelled) {
          setTemplates(out.templates || []);
          setLoading(false);
        }
      } catch (e: any) {
        if (!cancelled) {
          setErr(e?.message || String(e));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, isAdmin]);

  if (!isAdmin) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
          Templates
        </div>
        <div className="mt-2 text-sm text-gray-300">
          You don&apos;t have access to template authoring. This page is owner/admin only.
        </div>
      </div>
    );
  }
  if (!orgId) {
    return (
      <div className="rounded-2xl border border-amber-300/25 bg-amber-500/[0.05] p-6">
        <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
          Templates
        </div>
        <div className="mt-2 text-sm text-gray-300">
          Open this page from a workspace link (with <span className="font-mono">?orgId=…</span>) or pick an
          organization from your dashboard first.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between gap-3">
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-200/70">
            Templates · {orgId}
          </div>
          <h1 className="text-xl font-semibold leading-tight tracking-tight text-white">
            Customer acceptance requirements
          </h1>
          <p className="text-[13px] text-gray-300 leading-relaxed max-w-prose">
            What each customer&apos;s packet must contain to feel acceptance-ready. Edits never apply retroactively
            to existing records — their requirements snapshot is frozen at creation time.
          </p>
        </div>
        <button
          type="button"
          className="px-3 py-1.5 rounded-full text-[12px] font-medium border border-white/15 bg-white/[0.04] text-gray-200 hover:bg-white/[0.10] hover:text-white transition-colors whitespace-nowrap"
          onClick={() => router.push(`/admin/templates/new?orgId=${encodeURIComponent(orgId)}`)}
        >
          + New template
        </button>
      </header>

      {loading && (
        <div className="text-[12px] text-gray-500 italic">Loading templates…</div>
      )}
      {err && (
        <div className="rounded-lg border border-red-300/25 bg-red-500/[0.05] px-3 py-2 text-[12px] text-red-200">
          {err}
        </div>
      )}
      {!loading && !err && templates.length === 0 && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 text-[13px] text-gray-300">
          No templates yet. Click <span className="font-semibold">+ New template</span> to author one.
        </div>
      )}

      <div className="space-y-2.5">
        {templates.map((t) => {
          const arche = ARCHETYPE_LABELS[t.archetype as Archetype] || t.archetype;
          const title = t.customerLabel
            ? `${arche} — ${t.customerLabel}`
            : `${arche} · org-wide`;
          return (
            <button
              key={t.templateKey}
              type="button"
              className="w-full text-left rounded-xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] transition-colors px-4 py-3"
              onClick={() => router.push(`/admin/templates/${encodeURIComponent(t.templateKey)}?orgId=${encodeURIComponent(orgId)}`)}
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-[14px] font-medium text-gray-100 truncate">{title}</div>
                <div className="text-[11px] text-gray-500 shrink-0">
                  v{t.version || 1} · edited {fmtAgo(t.updatedAt)} by {t.updatedBy || "—"}
                </div>
              </div>
              <div className="text-[11px] text-gray-400 mt-1">
                {t.requiredProofCount} required {t.requiredProofCount === 1 ? "item" : "items"}
                {t.acceptanceChecksCount > 0
                  ? ` · ${t.acceptanceChecksCount} acceptance ${t.acceptanceChecksCount === 1 ? "check" : "checks"}`
                  : ""}
                {t.acceptanceCriteriaCount > 0
                  ? ` · ${t.acceptanceCriteriaCount} criteria`
                  : ""}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return "—";
  const dSec = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (dSec < 60) return `${dSec}s ago`;
  const dMin = Math.floor(dSec / 60);
  if (dMin < 60) return `${dMin}m ago`;
  const dHr = Math.floor(dMin / 60);
  if (dHr < 24) return `${dHr}h ago`;
  const dDy = Math.floor(dHr / 24);
  if (dDy < 30) return `${dDy}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

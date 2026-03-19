"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export type WorkflowStatus = "TODO" | "DOING" | "DONE";

export type WorkflowStep = {
  key: string;
  title: string;
  hint?: string;
  status?: WorkflowStatus; // backend may send, but we override with local
};

export type WorkflowV1 = {
  version: string;
  steps: WorkflowStep[];
};

type ApiResp = {
  ok: boolean;
  orgId?: string;
  incidentId?: string;
  workflow?: WorkflowV1;
  error?: string;
};

function storageKey(orgId: string, incidentId: string) {
  return `wf:${orgId}:${incidentId}:v1`;
}

function safeParseJSON(s: string | null): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function useWorkflowState(orgId: string, incidentId: string) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [workflow, setWorkflow] = useState<WorkflowV1 | null>(null);

  const localMap = useMemo(() => {
    if (typeof window === "undefined") return {};
    const m = safeParseJSON(localStorage.getItem(storageKey(orgId, incidentId)));
    return (m && typeof m === "object") ? m : {};
  }, [orgId, incidentId]);

  const merged = useMemo(() => {
    if (!workflow) return null;
    const steps = (workflow.steps || []).map(s => {
      const k = String(s.key);
      const local = localMap[k] as WorkflowStatus | undefined;
      return { ...s, status: local || (s.status as WorkflowStatus) || "TODO" };
    });
    return { ...workflow, steps };
  }, [workflow, localMap]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      const url = `/api/fn/getWorkflowV1?orgId=${encodeURIComponent(orgId)}&incidentId=${encodeURIComponent(incidentId)}`;
      const r = await fetch(url, { method: "GET" });
      const text = await r.text();
      let j: ApiResp | null = null;
      try { j = JSON.parse(text); } catch {
        throw new Error(`Workflow API returned non-JSON (HTTP ${r.status})`);
      }
      if (!j?.ok) throw new Error(j?.error || "getWorkflowV1 failed");
      setWorkflow(j.workflow || { version: "v1", steps: [] });
    } catch (e: any) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }, [orgId, incidentId]);

  useEffect(() => { refresh(); }, [refresh]);

  const setLocalStatus = useCallback((stepKey: string, status: WorkflowStatus) => {
    try {
      const k = storageKey(orgId, incidentId);
      const cur = safeParseJSON(localStorage.getItem(k)) || {};
      cur[String(stepKey)] = status;
      localStorage.setItem(k, JSON.stringify(cur));
    } catch {}
    // optimistic override in UI immediately by patching workflow state too
    setWorkflow(prev => {
      if (!prev?.steps) return prev;
      return {
        ...prev,
        steps: prev.steps.map(s =>
          String(s.key) === String(stepKey) ? { ...s, status } : s
        )
      };
    });
  }, [orgId, incidentId]);

  return { busy, err, workflow: merged, refresh, setLocalStatus };
}

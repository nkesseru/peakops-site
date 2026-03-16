#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
FILE="$ROOT/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
BAK="$FILE.bak_$TS"

echo "== verify file =="
test -f "$FILE"
cp "$FILE" "$BAK"
echo "backup: $BAK"

python3 <<'PY'
from pathlib import Path

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text()

marker = "// PEAKOPS_JOB_AUTOSELECT_HARDEN_V2"
if marker in s:
    print("already patched")
    raise SystemExit(0)

anchor = """  const hasActiveFieldJobs = selectableFieldJobs.length > 0;

  useEffect(() => {
    const currentId = String(currentJobId || "").trim();
    const existsInSelectable = selectableFieldJobs.some(
      (j: any) => String(j?.id || j?.jobId || "") === currentId
    );
    if (currentId && existsInSelectable) return;
    const firstSelectableId = String(selectableFieldJobs?.[0]?.id || selectableFieldJobs?.[0]?.jobId || "").trim();
    if (firstSelectableId) setCurrentJobId(firstSelectableId);
  }, [selectableFieldJobs, currentJobId]);
"""

replacement = """  const hasActiveFieldJobs = selectableFieldJobs.length > 0;

  useEffect(() => {
    const currentId = String(currentJobId || "").trim();
    const existsInSelectable = selectableFieldJobs.some(
      (j: any) => String(j?.id || j?.jobId || "") === currentId
    );
    if (currentId && existsInSelectable) return;
    const firstSelectableId = String(selectableFieldJobs?.[0]?.id || selectableFieldJobs?.[0]?.jobId || "").trim();
    if (firstSelectableId) setCurrentJobId(firstSelectableId);
  }, [selectableFieldJobs, currentJobId]);

  // PEAKOPS_JOB_AUTOSELECT_HARDEN_V2
  useEffect(() => {
    try {
      const list = Array.isArray(jobs) ? jobs : [];
      if (!list.length) return;

      const currentId = String(currentJobId || "").trim();
      const queryJobId = String(sp?.get?.("jobId") || "").trim();

      let savedJobId = "";
      try {
        savedJobId = String(localStorage.getItem(`peakops_current_job_${String(incidentId || "").trim()}`) || "").trim();
      } catch {}

      const normalized = list
        .map((j: any) => ({
          raw: j,
          id: String(j?.id || j?.jobId || "").trim(),
          status: String(j?.status || j?.rawStatus || "").trim().toLowerCase(),
        }))
        .filter((j: any) => j.id);

      if (!normalized.length) return;

      const currentStillExists = normalized.some((j: any) => j.id === currentId);
      if (currentId && currentStillExists) return;

      const chosen =
        normalized.find((j: any) => j.id === queryJobId) ||
        normalized.find((j: any) => j.id === savedJobId) ||
        normalized.find((j: any) => j.status === "open") ||
        normalized.find((j: any) => j.status === "in_progress" || j.status === "in-progress") ||
        normalized[0];

      const chosenId = String(chosen?.id || "").trim();
      if (!chosenId) return;

      setCurrentJobId(chosenId);

      try {
        localStorage.setItem(`peakops_current_job_${String(incidentId || "").trim()}`, chosenId);
      } catch {}

      if (process.env.NODE_ENV !== "production") {
        console.debug("[job-autoselect-hardened]", {
          incidentId,
          chosenId,
          queryJobId,
          savedJobId,
          currentId,
          jobsCount: normalized.length,
        });
      }
    } catch (e) {
      console.warn("[incident] hardened auto-select failed", e);
    }
  }, [jobs, currentJobId, incidentId, sp]);
"""

if anchor not in s:
    raise SystemExit("Could not find autoselect anchor block.")

s = s.replace(anchor, replacement, 1)

fetch_old = """        const docs = jb.docs;
        setJobs(docs);
        const selectable = docs.filter((j: any) => isFieldSelectableJob(j?.status));
        const currentId = String(currentJobId || "").trim();
        const existsInSelectable = selectable.some((j: any) => String(j?.id || j?.jobId || "") === currentId);
        const firstSelectableId = String(selectable?.[0]?.id || selectable?.[0]?.jobId || "").trim();
        let effectiveJobId = currentId;
        if (!currentId || !existsInSelectable) {
          if (firstSelectableId) {
            setCurrentJobId(firstSelectableId);
            effectiveJobId = firstSelectableId;
          } else {
            setCurrentJobId("");
            effectiveJobId = "";
          }
        }"""

fetch_new = """        const docs = jb.docs;
        setJobs(docs);

        const normalizedDocs = docs
          .map((j: any) => ({
            raw: j,
            id: String(j?.id || j?.jobId || "").trim(),
            status: String(j?.status || j?.rawStatus || "").trim().toLowerCase(),
          }))
          .filter((j: any) => j.id);

        const selectable = docs.filter((j: any) => isFieldSelectableJob(j?.status));
        const currentId = String(currentJobId || "").trim();
        const existsInSelectable = selectable.some((j: any) => String(j?.id || j?.jobId || "") === currentId);
        const firstSelectableId = String(selectable?.[0]?.id || selectable?.[0]?.jobId || "").trim();
        const firstAnyId = String(normalizedDocs?.[0]?.id || "").trim();

        let effectiveJobId = currentId;
        if (!currentId || !existsInSelectable) {
          const nextId = firstSelectableId || firstAnyId;
          if (nextId) {
            setCurrentJobId(nextId);
            effectiveJobId = nextId;
          } else {
            setCurrentJobId("");
            effectiveJobId = "";
          }
        }"""

if fetch_old in s:
    s = s.replace(fetch_old, fetch_new, 1)
else:
    print("warning: fetch block not replaced; continuing with effect-only patch")

p.write_text(s)
print("patched IncidentClient.tsx")
PY

echo
echo "== clear next port 3001 =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN || true)"
if [ -n "${PIDS:-}" ]; then
  kill -9 $PIDS
fi

echo
echo "== clear next cache =="
rm -rf "$ROOT/next-app/.next"

echo
echo "== quick verify =="
rg -n "PEAKOPS_JOB_AUTOSELECT_HARDEN_V2|job-autoselect-hardened|firstAnyId" "$FILE"

echo
echo "✅ patch complete"
echo "Now run:"
echo "cd ~/peakops/my-app && pnpm dev"

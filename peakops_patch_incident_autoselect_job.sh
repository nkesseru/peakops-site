#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app/next-app"
FILE="$ROOT/app/incidents/[incidentId]/IncidentClient.tsx"
TS="$(date +%Y%m%d_%H%M%S)"
BAK="$FILE.bak_$TS"

echo "== verify file =="
test -f "$FILE"

cp "$FILE" "$BAK"
echo "backup: $BAK"

python3 <<'PY'
from pathlib import Path
import re

p = Path.home() / "peakops/my-app/next-app/app/incidents/[incidentId]/IncidentClient.tsx"
s = p.read_text()

marker = 'const [selectedJobId, setSelectedJobId] = useState'
if marker not in s:
    raise SystemExit("Could not find selectedJobId state. Stop and inspect file manually.")

if "AUTOSELECT_JOB_EFFECT_V1" in s:
    print("Patch already present. No changes made.")
    raise SystemExit(0)

anchor = "const [selectedJobId, setSelectedJobId] = useState"
idx = s.find(anchor)
line_end = s.find("\n", idx)
insert_at = line_end + 1

block = r'''

  // AUTOSELECT_JOB_EFFECT_V1
  useEffect(() => {
    try {
      const list = Array.isArray(jobs) ? jobs : [];
      if (!list.length) return;

      const current = String(selectedJobId || "").trim();
      if (current) return;

      const queryJobId =
        typeof window !== "undefined"
          ? String(new URLSearchParams(window.location.search).get("jobId") || "").trim()
          : "";

      let savedJobId = "";
      try {
        savedJobId = typeof window !== "undefined"
          ? String(localStorage.getItem(`peakops_current_job_${String(incidentId || "").trim()}`) || "").trim()
          : "";
      } catch {}

      const normalized = list
        .map((j: any) => ({
          raw: j,
          id: String(j?.id || j?.jobId || "").trim(),
          status: String(j?.status || j?.rawStatus || "").trim().toLowerCase(),
        }))
        .filter((j: any) => j.id);

      if (!normalized.length) return;

      const chosen =
        normalized.find((j: any) => j.id === queryJobId) ||
        normalized.find((j: any) => j.id === savedJobId) ||
        normalized.find((j: any) => j.status === "open") ||
        normalized.find((j: any) => j.status === "in_progress" || j.status === "in-progress") ||
        normalized[0];

      const chosenId = String(chosen?.id || "").trim();
      if (!chosenId) return;

      setSelectedJobId(chosenId);

      try {
        if (typeof window !== "undefined") {
          localStorage.setItem(`peakops_current_job_${String(incidentId || "").trim()}`, chosenId);
        }
      } catch {}
    } catch (e) {
      console.warn("[incident] auto-select job failed", e);
    }
  }, [jobs, selectedJobId, incidentId]);

'''

s = s[:insert_at] + block + s[insert_at:]
p.write_text(s)
print("Patched IncidentClient.tsx")
PY

echo
echo "== syntax-ish check =="
rg -n "AUTOSELECT_JOB_EFFECT_V1|selectedJobId|peakops_current_job_" "$FILE"

echo
echo "== clear Next cache =="
rm -rf "$ROOT/.next"

echo
echo "Done."
echo "Now restart Next:"
echo "  cd ~/peakops/my-app && pnpm dev"

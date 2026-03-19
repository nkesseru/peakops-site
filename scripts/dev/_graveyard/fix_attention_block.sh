#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

ts="$(date +%Y%m%d_%H%M%S)"
cp -v "$FILE" "$FILE.bak_attention_fix_$ts" >/dev/null
echo "✅ backup -> $FILE.bak_attention_fix_$ts"

python3 - <<'PY'
import re
from pathlib import Path

p = Path("next-app/src/app/admin/incidents/[id]/page.tsx")
s = p.read_text()

# 1) Remove any previously injected attention blocks (keep file sane)
#    (We’ll rebuild them cleanly.)
s = re.sub(r'\n\s*// --- Attention items.*?// --- end Needs Attention \(derived\) ---\n', '\n', s, flags=re.S)

# 2) Remove any stray/double "incident/filings/timelineMeta/logs" consts (we'll insert once)
s = re.sub(r'\n\s*const\s+incident\s*=\s*bundle\?\..*?\n\s*const\s+timelineMeta\s*=.*?\n', '\n', s, flags=re.S)

# 3) Find a safe anchor AFTER state declarations, BEFORE UI derives.
#    We'll anchor right after banner state, which you have.
m = re.search(r'const\s+\[banner,\s*setBanner\]\s*=\s*useState<.*?>\([^)]*\);\s*\n', s)
if not m:
    raise SystemExit("❌ Could not find banner state anchor (const [banner, setBanner] = useState...).")

insert_at = m.end()

block = """
  // -----------------------------
  // Derived core objects (stable)
  // -----------------------------
  const incident = bundle?.incident ?? null;
  const filings = Array.isArray(bundle?.filings) ? bundle.filings : [];
  const logs = bundle?.logs ?? {};
  const filingsMeta = incident?.filingsMeta ?? null;
  const timelineMeta = bundle?.timelineMeta ?? incident?.timelineMeta ?? null;

  // --- Needs Attention (derived) ---
  function attentionLine(x: any) {
    if (!x) return "WARN: Unknown issue";
    if (typeof x === "string") return x;
    const level = String(x.level || x.severity || "WARN").toUpperCase();
    let msg = x.message || x.text || x.reason;
    if (!msg) {
      try { msg = JSON.stringify(x); } catch { msg = String(x); }
    }
    return `${level}: ${msg}`;
  }

  const showAttention = useMemo(() => {
    const hasMeta = !!(timelineMeta || filingsMeta);
    const hasFilings = Array.isArray(filings) && filings.length > 0;
    const hasTimeline = Array.isArray(timelineEvents) && timelineEvents.length > 0;
    const lg: any = logs || {};
    const hasLogs = ((lg?.system?.length || 0) + (lg?.user?.length || 0) + (lg?.filing?.length || 0)) > 0;
    return hasMeta || hasFilings || hasTimeline || hasLogs;
  }, [timelineMeta, filingsMeta, filings, timelineEvents, logs]);

  const attentionItems = useMemo(() => {
    try {
      if (typeof computeAttention === "function") {
        return computeAttention({ incident, filings, timelineMeta }) || [];
      }
      return [];
    } catch {
      return [];
    }
  }, [incident, filings, timelineMeta]);

  const attentionBlocks = useMemo(
    () =>
      (showAttention ? attentionItems : [])
        .filter((x: any) => String(x?.level || x?.severity || "").toUpperCase() === "BLOCK")
        .map(attentionLine),
    [attentionItems, showAttention]
  );

  const attentionWarns = useMemo(
    () =>
      (showAttention ? attentionItems : [])
        .filter((x: any) => String(x?.level || x?.severity || "").toUpperCase() === "WARN")
        .map(attentionLine),
    [attentionItems, showAttention]
  );
  // --- end Needs Attention (derived) ---

"""

s = s[:insert_at] + block + s[insert_at:]
p.write_text(s)
print("✅ Rebuilt Needs Attention block + stable derived objects (incident/filings/logs/meta).")
PY

echo "✅ done"

echo "==> quick sanity: ensure only one attentionItems + showAttention"
rg -n "const attentionItems|const showAttention|function attentionLine" "$FILE" || true

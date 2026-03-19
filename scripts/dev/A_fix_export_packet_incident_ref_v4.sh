#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILE="functions_clean/exportIncidentPacketV1.js"
cp "$FILE" "$FILE.bak_incidentref_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup: $FILE.bak_incidentref_*"

node - <<'NODE'
const fs = require("fs");

const file = "functions_clean/exportIncidentPacketV1.js";
let s = fs.readFileSync(file, "utf8");
const before = s;

// 1) Ensure incidentData exists (best-effort: insert after the FIRST incidentRef.get())
const getIdx = s.search(/await\s+incidentRef\.get\(\)\s*;/);
if (getIdx !== -1 && !s.includes("const incidentData")) {
  s = s.replace(
    /await\s+incidentRef\.get\(\)\s*;/,
    (m) => m + "\n\n    // normalized: always use incidentData for packet composition\n    const incidentData = (incidentSnap && incidentSnap.exists) ? (incidentSnap.data() || {}) : {};\n"
  );
}

// If they used a different snap var name than incidentSnap, try to detect it
// and rewrite the incidentData line accordingly.
s = s.replace(
  /const\s+incidentData\s*=\s*\(incidentSnap\s*&&\s*incidentSnap\.exists\)\s*\?\s*\(incidentSnap\.data\(\)\s*\|\|\s*\{\}\)\s*:\s*\{\}\s*;/,
  () => {
    const m = s.match(/const\s+(\w+)\s*=\s*await\s+incidentRef\.get\(\)\s*;/);
    const snapVar = m ? m[1] : "incidentSnap";
    return `const incidentData = (${snapVar} && ${snapVar}.exists) ? (${snapVar}.data() || {}) : {};`;
  }
);

// 2) Replace incident. -> incidentData. (safe)
s = s.replace(/\bincident\./g, "incidentData.");

// 3) If packet object uses shorthand `incident,` normalize to `incident: incidentData,`
s = s.replace(/\{\s*orgId\s*,\s*incidentId\s*,\s*exportedAt\s*,\s*incident\s*,/g, "{ orgId, incidentId, exportedAt, incident: incidentData,");
s = s.replace(/\bincident\s*,\s*filings\s*,\s*timelineEvents\b/g, "incident: incidentData, filings, timelineEvents");

// 4) If packet uses `incident` key explicitly referencing `incident`, fix it
s = s.replace(/\bincident\s*:\s*incident\b/g, "incident: incidentData");

// 5) FINAL SAFETY: if we still see a bare `incident` identifier (not incidentId), print hints
const leftovers = s.split("\n").filter(l => /\bincident\b/.test(l) && !/incidentId/.test(l) && !/incidentData/.test(l));
if (leftovers.length) {
  console.log("⚠️ leftover bare `incident` tokens remain (showing up to 5):");
  leftovers.slice(0,5).forEach(l => console.log("  " + l.trim()));
}

fs.writeFileSync(file, s, "utf8");
console.log(s !== before ? "✅ patched exportIncidentPacketV1.js (incidentData normalized)" : "ℹ️ no changes (already normalized)");
NODE

echo "✅ done"

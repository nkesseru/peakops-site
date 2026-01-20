#!/usr/bin/env bash
set -euo pipefail
set +H 2>/dev/null || true

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

FILE="functions_clean/exportIncidentPacketV1.js"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing: $FILE"
  exit 1
fi

cp "$FILE" "$FILE.bak_incidentvar_$(date +%Y%m%d_%H%M%S)"
echo "✅ backup: $FILE.bak_incidentvar_*"

node <<'NODE'
const fs = require("fs");

const file = "functions_clean/exportIncidentPacketV1.js";
let s = fs.readFileSync(file, "utf8");

// Find the snapshot var name: const <snapVar> = await incidentRef.get();
const m = s.match(/const\s+(\w+)\s*=\s*await\s+incidentRef\.get\(\)\s*;/);
if (!m) {
  console.error("❌ Could not find `const <snap> = await incidentRef.get();` in " + file);
  process.exit(1);
}
const snapVar = m[1];

// Ensure we have `incidentData` declared exactly once (right after the snap)
if (!s.includes("const incidentData =")) {
  s = s.replace(
    new RegExp(`(const\\s+${snapVar}\\s*=\\s*await\\s+incidentRef\\.get\$begin:math:text$\\$end:math:text$\\s*;)`),
    `$1\n\n    // normalized: always use incidentData for packet composition\n    const incidentData = ${snapVar}.exists ? (${snapVar}.data() || {}) : {};`
  );
}

// If there's an older guard that creates `const incident = ...`, rename it to incidentData
s = s.replace(
  new RegExp(`const\\s+incident\\s*=\\s*${snapVar}\\.exists\\s*\\?\\s*\$begin:math:text$\$\{snapVar\}\\\\\.data\\\\\(\\$end:math:text$\\s*\\|\\|\\s*\\{\\}\\)\\s*:\\s*\\{\\}\\s*;`, "g"),
  `const incidentData = ${snapVar}.exists ? (${snapVar}.data() || {}) : {};`
);

// Replace packet composition field `incident` to `incidentData` (object literal key stays 'incident')
s = s.replace(/\bincident\s*:\s*incident\b/g, "incident: incidentData");

// Replace ANY remaining `incident.` property access to `incidentData.` (but do NOT touch incidentId/orgId)
s = s.replace(/\bincident\./g, "incidentData.");

// If the packet object is built like `{ orgId, incidentId, exportedAt, incident, ... }` ensure it uses incidentData
s = s.replace(/\{\s*orgId\s*,\s*incidentId\s*,\s*exportedAt\s*,\s*incident\s*,/g, "{ orgId, incidentId, exportedAt, incident: incidentData,");

// Safety: if both `const incidentData = ...` got duplicated, keep first and remove the rest
const lines = s.split("\n");
let seen = 0;
const out = [];
for (const ln of lines) {
  if (ln.includes("const incidentData =")) {
    seen++;
    if (seen > 1) continue;
  }
  out.push(ln);
}
s = out.join("\n");

// Cleanup accidental "\n" literal artifacts inserted earlier
s = s.replace(/\\n/g, "");

// Write back
fs.writeFileSync(file, s);
console.log("✅ Patched exportIncidentPacketV1.js: normalized incidentData + removed stray incident refs");
NODE

echo "✅ done"

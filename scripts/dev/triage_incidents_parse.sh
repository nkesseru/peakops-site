#!/usr/bin/env bash
set -euo pipefail
cd ~/peakops/my-app

FILE="next-app/src/app/admin/incidents/[id]/page.tsx"
if [ ! -f "$FILE" ]; then
  echo "❌ missing: $FILE"
  exit 1
fi

node - <<'NODE'
const fs = require("fs");
const ts = require("typescript");

const file = "next-app/src/app/admin/incidents/[id]/page.tsx";
const sourceText = fs.readFileSync(file, "utf8");

const source = ts.createSourceFile(
  file,
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

const diags = source.parseDiagnostics || [];
if (!diags.length) {
  console.log("✅ TypeScript TSX parser: no parse diagnostics (so Next/SWC is choking differently).");
  process.exit(0);
}

const d = diags[0];
const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
const pos = d.start ?? 0;
const lc = source.getLineAndCharacterOfPosition(pos);

console.log("❌ TSX parse diagnostic:");
console.log("  message:", msg);
console.log(`  at: ${file}:${lc.line + 1}:${lc.character + 1}`);

const lines = sourceText.split(/\r?\n/);
const start = Math.max(0, lc.line - 5);
const end = Math.min(lines.length - 1, lc.line + 5);
console.log("\n--- context ---");
for (let i = start; i <= end; i++) {
  const mark = i === lc.line ? ">>" : "  ";
  console.log(`${mark} ${(i+1).toString().padStart(4)} | ${lines[i]}`);
}
NODE

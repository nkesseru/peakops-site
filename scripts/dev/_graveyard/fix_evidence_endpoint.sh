#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail

ROOT="$(pwd)"
FN_DIR="$ROOT/functions_clean"

echo "==> 0) sanity"
test -d "$FN_DIR" || { echo "❌ functions_clean not found"; exit 1; }

echo "==> 1) restore index.mjs to last known-good (try tag, fallback HEAD)"
if git rev-parse -q --verify phase2-submitqueue >/dev/null 2>&1; then
  git show phase2-submitqueue:functions_clean/index.mjs > "$FN_DIR/index.mjs"
  echo "✅ restored index.mjs from tag phase2-submitqueue"
else
  git restore --source=HEAD -- "$FN_DIR/index.mjs"
  echo "✅ restored index.mjs from HEAD"
fi

echo "==> 2) ensure functions_clean is ESM (export syntax allowed)"
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("functions_clean/package.json")
pkg = json.loads(p.read_text())
pkg["type"] = "module"
pkg["main"] = "index.mjs"
p.write_text(json.dumps(pkg, indent=2) + "\n")
print("✅ functions_clean/package.json set to type=module, main=index.mjs")
PY

echo "==> 3) write handler file (safe to overwrite)"
cat > "$FN_DIR/evidenceLockerApi.mjs" <<'MJS'
import { getFirestore } from "firebase-admin/firestore";

export async function handleListEvidenceLockerRequest(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Use GET" });

    const orgId = req.query.orgId;
    const incidentId = req.query.incidentId;
    const limitRaw = req.query.limit;

    if (typeof orgId !== "string" || typeof incidentId !== "string") {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    const limit = Math.max(1, Math.min(200, Number(limitRaw || 50) || 50));
    const db = getFirestore();

    const snap = await db
      .collection("incidents").doc(String(incidentId))
      .collection("evidence_locker")
      .orderBy("storedAt", "desc")
      .limit(limit)
      .get();

    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ ok: true, orgId, incidentId, count: docs.length, docs });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
MJS
echo "✅ wrote functions_clean/evidenceLockerApi.mjs"

echo "==> 4) patch index.mjs: add ONE import + ONE export (top-level, never inside a function)"
python3 - <<'PY'
from pathlib import Path
import re

idx = Path("functions_clean/index.mjs")
s = idx.read_text()

# remove any previous evidence locker lines (cleanup)
s = re.sub(r'^\s*import\s+\{\s*handleListEvidenceLockerRequest\s*\}\s+from\s+"\.\/evidenceLockerApi\.mjs";\s*\n', '', s, flags=re.M)
s = re.sub(r'^\s*export\s+const\s+listEvidenceLocker\s*=.*\n', '', s, flags=re.M)

imp = 'import { handleListEvidenceLockerRequest } from "./evidenceLockerApi.mjs";\n'
# insert after the onRequest import if present, else after last import, else at top
m = re.search(r'^(import\s+\{\s*onRequest\s*\}\s+from\s+"firebase-functions\/v2\/https";\s*\n)', s, flags=re.M)
if m:
  s = s[:m.end()] + imp + s[m.end():]
else:
  imps = list(re.finditer(r'^(import .*?\n)', s, flags=re.M))
  if imps:
    last = imps[-1].end()
    s = s[:last] + imp + s[last:]
  else:
    s = imp + s

s = s.rstrip() + "\n\nexport const listEvidenceLocker = onRequest(handleListEvidenceLockerRequest);\n"
idx.write_text(s)
print("✅ patched index.mjs (import + top-level export)")
PY

echo "==> 5) syntax check"
node --check "$FN_DIR/index.mjs"
node --check "$FN_DIR/evidenceLockerApi.mjs"
echo "✅ node --check passed"

echo "==> 6) restart dev stack"
bash scripts/dev/dev-down.sh 2>/dev/null || true
bash scripts/dev/dev-up.sh

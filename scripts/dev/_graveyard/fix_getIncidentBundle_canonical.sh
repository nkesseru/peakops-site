#!/usr/bin/env bash
set -euo pipefail
ROOT="$HOME/peakops/my-app"
cd "$ROOT"

FILE="functions_clean/index.mjs"
test -f "$FILE" || { echo "❌ missing $FILE"; exit 1; }

python3 - <<'PY'
from pathlib import Path
import re
p = Path("functions_clean/index.mjs")
s = p.read_text()

# Helper: inject a block only if not present
def ensure(snippet, anchor_pat):
    global s
    if snippet in s:
        return
    m = re.search(anchor_pat, s, flags=re.M)
    if not m:
        raise SystemExit(f"Could not find anchor for injection: {anchor_pat}")
    s = s[:m.end()] + "\n" + snippet + s[m.end():]

# 1) Ensure getFirestore import exists (most files already have it)
# We'll just confirm firebase-admin/firestore is present
if "getFirestore" not in s:
    # try to place it near other firestore imports
    ensure('import { getFirestore } from "firebase-admin/firestore";\n', r'^import .*firebase-admin\/app.*\n')

# 2) Ensure handler exists (function body for getIncidentBundle)
# We'll define a standalone handler, then wire export if needed.
handler = r'''
async function handleGetIncidentBundle(req, res) {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    if (!orgId or not incidentId) {
      return res.status(400).json({ ok:false, error:"Missing orgId/incidentId" });
    }

    const db = getFirestore();

    // Incident (source of truth)
    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();
    const incident = incSnap.exists ? (incSnap.data() || {}) : { id: incidentId, orgId };

    // Filings
    const filingsSnap = await incRef.collection("filings").get();
    const filings = filingsSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

    // Timeline events + meta
    let timelineEvents = [];
    try {
      const tSnap = await incRef.collection("timeline_events").orderBy("createdAt", "asc").limit(200).get();
      timelineEvents = tSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    } catch (_e) {}

    const timelineMeta = (incident.get("timelineMeta") if hasattr(incident,"get") else None) or incident.get("timelineMeta") or None
    const filingsMeta = (incident.get("filingsMeta") if hasattr(incident,"get") else None) or incident.get("filingsMeta") or None

    // Logs (safe defaults)
    const logs = {
      system: [],
      user: [],
      filing: [],
    };

    // If you store logs under incidents/<id>/logs, hydrate them; otherwise keep defaults
    try:
      ls = await incRef.collection("logs").limit(500).get()
      for d in ls.docs:
        x = d.data() or {}
        kind = str(x.get("kind") or x.get("type") or "").lower()
        if kind == "system":
          logs["system"].append({ "id": d.id, **x })
        elif kind == "user":
          logs["user"].append({ "id": d.id, **x })
        elif kind == "filing":
          logs["filing"].append({ "id": d.id, **x })
    except Exception:
      pass

    return res.json({
      ok: True,
      orgId,
      incidentId,
      incident,
      filings,
      logs,
      filingsMeta,
      timelineMeta,
      timelineEvents,
    })
  } catch (e) {
    return res.status(500).json({ ok:false, error:str(e) })
  }
}
'''
# The above handler is Python-ish due to quick draft—replace with JS-safe block below.

handler_js = r'''
async function handleGetIncidentBundle(req, res) {
  try {
    const orgId = String(req.query.orgId || "").trim();
    const incidentId = String(req.query.incidentId || "").trim();
    if (!orgId || !incidentId) {
      return res.status(400).json({ ok: false, error: "Missing orgId/incidentId" });
    }

    const db = getFirestore();

    const incRef = db.collection("incidents").doc(incidentId);
    const incSnap = await incRef.get();

    // Always return an incident object (even if missing)
    const incident = incSnap.exists ? (incSnap.data() || {}) : { id: incidentId, orgId };

    const filingsSnap = await incRef.collection("filings").get();
    const filings = filingsSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));

    let timelineEvents = [];
    try {
      const tSnap = await incRef.collection("timeline_events").orderBy("createdAt", "asc").limit(200).get();
      timelineEvents = tSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
    } catch (_e) {}

    const filingsMeta = incident?.filingsMeta ?? null;
    const timelineMeta = incident?.timelineMeta ?? null;

    // Safe defaults (you can later hydrate from Firestore if you standardize storage)
    const logs = { system: [], user: [], filing: [] };

    return res.json({
      ok: true,
      orgId,
      incidentId,
      incident,
      filings,
      logs,
      filingsMeta,
      timelineMeta,
      timelineEvents,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
'''

# Insert handler near other handlers (anchor after hello handler export is reliable)
if "function handleGetIncidentBundle" not in s:
    m = re.search(r'export const hello\s*=\s*onRequest\(', s)
    if not m:
        # fallback: top of file after imports
        m = re.search(r'^\s*//', s, flags=re.M) or re.search(r'^\s*$', s, flags=re.M)
        if not m:
            raise SystemExit("No insertion point found for handleGetIncidentBundle")
        idx = 0
    else:
        idx = m.start()
    s = s[:idx] + handler_js + "\n" + s[idx:]

# 3) Ensure export is wired
# We will export it as getIncidentBundle = onRequest(handleGetIncidentBundle)
if "export const getIncidentBundle" not in s:
    # Insert export near other exports (after hello export if possible)
    anchor = re.search(r'export const hello\s*=\s*onRequest\([^)]*\);\s*', s)
    if anchor:
        ins = 'export const getIncidentBundle = onRequest(handleGetIncidentBundle);\n'
        s = s[:anchor.end()] + "\n" + ins + s[anchor.end():]
    else:
        # fallback: append near EOF
        s = s.rstrip() + "\n\nexport const getIncidentBundle = onRequest(handleGetIncidentBundle);\n"

p.write_text(s)
print("✅ Patched functions_clean/index.mjs with canonical getIncidentBundle")
PY

echo "==> sanity check"
node --check functions_clean/index.mjs

echo "==> restart dev stack"
bash scripts/dev/dev-down.sh 2>/dev/null || true
bash scripts/dev/dev-up.sh

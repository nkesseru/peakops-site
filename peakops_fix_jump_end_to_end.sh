#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/peakops/my-app"
INC="$ROOT/next-app/app/incidents/[incidentId]/IncidentClient.tsx"

CARD_CANDIDATES=(
  "$ROOT/next-app/src/components/evidence/EvidenceLockerCard.tsx"
  "$ROOT/next-app/components/evidence/EvidenceLockerCard.tsx"
)

echo "== sanity =="
echo "IncidentClient: $INC"
for f in "${CARD_CANDIDATES[@]}"; do
  if [[ -f "$f" ]]; then
    CARD="$f"
    break
  fi
done

if [[ ! -f "$INC" ]]; then
  echo "❌ IncidentClient.tsx not found"
  exit 1
fi

if [[ -z "${CARD:-}" || ! -f "${CARD:-}" ]]; then
  echo "❌ Could not find EvidenceLockerCard.tsx"
  exit 1
fi

echo "EvidenceLockerCard: $CARD"

echo
echo "== kill port 3001 if occupied =="
PIDS="$(lsof -tiTCP:3001 -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$PIDS" ]]; then
  echo "Killing: $PIDS"
  kill -9 $PIDS || true
else
  echo "No 3001 listener found"
fi

echo
echo "== back up files =="
TS="$(date +%Y%m%d_%H%M%S)"
cp "$INC" "$INC.bak_jump_e2e_$TS"
cp "$CARD" "$CARD.bak_jump_e2e_$TS"

python3 <<'PY'
from pathlib import Path
import re
import sys

root = Path.home() / "peakops/my-app"
inc = root / "next-app/app/incidents/[incidentId]/IncidentClient.tsx"

card_candidates = [
    root / "next-app/src/components/evidence/EvidenceLockerCard.tsx",
    root / "next-app/components/evidence/EvidenceLockerCard.tsx",
]
card = None
for c in card_candidates:
    if c.exists():
        card = c
        break

if card is None:
    print("❌ EvidenceLockerCard.tsx not found")
    sys.exit(1)

inc_text = inc.read_text(encoding="utf-8")
orig_inc = inc_text

# 1) Add pendingJumpEvidenceId state right after selectedEvidenceId if possible
if "pendingJumpEvidenceId" not in inc_text:
    inc_text = re.sub(
        r'(const \[selectedEvidenceId,\s*setSelectedEvidenceId\]\s*=\s*useState<[^;]+;\n)',
        r'\1  const [pendingJumpEvidenceId, setPendingJumpEvidenceId] = useState<string>("");\n',
        inc_text,
        count=1
    )

# fallback if the exact typed state wasn't found
if "pendingJumpEvidenceId" not in inc_text:
    inc_text = re.sub(
        r'(const \[selectedEvidenceId,\s*setSelectedEvidenceId\]\s*=\s*useState\([^\n]*\)\s*;\n)',
        r'\1  const [pendingJumpEvidenceId, setPendingJumpEvidenceId] = useState<string>("");\n',
        inc_text,
        count=1
    )

# 2) Replace jumpToEvidence body with robust version
jump_pat = re.compile(
    r'const jumpToEvidence = \(eid: string\) => \{.*?\n  \};',
    re.S
)

jump_replacement = '''const jumpToEvidence = (eid: string) => {
    try {
      const id = String(eid || "").trim();
      if (!id) return;

      setSelectedEvidenceId(id);
      setPendingJumpEvidenceId(id);

      try {
        if (typeof setActiveTab === "function") setActiveTab("evidence");
      } catch {}

      try {
        const u = new URL(window.location.href);
        u.searchParams.set("evidenceId", id);
        window.history.replaceState({}, "", u.toString());
      } catch {}

      const tryScroll = () => {
        try {
          const escaped = (globalThis as any).CSS?.escape ? (globalThis as any).CSS.escape(id) : id;
          const selectors = [
            `[data-evidence-id="${id}"]`,
            `[data-evidence-id="${escaped}"]`,
            `#evidence-card-${escaped}`,
            `[data-evidence-ref="${id}"]`,
          ];

          for (const sel of selectors) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el) {
              try {
                el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
              } catch {}
              try {
                el.classList.add("ring-2", "ring-cyan-400/70");
                setTimeout(() => {
                  try { el.classList.remove("ring-2", "ring-cyan-400/70"); } catch {}
                }, 1800);
              } catch {}
              return true;
            }
          }
        } catch {}
        return false;
      };

      setTimeout(() => { tryScroll(); }, 0);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          tryScroll();
        });
      });
    } catch (e) {
      console.warn("[incident] jumpToEvidence failed", e);
    }
  };'''

if jump_pat.search(inc_text):
    inc_text = jump_pat.sub(jump_replacement, inc_text, count=1)
else:
    print("⚠️ Could not safely replace jumpToEvidence().")
    print("Search manually for: const jumpToEvidence = (eid: string) => {")
    sys.exit(2)

# 3) Add post-render pending jump effect if missing
if "pendingJumpEvidenceId" in inc_text and "pending evidence jump effect" not in inc_text.lower():
    insert_anchor = "const evidenceCount = evidence.length;"
    effect_block = '''
  // pending evidence jump effect
  useEffect(() => {
    try {
      const id = String(pendingJumpEvidenceId || "").trim();
      if (!id) return;
      if (String(activeTab || "").toLowerCase() !== "evidence") return;
      if (!Array.isArray(evidence) || !evidence.length) return;

      const run = () => {
        try {
          const escaped = (globalThis as any).CSS?.escape ? (globalThis as any).CSS.escape(id) : id;
          const selectors = [
            `[data-evidence-id="${id}"]`,
            `#evidence-card-${escaped}`,
            `[data-evidence-ref="${id}"]`,
          ];

          for (const sel of selectors) {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (el) {
              try { el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" }); } catch {}
              setPendingJumpEvidenceId("");
              return;
            }
          }
        } catch {}
      };

      setTimeout(run, 0);
      requestAnimationFrame(() => requestAnimationFrame(run));
    } catch {}
  }, [pendingJumpEvidenceId, activeTab, evidence]);
'''
    if insert_anchor in inc_text:
        inc_text = inc_text.replace(insert_anchor, effect_block + "\n" + insert_anchor, 1)

# 4) Ensure Evidence tab honors evidenceId from query on page load
if 'sp?.get("evidenceId")' not in inc_text:
    anchor = 'const evidenceCount = evidence.length;'
    qblock = '''
  useEffect(() => {
    try {
      const qid = String(sp?.get("evidenceId") || "").trim();
      if (!qid) return;
      setSelectedEvidenceId(qid);
      setPendingJumpEvidenceId(qid);
    } catch {}
  }, [sp]);
'''
    if anchor in inc_text:
        inc_text = inc_text.replace(anchor, qblock + "\n" + anchor, 1)

if inc_text != orig_inc:
    inc.write_text(inc_text, encoding="utf-8")
    print("✅ Patched IncidentClient.tsx")
else:
    print("ℹ️ IncidentClient.tsx unchanged")

card_text = card.read_text(encoding="utf-8")
orig_card = card_text

# 5) Add stable DOM anchors to evidence card outer wrapper
# First try common opening div/className pattern
patterns = [
    r'(<div\s+className=\{[^>]*?)(>)',
    r'(<div\s+className="[^"]*"[^>]*)(>)',
]

patched = False
for pat in patterns:
    m = re.search(pat, card_text, re.S)
    if m and 'data-evidence-id=' not in m.group(1) and 'id={`evidence-card-' not in m.group(1):
        repl = m.group(1) + ' id={`evidence-card-${String((item as any)?.id || (ev as any)?.id || "")}`} data-evidence-id={String((item as any)?.id || (ev as any)?.id || "")}' + m.group(2)
        card_text = card_text.replace(m.group(0), repl, 1)
        patched = True
        break

# fallback: use evidenceId prop / doc / item references if present
if not patched and 'data-evidence-id=' not in card_text:
    card_text = re.sub(
        r'(<article\b[^>]*)(>)',
        r'\1 id={`evidence-card-${String((item as any)?.id || "")}`} data-evidence-id={String((item as any)?.id || "")}\2',
        card_text,
        count=1
    )
    patched = card_text != orig_card

if card_text != orig_card:
    card.write_text(card_text, encoding="utf-8")
    print(f"✅ Patched {card}")
else:
    print(f"ℹ️ {card.name} unchanged (or needs manual anchor patch)")

PY

echo
echo "== verify =="
rg -n "pendingJumpEvidenceId|jumpToEvidence =|evidenceId\\)|onJumpToEvidence" "$INC" || true
rg -n "data-evidence-id|evidence-card-" "$CARD" || true

echo
echo "== clear next cache =="
rm -rf "$ROOT/next-app/.next"

echo
echo "✅ Patch complete."
echo "Now run:"
echo "  cd ~/peakops/my-app && pnpm dev"
echo
echo "Then test:"
echo "  1) Open Timeline"
echo "  2) Click Jump"
echo "  3) Confirm it switches to Evidence and scrolls to the card"

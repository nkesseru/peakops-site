#!/usr/bin/env bash
set -euo pipefail

ORG_ID="${1:-org_001}"
INCIDENT_ID="${2:-inc_TEST}"
BASE_URL="${3:-http://127.0.0.1:3000}"

ROOT="$(pwd)"
if [[ ! -d "$ROOT/next-app" ]]; then
  echo "❌ run this from repo root (the dir that contains next-app/)"
  exit 1
fi

FILE="$ROOT/next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts"
if [[ ! -f "$FILE" ]]; then
  echo "❌ missing: $FILE"
  exit 1
fi

TS="$(date +%Y%m%d_%H%M%S)"
BK="$ROOT/scripts/dev/_bak"
mkdir -p "$BK"
cp "$FILE" "$BK/downloadIncidentPacketZip_route_${TS}.ts"
echo "✅ backup: $BK/downloadIncidentPacketZip_route_${TS}.ts"

python3 - <<'PY'
from pathlib import Path
import re

p = Path("next-app/src/app/api/fn/downloadIncidentPacketZip/route.ts")
s = p.read_text()

orig = s

# 1) Nuke any previously-injected broken "schema validation" fragments
#    - remove blocks that start with "Schema validation" comment until catch/end-ish
s = re.sub(
    r"\n\s*//\s*---\s*Schema validation.*?\n\s*}\s*catch\s*\(.*?\)\s*\{.*?\n\s*}\s*\n",
    "\n",
    s,
    flags=re.S,
)

# 2) Remove the specific stray parse-breaking fragment (seen in your logs)
#    line that begins with ", null, 2))" (optionally with whitespace)
s = re.sub(r"^\s*,\s*null,\s*2\)\)\s*$\n?", "", s, flags=re.M)

# 3) Remove any broken vUrl assignment like: const vUrl = ;
s = re.sub(r"^\s*const\s+vUrl\s*=\s*;\s*$\n?", "", s, flags=re.M)

# 4) Remove any imports that try to reach into functions_clean validators (bad layering)
s = re.sub(r"^\s*import\s+\{\s*validateDirsV1\s*\}\s+from\s+['\"].*functions_clean\/validateDirsV1['\"].*\n", "", s, flags=re.M)
s = re.sub(r"^\s*import\s+\{\s*validateOe417V1\s*\}\s+from\s+['\"].*functions_clean\/validateOe417V1['\"].*\n", "", s, flags=re.M)

# 5) Insert a CLEAN validation embed block BEFORE hashes/manifest are computed
anchor = re.search(r"^\s*//\s*hashes\s*\+\s*manifest.*$", s, flags=re.M)
if not anchor:
    raise SystemExit("❌ Could not find anchor comment: // hashes + manifest")

inject = r"""
    // --- Schema validation (embed into packet BEFORE hashes/manifest) ---
    // NOTE: We do this inline (no cross-imports) to keep Next route stable.
    // We validate the filings payloads we are about to ship.
    try {
      const expect: Record<string, { schema: string; required?: string[] }> = {
        "filings/dirs.json": { schema: "dirs.v1", required: ["outageType", "startTime"] },
        "filings/oe417.json": { schema: "oe_417.v1", required: ["eventType", "impact", "startTime"] },
        "filings/nors.json": { schema: "nors.v1" },
        "filings/sar.json": { schema: "sar.v1" },
        "filings/baba.json": { schema: "baba.v1" },
      };

      function safeParseBytes(bytes: Uint8Array) {
        try {
          const txt = Buffer.from(bytes).toString("utf8");
          return { ok: true as const, v: JSON.parse(txt) };
        } catch (e: any) {
          return { ok: false as const, error: String(e?.message || e) };
        }
      }

      function getFileBytes(path: string): Uint8Array | null {
        const f = files.find((x: any) => x?.path === path);
        return f?.bytes ?? null;
      }

      function hasPath(obj: any, path: string): boolean {
        // supports "location.state" etc
        const parts = path.split(".");
        let cur = obj;
        for (const part of parts) {
          if (cur == null || typeof cur !== "object" || !(part in cur)) return false;
          cur = cur[part];
        }
        return true;
      }

      const validationAt = new Date().toISOString();
      const results: any[] = [];

      for (const [path, rule] of Object.entries(expect)) {
        const bytes = getFileBytes(path);
        if (!bytes) {
          results.push({ path, ok: false, level: "FAIL", reason: "missing_file" });
          continue;
        }

        const parsed = safeParseBytes(bytes);
        if (!parsed.ok) {
          results.push({ path, ok: false, level: "FAIL", reason: "invalid_json", error: parsed.error });
          continue;
        }

        const doc = parsed.v || {};
        const payload = doc?.payload ?? doc;

        const schema = String(doc?.schemaVersion || payload?.meta?.schemaVersion || "");
        const expectedSchema = rule.schema;

        const missing: string[] = [];
        for (const k of (rule.required || [])) {
          if (!hasPath(payload, k)) missing.push(k);
        }

        const schemaOk = !expectedSchema || schema === expectedSchema;
        const reqOk = missing.length === 0;

        const ok = schemaOk && reqOk;
        const level = ok ? "PASS" : (schemaOk ? "WARN" : "FAIL");

        results.push({
          path,
          ok,
          level,
          schema,
          expectedSchema,
          missing,
          type: String(doc?.type || payload?.filingType || "").toUpperCase() || null,
          updatedAt: doc?.updatedAt || null,
        });

        // per-file validation detail
        files.push({
          path: path.replace("filings/", "filings/").replace(".json", ".validation.json"),
          bytes: utf8(JSON.stringify({ ok, level, schema, expectedSchema, missing, validatedAt: validationAt }, null, 2)),
        });
      }

      const summary = {
        pass: results.filter((r) => r.level === "PASS").length,
        warn: results.filter((r) => r.level === "WARN").length,
        fail: results.filter((r) => r.level === "FAIL").length,
        total: results.length,
      };

      files.push({
        path: "filings/validation.json",
        bytes: utf8(JSON.stringify({ ok: summary.fail === 0, orgId, incidentId, validatedAt: validationAt, summary, results }, null, 2)),
      });
    } catch (e: any) {
      // never break packet generation due to validation
      files.push({
        path: "filings/validation.json",
        bytes: utf8(JSON.stringify({ ok: false, orgId, incidentId, error: String(e?.message || e) }, null, 2)),
      });
    }

"""

s = s[:anchor.start()] + inject + s[anchor.start():]

# 6) Ensure zip generation line isn't broken (some earlier scripts left "await" dangling)
s = re.sub(
    r"const\s+zipBytes\s*=\s*await\s*\n",
    "const zipBytes = await zip.generateAsync({ type: \"uint8array\", compression: \"DEFLATE\" });\n",
    s,
)

# Also ensure we have a generateAsync somewhere before zipSha, if not, add it.
if "generateAsync({ type: \"uint8array\"" not in s:
    s = re.sub(
        r"(//\s*ZIP\s*\n\s*const\s+zip\s*=\s*new\s+JSZip\(\);\s*\n\s*for\s*\(const\s+f\s+of\s+files\)\s+zip\.file\(f\.path,\s*f\.bytes\);\s*\n)",
        r"\1\n    const zipBytes = await zip.generateAsync({ type: \"uint8array\", compression: \"DEFLATE\" });\n",
        s
    )

p.write_text(s)
print("✅ patched downloadIncidentPacketZip/route.ts: clean inline validation embed")
PY

echo "==> restart next"
pkill -f "next dev" 2>/dev/null || true
mkdir -p "$ROOT/.logs"
( cd "$ROOT/next-app" && pnpm dev --port 3000 > "$ROOT/.logs/next.log" 2>&1 ) &
sleep 2

echo "==> smoke: download packet zip + verify filings/validation.json exists"
DURL="$BASE_URL/api/fn/downloadIncidentPacketZip?orgId=$ORG_ID&incidentId=$INCIDENT_ID"
TMP="/tmp/peak_packet_validation_${TS}"
mkdir -p "$TMP"
curl -fsS "$DURL" -o "$TMP/packet.zip" || {
  echo "❌ download failed"
  tail -n 220 "$ROOT/.logs/next.log"
  exit 1
}

unzip -l "$TMP/packet.zip" | egrep "filings/(validation\.json|dirs\.validation\.json|oe417\.validation\.json)" >/dev/null || {
  echo "❌ validation files missing from zip"
  unzip -l "$TMP/packet.zip" | head -n 160
  exit 2
}

echo "✅ validation files present"
echo
echo "--- filings/validation.json (first 160 lines) ---"
unzip -p "$TMP/packet.zip" "filings/validation.json" | sed -n '1,160p'
echo
echo "✅ DONE"
echo "OPEN:"
echo "  $BASE_URL/admin/incidents/$INCIDENT_ID/bundle?orgId=$ORG_ID"
echo "LOGS:"
echo "  tail -n 220 $ROOT/.logs/next.log"

#!/usr/bin/env bash
set +H 2>/dev/null || true
set -euo pipefail
cd ~/peakops/my-app

BOOT="scripts/dev/boot_dev_stack_v2.sh"
test -f "$BOOT"

python3 - <<'PY'
from pathlib import Path
p = Path("scripts/dev/boot_dev_stack_v2.sh")
s = p.read_text()

# Find the bundler "files" list and add getWorkflowV1 if missing.
if "getWorkflowV1.mjs" in s:
    print("ℹ️ getWorkflowV1 already in bundler list")
else:
    # anchor after exportContractPacketV1 entry if present
    anchor = '["exportContractPacketV1.mjs", "exportContractPacketV1.cjs"],'
    if anchor not in s:
        raise SystemExit("❌ Could not find bundler files[] anchor in boot_dev_stack_v2.sh")
    s = s.replace(anchor, anchor + "\n  [\"getWorkflowV1.mjs\", \"getWorkflowV1.cjs\"],")
    p.write_text(s)
    print("✅ inserted getWorkflowV1 into boot_dev_stack_v2.sh bundler list")
PY

echo "==> reboot canonical stack"
bash scripts/dev/boot_contracts_stack_canonical.sh peakops-pilot org_001 car_abc123 v1

echo
echo "==> smoke getWorkflowV1 (direct)"
curl -sS "http://127.0.0.1:5001/peakops-pilot/us-central1/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -c 260; echo

echo
echo "==> smoke getWorkflowV1 (via Next)"
curl -sS "http://127.0.0.1:3000/api/fn/getWorkflowV1?orgId=org_001&incidentId=inc_TEST" | head -c 260; echo

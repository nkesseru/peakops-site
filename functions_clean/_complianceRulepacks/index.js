// PEAKOPS_COMPLIANCE_RULEPACKS_JS_V1 (PR 133B)
//
// Static registry of compliance rulepack JSON files, co-located with
// the Cloud Function bundle so the runtime can load them via require().
//
// HARD RULE: the JSON files in this directory must remain BYTE-IDENTICAL
// to the canonical source at `contracts/rulepacks/*/v1.json`. If a
// rulepack changes there, it must be re-copied here in the same PR.
// A future CI assertion should enforce this; for now, discipline + the
// README note in this directory.
//
// Architecture lock (PR 133B):
//   - No new rulepacks. The 5 entries match the canonical set:
//     DIRS, OE_417, NORS, SAR, BABA.
//   - Loaded once at module init; cached as a frozen record.
//   - `getRulepack(unknownType)` returns undefined (engine treats as
//     "no rules for this filing type" — silent no-op).

const dirs = require("./dirs/v1.json");
const oe417 = require("./oe417/v1.json");
const nors = require("./nors/v1.json");
const sar = require("./sar/v1.json");
const baba = require("./baba/v1.json");

const RULEPACKS = Object.freeze({
  DIRS: dirs,
  OE_417: oe417,
  NORS: nors,
  SAR: sar,
  BABA: baba,
});

function getRulepack(filingType) {
  return RULEPACKS[String(filingType || "")];
}

module.exports = {
  RULEPACKS,
  getRulepack,
};

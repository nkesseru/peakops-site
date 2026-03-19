import dirs from "../../contracts/rulepacks/dirs/v1.json";
import oe417 from "../../contracts/rulepacks/oe417/v1.json";
import nors from "../../contracts/rulepacks/nors/v1.json";
import sar from "../../contracts/rulepacks/sar/v1.json";
import baba from "../../contracts/rulepacks/baba/v1.json";

export const RULEPACKS: Record<string, any> = {
  DIRS: dirs,
  OE_417: oe417,
  NORS: nors,
  SAR: sar,
  BABA: baba,
};

export function getRulepack(filingType: string) {
  return RULEPACKS[filingType];
}

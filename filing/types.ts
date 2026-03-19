import { FilingType } from "../contracts/filings/filingTypes";

export interface FilingDraft {
  type: FilingType;
  payload: Record<string, unknown>;
  generatedAt: string; // ISO
  generatorVersion: string; // bump when format changes
}

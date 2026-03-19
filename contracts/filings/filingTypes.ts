export const FilingTypes = [
  "DIRS",
  "OE_417",
  "NORS",
  "SAR",
  "BABA",
] as const;

export type FilingType = (typeof FilingTypes)[number];

// src/config.ts
// Central config for ingest + queue worker

// For now we hard-code the key here.
// Later we can move this to .env or runtime config.
export const INGEST_API_KEY = "SUPER_LONG_RANDOM_PROD_KEY";

// Hard caps for how many rows one ingest call will accept
export const MAX_INGEST_ROWS = 1000;

// Reliability metric sanity caps
export const MAX_SAIDI_HOURS = 8760; // hours/year
export const MAX_CAIDI_HOURS = 8760;
export const MAX_SAIFI_EVENTS = 100; // events/year

// Queue worker attempts limit
export const MAX_SUBMISSION_ATTEMPTS = 5;

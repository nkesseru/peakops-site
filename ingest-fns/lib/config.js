"use strict";
// src/config.ts
// Central config for ingest + queue worker
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SUBMISSION_ATTEMPTS = exports.MAX_SAIFI_EVENTS = exports.MAX_CAIDI_HOURS = exports.MAX_SAIDI_HOURS = exports.MAX_INGEST_ROWS = exports.INGEST_API_KEY = void 0;
// For now we hard-code the key here.
// Later we can move this to .env or runtime config.
exports.INGEST_API_KEY = "SUPER_LONG_RANDOM_PROD_KEY";
// Hard caps for how many rows one ingest call will accept
exports.MAX_INGEST_ROWS = 1000;
// Reliability metric sanity caps
exports.MAX_SAIDI_HOURS = 8760; // hours/year
exports.MAX_CAIDI_HOURS = 8760;
exports.MAX_SAIFI_EVENTS = 100; // events/year
// Queue worker attempts limit
exports.MAX_SUBMISSION_ATTEMPTS = 5;

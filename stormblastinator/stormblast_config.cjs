// stormblastinator/stormblast_config.cjs

module.exports = {
  apiKey: "SUPER_LONG_RANDOM_PROD_KEY", // must match INGEST_API_KEY in config.ts

  // Function URLs (HTTP endpoints)
  reliabilityUrl:
    "https://us-central1-peakops-pilot.cloudfunctions.net/reliabilityIngest",
  telecomUrl:
    "https://us-central1-peakops-pilot.cloudfunctions.net/telecomIngest",
  queueUrl:
    "https://us-central1-peakops-pilot.cloudfunctions.net/processQueuedSubmissions",

  // How hard to blast
  reliabilityValidCount: 50,
  reliabilityGarbageCount: 20,
  telecomValidCount: 30,
  telecomGarbageCount: 10,
};

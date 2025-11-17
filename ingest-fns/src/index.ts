import { onRequest } from "firebase-functions/v2/https";

export const ping = onRequest({ region: "us-west1" }, (_req, res) => {
  res.status(200).json({ ok: true, t: Date.now() });
});

export { reliabilityIngest } from "./reliability/reliabilityIngest";
export { telecomIngest } from "./telecom/telecomIngest";
export { processQueuedSubmissions } from "./submission/processQueuedSubmissions";

export { stormwatchRealtimeAlerts } from "./stormwatchTriggers";
export {
  stormwatchDailyDigest,
  stormwatchWeeklyDigest,
  stormwatchMonthlyDigest,
} from "./stormwatchDigests";

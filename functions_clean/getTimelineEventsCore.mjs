/**
 * getTimelineEventsCore.mjs
 * Temporary unblock module so Firebase Functions emulator can load.
 * Replace with real implementation when ready.
 */

export async function getTimelineEventsCore(_db, _args = {}) {
  // Return a safe empty timeline payload.
  return { ok: true, events: [], count: 0 };
}

// Some call-sites might import a default; provide one too.
export default getTimelineEventsCore;

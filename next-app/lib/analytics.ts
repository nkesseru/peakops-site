"use client";

// PEAKOPS_ANALYTICS_EVENTS_V1 (2026-05-12)
// Append-only product telemetry written to Firestore `analytics_events`.
// Call sites use the helper fire-and-forget — analytics MUST NEVER block
// product behavior or surface errors to the user. All failures are
// swallowed (and console.warn'd in development only).
//
// Caller contract:
//   - Pass a stable UPPER_SNAKE_CASE event type, e.g. "INCIDENT_CREATED".
//   - `metadata` is optional and should contain ONLY operational signals:
//     counts, booleans, durations, status strings, route/page hints,
//     lifecycle states. Never put notes, report bodies, evidence captions,
//     customer contact details, or export content in metadata.
//   - `metadata.incidentId` is promoted to a top-level `incidentId` field
//     for easier querying, and stripped from the stored `metadata` object.

import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { auth, db } from "./firebaseClient";

const SESSION_ID_KEY = "peakops_session_id";
const ORG_ID_KEY = "peakops_orgId";

function getSessionId(): string {
  if (typeof window === "undefined") return "";
  try {
    let sid = window.sessionStorage.getItem(SESSION_ID_KEY) || "";
    if (!sid) {
      const c = (typeof crypto !== "undefined" ? crypto : null) as Crypto | null;
      sid =
        c && typeof c.randomUUID === "function"
          ? c.randomUUID()
          : `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      window.sessionStorage.setItem(SESSION_ID_KEY, sid);
    }
    return sid;
  } catch {
    return "";
  }
}

function getOrgIdFromContext(): string {
  if (typeof window === "undefined") return "";
  try {
    const usp = new URLSearchParams(window.location.search);
    const fromQuery = String(usp.get("orgId") || "").trim();
    if (fromQuery) return fromQuery;
  } catch { /* URL parse may fail */ }
  try {
    const fromStorage = String(window.localStorage.getItem(ORG_ID_KEY) || "").trim();
    if (fromStorage) return fromStorage;
  } catch { /* localStorage may be unavailable */ }
  return "";
}

function getBuildVersion(): string {
  const raw =
    process.env.NEXT_PUBLIC_BUILD_VERSION ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    "";
  return String(raw).slice(0, 12);
}

export async function logAnalyticsEvent(
  type: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    if (typeof window === "undefined") return;
    const user = auth.currentUser;

    let role = "";
    let claimOrgIds: string[] = [];
    if (user) {
      try {
        const tr = await user.getIdTokenResult();
        const c = (tr.claims || {}) as Record<string, unknown>;
        role = String(c.role || "").toLowerCase();
        if (Array.isArray(c.orgIds)) {
          claimOrgIds = (c.orgIds as unknown[]).map((v) => String(v));
        }
      } catch { /* token unavailable — proceed with empty role */ }
    }

    const md = { ...(metadata || {}) } as Record<string, unknown>;
    const incidentId = String(md.incidentId || "").trim();
    delete md.incidentId;

    const orgId = (typeof md.orgId === "string" && md.orgId)
      ? String(md.orgId)
      : getOrgIdFromContext() || claimOrgIds[0] || "";
    if ("orgId" in md) delete md.orgId;

    const route =
      typeof window.location?.pathname === "string" ? window.location.pathname : "";

    await addDoc(collection(db, "analytics_events"), {
      type: String(type),
      orgId,
      userId: user?.uid || "",
      role,
      incidentId,
      route,
      sessionId: getSessionId(),
      buildVersion: getBuildVersion(),
      metadata: md,
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[analytics] logAnalyticsEvent failed", e);
    }
  }
}

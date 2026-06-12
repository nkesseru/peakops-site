// PEAKOPS_NOTIFICATIONS_V1 (2026-05-05)
// Per-user notification feed for in-app alerts. One subcollection
// per user at users/{uid}/notifications/{notificationId}. Each doc
// is a small record of an event the user should know about
// (report_ready, awaiting_review). Server-side triggers fan these
// out; the client just reads + marks-as-read.
//
// No email/SMS/Slack in v1 — purely in-app. The bell icon in the
// header subscribes via onSnapshot so the UI updates within
// seconds of a new doc landing.
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "./firebaseClient";

// PEAKOPS_NOTIFICATIONS_V1_2 (2026-05-05)
// "test" is the diagnostic type written by the dev-only
// /api/dev/createTestNotification endpoint. Renders in the bell
// via notificationHref's fallback (uses targetUrl when present).
export type NotificationType = "report_ready" | "awaiting_review" | "test";

export type Notification = {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  incidentId?: string;
  orgId?: string;
  // PEAKOPS_NOTIFICATIONS_V1_1 (2026-05-05)
  // Pre-resolved click-through URL written by the server. Optional
  // for back-compat with V1 docs that don't have it; the routing
  // helper falls back to the type-based map when missing.
  targetUrl?: string;
  read: boolean;
  createdAt?: any;
};

export const NOTIFICATIONS_LIST_LIMIT = 20;

function isNotificationType(v: unknown): v is NotificationType {
  return v === "report_ready" || v === "awaiting_review" || v === "test";
}

function coerceNotification(id: string, raw: any): Notification | null {
  if (!raw || typeof raw !== "object") return null;
  if (!isNotificationType(raw.type)) return null;
  return {
    id,
    type: raw.type,
    title: typeof raw.title === "string" ? raw.title : "",
    message: typeof raw.message === "string" ? raw.message : "",
    incidentId: typeof raw.incidentId === "string" ? raw.incidentId : undefined,
    orgId: typeof raw.orgId === "string" ? raw.orgId : undefined,
    targetUrl: typeof raw.targetUrl === "string" && raw.targetUrl ? raw.targetUrl : undefined,
    read: raw.read === true,
    createdAt: raw.createdAt || null,
  };
}

// PEAKOPS_NOTIFICATIONS_V1 (2026-05-05)
// Real-time subscription to the user's recent notifications. Returns
// an unsubscribe function — the bell component owns the lifecycle.
// Sorted newest-first; cap at NOTIFICATIONS_LIST_LIMIT to keep
// the dropdown bounded. Older notifications are still queryable
// via a future "View all" page; the bell just shows the recent.
export function subscribeRecentNotifications(
  uid: string,
  onChange: (list: Notification[]) => void,
): Unsubscribe {
  if (!uid) return () => {};
  const q = query(
    collection(db, "users", uid, "notifications"),
    orderBy("createdAt", "desc"),
    limit(NOTIFICATIONS_LIST_LIMIT),
  );
  return onSnapshot(
    q,
    (snap) => {
      const list: Notification[] = [];
      snap.forEach((d) => {
        const n = coerceNotification(d.id, d.data());
        if (n) list.push(n);
      });
      onChange(list);
    },
    () => {
      // Listener errors (permission-denied if rules tighten before
      // claims propagate, network blips) are silent here — the
      // bell renders an empty list. Surfacing as a UI error would
      // be noisier than the fallback.
    },
  );
}

export async function markNotificationRead(uid: string, notificationId: string): Promise<void> {
  if (!uid || !notificationId) return;
  await updateDoc(
    doc(db, "users", uid, "notifications", notificationId),
    { read: true },
  );
}

// PEAKOPS_NOTIFICATIONS_V1 (2026-05-05)
// Bulk mark-as-read used by the "Mark all read" affordance in the
// dropdown. Batched so it's one round-trip regardless of count.
// Cap at the same listing limit — if the user has older unread
// notifications outside the visible set, those stay unread (they
// won't see them in the dropdown anyway).
export async function markAllNotificationsRead(uid: string, ids: string[]): Promise<void> {
  if (!uid || !Array.isArray(ids) || ids.length === 0) return;
  const batch = writeBatch(db);
  for (const id of ids.slice(0, NOTIFICATIONS_LIST_LIMIT)) {
    batch.update(doc(db, "users", uid, "notifications", id), { read: true });
  }
  await batch.commit();
}

// PEAKOPS_NOTIFICATIONS_V1 (2026-05-05) /
// PEAKOPS_NOTIFICATIONS_V1_1 (2026-05-05)
// Routing: prefer the server-written targetUrl when present; fall
// back to the type-based map for V1 docs that predate it. Both
// paths route to: report_ready → /summary, awaiting_review →
// /review. Without an incidentId the click defaults to the listings
// page so no row ever dead-ends.
export function notificationHref(n: Notification, orgIdHint?: string): string {
  if (n.targetUrl) return n.targetUrl;
  const oid = String(n.orgId || orgIdHint || "").trim();
  const orgQs = oid ? `?orgId=${encodeURIComponent(oid)}` : "";
  const iid = String(n.incidentId || "").trim();
  if (!iid) return `/incidents${orgQs}`;
  if (n.type === "report_ready") return `/incidents/${encodeURIComponent(iid)}/summary${orgQs}`;
  if (n.type === "awaiting_review") return `/incidents/${encodeURIComponent(iid)}/review${orgQs}`;
  return `/incidents/${encodeURIComponent(iid)}${orgQs}`;
}

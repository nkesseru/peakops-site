"use client";

// PEAKOPS_NOTIFICATIONS_V1 (2026-05-05)
// Header bell + dropdown. Subscribes to the signed-in user's
// notifications via onSnapshot so new docs appear within seconds.
// Click a row → mark as read → navigate to the natural follow-up
// surface (Summary for report_ready, Review for awaiting_review).
//
// State is per-component, no global store. The bell is mounted once
// in the Mission Control header today; if it ever lands on a second
// page, the listener simply runs twice — same data, no contention.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/useAuth";
import { authedFetch } from "@/lib/apiClient";
import {
  markAllNotificationsRead,
  markNotificationRead,
  notificationHref,
  subscribeRecentNotifications,
  type Notification,
} from "@/lib/notifications";

type Props = {
  // Optional orgId fallback used when a notification lacks one (older
  // schema, defensive). The MC header has the active orgId in scope.
  orgIdHint?: string;
};

export default function NotificationsBell({ orgIdHint }: Props) {
  const { user } = useAuth();
  const uid = user?.uid || "";
  const sp = useSearchParams();

  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // PEAKOPS_NOTIFICATIONS_V1_2 (2026-05-05) /
  // PEAKOPS_NOTIFICATIONS_DEBUG_GATE_V2 (2026-05-05)
  // Dev affordance: "Send test" button in the dropdown header.
  // Strict gate — ONLY visible when the URL carries `?dev=1`.
  // Previously NODE_ENV !== "production" was enough (so any local
  // build showed it); QA flagged that admins on a normal /incidents
  // URL could still seed test notifications. The button now requires
  // explicit dev=1 in the URL across every environment.
  const devMode = (() => {
    const flag = String(sp?.get?.("dev") || "").trim();
    return flag === "1" || flag.toLowerCase() === "true";
  })();

  // Subscribe to notifications when uid is available. Unsubscribes
  // automatically on unmount or when uid changes (sign out).
  useEffect(() => {
    if (!uid) {
      setNotifications([]);
      return;
    }
    const unsub = subscribeRecentNotifications(uid, setNotifications);
    return () => {
      try { unsub(); } catch { /* ignore */ }
    };
  }, [uid]);

  // Click-outside to close. Pointer-down captures both mouse + touch
  // and fires before the click on the bell itself, so we filter on
  // the wrapper ref to keep the toggle behavior intact.
  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent) {
      const t = e.target as Node | null;
      if (!t || !wrapperRef.current) return;
      if (!wrapperRef.current.contains(t)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [open]);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  async function handleNotificationClick(n: Notification) {
    setOpen(false);
    if (!n.read && uid) {
      try { await markNotificationRead(uid, n.id); } catch { /* noisy errors handled by rules */ }
    }
  }

  async function handleMarkAllRead() {
    if (!uid) return;
    const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
    if (unreadIds.length === 0) return;
    try { await markAllNotificationsRead(uid, unreadIds); } catch { /* ignore */ }
  }

  // PEAKOPS_NOTIFICATIONS_V1_2 (2026-05-05)
  // Dev test write. Not wired in prod unless ?dev=1. Body is
  // optional; we pass orgIdHint so the synthetic targetUrl reflects
  // the active org.
  async function handleSendTest() {
    if (!uid || testBusy) return;
    setTestBusy(true);
    try {
      const res = await authedFetch("/api/dev/createTestNotification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId: orgIdHint || undefined,
          targetUrl: orgIdHint ? `/incidents?orgId=${encodeURIComponent(orgIdHint)}` : undefined,
        }),
      });
      const text = await res.text().catch(() => "");
      let out: any = {};
      try { out = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.log("[notify-debug] dev test response", { status: res.status, body: out });
      }
    } catch (e: any) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn("[notify-debug] dev test request failed", String(e?.message || e));
      }
    } finally {
      setTestBusy(false);
    }
  }

  if (!uid) return null;

  return (
    <div ref={wrapperRef} style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      <button
        type="button"
        aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          padding: "6px 10px",
          fontSize: 14,
          background: "transparent",
          color: unreadCount > 0 ? "#C8A84E" : "#b3b3b3",
          border: "1px solid #1c1c1c",
          borderRadius: 6,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          position: "relative",
        }}
      >
        <span aria-hidden="true">🔔</span>
        {unreadCount > 0 && (
          <span
            style={{
              minWidth: 18,
              height: 18,
              padding: "0 5px",
              borderRadius: 999,
              background: "#C8A84E",
              color: "#050505",
              fontSize: 10,
              fontWeight: 700,
              lineHeight: "18px",
              textAlign: "center",
              display: "inline-block",
            }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Recent notifications"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            width: 340,
            maxHeight: 420,
            overflowY: "auto",
            background: "#050505",
            border: "1px solid #1c1c1c",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            zIndex: 50,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 12px",
              borderBottom: "1px solid #1c1c1c",
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.10em", color: "#6f6f6f", textTransform: "uppercase" as const }}>
              Notifications
            </span>
            <div style={{ display: "inline-flex", gap: 6 }}>
              {/* PEAKOPS_NOTIFICATIONS_V1_2 (2026-05-05)
                  Dev-only test write. Same endpoint a curl would
                  call; proves the bell read path works indepent of
                  any producer trigger. */}
              {devMode && (
                <button
                  type="button"
                  onClick={handleSendTest}
                  disabled={testBusy}
                  style={{
                    padding: "3px 8px",
                    fontSize: 10,
                    fontWeight: 600,
                    background: "transparent",
                    color: testBusy ? "#6f6f6f" : "#C8A84E",
                    border: "1px solid rgba(200,168,78,0.3)",
                    borderRadius: 4,
                    cursor: testBusy ? "not-allowed" : "pointer",
                  }}
                >
                  {testBusy ? "Sending…" : "Send test"}
                </button>
              )}
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={handleMarkAllRead}
                  style={{
                    padding: "3px 8px",
                    fontSize: 10,
                    fontWeight: 600,
                    background: "transparent",
                    color: "#b3b3b3",
                    border: "1px solid #1c1c1c",
                    borderRadius: 4,
                    cursor: "pointer",
                  }}
                >
                  Mark all read
                </button>
              )}
            </div>
          </div>
          {notifications.length === 0 ? (
            <div style={{ padding: "16px 12px", fontSize: 12, color: "#6f6f6f", textAlign: "center" }}>
              No notifications yet.
            </div>
          ) : (
            <div>
              {notifications.map((n) => {
                const href = notificationHref(n, orgIdHint);
                return (
                  <Link
                    key={n.id}
                    href={href}
                    onClick={() => { void handleNotificationClick(n); }}
                    style={{
                      display: "block",
                      padding: "10px 12px",
                      borderBottom: "1px solid #161616",
                      textDecoration: "none",
                      background: n.read ? "transparent" : "rgba(200,168,78,0.04)",
                    }}
                  >
                    <div style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                    }}>
                      {!n.read && (
                        <span
                          aria-hidden="true"
                          style={{
                            marginTop: 6,
                            width: 6,
                            height: 6,
                            borderRadius: 999,
                            background: "#C8A84E",
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: "#f5f5f5",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}>
                          {n.title || (n.type === "report_ready" ? "Report ready" : "Awaiting review")}
                        </div>
                        {n.message && (
                          <div style={{
                            marginTop: 2,
                            fontSize: 11,
                            color: "#b3b3b3",
                            lineHeight: 1.4,
                          }}>
                            {n.message}
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

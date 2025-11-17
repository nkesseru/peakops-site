// src/app/admin/stormwatch/page.tsx
import { getAdminDb } from "@/lib/firebaseAdmin";
import { Timestamp } from "firebase-admin/firestore";
import Link from "next/link";
import styles from "./stormwatch.module.css";

type StormwatchEvent = {
  id: string;
  timestamp?: Timestamp;
  function?: string;
  kind?: string;
  accepted?: number;
  rejected?: number;
  processed?: number;
  failed?: number;
  severity?: "INFO" | "WARN" | "ERROR";
};

type SystemNotification = {
  id: string;
  createdAt?: Timestamp;
  title?: string;
  body?: string;
  severity?: "INFO" | "WARN" | "ERROR";
  type?: string;
  orgId?: string | null;
};

function formatDate(ts?: Timestamp) {
  if (!ts) return "-";
  const d = ts.toDate();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${h}:${min}`;
}

export default async function StormwatchPage() {
  const db = getAdminDb();

  const now = Date.now();
  const since24h = Timestamp.fromDate(new Date(now - 24 * 60 * 60 * 1000));
  const since7d = Timestamp.fromDate(new Date(now - 7 * 24 * 60 * 60 * 1000));

  // stormwatch_events (last 24h)
  const eventsSnap = await db
    .collection("stormwatch_events")
    .where("timestamp", ">=", since24h)
    .orderBy("timestamp", "desc")
    .limit(50)
    .get();

  const events: StormwatchEvent[] = eventsSnap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as any),
  }));

  // system_notifications (last 7d)
  const notifSnap = await db
    .collection("system_notifications")
    .where("createdAt", ">=", since7d)
    .orderBy("createdAt", "desc")
    .limit(50)
    .get();

  const notifications: SystemNotification[] = notifSnap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as any),
  }));

  // KPI aggregates
  let totalRuns = events.length;
  let totalAccepted = 0;
  let totalRejected = 0;
  let totalProcessed = 0;
  let totalFailed = 0;
  let warnCount = 0;
  let errorCount = 0;

  for (const ev of events) {
    if (typeof ev.accepted === "number") totalAccepted += ev.accepted;
    if (typeof ev.rejected === "number") totalRejected += ev.rejected;
    if (typeof ev.processed === "number") totalProcessed += ev.processed;
    if (typeof ev.failed === "number") totalFailed += ev.failed;

    if (ev.severity === "WARN") warnCount++;
    if (ev.severity === "ERROR") errorCount++;
  }

  const rejectionRate =
    totalAccepted + totalRejected > 0
      ? (totalRejected / (totalAccepted + totalRejected)) * 100
      : 0;

  return (
    <div className={styles.page}>
      <div className={styles.wrapper}>
        {/* Header */}
        <div className={styles.header}>
          <h1 className={styles.title}>StormWatch</h1>
          <span className={styles.subtitle}>
            Last 24 hours • stormwatch_events • system_notifications
          </span>
        </div>

        {/* KPI cards */}
        <div className={styles.cards}>
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Total Runs</h2>
            <div className={styles.cardValue}>{totalRuns}</div>
            <div className={styles.cardSub}>Ingest + queue runs (24h)</div>
          </div>

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Rows Accepted</h2>
            <div className={styles.cardValue}>{totalAccepted}</div>
            <div className={styles.cardSub}>
              Rejected: {totalRejected} ({rejectionRate.toFixed(1)}%)
            </div>
          </div>

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Queue Processed</h2>
            <div className={styles.cardValue}>{totalProcessed}</div>
            <div className={styles.cardSub}>Failed: {totalFailed}</div>
          </div>

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Alerts</h2>
            <div className={styles.cardValue}>{warnCount + errorCount}</div>
            <div className={styles.cardSub}>
              Warnings: {warnCount} • Errors: {errorCount}
            </div>
          </div>
        </div>

        {/* Main content */}
        <div className={styles.content}>
          {/* Left: Events */}
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>Recent StormWatch Events</h2>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th}>Time</th>
                    <th className={styles.th}>Function</th>
                    <th className={styles.th}>Kind</th>
                    <th className={styles.th}>Result</th>
                    <th className={styles.th}>Severity</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => {
                    const isIngest = ev.kind === "INGEST_RUN";
                    const isQueue = ev.kind === "QUEUE_RUN";

                    const resultText = isIngest
                      ? `accepted ${ev.accepted ?? 0} / rejected ${
                          ev.rejected ?? 0
                        }`
                      : isQueue
                      ? `processed ${ev.processed ?? 0} / failed ${
                          ev.failed ?? 0
                        }`
                      : "";

                    // Default: blue "info"
                    let badgeClass = styles.badgeInfo;

                    // Error / warn override everything
                    if (ev.severity === "ERROR") {
                      badgeClass = styles.badgeError;
                    } else if (ev.severity === "WARN") {
                      badgeClass = styles.badgeWarn;
                    } else {
                      // Success green when no rejects/fails
                      const noIngestErrors =
                        isIngest && (ev.rejected ?? 0) === 0;
                      const noQueueErrors =
                        isQueue && (ev.failed ?? 0) === 0;

                      if (noIngestErrors || noQueueErrors) {
                        badgeClass = styles.badgeSuccess;
                      }
                    }

                    return (
                      <tr key={ev.id} className={styles.row}>
                        <td className={styles.td}>
                          {ev.timestamp ? formatDate(ev.timestamp) : "-"}
                        </td>
                        <td className={styles.td}>
                          <Link
                            href={`/admin/stormwatch/event/${ev.id}`}
                            style={{ color: "#e2e8f0", textDecoration: "none" }}
                          >
                            {ev.function}
                          </Link>
                        </td>
                        <td className={styles.td}>{ev.kind}</td>
                        <td className={styles.td}>{resultText}</td>
                        <td className={styles.td}>
                          <span className={`${styles.badge} ${badgeClass}`}>
                            {ev.severity ?? "INFO"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {events.length === 0 && (
                    <tr>
                      <td colSpan={5} className={styles.emptyRow}>
                        No events in the last 24 hours.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right: Notifications */}
          <div className={styles.panel}>
            <h2 className={styles.panelTitle}>System Notifications</h2>
            <div className={styles.notificationsList}>
              {notifications.length === 0 && (
                <div className={styles.notificationBody}>
                  No notifications in the last 7 days.
                </div>
              )}
              {notifications.map((n) => {
                let badgeClass = styles.badgeInfo;
                if (n.severity === "ERROR") badgeClass = styles.badgeError;
                else if (n.severity === "WARN")
                  badgeClass = styles.badgeWarn;

                return (
                  <div key={n.id} className={styles.notification}>
                    <div>
                      <span
                        className={`${styles.badge} ${badgeClass}`}
                        style={{ marginRight: 6 }}
                      >
                        {n.severity}
                      </span>
                      <span className={styles.notificationTitle}>
                        {n.title}
                      </span>
                    </div>
                    <div className={styles.notificationBody}>{n.body}</div>
                    <div className={styles.notificationMeta}>
                      {n.createdAt ? formatDate(n.createdAt) : ""}
                      {n.orgId ? ` • org: ${n.orgId}` : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

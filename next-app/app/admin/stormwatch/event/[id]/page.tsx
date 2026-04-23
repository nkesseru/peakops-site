// src/app/admin/stormwatch/event/[id]/page.tsx
import { getAdminDb } from "@/lib/firebaseAdmin";
import { Timestamp } from "firebase-admin/firestore";
import Link from "next/link";

type Params = { id: string };

function formatDate(ts?: Timestamp) {
  if (!ts) return "-";
  const d = ts.toDate();
  return d.toISOString();
}

export default async function StormwatchEventPage({
  params,
}: {
  params: Params;
}) {
  const db = getAdminDb();
  const docRef = db.collection("stormwatch_events").doc(params.id);
  const snap = await docRef.get();

  if (!snap.exists) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui", color: "#e2e8f0", background: "#020617", minHeight: "100vh" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <h1 style={{ fontSize: 24, marginBottom: 12 }}>StormWatch Event</h1>
          <p>No event found for ID: {params.id}</p>
          <Link href="/admin/stormwatch" style={{ color: "#3b82f6", fontSize: 14 }}>
            ← Back to StormWatch
          </Link>
        </div>
      </div>
    );
  }

  const data = snap.data() as any;
  const createdAt = data.timestamp as Timestamp | undefined;

  const firestoreConsoleUrl = `https://console.firebase.google.com/project/peakops-pilot/firestore/data/~2Fstormwatch_events~2F${encodeURIComponent(
    params.id,
  )}`;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", color: "#e2e8f0", background: "#020617", minHeight: "100vh" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
          <h1 style={{ fontSize: 24, fontWeight: 600 }}>StormWatch Event</h1>
          <Link href="/admin/stormwatch" style={{ color: "#3b82f6", fontSize: 14 }}>
            ← Back to StormWatch
          </Link>
        </div>

        <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 12 }}>
          ID: <code>{params.id}</code>
        </p>
        <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 20 }}>
          Timestamp: {formatDate(createdAt)}
        </p>

        <div
          style={{
            background: "#020617",
            border: "1px solid #1e293b",
            borderRadius: 12,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>Event Data</h2>
          <pre
            style={{
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "#cbd5f5",
            }}
          >
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>

        <div
          style={{
            background: "#020617",
            border: "1px solid #1e293b",
            borderRadius: 12,
            padding: 16,
          }}
        >
          <h2 style={{ fontSize: 14, marginBottom: 8 }}>Firestore Console</h2>
          <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 8 }}>
            Open this event directly in the Firebase console:
          </p>
          <a
            href={firestoreConsoleUrl}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#22c55e", fontSize: 13 }}
          >
            Open in Firebase Console ↗
          </a>
        </div>
      </div>
    </div>
  );
}

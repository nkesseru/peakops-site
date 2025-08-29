import { useEffect, useMemo, useState } from "react";
import { initializeApp, getApps, FirebaseApp } from "firebase/app";
import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  Firestore,
} from "firebase/firestore";

// Read Firebase Web config from NEXT_PUBLIC_ env vars (safe for client)
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "",
};

// If any fields are blank, we will NOT call initializeApp; we'll render an error UI instead.
const missingKeys = Object.entries(firebaseConfig)
  .filter(([, v]) => !v)
  .map(([k]) => k);

// Initialize only when config is complete
let app: FirebaseApp | null = null;
let db: Firestore | null = null;

if (missingKeys.length === 0) {
  app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  db = getFirestore(app);
}

type Job = {
  id: string;
  orgId: string;
  wo?: { id: string; scope?: string; carrierId?: string };
  siteId?: string;
  status?: string;
  window?: { start?: any; end?: any };
  preflight?: { dispatcherDone?: boolean; techDone?: boolean };
  compliance?: { progress?: { required?: number; ok?: number }; ready?: boolean };
  assignedTechs?: string[];
};

export default function MissionControl() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);

  useEffect(() => {
    if (missingKeys.length || !db) return;

    const q = query(
      collection(db, "jobs"),
      where("orgId", "==", "butler_pilot"),
      orderBy("window.start")
    );
    const unsub = onSnapshot(q, (snap) => {
      const arr: Job[] = [];
      snap.forEach((d) => arr.push({ id: d.id, ...(d.data() as any) }));
      setJobs(arr);
    });
    return () => unsub();
  }, []);

  const rows = useMemo(() => jobs, [jobs]);

  if (missingKeys.length) {
    return (
      <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
        <h2>Mission Control — Butler</h2>
        <p style={{ color: "#b91c1c" }}>Missing Firebase client config env vars:</p>
        <ul>
          {missingKeys.map((k) => (
            <li key={k}>
              <code>NEXT_PUBLIC_{k}</code>
            </li>
          ))}
        </ul>
        <p>Set them in <strong>.env.local</strong> (dev) and in Vercel Project Settings (prod) and reload.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <h2 style={{ marginBottom: 12 }}>Mission Control — Butler</h2>
      <table cellPadding={8} style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb" }}>
            <th>WO</th><th>Scope</th><th>Status</th><th>Pre-Flight</th><th>Compliance</th><th>Assigned</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((j) => {
            const pf = !!(j.preflight?.dispatcherDone && j.preflight?.techDone);
            const prog = j.compliance?.progress; const compOk = !!j.compliance?.ready;
            const pct = prog ? `${prog.ok ?? 0}/${prog.required ?? 12}` : "0/12";
            return (
              <tr key={j.id} onClick={() => setSelected(j)}
                  style={{ borderBottom: "1px solid #f3f4f6", cursor: "pointer" }}>
                <td>{j.wo?.id || j.id}</td>
                <td>{j.wo?.scope || "-"}</td>
                <td>{j.status || "-"}</td>
                <td>{pf ? "Ready" : "Missing"}</td>
                <td>{pct}{compOk ? " ✓" : ""}</td>
                <td>{j.assignedTechs?.join(", ") || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}

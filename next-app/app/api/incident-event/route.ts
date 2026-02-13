import { NextResponse } from "next/server";
import { getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

if (!getApps().length) {
  initializeApp({
    credential: applicationDefault(),
  });
}

const db = getFirestore();

const ALLOWED_EVENTS = [
  "FIELD_ARRIVED",
  "SESSION_SUBMITTED",
  "SUPERVISOR_REQUEST_UPDATE",
  "NOTES_SAVED",
  "EVIDENCE_ADDED",
];

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { type, incidentId, actor, message } = body;

    if (!type || !incidentId || !actor?.role) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    if (!ALLOWED_EVENTS.includes(type)) {
      return NextResponse.json(
        { error: "Invalid event type" },
        { status: 400 }
      );
    }

    await db.collection("events").add({
      type,
      incidentId,
      actor: {
        role: actor.role,
        uid: actor.uid || null,
        name: actor.name || null,
      },
      message: message || null,
      createdAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("incident-event error", err);
    return NextResponse.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
}

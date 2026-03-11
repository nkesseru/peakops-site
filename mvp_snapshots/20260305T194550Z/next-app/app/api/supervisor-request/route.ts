import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebaseAdmin";

// Tiny helper: never hang forever (but this should be fast anyway)
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout:${label}:${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
     .catch((e) => { clearTimeout(t); reject(e); });
  });
}

type Actor = { role?: string; uid?: string; email?: string } | null;

function docRef(db: any, incidentId: string) {
  return db.collection("supervisor_requests").doc(String(incidentId));
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const incidentId = String(url.searchParams.get("incidentId") || "").trim();
    if (!incidentId) return NextResponse.json({ ok: false, error: "missing incidentId" }, { status: 400 });

    const db = getAdminDb();
    const ref = docRef(db, incidentId);

    const snap = await withTimeout(ref.get(), 15000, "GET_supervisor_request");
    if (!snap.exists) return NextResponse.json({ ok: true, requestUpdate: null });

    const data = snap.data() || {};
    return NextResponse.json({
      ok: true,
      requestUpdate: {
        incidentId,
        message: String(data.message || ""),
        actor: data.actor || null,
        updatedAt: data.updatedAt || null,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const incidentId = String(body?.incidentId || "").trim();
    const message = String(body?.message || "").trim();
    const actor: Actor = body?.actor || null;

    if (!incidentId) return NextResponse.json({ ok: false, error: "missing incidentId" }, { status: 400 });
    if (!message) return NextResponse.json({ ok: false, error: "missing message" }, { status: 400 });

    const db = getAdminDb();
    const ref = docRef(db, incidentId);

    // NOTE: using admin Timestamp if available; else serverDate fallback
    const admin = await import("firebase-admin");
    const updatedAt = (admin as any).firestore?.FieldValue?.serverTimestamp?.() || new Date();

    await withTimeout(
      ref.set(
        {
          incidentId,
          message,
          actor: actor || { role: "supervisor" },
          updatedAt,
        },
        { merge: true }
      ),
      6000,
      "POST_supervisor_request"
    );

    // Optional: also log to events for audit trail (safe; remove if you don’t want it)
    try {
      await db.collection("events").add({
        type: "SUPERVISOR_REQUEST_UPDATE",
        incidentId,
        message,
        actor: actor || { role: "supervisor" },
        createdAt: updatedAt,
      });
    } catch {}

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const incidentId = String(body?.incidentId || "").trim();
    if (!incidentId) return NextResponse.json({ ok: false, error: "missing incidentId" }, { status: 400 });

    const db = getAdminDb();
    const ref = docRef(db, incidentId);

    await withTimeout(ref.delete(), 15000, "DELETE_supervisor_request");

    // Optional audit event
    try {
      const admin = await import("firebase-admin");
      const ts = (admin as any).firestore?.FieldValue?.serverTimestamp?.() || new Date();
      await db.collection("events").add({
        type: "SUPERVISOR_REQUEST_CLEARED",
        incidentId,
        actor: body?.actor || { role: "field" },
        createdAt: ts,
      });
    } catch {}

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}

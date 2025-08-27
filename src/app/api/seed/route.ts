import { NextResponse } from "next/server";
import { getAdminDb } from "@/src/lib/firebaseAdmin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getAdminDb();
    await db.collection("jobs").doc("WO-TEST-200").set({
      orgId: "butler_pilot",
      wo: { id: "WO-TEST-200", carrierId: "ATT", scope: "LTE upgrade" },
      status: "scheduled",
      assignedTechs: ["tech_177"],
      preflight: { dispatcherDone: false, techDone: false },
      compliance: { progress: { ok: 0, required: 12 }, ready: false },
      window: {
        start: new Date("2025-10-05T15:00:00Z"),
        end: new Date("2025-10-05T17:00:00Z"),
      },
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("seed error", e?.message || e);
    return NextResponse.json({ ok: false, error: e?.message || "seed-failed" }, { status: 500 });
  }
}

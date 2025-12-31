import { NextResponse } from "next/server";
const FN_BASE = process.env.FN_BASE || "http://127.0.0.1:5001/peakops-pilot/us-central1";
export async function GET() {
  const r = await fetch(`${FN_BASE}/listContractsV1`);
  const text = await r.text();
  try { return NextResponse.json(JSON.parse(text), { status: r.status }); }
  catch { return new NextResponse(text, { status: r.status }); }
}

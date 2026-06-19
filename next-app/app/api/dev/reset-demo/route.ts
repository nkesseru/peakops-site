import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";

export async function POST() {
  // PEAKOPS_DEV_ROUTE_PROD_GATE_V1 (2026-04-24)
  // /api/dev/reset-demo executes shell scripts on the server. It must
  // never be reachable in production. Return 404 so the route looks
  // absent rather than disabled — same surface area as a non-existent
  // path.
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  try {
    const repoRoot = process.cwd();
    const appRoot = path.join(repoRoot, "..");

    const resetScript = path.join(appRoot, "scripts/dev/reset_demo_incident.sh");
    const seedScript = path.join(appRoot, "scripts/dev/seed_demo_blank_incident.sh");

    const reset = await execFileAsync("bash", [resetScript], {
      cwd: appRoot,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });

    const seed = await execFileAsync("bash", [seedScript], {
      cwd: appRoot,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });

    return NextResponse.json({
      ok: true,
      reset_stdout: reset.stdout || "",
      reset_stderr: reset.stderr || "",
      seed_stdout: seed.stdout || "",
      seed_stderr: seed.stderr || "",
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: String(e?.message || e),
        stdout: e?.stdout || "",
        stderr: e?.stderr || "",
      },
      { status: 500 }
    );
  }
}

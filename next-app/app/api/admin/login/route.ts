// src/app/api/admin/login/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const password = (formData.get("password") || "").toString();
  const redirectTo =
    (formData.get("redirectTo") || "/admin/stormwatch").toString();

  const expected = process.env.ADMIN_DASHBOARD_PASSWORD;

  if (expected && password === expected) {
    const res = NextResponse.redirect(new URL(redirectTo, req.url));

    res.cookies.set("stormwatch-auth", "ok", {
      httpOnly: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 7, // 7 days
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    });

    return res;
  }

  const url = new URL("/admin/login", req.url);
  url.searchParams.set("error", "1");
  url.searchParams.set("redirectTo", redirectTo);

  return NextResponse.redirect(url);
}

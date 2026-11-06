import { NextResponse } from "next/server";

/**
 * better-auth handles verification / reset callbacks under /api/auth/*.
 * Keep this route as a friendly redirect target for legacy email links
 * that still point at /auth/callback.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = url.searchParams.get("next") || "/dashboard";
  const token = url.searchParams.get("token");
  const type = url.searchParams.get("type");

  if (token && (type === "recovery" || type === "reset-password")) {
    return NextResponse.redirect(
      new URL(`/reset-password?token=${encodeURIComponent(token)}`, url.origin),
    );
  }

  // Prefer relative redirect
  const dest = next.startsWith("/") ? next : "/dashboard";
  return NextResponse.redirect(new URL(dest, url.origin));
}

import { NextResponse } from "next/server";

import { isOwnerBootstrapAllowed } from "@/lib/auth/invite-only";

export const runtime = "nodejs";

/**
 * Public — tells the /signup page whether first-owner bootstrap is
 * still open (OWNER_EMAIL set and no accounts row yet). Does not
 * reveal OWNER_EMAIL.
 */
export async function GET() {
  try {
    const ownerBootstrapAllowed = await isOwnerBootstrapAllowed();
    return NextResponse.json({ ownerBootstrapAllowed });
  } catch (err) {
    console.error("[signup-policy]", err);
    return NextResponse.json({ ownerBootstrapAllowed: false });
  }
}

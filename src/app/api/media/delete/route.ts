import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { getSession } from "@/lib/auth/session";

function mediaRoot() {
  return process.env.MEDIA_ROOT || path.join(process.cwd(), "data", "media");
}

const BUCKETS = new Set(["avatars", "chat-media", "flow-media"]);

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { bucket?: string; paths?: string[] };
  if (!body.bucket || !BUCKETS.has(body.bucket) || !Array.isArray(body.paths)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  for (const p of body.paths) {
    if (p.includes("..") || path.isAbsolute(p)) continue;
    await fs.unlink(path.join(mediaRoot(), body.bucket, p)).catch(() => undefined);
  }
  return NextResponse.json({ ok: true });
}

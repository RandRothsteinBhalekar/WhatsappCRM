import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

function mediaRoot() {
  return process.env.MEDIA_ROOT || path.join(process.cwd(), "data", "media");
}

const BUCKETS = new Set(["avatars", "chat-media", "flow-media"]);

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".bin": "application/octet-stream",
};

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ bucket: string; path: string[] }> },
) {
  const { bucket, path: parts } = await ctx.params;
  if (!BUCKETS.has(bucket)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const objectPath = parts.map(decodeURIComponent).join("/");
  if (objectPath.includes("..")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const filePath = path.join(mediaRoot(), bucket, objectPath);
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return new NextResponse(data, {
      headers: {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

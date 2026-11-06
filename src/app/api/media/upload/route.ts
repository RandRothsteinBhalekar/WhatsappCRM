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

  const form = await request.formData();
  const bucket = String(form.get("bucket") || "");
  const objectPath = String(form.get("path") || "");
  const file = form.get("file");

  if (!BUCKETS.has(bucket) || !objectPath || !(file instanceof Blob)) {
    return NextResponse.json({ error: "Invalid upload" }, { status: 400 });
  }
  if (objectPath.includes("..") || path.isAbsolute(objectPath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const dest = path.join(mediaRoot(), bucket, objectPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(dest, buf);

  return NextResponse.json({ path: objectPath });
}

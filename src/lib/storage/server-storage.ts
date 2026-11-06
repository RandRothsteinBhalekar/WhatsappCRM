import fs from "node:fs/promises";
import path from "node:path";
import { createDbClient } from "@/lib/db/sb-compat";

function mediaRoot() {
  return process.env.MEDIA_ROOT || path.join(process.cwd(), "data", "media");
}

function publicBase() {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
    "http://localhost:3000"
  );
}

export function createServerStorage(opts: {
  userId?: string | null;
  bypassRls?: boolean;
}) {
  return {
    from(bucket: string) {
      return {
        async upload(
          objectPath: string,
          body: Blob | Buffer | ArrayBuffer | File | Uint8Array,
          _opts?: unknown,
        ) {
          try {
            const root = path.join(mediaRoot(), bucket);
            const dest = path.join(root, objectPath);
            await fs.mkdir(path.dirname(dest), { recursive: true });
            let buf: Buffer;
            if (Buffer.isBuffer(body)) buf = body;
            else if (body instanceof Uint8Array) buf = Buffer.from(body);
            else if (body instanceof ArrayBuffer) buf = Buffer.from(body);
            else buf = Buffer.from(await (body as Blob).arrayBuffer());
            await fs.writeFile(dest, buf);
            return { data: { path: objectPath }, error: null };
          } catch (e) {
            return {
              data: null,
              error: { message: e instanceof Error ? e.message : String(e) },
            };
          }
        },
        async remove(paths: string[]) {
          try {
            for (const p of paths) {
              const dest = path.join(mediaRoot(), bucket, p);
              await fs.unlink(dest).catch(() => undefined);
            }
            return { data: paths, error: null };
          } catch (e) {
            return {
              data: null,
              error: { message: e instanceof Error ? e.message : String(e) },
            };
          }
        },
        getPublicUrl(objectPath: string) {
          const url = `${publicBase()}/api/media/${bucket}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
          return { data: { publicUrl: url } };
        },
      };
    },
  };
}

/** Ensure upload path is allowed for account when needed */
export async function assertAccountMediaAccess(
  userId: string,
  accountId: string,
) {
  const db = createDbClient({ userId });
  const { data } = await db
    .from("profiles")
    .select("account_id")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { account_id?: string } | null)?.account_id === accountId;
}

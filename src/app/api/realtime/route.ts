import postgres from "postgres";
import { getSession } from "@/lib/auth/session";
import { createDbClient } from "@/lib/db/sb-compat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE stream of Postgres NOTIFY `wacrm_realtime` events, filtered by
 * the caller's account_id when present on the payload.
 *
 * Uses a dedicated postgres.js client for LISTEN — never the shared
 * app pool. Ending the shared client on disconnect was destroying
 * every DB connection (CONNECTION_ENDED / read-only UI).
 */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const db = createDbClient({ userId: session.user.id });
  const { data: profile } = await db
    .from("profiles")
    .select("account_id")
    .eq("user_id", session.user.id)
    .maybeSingle();
  const accountId = (profile as { account_id?: string } | null)?.account_id;

  const encoder = new TextEncoder();
  let closed = false;
  let listenSql: ReturnType<typeof postgres> | null = null;
  let unlist: (() => void) | null = null;

  const cleanup = () => {
    closed = true;
    try {
      unlist?.();
    } catch {
      /* ignore */
    }
    unlist = null;
    if (listenSql) {
      const client = listenSql;
      listenSql = null;
      void client.end({ timeout: 1 }).catch(() => undefined);
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const heartbeat = setInterval(() => {
        if (closed) return;
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 15000);

      try {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error("DATABASE_URL is not set");
        // Dedicated connection — safe to end when this SSE closes.
        listenSql = postgres(url, {
          max: 1,
          idle_timeout: 0,
          connect_timeout: 10,
          onnotice: () => {},
        });
        unlist = await listenSql.listen("wacrm_realtime", (payload) => {
          try {
            const msg = JSON.parse(payload) as {
              account_id?: string | null;
              table: string;
              op: string;
            };
            if (accountId && msg.account_id && msg.account_id !== accountId) {
              return;
            }
            send(msg);
          } catch {
            /* ignore malformed */
          }
        });
      } catch (err) {
        console.error("[realtime] listen failed:", err);
        // Keep the SSE open so clients can rely on heartbeats / polling.
      }

      const cancel = () => {
        clearInterval(heartbeat);
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // @ts-expect-error attach for cancel
      controller._cancel = cancel;
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

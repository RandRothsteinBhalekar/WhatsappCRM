"use client";

type Handler = (payload: {
  eventType: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  old: any;
}) => void;

type Sub = {
  table: string;
  filter?: string;
  event: string;
  handler: Handler;
};

/**
 * Minimal supabase.channel() compatible wrapper over SSE /api/realtime.
 */
export function createBrowserRealtime() {
  const channels = new Map<
    string,
    {
      subs: Sub[];
      es: EventSource | null;
      statusCbs: Array<(s: string) => void>;
    }
  >();

  return {
    channel(name: string) {
      if (!channels.has(name)) {
        channels.set(name, { subs: [], es: null, statusCbs: [] });
      }
      const ch = channels.get(name)!;

      const api = {
        on(
          type: string,
          opts: { event?: string; schema?: string; table?: string; filter?: string },
          handler: Handler,
        ) {
          if (type === "postgres_changes" && opts.table) {
            ch.subs.push({
              table: opts.table,
              filter: opts.filter,
              event: opts.event || "*",
              handler,
            });
          }
          return api;
        },
        subscribe(cb?: (status: string) => void) {
          if (cb) ch.statusCbs.push(cb);
          if (ch.es) return api;
          const es = new EventSource("/api/realtime");
          ch.es = es;
          es.onopen = () => ch.statusCbs.forEach((c) => c("SUBSCRIBED"));
          es.onerror = () => ch.statusCbs.forEach((c) => c("CHANNEL_ERROR"));
          es.onmessage = (ev) => {
            try {
              const msg = JSON.parse(ev.data) as {
                table: string;
                op: string;
                id?: string;
                account_id?: string;
                conversation_id?: string;
                record?: Record<string, unknown>;
              };
              for (const sub of ch.subs) {
                if (sub.table !== msg.table) continue;
                if (sub.event !== "*" && sub.event !== msg.op) continue;
                if (sub.filter && msg.conversation_id) {
                  // filter like `conversation_id=eq.uuid`
                  const m = sub.filter.match(/(\w+)=eq\.(.+)/);
                  if (m) {
                    const [, col, val] = m;
                    const actual =
                      col === "conversation_id"
                        ? msg.conversation_id
                        : col === "account_id"
                          ? msg.account_id
                          : msg.record?.[col];
                    if (String(actual) !== val) continue;
                  }
                }
                sub.handler({
                  eventType: msg.op,
                  new: msg.record || { id: msg.id, ...msg },
                  old: {},
                });
              }
            } catch {
              /* ignore malformed */
            }
          };
          return api;
        },
        unsubscribe() {
          ch.es?.close();
          ch.es = null;
          return Promise.resolve({ error: null });
        },
      };
      return api;
    },
    removeChannel(channel: { unsubscribe?: () => Promise<unknown> }) {
      return channel?.unsubscribe?.() ?? Promise.resolve({ error: null });
    },
  };
}

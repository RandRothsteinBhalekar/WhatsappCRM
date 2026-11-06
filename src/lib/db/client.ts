import postgres from "postgres";

declare global {
  // eslint-disable-next-line no-var
  var __wacrmSql: ReturnType<typeof postgres> | undefined;
}

function createPool() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return postgres(url, {
    max: 20,
    // Keep idle connections; ending/recreating under Next HMR + SSE
    // was a source of CONNECTION_ENDED during profile loads.
    idle_timeout: 0,
    max_lifetime: 60 * 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
}

/**
 * Shared postgres.js pool (server-only).
 * Never call `.end()` on this — use a dedicated client for LISTEN/SSE.
 */
export function sql() {
  if (process.env.NODE_ENV === "production") {
    return (globalThis.__wacrmSql ??= createPool());
  }
  // HMR-safe in dev
  if (!globalThis.__wacrmSql) globalThis.__wacrmSql = createPool();
  return globalThis.__wacrmSql;
}

export type Sql = ReturnType<typeof sql>;

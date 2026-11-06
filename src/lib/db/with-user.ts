import { sql, type Sql } from "./client";

/**
 * Run work on a pooled connection with auth.uid() = userId (via GUC).
 * RLS policies that call auth.uid() then apply.
 */
export async function withUser<T>(
  userId: string,
  fn: (db: Sql) => Promise<T>,
): Promise<T> {
  const db = sql();
  const result = await db.begin(async (tx) => {
    await tx`SELECT set_config('app.current_user_id', ${userId}, true)`;
    await tx`SELECT set_config('row_security', 'on', true)`;
    return fn(tx as unknown as Sql);
  });
  return result as T;
}

/** Privileged connection: RLS off (webhook, engines, API keys). */
export async function withAdmin<T>(fn: (db: Sql) => Promise<T>): Promise<T> {
  const db = sql();
  const result = await db.begin(async (tx) => {
    await tx`SELECT set_config('row_security', 'off', true)`;
    return fn(tx as unknown as Sql);
  });
  return result as T;
}

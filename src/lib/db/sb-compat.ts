import { sql, type Sql } from "./client";
import { QueryBuilder, callRpc } from "./query-builder";
import type { QueryState, SbResult } from "./types";

export type DbClientOptions = {
  userId?: string | null;
  bypassRls?: boolean;
};

async function scopedDb<T>(
  opts: DbClientOptions,
  fn: (db: Sql) => Promise<T>,
): Promise<T> {
  const db = sql();
  if (!opts.userId && !opts.bypassRls) {
    return fn(db);
  }
  const result = await db.begin(async (tx) => {
    const t = tx as unknown as Sql;
    if (opts.bypassRls) {
      await tx`SELECT set_config('row_security', 'off', true)`;
    }
    if (opts.userId) {
      await tx`SELECT set_config('app.current_user_id', ${opts.userId}, true)`;
      if (!opts.bypassRls) {
        await tx`SELECT set_config('row_security', 'on', true)`;
      }
    }
    return fn(t);
  });
  return result as T;
}

/**
 * Chainable builder that records operations, then runs them inside a
 * scoped transaction (auth.uid GUC / RLS bypass) when awaited.
 */
class DeferredQueryBuilder<T = unknown> implements PromiseLike<SbResult<T>> {
  private state: QueryState;

  constructor(
    private readonly opts: DbClientOptions,
    table: string,
  ) {
    this.state = {
      table,
      action: "select",
      columns: "*",
      filters: [],
      order: [],
      limit: null,
      offset: null,
      rangeFrom: null,
      rangeTo: null,
      payload: null,
      onConflict: null,
      ignoreDuplicates: false,
      returning: null,
      head: false,
      count: null,
      single: false,
      maybeSingle: false,
    };
  }

  private live(db: Sql) {
    const b = new QueryBuilder<T>(db, this.state.table, {
      bypassRls: this.opts.bypassRls,
    });
    Object.assign(b as unknown as { state: QueryState }, {
      state: structuredClone(this.state),
    });
    return b;
  }

  select(columns = "*", options?: { head?: boolean; count?: "exact" | "planned" | "estimated" }) {
    if (this.state.action === "select") this.state.columns = columns;
    else this.state.returning = columns;
    if (options?.head) this.state.head = true;
    if (options?.count) this.state.count = options.count;
    return this;
  }
  insert(payload: unknown) {
    this.state.action = "insert";
    this.state.payload = payload;
    return this;
  }
  update(payload: unknown) {
    this.state.action = "update";
    this.state.payload = payload;
    return this;
  }
  upsert(payload: unknown, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.state.action = "upsert";
    this.state.payload = payload;
    this.state.onConflict = opts?.onConflict ?? null;
    this.state.ignoreDuplicates = opts?.ignoreDuplicates ?? false;
    return this;
  }
  delete(_opts?: { count?: "exact" | "planned" | "estimated" }) {
    this.state.action = "delete";
    if (_opts?.count) this.state.count = _opts.count;
    return this;
  }
  eq(column: string, value: unknown) {
    this.state.filters.push({ type: "eq", column, value });
    return this;
  }
  neq(column: string, value: unknown) {
    this.state.filters.push({ type: "neq", column, value });
    return this;
  }
  in(column: string, value: unknown[]) {
    this.state.filters.push({ type: "in", column, value });
    return this;
  }
  is(column: string, value: null | boolean) {
    this.state.filters.push({ type: "is", column, value });
    return this;
  }
  gt(column: string, value: unknown) {
    this.state.filters.push({ type: "gt", column, value });
    return this;
  }
  gte(column: string, value: unknown) {
    this.state.filters.push({ type: "gte", column, value });
    return this;
  }
  lt(column: string, value: unknown) {
    this.state.filters.push({ type: "lt", column, value });
    return this;
  }
  lte(column: string, value: unknown) {
    this.state.filters.push({ type: "lte", column, value });
    return this;
  }
  like(column: string, value: string) {
    this.state.filters.push({ type: "like", column, value });
    return this;
  }
  ilike(column: string, value: string) {
    this.state.filters.push({ type: "ilike", column, value });
    return this;
  }
  contains(column: string, value: unknown) {
    this.state.filters.push({ type: "contains", column, value });
    return this;
  }
  overlaps(column: string, value: unknown) {
    this.state.filters.push({ type: "overlaps", column, value });
    return this;
  }
  or(expression: string) {
    this.state.filters.push({ type: "or", expression });
    return this;
  }
  not(column: string, operator: string, value: unknown) {
    if (operator === "is") {
      this.state.filters.push({
        type: "not",
        filter: { type: "is", column, value: value as null | boolean },
      });
    } else {
      this.state.filters.push({
        type: "not",
        filter: { type: "eq", column, value },
      });
    }
    return this;
  }
  match(query: Record<string, unknown>) {
    for (const [column, value] of Object.entries(query)) {
      this.state.filters.push({ type: "eq", column, value });
    }
    return this;
  }
  filter(column: string, operator: string, value: unknown) {
    const map: Record<string, "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike"> = {
      eq: "eq",
      neq: "neq",
      gt: "gt",
      gte: "gte",
      lt: "lt",
      lte: "lte",
      like: "like",
      ilike: "ilike",
    };
    const type = map[operator];
    if (type === "like" || type === "ilike") {
      this.state.filters.push({ type, column, value: String(value) });
    } else if (type) {
      this.state.filters.push({ type, column, value });
    }
    return this;
  }
  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) {
    this.state.order.push({
      column,
      ascending: opts?.ascending !== false,
      nullsFirst: opts?.nullsFirst,
    });
    return this;
  }
  limit(count: number) {
    this.state.limit = count;
    return this;
  }
  range(from: number, to: number) {
    this.state.rangeFrom = from;
    this.state.rangeTo = to;
    this.state.offset = from;
    this.state.limit = to - from + 1;
    return this;
  }
  single() {
    this.state.single = true;
    this.state.limit = 1;
    return this as unknown as DeferredQueryBuilder<T extends unknown[] ? T[number] : T>;
  }
  maybeSingle() {
    this.state.maybeSingle = true;
    this.state.limit = 1;
    return this as unknown as DeferredQueryBuilder<(T extends unknown[] ? T[number] : T) | null>;
  }

  then<TResult1 = SbResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SbResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    // Await the QueryBuilder thenable *inside* begin so the transaction
    // is not committed/released before SQL finishes (CONNECTION_ENDED).
    return scopedDb(this.opts, async (db) => {
      return await Promise.resolve(this.live(db));
    }).then(
      onfulfilled as (value: SbResult<T>) => TResult1 | PromiseLike<TResult1>,
      onrejected,
    );
  }
}

export function createDbClient(opts: DbClientOptions = {}) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from<T = any>(table: string) {
      return new DeferredQueryBuilder<T>(opts, table);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc<T = any>(fn: string, args?: Record<string, unknown>) {
      return scopedDb(opts, (db) =>
        callRpc<T>(db, fn, args ?? {}, { bypassRls: opts.bypassRls }),
      );
    },
  };
}

export type SbCompatClient = ReturnType<typeof createDbClient>;

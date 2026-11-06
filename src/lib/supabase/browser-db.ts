"use client";

import type { Filter, QueryState, SbResult } from "@/lib/db/types";

function emptyState(table: string): QueryState {
  return {
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

async function execFrom(state: QueryState): Promise<SbResult<unknown>> {
  const res = await fetch("/api/db/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ kind: "from", state }),
  });
  return res.json();
}

async function execRpc(
  fn: string,
  args?: Record<string, unknown>,
): Promise<SbResult<unknown>> {
  const res = await fetch("/api/db/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ kind: "rpc", fn, args }),
  });
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
class BrowserQueryBuilder<T = any> implements PromiseLike<SbResult<T>> {
  private state: QueryState;

  constructor(table: string) {
    this.state = emptyState(table);
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
    const filter: Filter =
      operator === "is"
        ? { type: "is", column, value: value as null | boolean }
        : { type: "eq", column, value };
    this.state.filters.push({ type: "not", filter });
    return this;
  }
  match(query: Record<string, unknown>) {
    for (const [column, value] of Object.entries(query)) {
      this.state.filters.push({ type: "eq", column, value });
    }
    return this;
  }
  filter(column: string, operator: string, value: unknown) {
    return this.eq(column, value); // simplified; most call sites use eq helpers
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
    return this;
  }
  maybeSingle() {
    this.state.maybeSingle = true;
    this.state.limit = 1;
    return this;
  }

  then<TResult1 = SbResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SbResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return execFrom(structuredClone(this.state)).then(
      onfulfilled as never,
      onrejected,
    ) as PromiseLike<TResult1 | TResult2>;
  }
}

export function createBrowserDb() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from<T = any>(table: string) {
      return new BrowserQueryBuilder<T>(table);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rpc<T = any>(fn: string, args?: Record<string, unknown>) {
      return execRpc(fn, args) as Promise<SbResult<T>>;
    },
  };
}

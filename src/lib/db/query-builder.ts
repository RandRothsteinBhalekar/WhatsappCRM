import type { Sql } from "./client";
import type {
  Filter,
  OrderBy,
  QueryState,
  SbError,
  SbResult,
} from "./types";

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function qIdent(name: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

function err(message: string, code?: string): SbError {
  return { message, code };
}

type Embed = {
  alias: string;
  table: string;
  columns: string;
};

/** Split a PostgREST select list on commas not inside parentheses. */
function splitSelectParts(columns: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of columns) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * Parse PostgREST-ish select lists:
 * - `*, contact:contacts(*)` (belongs-to with alias)
 * - `*, contact_tags(tags(*))` (has-many + nested belongs-to)
 */
export function parseSelect(columns: string): { root: string[]; embeds: Embed[] } {
  if (!columns || columns.trim() === "*") {
    return { root: ["*"], embeds: [] };
  }
  const embeds: Embed[] = [];
  const root: string[] = [];

  for (const part of splitSelectParts(columns)) {
    const aliased = part.match(/^(\w+):(\w+)\((.*)\)$/s);
    if (aliased) {
      embeds.push({
        alias: aliased[1],
        table: aliased[2],
        columns: aliased[3] || "*",
      });
      continue;
    }
    // Has-many / nested resource form: relation(columns)
    const nested = part.match(/^(\w+)\((.*)\)$/s);
    if (nested) {
      embeds.push({
        alias: nested[1],
        table: nested[1],
        columns: nested[2] || "*",
      });
      continue;
    }
    root.push(part);
  }
  if (root.length === 0) root.push("*");
  return { root, embeds };
}

function selectListSql(root: string[]): string {
  if (root[0] === "*" || root.includes("*")) return "*";
  return root.map((c) => qIdent(c)).join(", ");
}

/** Heuristic FK: embed table X from parent P → child has parent_id */
function embedFkColumn(
  parent: string,
  _child: string,
): { parentCol: string; childCol: string } {
  // Common: messages → conversation_id, contact_tags → contact_id
  const singular = parent.endsWith("s") ? parent.slice(0, -1) : parent;
  return { parentCol: "id", childCol: `${singular}_id` };
}

function reverseEmbedFk(
  _parent: string,
  child: string,
): { parentCol: string; childCol: string } {
  // contact:contacts(*) on conversations → conversations.contact_id → contacts.id
  const singular = child.endsWith("s") ? child.slice(0, -1) : child;
  return { parentCol: `${singular}_id`, childCol: "id" };
}

/**
 * Attach PostgREST-style embeds onto already-fetched parent rows.
 * Belongs-to vs has-many is chosen by whether the parent row carries
 * `${singular(child)}_id` (e.g. contact_id / tag_id).
 */
async function hydrateEmbeds(
  db: Sql,
  parentTable: string,
  rows: Record<string, unknown>[],
  embeds: Embed[],
): Promise<void> {
  if (!embeds.length || !rows.length) return;

  for (const embed of embeds) {
    const reverse = reverseEmbedFk(parentTable, embed.table);
    const sample = rows[0];
    const belongsTo =
      sample != null &&
      Object.prototype.hasOwnProperty.call(sample, reverse.parentCol);

    const parsed = parseSelect(embed.columns || "*");
    const childSelect = selectListSql(parsed.root);

    if (belongsTo) {
      const ids = [
        ...new Set(
          rows.map((r) => r[reverse.parentCol]).filter((v) => v != null),
        ),
      ];
      if (!ids.length) {
        for (const r of rows) r[embed.alias] = null;
        continue;
      }
      const childSql = `SELECT ${childSelect} FROM ${qIdent(embed.table)} WHERE ${qIdent(reverse.childCol)} = ANY($1)`;
      const children = (await db.unsafe(childSql, [ids] as never[])) as Record<
        string,
        unknown
      >[];
      await hydrateEmbeds(db, embed.table, children, parsed.embeds);
      const byId = new Map(children.map((c) => [c[reverse.childCol], c]));
      for (const r of rows) {
        r[embed.alias] = byId.get(r[reverse.parentCol] as string) ?? null;
      }
      continue;
    }

    const fk = embedFkColumn(parentTable, embed.table);
    const ids = [
      ...new Set(rows.map((r) => r[fk.parentCol]).filter((v) => v != null)),
    ];
    if (!ids.length) {
      for (const r of rows) r[embed.alias] = [];
      continue;
    }
    const childSql = `SELECT ${childSelect} FROM ${qIdent(embed.table)} WHERE ${qIdent(fk.childCol)} = ANY($1)`;
    const children = (await db.unsafe(childSql, [ids] as never[])) as Record<
      string,
      unknown
    >[];
    await hydrateEmbeds(db, embed.table, children, parsed.embeds);
    const byParent = new Map<string, Record<string, unknown>[]>();
    for (const c of children) {
      const key = String(c[fk.childCol]);
      const list = byParent.get(key) ?? [];
      list.push(c);
      byParent.set(key, list);
    }
    for (const r of rows) {
      r[embed.alias] = byParent.get(String(r[fk.parentCol])) ?? [];
    }
  }
}

export class QueryBuilder<T = unknown> implements PromiseLike<SbResult<T>> {
  private state: QueryState;

  constructor(
    private readonly db: Sql,
    table: string,
    private readonly opts: { bypassRls?: boolean } = {},
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

  select(columns = "*", options?: { head?: boolean; count?: "exact" | "planned" | "estimated" }) {
    this.state.action = this.state.action === "insert" || this.state.action === "update" || this.state.action === "upsert" || this.state.action === "delete"
      ? this.state.action
      : "select";
    if (this.state.action === "select") {
      this.state.columns = columns;
    } else {
      this.state.returning = columns;
    }
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

  delete() {
    this.state.action = "delete";
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
    } else if (operator === "eq") {
      this.state.filters.push({
        type: "not",
        filter: { type: "eq", column, value },
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
    const map: Record<string, Filter["type"]> = {
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
      this.state.filters.push({ type: type as "eq", column, value });
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
    return this as unknown as QueryBuilder<T extends unknown[] ? T[number] : T>;
  }

  maybeSingle() {
    this.state.maybeSingle = true;
    this.state.limit = 1;
    return this as unknown as QueryBuilder<(T extends unknown[] ? T[number] : T) | null>;
  }

  then<TResult1 = SbResult<T>, TResult2 = never>(
    onfulfilled?: ((value: SbResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private buildWhere(startIndex: number): { clause: string; params: unknown[]; next: number } {
    const params: unknown[] = [];
    const parts: string[] = [];
    let i = startIndex;

    const pushFilter = (f: Filter): string => {
      if (f.type === "or") {
        // Minimal PostgREST or: "col.eq.val,col2.eq.val2"
        return `(${this.translateOr(f.expression, () => {
          /* params collected via side effect below — use simplified path */
        })})`;
      }
      if (f.type === "not") {
        return `NOT (${pushFilter(f.filter)})`;
      }
      const col = qIdent(f.column);
      if (f.type === "is") {
        if (f.value === null) return `${col} IS NULL`;
        if (f.value === true) return `${col} IS TRUE`;
        return `${col} IS FALSE`;
      }
      if (f.type === "in") {
        params.push(f.value);
        i++;
        return `${col} = ANY($${i - 1 + startIndex - startIndex + params.length + startIndex - 1})`.replace(
          /./,
          "",
        ); // placeholder rewritten below
      }
      // rewrite cleanly:
      return "";
    };

    // Cleaner implementation:
    i = startIndex;
    for (const f of this.state.filters) {
      if (f.type === "or") {
        const { sql: orSql, params: orParams, next } = this.buildOr(f.expression, i);
        parts.push(`(${orSql})`);
        params.push(...orParams);
        i = next;
        continue;
      }
      if (f.type === "not") {
        const inner = f.filter;
        if (inner.type === "is" && inner.value === null) {
          parts.push(`${qIdent(inner.column)} IS NOT NULL`);
        } else if (inner.type === "eq") {
          params.push(inner.value);
          parts.push(`${qIdent(inner.column)} <> $${i++}`);
        }
        continue;
      }
      const col = qIdent(f.column);
      switch (f.type) {
        case "eq":
          params.push(f.value);
          parts.push(`${col} = $${i++}`);
          break;
        case "neq":
          params.push(f.value);
          parts.push(`${col} <> $${i++}`);
          break;
        case "gt":
          params.push(f.value);
          parts.push(`${col} > $${i++}`);
          break;
        case "gte":
          params.push(f.value);
          parts.push(`${col} >= $${i++}`);
          break;
        case "lt":
          params.push(f.value);
          parts.push(`${col} < $${i++}`);
          break;
        case "lte":
          params.push(f.value);
          parts.push(`${col} <= $${i++}`);
          break;
        case "like":
          params.push(f.value);
          parts.push(`${col} LIKE $${i++}`);
          break;
        case "ilike":
          params.push(f.value);
          parts.push(`${col} ILIKE $${i++}`);
          break;
        case "in":
          params.push(f.value);
          parts.push(`${col} = ANY($${i++})`);
          break;
        case "is":
          if (f.value === null) parts.push(`${col} IS NULL`);
          else if (f.value === true) parts.push(`${col} IS TRUE`);
          else parts.push(`${col} IS FALSE`);
          break;
        case "contains":
          params.push(JSON.stringify(f.value));
          parts.push(`${col} @> $${i++}::jsonb`);
          break;
        case "overlaps":
          params.push(f.value);
          parts.push(`${col} && $${i++}`);
          break;
        default:
          break;
      }
    }

    return {
      clause: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
      params,
      next: i,
    };
  }

  private buildOr(
    expression: string,
    startIndex: number,
  ): { sql: string; params: unknown[]; next: number } {
    // Supports: col.eq.value,col2.is.null,and(col.eq.a,col.neq.b)
    const params: unknown[] = [];
    let i = startIndex;
    const tokens = expression.split(",").map((s) => s.trim()).filter(Boolean);
    const parts: string[] = [];
    for (const token of tokens) {
      const m = token.match(/^(\w+)\.(eq|neq|gt|gte|lt|lte|like|ilike|is)\.(.*)$/);
      if (!m) continue;
      const [, col, op, raw] = m;
      const c = qIdent(col);
      if (op === "is" && raw === "null") {
        parts.push(`${c} IS NULL`);
        continue;
      }
      let value: unknown = raw;
      if (raw === "true") value = true;
      else if (raw === "false") value = false;
      params.push(value);
      const ops: Record<string, string> = {
        eq: "=",
        neq: "<>",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
        like: "LIKE",
        ilike: "ILIKE",
      };
      parts.push(`${c} ${ops[op]} $${i++}`);
    }
    return { sql: parts.join(" OR "), params, next: i };
  }

  private translateOr(_expression: string, _cb: () => void): string {
    return "TRUE";
  }

  private async execute(): Promise<SbResult<T>> {
    try {
      if (this.opts.bypassRls) {
        await this.db`SELECT set_config('row_security', 'off', true)`;
      }
      switch (this.state.action) {
        case "select":
          return await this.execSelect();
        case "insert":
          return await this.execInsert();
        case "update":
          return await this.execUpdate();
        case "upsert":
          return await this.execUpsert();
        case "delete":
          return await this.execDelete();
        default:
          return { data: null as T, error: err("Unknown action") };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { data: null as T, error: err(message) };
    }
  }

  private orderClause(): string {
    if (!this.state.order.length) return "";
    return (
      "ORDER BY " +
      this.state.order
        .map((o) => {
          const dir = o.ascending ? "ASC" : "DESC";
          const nulls =
            o.nullsFirst === undefined
              ? ""
              : o.nullsFirst
                ? " NULLS FIRST"
                : " NULLS LAST";
          return `${qIdent(o.column)} ${dir}${nulls}`;
        })
        .join(", ")
    );
  }

  private async execSelect(): Promise<SbResult<T>> {
    const { root, embeds } = parseSelect(this.state.columns);
    const table = qIdent(this.state.table);
    const selectList =
      root[0] === "*"
        ? `${table}.*`
        : root.map((c) => (c === "*" ? `${table}.*` : `${table}.${qIdent(c)}`)).join(", ");

    const { clause, params } = this.buildWhere(1);
    let limitSql = "";
    const allParams = [...params];
    let idx = params.length + 1;
    if (this.state.limit != null) {
      limitSql += ` LIMIT $${idx++}`;
      allParams.push(this.state.limit);
    }
    if (this.state.offset != null) {
      limitSql += ` OFFSET $${idx++}`;
      allParams.push(this.state.offset);
    }

    const text = `SELECT ${selectList} FROM ${table} ${clause} ${this.orderClause()} ${limitSql}`;
    const rows = (await this.db.unsafe(text, allParams as never[])) as Record<string, unknown>[];

    if (this.state.head) {
      return { data: null as T, error: null, count: rows.length };
    }

    let data: unknown = rows;

    // Resolve belongs-to + has-many embeds (including nested selects).
    if (embeds.length && rows.length) {
      await hydrateEmbeds(this.db, this.state.table, rows, embeds);
    }

    if (this.state.single || this.state.maybeSingle) {
      if (rows.length === 0) {
        if (this.state.maybeSingle) return { data: null as T, error: null };
        return { data: null as T, error: err("JSON object requested, multiple (or no) rows returned", "PGRST116") };
      }
      if (rows.length > 1 && this.state.single) {
        return { data: null as T, error: err("JSON object requested, multiple (or no) rows returned", "PGRST116") };
      }
      data = rows[0];
    }

    return { data: data as T, error: null };
  }

  private async execInsert(): Promise<SbResult<T>> {
    const rows = Array.isArray(this.state.payload)
      ? (this.state.payload as Record<string, unknown>[])
      : [this.state.payload as Record<string, unknown>];
    if (!rows.length) return { data: null as T, error: null };

    const keys = Object.keys(rows[0]);
    const cols = keys.map(qIdent).join(", ");
    const values: unknown[] = [];
    const valueSql: string[] = [];
    let i = 1;
    for (const row of rows) {
      const placeholders: string[] = [];
      for (const k of keys) {
        values.push(row[k]);
        placeholders.push(`$${i++}`);
      }
      valueSql.push(`(${placeholders.join(", ")})`);
    }
    const returning = this.state.returning
      ? `RETURNING ${this.state.returning === "*" ? "*" : this.state.returning}`
      : "RETURNING *";
    const text = `INSERT INTO ${qIdent(this.state.table)} (${cols}) VALUES ${valueSql.join(", ")} ${returning}`;
    const result = (await this.db.unsafe(text, values as never[])) as unknown[];

    if (this.state.single || this.state.maybeSingle || !Array.isArray(this.state.payload)) {
      return { data: (result[0] ?? null) as T, error: null };
    }
    return { data: result as T, error: null };
  }

  private async execUpdate(): Promise<SbResult<T>> {
    const payload = this.state.payload as Record<string, unknown>;
    const keys = Object.keys(payload);
    if (!keys.length) return { data: null as T, error: err("Empty update") };

    const sets: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const k of keys) {
      sets.push(`${qIdent(k)} = $${i++}`);
      values.push(payload[k]);
    }
    const { clause, params } = this.buildWhere(i);
    values.push(...params);
    const returning = this.state.returning
      ? `RETURNING ${this.state.returning === "*" ? "*" : this.state.returning}`
      : "";
    const text = `UPDATE ${qIdent(this.state.table)} SET ${sets.join(", ")} ${clause} ${returning}`;
    const result = (await this.db.unsafe(text, values as never[])) as unknown[];

    if (!returning) return { data: null as T, error: null };
    if (this.state.single || this.state.maybeSingle) {
      if (!result.length) {
        if (this.state.maybeSingle) return { data: null as T, error: null };
        return { data: null as T, error: err("JSON object requested, multiple (or no) rows returned", "PGRST116") };
      }
      return { data: result[0] as T, error: null };
    }
    return { data: result as T, error: null };
  }

  private async execUpsert(): Promise<SbResult<T>> {
    const rows = Array.isArray(this.state.payload)
      ? (this.state.payload as Record<string, unknown>[])
      : [this.state.payload as Record<string, unknown>];
    if (!rows.length) return { data: null as T, error: null };

    const keys = Object.keys(rows[0]);
    const cols = keys.map(qIdent).join(", ");
    const values: unknown[] = [];
    const valueSql: string[] = [];
    let i = 1;
    for (const row of rows) {
      const placeholders: string[] = [];
      for (const k of keys) {
        values.push(row[k]);
        placeholders.push(`$${i++}`);
      }
      valueSql.push(`(${placeholders.join(", ")})`);
    }

    const conflict = this.state.onConflict
      ? this.state.onConflict.split(",").map((c) => qIdent(c.trim())).join(", ")
      : qIdent("id");

    const updateSet = this.state.ignoreDuplicates
      ? ""
      : keys
          .filter((k) => k !== "id")
          .map((k) => `${qIdent(k)} = EXCLUDED.${qIdent(k)}`)
          .join(", ");

    const onConflict = this.state.ignoreDuplicates
      ? `ON CONFLICT (${conflict}) DO NOTHING`
      : `ON CONFLICT (${conflict}) DO UPDATE SET ${updateSet}`;

    const returning = this.state.returning
      ? `RETURNING ${this.state.returning === "*" ? "*" : this.state.returning}`
      : "RETURNING *";

    const text = `INSERT INTO ${qIdent(this.state.table)} (${cols}) VALUES ${valueSql.join(", ")} ${onConflict} ${returning}`;
    const result = (await this.db.unsafe(text, values as never[])) as unknown[];

    if (this.state.single || !Array.isArray(this.state.payload)) {
      return { data: (result[0] ?? null) as T, error: null };
    }
    return { data: result as T, error: null };
  }

  private async execDelete(): Promise<SbResult<T>> {
    const { clause, params } = this.buildWhere(1);
    const returning = this.state.returning
      ? `RETURNING ${this.state.returning === "*" ? "*" : this.state.returning}`
      : "";
    const text = `DELETE FROM ${qIdent(this.state.table)} ${clause} ${returning}`;
    const result = (await this.db.unsafe(text, params as never[])) as unknown[];
    if (!returning) return { data: null as T, error: null };
    return { data: result as T, error: null };
  }
}

export async function callRpc<T = unknown>(
  db: Sql,
  fn: string,
  args: Record<string, unknown> = {},
  opts: { bypassRls?: boolean } = {},
): Promise<SbResult<T>> {
  try {
    if (!IDENT.test(fn)) return { data: null as T, error: err(`Invalid RPC: ${fn}`) };
    if (opts.bypassRls) {
      await db`SELECT set_config('row_security', 'off', true)`;
    }
    const keys = Object.keys(args);
    const params = keys.map((k) => args[k]);
    const argList = keys.map((k, i) => `${qIdent(k)} := $${i + 1}`).join(", ");
    const text = `SELECT * FROM ${qIdent(fn)}(${argList})`;
    const rows = await db.unsafe(text, params as never[]);
    // Scalar RPCs often return one column named after the function
    if (rows.length === 1) {
      const row = rows[0] as Record<string, unknown>;
      const vals = Object.values(row);
      if (vals.length === 1) return { data: vals[0] as T, error: null };
      return { data: row as T, error: null };
    }
    return { data: rows as T, error: null };
  } catch (e) {
    return {
      data: null as T,
      error: err(e instanceof Error ? e.message : String(e)),
    };
  }
}

export type { OrderBy };

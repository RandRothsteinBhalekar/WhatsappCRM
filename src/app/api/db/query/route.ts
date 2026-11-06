import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { createDbClient } from "@/lib/db/sb-compat";
import type { QueryState } from "@/lib/db/types";

const TABLE_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Execute a serialized QueryBuilder state as the authenticated user.
 * Used by the browser supabase-compat client.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ data: null, error: { message: "Unauthorized" } }, { status: 401 });
  }

  let body: { kind: "from"; state: QueryState } | { kind: "rpc"; fn: string; args?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ data: null, error: { message: "Invalid JSON" } }, { status: 400 });
  }

  const db = createDbClient({ userId: session.user.id });

  try {
    if (body.kind === "rpc") {
      if (!TABLE_RE.test(body.fn)) {
        return NextResponse.json({ data: null, error: { message: "Invalid RPC" } }, { status: 400 });
      }
      const result = await db.rpc(body.fn, body.args ?? {});
      return NextResponse.json(result);
    }

    if (body.kind !== "from" || !body.state?.table || !TABLE_RE.test(body.state.table)) {
      return NextResponse.json({ data: null, error: { message: "Invalid table" } }, { status: 400 });
    }

    const state = body.state;
    // Rebuild chain from state
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = db.from(state.table);

    if (state.action === "insert") q = q.insert(state.payload);
    else if (state.action === "update") q = q.update(state.payload);
    else if (state.action === "upsert") {
      q = q.upsert(state.payload, {
        onConflict: state.onConflict ?? undefined,
        ignoreDuplicates: state.ignoreDuplicates,
      });
    } else if (state.action === "delete") q = q.delete();

    if (state.action === "select") {
      q = q.select(state.columns, {
        head: state.head || undefined,
        count: state.count || undefined,
      });
    } else if (state.returning) {
      q = q.select(state.returning);
    }

    for (const f of state.filters) {
      switch (f.type) {
        case "eq":
          q = q.eq(f.column, f.value);
          break;
        case "neq":
          q = q.neq(f.column, f.value);
          break;
        case "in":
          q = q.in(f.column, f.value);
          break;
        case "is":
          q = q.is(f.column, f.value);
          break;
        case "gt":
          q = q.gt(f.column, f.value);
          break;
        case "gte":
          q = q.gte(f.column, f.value);
          break;
        case "lt":
          q = q.lt(f.column, f.value);
          break;
        case "lte":
          q = q.lte(f.column, f.value);
          break;
        case "like":
          q = q.like(f.column, f.value);
          break;
        case "ilike":
          q = q.ilike(f.column, f.value);
          break;
        case "contains":
          q = q.contains(f.column, f.value);
          break;
        case "overlaps":
          q = q.overlaps(f.column, f.value);
          break;
        case "or":
          q = q.or(f.expression);
          break;
        case "not":
          if (f.filter.type === "is") q = q.not(f.filter.column, "is", f.filter.value);
          else if (f.filter.type === "eq") q = q.not(f.filter.column, "eq", f.filter.value);
          break;
      }
    }

    for (const o of state.order) {
      q = q.order(o.column, { ascending: o.ascending, nullsFirst: o.nullsFirst });
    }
    if (state.limit != null && state.rangeFrom == null) q = q.limit(state.limit);
    if (state.rangeFrom != null && state.rangeTo != null) {
      q = q.range(state.rangeFrom, state.rangeTo);
    }
    if (state.single) q = q.single();
    if (state.maybeSingle) q = q.maybeSingle();

    const result = await q;
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ data: null, error: { message } }, { status: 500 });
  }
}

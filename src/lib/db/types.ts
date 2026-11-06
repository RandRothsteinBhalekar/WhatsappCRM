export type SbError = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};

// Default `any` mirrors supabase-js's loose row typing so existing call
// sites keep compiling without per-query generics.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SbResult<T = any> = {
  data: T;
  error: SbError | null;
  count?: number | null;
};

export type Filter =
  | { type: "eq"; column: string; value: unknown }
  | { type: "neq"; column: string; value: unknown }
  | { type: "in"; column: string; value: unknown[] }
  | { type: "is"; column: string; value: null | boolean }
  | { type: "gt"; column: string; value: unknown }
  | { type: "gte"; column: string; value: unknown }
  | { type: "lt"; column: string; value: unknown }
  | { type: "lte"; column: string; value: unknown }
  | { type: "like"; column: string; value: string }
  | { type: "ilike"; column: string; value: string }
  | { type: "contains"; column: string; value: unknown }
  | { type: "overlaps"; column: string; value: unknown }
  | { type: "or"; expression: string }
  | { type: "not"; filter: Filter };

export type OrderBy = { column: string; ascending: boolean; nullsFirst?: boolean };

export type QueryState = {
  table: string;
  action: "select" | "insert" | "update" | "upsert" | "delete";
  columns: string;
  filters: Filter[];
  order: OrderBy[];
  limit: number | null;
  offset: number | null;
  rangeFrom: number | null;
  rangeTo: number | null;
  payload: unknown;
  onConflict: string | null;
  ignoreDuplicates: boolean;
  returning: string | null;
  head: boolean;
  count: "exact" | "planned" | "estimated" | null;
  single: boolean;
  maybeSingle: boolean;
};

/**
 * Compatibility types formerly imported from @supabase/supabase-js.
 * Kept intentionally loose so the postgres.js / browser-proxy clients
 * drop in without rewriting every call site's generics.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type SupabaseClient = {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<any>;
  storage?: any;
  auth?: any;
  channel?: (...args: any[]) => any;
  removeChannel?: (...args: any[]) => any;
};

export type RealtimeChannel = {
  on: (...args: any[]) => RealtimeChannel;
  subscribe: (cb?: (status: string) => void) => RealtimeChannel;
  unsubscribe: () => Promise<{ error: unknown }>;
};

export type User = {
  id: string;
  email?: string;
  created_at?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
};

export type EmailOtpType =
  | "signup"
  | "invite"
  | "magiclink"
  | "recovery"
  | "email_change"
  | "email";

export type Session = {
  access_token?: string;
  user: User;
};

export type PostgrestError = {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
};

/** Runtime createClient is not exported here — use @/lib/supabase/* or admin-client. */
export function createClient(..._args: unknown[]): never {
  throw new Error(
    "Use @/lib/supabase/server, @/lib/supabase/client, or supabaseAdmin() instead",
  );
}

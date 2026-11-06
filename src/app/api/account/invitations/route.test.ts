import { beforeEach, describe, expect, it, vi } from "vitest";

const insertCalls: Record<string, unknown>[] = [];
let insertError: { code?: string; message?: string } | null = null;
let callerRole = "admin";

vi.mock("@/lib/auth/account", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/account")>(
    "@/lib/auth/account",
  );
  return {
    ...actual,
    requireRole: vi.fn(async () => {
      if (callerRole === "viewer") {
        throw new actual.ForbiddenError("Insufficient role");
      }
      return {
        userId: "user-1",
        accountId: "acct-1",
        role: callerRole,
        account: { id: "acct-1", name: "Acme" },
        supabase: {
          from: () => {
            const chain: Record<string, unknown> = {};
            const self = () => chain;
            for (const m of [
              "select",
              "eq",
              "is",
              "gt",
              "order",
              "insert",
            ]) {
              chain[m] = vi.fn((arg?: unknown) => {
                if (m === "insert") {
                  insertCalls.push(arg as Record<string, unknown>);
                }
                return chain;
              });
            }
            chain.single = vi.fn(async () => {
              if (insertError) {
                return { data: null, error: insertError };
              }
              const row = insertCalls[insertCalls.length - 1] ?? {};
              return {
                data: {
                  id: "inv-1",
                  role: row.role,
                  email: row.email,
                  label: row.label ?? null,
                  expires_at: row.expires_at,
                  created_at: new Date().toISOString(),
                },
                error: null,
              };
            });
            chain.then = (resolve: (v: unknown) => unknown) =>
              resolve({ data: [], error: null });
            return chain;
          },
        },
      };
    }),
    toErrorResponse: actual.toErrorResponse,
  };
});

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response("rate", { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}));

import { POST } from "./route";

describe("POST /api/account/invitations", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    insertError = null;
    callerRole = "admin";
  });

  it("rejects missing email", async () => {
    const res = await POST(
      new Request("http://localhost/api/account/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "agent" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/email/i);
    expect(insertCalls).toHaveLength(0);
  });

  it("rejects invalid email", async () => {
    const res = await POST(
      new Request("http://localhost/api/account/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "agent", email: "not-an-email" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("persists normalized email on create", async () => {
    const res = await POST(
      new Request("http://localhost/api/account/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role: "agent",
          email: "  Teammate@Example.COM ",
        }),
      }),
    );
    expect(res.status).toBe(201);
    expect(insertCalls[0]?.email).toBe("teammate@example.com");
    const body = await res.json();
    expect(body.token).toBeTruthy();
    expect(body.url).toContain("/join/");
  });

  it("forbids non-admin callers", async () => {
    callerRole = "viewer";
    const res = await POST(
      new Request("http://localhost/api/account/invitations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "agent", email: "a@b.co" }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("better-auth/cookies", () => ({
  getSessionCookie: vi.fn(),
}));

import { getSessionCookie } from "better-auth/cookies";
import { middleware } from "./middleware";

const mockedGetSessionCookie = vi.mocked(getSessionCookie);

function req(path: string) {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

describe("middleware", () => {
  beforeEach(() => {
    mockedGetSessionCookie.mockReset();
  });

  it("redirects unauthenticated users from /dashboard to /login", async () => {
    mockedGetSessionCookie.mockReturnValue(null);
    const res = await middleware(req("/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("redirects authenticated users from /login to /dashboard", async () => {
    mockedGetSessionCookie.mockReturnValue("session-token");
    const res = await middleware(req("/login"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("allows invite redirect from /signup when signed in", async () => {
    mockedGetSessionCookie.mockReturnValue("session-token");
    const res = await middleware(req("/signup?invite=abc"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/join/abc");
  });

  it("returns 401 for unauthenticated WhatsApp API (non-webhook)", async () => {
    mockedGetSessionCookie.mockReturnValue(null);
    const res = await middleware(req("/api/whatsapp/send"));
    expect(res.status).toBe(401);
  });

  it("allows webhook without session", async () => {
    mockedGetSessionCookie.mockReturnValue(null);
    const res = await middleware(req("/api/whatsapp/webhook"));
    expect(res.status).toBe(200);
  });
});

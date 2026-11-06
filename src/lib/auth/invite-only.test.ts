import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashInviteToken } from "@/lib/auth/invitations";
import {
  assertCanSignUp,
  isOwnerBootstrapAllowed,
  isOwnerBootstrapEmail,
  normalizeEmail,
  SignUpDeniedError,
  type InviteLookupRow,
} from "@/lib/auth/invite-only";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Owner@Example.COM ")).toBe("owner@example.com");
  });

  it("returns empty for non-strings", () => {
    expect(normalizeEmail(null)).toBe("");
    expect(normalizeEmail(undefined)).toBe("");
    expect(normalizeEmail(42)).toBe("");
  });
});

describe("isOwnerBootstrapEmail", () => {
  afterEach(() => {
    delete process.env.OWNER_EMAIL;
  });

  it("matches OWNER_EMAIL case-insensitively", () => {
    process.env.OWNER_EMAIL = "Owner@Example.com";
    expect(isOwnerBootstrapEmail("owner@example.com")).toBe(true);
    expect(isOwnerBootstrapEmail("other@example.com")).toBe(false);
  });

  it("is false when OWNER_EMAIL is unset", () => {
    delete process.env.OWNER_EMAIL;
    expect(isOwnerBootstrapEmail("anyone@example.com")).toBe(false);
  });
});

describe("isOwnerBootstrapAllowed", () => {
  afterEach(() => {
    delete process.env.OWNER_EMAIL;
  });

  it("is false when OWNER_EMAIL is unset", async () => {
    delete process.env.OWNER_EMAIL;
    await expect(
      isOwnerBootstrapAllowed(async () => false),
    ).resolves.toBe(false);
  });

  it("is true when owner set and no accounts", async () => {
    process.env.OWNER_EMAIL = "owner@example.com";
    await expect(
      isOwnerBootstrapAllowed(async () => false),
    ).resolves.toBe(true);
  });

  it("is false when accounts already exist", async () => {
    process.env.OWNER_EMAIL = "owner@example.com";
    await expect(
      isOwnerBootstrapAllowed(async () => true),
    ).resolves.toBe(false);
  });
});

describe("assertCanSignUp", () => {
  const token = "invite-token-abc";
  const tokenHash = hashInviteToken(token);
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  function inviteRow(
    overrides: Partial<InviteLookupRow> = {},
  ): InviteLookupRow {
    return {
      email: "agent@example.com",
      accepted_at: null,
      expires_at: future,
      ...overrides,
    };
  }

  beforeEach(() => {
    process.env.OWNER_EMAIL = "owner@example.com";
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    delete process.env.OWNER_EMAIL;
    vi.unstubAllEnvs();
  });

  it("allows owner bootstrap when no accounts exist", async () => {
    await expect(
      assertCanSignUp({
        email: "owner@example.com",
        hasAccounts: async () => false,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects owner email once accounts exist (no invite)", async () => {
    await expect(
      assertCanSignUp({
        email: "owner@example.com",
        hasAccounts: async () => true,
      }),
    ).rejects.toMatchObject({ reason: "invite_required" } satisfies Partial<SignUpDeniedError>);
  });

  it("rejects stranger without invite", async () => {
    await expect(
      assertCanSignUp({
        email: "stranger@example.com",
        hasAccounts: async () => true,
      }),
    ).rejects.toMatchObject({ reason: "invite_required" });
  });

  it("allows matching invite email + token", async () => {
    await expect(
      assertCanSignUp({
        email: "Agent@Example.com",
        inviteToken: token,
        hasAccounts: async () => true,
        lookupInvite: async (hash) => {
          expect(hash).toBe(tokenHash);
          return inviteRow();
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects wrong email for a valid token", async () => {
    await expect(
      assertCanSignUp({
        email: "wrong@example.com",
        inviteToken: token,
        hasAccounts: async () => true,
        lookupInvite: async () => inviteRow(),
      }),
    ).rejects.toMatchObject({ reason: "invite_email_mismatch" });
  });

  it("rejects expired invite", async () => {
    await expect(
      assertCanSignUp({
        email: "agent@example.com",
        inviteToken: token,
        now: new Date("2030-01-01T00:00:00Z"),
        hasAccounts: async () => true,
        lookupInvite: async () =>
          inviteRow({ expires_at: new Date("2020-01-01T00:00:00Z") }),
      }),
    ).rejects.toMatchObject({ reason: "invite_invalid" });
  });

  it("rejects used invite", async () => {
    await expect(
      assertCanSignUp({
        email: "agent@example.com",
        inviteToken: token,
        hasAccounts: async () => true,
        lookupInvite: async () =>
          inviteRow({ accepted_at: new Date().toISOString() }),
      }),
    ).rejects.toMatchObject({ reason: "invite_invalid" });
  });

  it("rejects unknown token", async () => {
    await expect(
      assertCanSignUp({
        email: "agent@example.com",
        inviteToken: token,
        hasAccounts: async () => true,
        lookupInvite: async () => null,
      }),
    ).rejects.toMatchObject({ reason: "invite_invalid" });
  });

  it("rejects invite row without email", async () => {
    await expect(
      assertCanSignUp({
        email: "agent@example.com",
        inviteToken: token,
        hasAccounts: async () => true,
        lookupInvite: async () => inviteRow({ email: null }),
      }),
    ).rejects.toMatchObject({ reason: "invite_missing_email" });
  });

  it("fails closed in production when OWNER_EMAIL is unset", async () => {
    delete process.env.OWNER_EMAIL;
    vi.stubEnv("NODE_ENV", "production");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        assertCanSignUp({
          email: "anyone@example.com",
          hasAccounts: async () => false,
        }),
      ).rejects.toMatchObject({ reason: "owner_email_unset" });
    } finally {
      errSpy.mockRestore();
    }
  });
});

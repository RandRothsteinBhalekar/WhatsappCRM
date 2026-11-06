/**
 * Live invite-only auth against real Postgres + Better Auth.
 *
 *   npm run test:live
 *
 * Requires DATABASE_URL, BETTER_AUTH_SECRET (or AUTH_SECRET), and
 * OWNER_EMAIL in .env.local. Migration 063 (invite email) must be applied.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "@/lib/auth/auth";
import {
  assertCanSignUp,
  SignUpDeniedError,
} from "@/lib/auth/invite-only";
import { generateInviteToken, hashInviteToken } from "@/lib/auth/invitations";
import { sql } from "@/lib/db/client";

const OWNER = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
const SUFFIX = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const AGENT_EMAIL = `agent-${SUFFIX}@invite-only.test`;
const STRANGER_EMAIL = `stranger-${SUFFIX}@invite-only.test`;
const WRONG_EMAIL = `wrong-${SUFFIX}@invite-only.test`;
const PASSWORD = "test-pass-invite-only-99";

const createdUserIds: string[] = [];
const createdInviteIds: string[] = [];
let accountId: string | null = null;
let ownerUserId: string | null = null;

function isAuthError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === "object" &&
      ("status" in err || "statusCode" in err || "body" in err || "message" in err),
  );
}

async function signUpEmail(input: {
  email: string;
  password: string;
  name: string;
  inviteToken?: string;
}) {
  const headers = new Headers();
  if (input.inviteToken) {
    headers.set("x-invite-token", input.inviteToken);
  }
  return auth.api.signUpEmail({
    body: {
      email: input.email,
      password: input.password,
      name: input.name,
      ...(input.inviteToken ? { inviteToken: input.inviteToken } : {}),
    } as { email: string; password: string; name: string },
    headers,
  });
}

describe("invite-only live", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL required for invite-only.live.test.ts");
    }
    if (!process.env.BETTER_AUTH_SECRET && !process.env.AUTH_SECRET) {
      throw new Error("BETTER_AUTH_SECRET required for invite-only.live.test.ts");
    }
    if (!OWNER) {
      throw new Error("OWNER_EMAIL required for invite-only.live.test.ts");
    }

    const db = sql();
    // Ensure email column exists (migration 063).
    const cols = await db<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'account_invitations' AND column_name = 'email'
    `;
    if (!cols.length) {
      throw new Error(
        "account_invitations.email missing — run npm run db:migrate (063_invite_email)",
      );
    }

    const accounts = await db<{ id: string; owner_user_id: string }[]>`
      SELECT id, owner_user_id FROM accounts ORDER BY created_at ASC LIMIT 1
    `;
    if (accounts[0]) {
      accountId = accounts[0].id;
      ownerUserId = accounts[0].owner_user_id;
    }
  });

  afterAll(async () => {
    const db = sql();
    for (const id of createdInviteIds) {
      await db`DELETE FROM account_invitations WHERE id = ${id}`;
    }
    for (const userId of createdUserIds) {
      await db`DELETE FROM profiles WHERE user_id = ${userId}`;
      await db`DELETE FROM accounts WHERE owner_user_id = ${userId}`;
      await db`DELETE FROM sessions WHERE user_id = ${userId}`;
      await db`DELETE FROM auth_accounts WHERE user_id = ${userId}`;
      await db`DELETE FROM users WHERE id = ${userId}`;
    }
  });

  it("rejects stranger signup without invite", async () => {
    await expect(
      assertCanSignUp({
        email: STRANGER_EMAIL,
        hasAccounts: async () => true,
      }),
    ).rejects.toBeInstanceOf(SignUpDeniedError);

    await expect(
      signUpEmail({
        email: STRANGER_EMAIL,
        password: PASSWORD,
        name: "Stranger",
      }),
    ).rejects.toSatisfy(isAuthError);
  });

  it("allows owner bootstrap only when no accounts exist", async () => {
    const db = sql();
    const rows = await db<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM accounts LIMIT 1) AS exists
    `;
    const hasAccounts = Boolean(rows[0]?.exists);

    if (hasAccounts) {
      await expect(
        assertCanSignUp({
          email: OWNER,
          hasAccounts: async () => true,
        }),
      ).rejects.toMatchObject({ reason: "invite_required" });
      return;
    }

    const user = await signUpEmail({
      email: OWNER,
      password: PASSWORD,
      name: "Owner Bootstrap",
    });
    const id = (user as { user?: { id?: string } })?.user?.id;
    if (id) createdUserIds.push(id);
    ownerUserId = id ?? null;

    const accounts = await db<{ id: string }[]>`
      SELECT id FROM accounts WHERE owner_user_id = ${id!} LIMIT 1
    `;
    expect(accounts.length).toBe(1);
    accountId = accounts[0].id;

    const profile = await db<{ account_role: string }[]>`
      SELECT account_role::text AS account_role FROM profiles WHERE user_id = ${id!}
    `;
    expect(profile[0]?.account_role).toBe("owner");
  });

  it("invite path: wrong email rejected, matching email signs up, redeem, revoke", async () => {
    const db = sql();
    if (!accountId || !ownerUserId) {
      const accounts = await db<{ id: string; owner_user_id: string }[]>`
        SELECT id, owner_user_id FROM accounts ORDER BY created_at ASC LIMIT 1
      `;
      accountId = accounts[0]?.id ?? null;
      ownerUserId = accounts[0]?.owner_user_id ?? null;
    }
    expect(accountId).toBeTruthy();
    expect(ownerUserId).toBeTruthy();

    const { token, hash } = generateInviteToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [inv] = await db<{ id: string }[]>`
      INSERT INTO account_invitations (
        account_id, token_hash, role, email, created_by_user_id, expires_at
      ) VALUES (
        ${accountId!},
        ${hash},
        'agent',
        ${AGENT_EMAIL},
        ${ownerUserId!},
        ${expiresAt.toISOString()}
      )
      RETURNING id
    `;
    createdInviteIds.push(inv.id);

    await expect(
      assertCanSignUp({
        email: WRONG_EMAIL,
        inviteToken: token,
      }),
    ).rejects.toMatchObject({ reason: "invite_email_mismatch" });

    await expect(
      signUpEmail({
        email: WRONG_EMAIL,
        password: PASSWORD,
        name: "Wrong",
        inviteToken: token,
      }),
    ).rejects.toSatisfy(isAuthError);

    const signedUp = await signUpEmail({
      email: AGENT_EMAIL,
      password: PASSWORD,
      name: "Agent Invitee",
      inviteToken: token,
    });
    const inviteeId = (signedUp as { user?: { id?: string } })?.user?.id;
    expect(inviteeId).toBeTruthy();
    createdUserIds.push(inviteeId!);

    // Temporary personal owner account from bootstrap.
    const personal = await db<{ id: string; role: string }[]>`
      SELECT a.id, p.account_role::text AS role
      FROM profiles p
      JOIN accounts a ON a.id = p.account_id
      WHERE p.user_id = ${inviteeId!}
    `;
    expect(personal[0]?.role).toBe("owner");
    expect(personal[0]?.id).not.toBe(accountId);

    // Redeem into team account — auth.uid() reads app.current_user_id.
    await db.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user_id', ${inviteeId!}, true)`;
      await tx`SELECT set_config('row_security', 'off', true)`;
      await tx`SELECT redeem_invitation(${hash})`;
    });

    const after = await db<{ account_id: string; role: string }[]>`
      SELECT account_id::text AS account_id, account_role::text AS role
      FROM profiles WHERE user_id = ${inviteeId!}
    `;
    expect(after[0]?.account_id).toBe(accountId);
    expect(after[0]?.role).toBe("agent");

    // Login works for invitee.
    const session = await auth.api.signInEmail({
      body: { email: AGENT_EMAIL, password: PASSWORD },
    });
    expect((session as { user?: { id?: string } })?.user?.id).toBe(inviteeId);

    // Revoke a fresh invite and ensure signup fails.
    const revoked = generateInviteToken();
    const [revRow] = await db<{ id: string }[]>`
      INSERT INTO account_invitations (
        account_id, token_hash, role, email, created_by_user_id, expires_at
      ) VALUES (
        ${accountId!},
        ${revoked.hash},
        'viewer',
        ${`revoked-${SUFFIX}@invite-only.test`},
        ${ownerUserId!},
        ${expiresAt.toISOString()}
      )
      RETURNING id
    `;
    await db`DELETE FROM account_invitations WHERE id = ${revRow.id}`;

    await expect(
      assertCanSignUp({
        email: `revoked-${SUFFIX}@invite-only.test`,
        inviteToken: revoked.token,
      }),
    ).rejects.toMatchObject({ reason: "invite_invalid" });

    // Sanity: hash helper still matches createHash path used in DB.
    expect(hashInviteToken(token)).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
  });
});

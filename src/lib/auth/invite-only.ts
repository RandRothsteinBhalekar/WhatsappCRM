// ============================================================
// Invite-only signup policy — server-side source of truth.
//
// Open registration is disabled. A new user may be created only when:
//   1. Owner bootstrap — email matches OWNER_EMAIL and no accounts
//      row exists yet (first deploy), or
//   2. Email-bound invite — a valid pending invite token whose
//      stored email matches the signup email (case-insensitive).
//
// Login for existing users is unaffected.
// ============================================================

import { sql } from "@/lib/db/client";
import { hashInviteToken } from "@/lib/auth/invitations";

export type SignUpDenialReason =
  | "owner_email_unset"
  | "invite_required"
  | "invite_invalid"
  | "invite_email_mismatch"
  | "invite_missing_email";

export class SignUpDeniedError extends Error {
  readonly reason: SignUpDenialReason;

  constructor(reason: SignUpDenialReason, message: string) {
    super(message);
    this.name = "SignUpDeniedError";
    this.reason = reason;
  }
}

/** Trim + lowercase. Empty / non-string → "". */
export function normalizeEmail(email: unknown): string {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

export function getOwnerEmail(): string {
  return normalizeEmail(process.env.OWNER_EMAIL);
}

export function isOwnerBootstrapEmail(email: string): boolean {
  const owner = getOwnerEmail();
  if (!owner) return false;
  return normalizeEmail(email) === owner;
}

/**
 * True when OWNER_EMAIL is set and the CRM has no tenant yet.
 * Inject `hasAccounts` in tests to avoid hitting Postgres.
 */
export async function isOwnerBootstrapAllowed(
  hasAccounts?: () => Promise<boolean>,
): Promise<boolean> {
  if (!getOwnerEmail()) return false;
  const check =
    hasAccounts ??
    (async () => {
      const db = sql();
      const rows = await db<{ exists: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM accounts LIMIT 1) AS exists
      `;
      return Boolean(rows[0]?.exists);
    });
  const accountsExist = await check();
  return !accountsExist;
}

export type InviteLookupRow = {
  email: string | null;
  accepted_at: string | Date | null;
  expires_at: string | Date;
};

/**
 * Look up a pending invite by plaintext token. Returns null when the
 * token hash does not match any row.
 */
export async function findInviteByToken(
  token: string,
  lookup?: (tokenHash: string) => Promise<InviteLookupRow | null>,
): Promise<InviteLookupRow | null> {
  const trimmed = typeof token === "string" ? token.trim() : "";
  if (!trimmed) return null;

  const run =
    lookup ??
    (async (tokenHash: string) => {
      const db = sql();
      const rows = await db<InviteLookupRow[]>`
        SELECT email, accepted_at, expires_at
        FROM account_invitations
        WHERE token_hash = ${tokenHash}
        LIMIT 1
      `;
      return rows[0] ?? null;
    });

  return run(hashInviteToken(trimmed));
}

function isExpired(expiresAt: string | Date, now: Date): boolean {
  const ts =
    expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(String(expiresAt));
  if (!Number.isFinite(ts)) return true;
  return ts <= now.getTime();
}

export type AssertCanSignUpInput = {
  email: string;
  inviteToken?: string | null;
  /** Injectable clock for tests. */
  now?: Date;
  hasAccounts?: () => Promise<boolean>;
  lookupInvite?: (tokenHash: string) => Promise<InviteLookupRow | null>;
};

/**
 * Throws `SignUpDeniedError` when signup must be blocked.
 * Resolves when the caller may proceed to create the user.
 */
export async function assertCanSignUp(
  input: AssertCanSignUpInput,
): Promise<void> {
  const email = normalizeEmail(input.email);
  const ownerEmail = getOwnerEmail();
  const isProd = process.env.NODE_ENV === "production";

  if (!ownerEmail) {
    if (isProd) {
      console.error(
        "[invite-only] OWNER_EMAIL is unset in production — rejecting all signups",
      );
      throw new SignUpDeniedError(
        "owner_email_unset",
        "Sign up is disabled. Set OWNER_EMAIL on the server.",
      );
    }
    // Dev without OWNER_EMAIL: still require an invite (fail closed on
    // open registration). Owner bootstrap is unavailable until configured.
  }

  if (ownerEmail && isOwnerBootstrapEmail(email)) {
    if (await isOwnerBootstrapAllowed(input.hasAccounts)) {
      return;
    }
  }

  const token =
    typeof input.inviteToken === "string" ? input.inviteToken.trim() : "";
  if (!token) {
    throw new SignUpDeniedError(
      "invite_required",
      "An invitation is required to create an account.",
    );
  }

  const invite = await findInviteByToken(token, input.lookupInvite);
  if (!invite) {
    throw new SignUpDeniedError(
      "invite_invalid",
      "This invitation link is invalid or has expired.",
    );
  }
  if (invite.accepted_at != null) {
    throw new SignUpDeniedError(
      "invite_invalid",
      "This invitation has already been used.",
    );
  }
  const now = input.now ?? new Date();
  if (isExpired(invite.expires_at, now)) {
    throw new SignUpDeniedError(
      "invite_invalid",
      "This invitation link is invalid or has expired.",
    );
  }

  const inviteEmail = normalizeEmail(invite.email);
  if (!inviteEmail) {
    throw new SignUpDeniedError(
      "invite_missing_email",
      "This invitation is missing an email. Ask your admin for a new invite.",
    );
  }
  if (inviteEmail !== email) {
    throw new SignUpDeniedError(
      "invite_email_mismatch",
      "Sign up with the email address this invitation was sent to.",
    );
  }
}

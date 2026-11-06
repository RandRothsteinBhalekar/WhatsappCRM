import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { sql } from "@/lib/db/client";
import { bootstrapAccountForUser } from "@/lib/auth/bootstrap-account";
import { DEFAULT_CURRENCY } from "@/lib/currency";

export const runtime = "nodejs";

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[] | null;
  account_id: string | null;
  account_role: string | null;
};

/**
 * Critical auth path — load profile + account without the generic
 * query builder. Self-heals missing profiles after a failed signup hook.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userId = session.user.id;
  const email = session.user.email || "";
  const fullName = session.user.name || email;

  try {
    const db = sql();
    let profile = await db.begin(async (tx) => {
      await tx`SELECT set_config('app.current_user_id', ${userId}, true)`;
      await tx`SELECT set_config('row_security', 'on', true)`;
      const rows = await tx<ProfileRow[]>`
        SELECT
          id,
          full_name,
          email,
          avatar_url,
          role,
          beta_features,
          account_id,
          account_role::text AS account_role
        FROM profiles
        WHERE user_id = ${userId}
        LIMIT 1
      `;
      return rows[0] ?? null;
    });

    if (!profile) {
      await bootstrapAccountForUser({ userId, email, fullName });
      profile = await db.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${userId}, true)`;
        await tx`SELECT set_config('row_security', 'on', true)`;
        const rows = await tx<ProfileRow[]>`
          SELECT
            id,
            full_name,
            email,
            avatar_url,
            role,
            beta_features,
            account_id,
            account_role::text AS account_role
          FROM profiles
          WHERE user_id = ${userId}
          LIMIT 1
        `;
        return rows[0] ?? null;
      });
    }

    if (!profile) {
      return NextResponse.json(
        { error: "no profiles row for the signed-in user" },
        { status: 404 },
      );
    }

    let account: {
      id: string;
      name: string;
      default_currency: string;
    } | null = null;

    if (profile.account_id) {
      const accountRows = await db.begin(async (tx) => {
        await tx`SELECT set_config('app.current_user_id', ${userId}, true)`;
        await tx`SELECT set_config('row_security', 'on', true)`;
        return tx<{ id: string; name: string; default_currency: string | null }[]>`
          SELECT id, name, default_currency
          FROM accounts
          WHERE id = ${profile!.account_id}
          LIMIT 1
        `;
      });
      const row = accountRows[0];
      if (row) {
        account = {
          id: row.id,
          name: row.name,
          default_currency: row.default_currency ?? DEFAULT_CURRENCY,
        };
      }
    }

    return NextResponse.json({
      profile: {
        id: profile.id,
        full_name: profile.full_name,
        email: profile.email,
        avatar_url: profile.avatar_url,
        role: profile.role,
        beta_features: profile.beta_features ?? [],
        account_id: profile.account_id,
        account_role: profile.account_role,
      },
      account,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GET /api/me/profile]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

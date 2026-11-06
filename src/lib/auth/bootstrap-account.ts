import { sql } from "@/lib/db/client";

/**
 * Replaces the old handle_new_user trigger: create a personal account
 * and owner profile for a newly registered user.
 */
export async function bootstrapAccountForUser(input: {
  userId: string;
  email: string;
  fullName: string;
}) {
  const db = sql();
  await db.begin(async (tx) => {
    await tx`SELECT set_config('row_security', 'off', true)`;

    const existing = await tx`
      SELECT id FROM profiles WHERE user_id = ${input.userId} LIMIT 1
    `;
    if (existing.length) return;

    const [account] = await tx`
      INSERT INTO accounts (name, owner_user_id)
      VALUES (${input.fullName || input.email}, ${input.userId})
      RETURNING id
    `;

    await tx`
      INSERT INTO profiles (user_id, full_name, email, account_id, account_role)
      VALUES (
        ${input.userId},
        ${input.fullName || input.email},
        ${input.email},
        ${account.id},
        'owner'
      )
      ON CONFLICT (user_id) DO NOTHING
    `;
  });
}

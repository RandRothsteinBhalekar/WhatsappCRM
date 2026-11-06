import { createDbClient } from "@/lib/db/sb-compat";
import { getSession } from "@/lib/auth/session";
import { createServerStorage } from "@/lib/storage/server-storage";

/**
 * Server client scoped to the current better-auth session (RLS via auth.uid()).
 */
export async function createClient() {
  const session = await getSession();
  const userId = session?.user?.id ?? null;
  const db = createDbClient({ userId });
  const storage = createServerStorage({ userId, bypassRls: false });

  return {
    ...db,
    storage,
    auth: {
      async getUser() {
        if (!session?.user) return { data: { user: null }, error: null };
        return {
          data: {
            user: {
              id: session.user.id,
              email: session.user.email,
              user_metadata: { full_name: session.user.name },
              app_metadata: {},
            },
          },
          error: null,
        };
      },
      async getSession() {
        if (!session?.user) return { data: { session: null }, error: null };
        return {
          data: {
            session: {
              user: {
                id: session.user.id,
                email: session.user.email,
                user_metadata: { full_name: session.user.name },
              },
            },
          },
          error: null,
        };
      },
      async exchangeCodeForSession() {
        return { data: { session: null }, error: { message: "Not supported" } };
      },
      async verifyOtp() {
        return { data: { session: null }, error: { message: "Not supported" } };
      },
    },
  };
}

"use client";

import { createBrowserDb } from "./browser-db";
import { authClient } from "@/lib/auth/auth-client";
import { createBrowserStorage } from "@/lib/storage/browser-storage";
import { createBrowserRealtime } from "@/lib/realtime/browser-realtime";

let _client: ReturnType<typeof buildClient> | null = null;

function buildClient() {
  const db = createBrowserDb();
  const storage = createBrowserStorage();
  const realtime = createBrowserRealtime();

  return {
    from: db.from.bind(db),
    rpc: db.rpc.bind(db),
    storage,
    channel: realtime.channel.bind(realtime),
    removeChannel: realtime.removeChannel.bind(realtime),
    auth: {
      async getSession() {
        const { data } = await authClient.getSession();
        const session = data?.session as
          | { token?: string; user?: { id: string; email: string; name?: string } }
          | null
          | undefined;
        const user = data?.user ?? session?.user;
        if (!session || !user) {
          return { data: { session: null }, error: null };
        }
        return {
          data: {
            session: {
              access_token: session.token || "session",
              user: {
                id: user.id,
                email: user.email,
                user_metadata: { full_name: user.name },
                app_metadata: {},
              },
            },
          },
          error: null,
        };
      },
      async getUser() {
        const { data } = await authClient.getSession();
        if (!data?.user) return { data: { user: null }, error: null };
        return {
          data: {
            user: {
              id: data.user.id,
              email: data.user.email,
              user_metadata: { full_name: data.user.name },
              app_metadata: {},
            },
          },
          error: null,
        };
      },
      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const res = await authClient.signIn.email({ email, password });
        if (res.error) {
          return { data: { user: null, session: null }, error: { message: res.error.message } };
        }
        const data = res.data as {
          user?: { id: string; email: string; name?: string };
          session?: unknown;
          token?: string;
        } | null;
        return {
          data: {
            user: data?.user
              ? {
                  id: data.user.id,
                  email: data.user.email,
                  user_metadata: { full_name: data.user.name },
                }
              : null,
            session: data?.session ?? (data?.token ? { access_token: data.token } : null),
          },
          error: null,
        };
      },
      async signUp({
        email,
        password,
        options,
      }: {
        email: string;
        password: string;
        options?: {
          data?: { full_name?: string };
          emailRedirectTo?: string;
          /** Opaque invite token from /join/<token> or ?invite=. */
          inviteToken?: string;
        };
      }) {
        const inviteToken = options?.inviteToken?.trim() || undefined;
        const res = await authClient.signUp.email({
          email,
          password,
          name: options?.data?.full_name || email,
          ...(inviteToken ? { inviteToken } : {}),
          fetchOptions: inviteToken
            ? { headers: { "x-invite-token": inviteToken } }
            : undefined,
        } as Parameters<typeof authClient.signUp.email>[0]);
        if (res.error) {
          return { data: { user: null, session: null }, error: { message: res.error.message } };
        }
        const data = res.data as {
          user?: { id: string; email: string; name?: string };
          session?: unknown;
          token?: string;
        } | null;
        return {
          data: {
            user: data?.user
              ? {
                  id: data.user.id,
                  email: data.user.email,
                  user_metadata: { full_name: data.user.name },
                }
              : null,
            session: data?.session ?? (data?.token ? { access_token: data.token } : null),
          },
          error: null,
        };
      },
      async signOut(_opts?: { scope?: string }) {
        const res = await authClient.signOut();
        return { error: res.error ? { message: res.error.message } : null };
      },
      async resetPasswordForEmail(email: string, _opts?: { redirectTo?: string }) {
        const res = await authClient.requestPasswordReset({
          email,
          redirectTo: _opts?.redirectTo || `${window.location.origin}/reset-password`,
        });
        return { data: {}, error: res.error ? { message: res.error.message } : null };
      },
      async updateUser(attrs: {
        password?: string;
        email?: string;
        data?: Record<string, unknown>;
        currentPassword?: string;
      }) {
        if (attrs.password) {
          const res = await authClient.changePassword({
            newPassword: attrs.password,
            currentPassword: attrs.currentPassword || "",
          });
          if (res.error) return { data: { user: null }, error: { message: res.error.message } };
        }
        if (attrs.email) {
          const res = await authClient.changeEmail({ newEmail: attrs.email });
          if (res.error) return { data: { user: null }, error: { message: res.error.message } };
        }
        return { data: { user: null }, error: null };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onAuthStateChange(callback: (event: string, session: any) => void) {
        const unsub = authClient.useSession; // placeholder — see subscribe below
        void unsub;
        let lastId: string | null | undefined = undefined;
        const id = setInterval(async () => {
          const { data } = await authClient.getSession();
          const uid = data?.user?.id ?? null;
          if (uid !== lastId) {
            lastId = uid;
            callback(
              uid ? "SIGNED_IN" : "SIGNED_OUT",
              data?.session
                ? {
                    user: {
                      id: data.user!.id,
                      email: data.user!.email,
                      user_metadata: { full_name: data.user!.name },
                    },
                  }
                : null,
            );
          }
        }, 2000);
        // Immediate check
        void authClient.getSession().then(({ data }) => {
          lastId = data?.user?.id ?? null;
          callback(
            lastId ? "INITIAL_SESSION" : "SIGNED_OUT",
            data?.session
              ? {
                  user: {
                    id: data.user!.id,
                    email: data.user!.email,
                    user_metadata: { full_name: data.user!.name },
                  },
                }
              : null,
          );
        });
        return {
          data: {
            subscription: {
              unsubscribe: () => clearInterval(id),
            },
          },
        };
      },
      async exchangeCodeForSession(_code: string) {
        return { data: { session: null }, error: { message: "Use better-auth callback" } };
      },
      async verifyOtp(_opts: unknown) {
        return { data: { session: null }, error: { message: "Use better-auth verification" } };
      },
    },
  };
}

export function createClient() {
  if (!_client) _client = buildClient();
  return _client;
}

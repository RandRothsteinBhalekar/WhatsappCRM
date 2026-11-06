import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Pool } from "pg";
import { bootstrapAccountForUser } from "./bootstrap-account";
import {
  assertCanSignUp,
  SignUpDeniedError,
} from "./invite-only";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Map Better Auth's camelCase field names onto our snake_case Postgres columns.
 */
const userFields = {
  emailVerified: "email_verified",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

const sessionFields = {
  expiresAt: "expires_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
  ipAddress: "ip_address",
  userAgent: "user_agent",
  userId: "user_id",
} as const;

const accountFields = {
  accountId: "account_id",
  providerId: "provider_id",
  userId: "user_id",
  accessToken: "access_token",
  refreshToken: "refresh_token",
  idToken: "id_token",
  accessTokenExpiresAt: "access_token_expires_at",
  refreshTokenExpiresAt: "refresh_token_expires_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

const verificationFields = {
  expiresAt: "expires_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const;

const localOrigin =
  process.env.BETTER_AUTH_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  "http://localhost:3000";

export const auth = betterAuth({
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET,
  baseURL: localOrigin,
  // Tunnels (ngrok) present a different Origin than baseURL. Without
  // these, sign-in/sign-up is rejected as CSRF from the public host.
  trustedOrigins: [
    localOrigin,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://*.ngrok-free.app",
    "https://*.ngrok-free.dev",
    "https://*.ngrok.app",
    "https://*.ngrok.io",
    "https://*.trycloudflare.com",
  ],
  advanced: {
    // ngrok / reverse proxies send X-Forwarded-Host / Proto.
    trustedProxyHeaders: true,
    database: {
      generateId: () => crypto.randomUUID(),
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
    async sendResetPassword({ user, url }) {
      // Local/dev: log the link. Wire SMTP here for production.
      console.info(`[auth] password reset for ${user.email}: ${url}`);
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;

      const body = (ctx.body ?? {}) as {
        email?: unknown;
        inviteToken?: unknown;
      };
      const headerToken =
        typeof ctx.headers?.get === "function"
          ? ctx.headers.get("x-invite-token")
          : null;
      const inviteToken =
        (typeof body.inviteToken === "string" && body.inviteToken) ||
        headerToken ||
        null;

      try {
        await assertCanSignUp({
          email: typeof body.email === "string" ? body.email : "",
          inviteToken,
        });
      } catch (err) {
        if (err instanceof SignUpDeniedError) {
          throw new APIError("FORBIDDEN", { message: err.message });
        }
        throw err;
      }
    }),
  },
  user: {
    modelName: "users",
    fields: userFields,
    additionalFields: {},
  },
  session: {
    modelName: "sessions",
    fields: sessionFields,
    expiresIn: 60 * 60 * 24 * 14,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },
  account: {
    modelName: "auth_accounts",
    fields: accountFields,
  },
  verification: {
    modelName: "verifications",
    fields: verificationFields,
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            await bootstrapAccountForUser({
              userId: user.id,
              email: user.email,
              fullName: user.name || user.email,
            });
          } catch (err) {
            console.error("[auth] bootstrapAccountForUser failed:", err);
          }
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;

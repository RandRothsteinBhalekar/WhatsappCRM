import { headers } from "next/headers";
import { auth } from "./auth";

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireSessionUser() {
  const session = await getSession();
  if (!session?.user) return null;
  return session.user;
}

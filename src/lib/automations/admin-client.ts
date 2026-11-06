import { createDbClient, type SbCompatClient } from "@/lib/db/sb-compat";
import { createServerStorage } from "@/lib/storage/server-storage";

let _admin: (SbCompatClient & { storage: ReturnType<typeof createServerStorage> }) | null =
  null;

/** Service-role equivalent — RLS bypassed. */
export function supabaseAdmin() {
  if (!_admin) {
    const db = createDbClient({ bypassRls: true });
    const storage = createServerStorage({ bypassRls: true });
    _admin = { ...db, storage };
  }
  return _admin;
}

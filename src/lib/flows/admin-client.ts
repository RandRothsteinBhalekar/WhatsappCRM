import { createDbClient } from "@/lib/db/sb-compat";
import { createServerStorage } from "@/lib/storage/server-storage";

let _admin: ReturnType<typeof build> | null = null;

function build() {
  const db = createDbClient({ bypassRls: true });
  const storage = createServerStorage({ bypassRls: true });
  return { ...db, storage };
}

export function supabaseAdmin() {
  if (!_admin) _admin = build();
  return _admin;
}

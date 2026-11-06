/**
 * Copy supabase/migrations → db/migrations with local-Postgres adaptations:
 * - auth.users → users
 * - strip storage.* and Supabase role GRANTs
 * - strip handle_new_user (signup bootstrap is app-side)
 * - KEEP RLS policies (auth.uid() reads app.current_user_id GUC)
 * - stub storage-only migration files
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "supabase", "migrations");
const destDir = path.join(root, "db", "migrations");

const STORAGE_ONLY = new Set([
  "008_profile_avatars_storage.sql",
  "016_flow_media.sql",
  "023_chat_media.sql",
  "043_storage_scoped_select.sql",
]);

function stripStorageBlocks(sql) {
  let out = sql;
  out = out.replace(
    /INSERT\s+INTO\s+storage\.buckets[\s\S]*?;/gi,
    "-- (storage.buckets skipped)\n",
  );
  out = out.replace(
    /UPDATE\s+storage\.buckets[\s\S]*?;/gi,
    "-- (storage.buckets skipped)\n",
  );
  out = out.replace(
    /ALTER\s+TABLE\s+storage\.[^\s;]+[\s\S]*?;/gi,
    "-- (storage alter skipped)\n",
  );
  // storage policies
  out = out.replace(
    /\b(?:DROP|CREATE)\s+POLICY\b[\s\S]*?\bON\s+storage\.[^\s;]+[\s\S]*?;/gi,
    "-- (storage policy skipped)\n",
  );
  return out;
}

function stripHandleNewUser(sql) {
  let out = sql;
  // Full CREATE FUNCTION ... $$ ... $$; (dollar-quoted body)
  out = out.replace(
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+(?:public\.)?handle_new_user[\s\S]*?\$\$\s*;/gi,
    "-- (handle_new_user removed — app bootstraps account on signup)\n",
  );
  out = out.replace(
    /DROP\s+FUNCTION\s+IF\s+EXISTS\s+(?:public\.)?handle_new_user\s*\(\s*\)\s*;/gi,
    "-- (handle_new_user drop skipped)\n",
  );
  out = out.replace(
    /DROP\s+TRIGGER\s+IF\s+EXISTS\s+on_auth_user_created\s+ON\s+.*?;/gi,
    "-- (auth signup trigger removed)\n",
  );
  out = out.replace(
    /CREATE\s+TRIGGER\s+on_auth_user_created[\s\S]*?;/gi,
    "-- (auth signup trigger removed)\n",
  );
  out = out.replace(
    /ALTER\s+FUNCTION\s+(?:public\.)?handle_new_user\s*\(\s*\)\s+OWNER\s+TO\s+\w+\s*;/gi,
    "-- (handle_new_user owner skipped)\n",
  );
  return out;
}

function stripSupabaseRealtime(sql) {
  // Publication supabase_realtime does not exist outside Supabase
  return sql.replace(
    /DO\s+\$\$[\s\S]*?supabase_realtime[\s\S]*?END\s+\$\$\s*;/gi,
    "-- (supabase_realtime publication skipped — use NOTIFY/SSE)\n",
  );
}

function transform(sql) {
  let out = sql;
  out = out.replace(/REFERENCES\s+auth\.users/gi, "REFERENCES users");
  out = out.replace(/\bauth\.users\b/gi, "users");
  // Supabase auth.users columns → our users table
  out = out.replace(
    /u\.raw_user_meta_data\s*->>\s*'full_name'/gi,
    "u.name",
  );
  out = out.replace(
    /NEW\.raw_user_meta_data\s*->>\s*'full_name'/gi,
    "NEW.name",
  );
  out = out.replace(/\braw_user_meta_data\b/gi, "NULL::jsonb /* was raw_user_meta_data */");
  out = stripStorageBlocks(out);
  out = stripHandleNewUser(out);
  out = stripSupabaseRealtime(out);
  out = out.replace(
    /^\s*GRANT\b.*\b(?:authenticated|anon|service_role)\b.*?;\s*$/gim,
    "-- (Supabase role GRANT skipped)\n",
  );
  out = out.replace(
    /^\s*REVOKE\b.*\b(?:authenticated|anon|service_role)\b.*?;\s*$/gim,
    "-- (Supabase role REVOKE skipped)\n",
  );
  // Docker image uses POSTGRES_USER (wacrm), not a `postgres` role.
  // Only strip single-statement ALTER … OWNER TO postgres (never cross `;`).
  out = out.replace(
    /ALTER\s+(?:FUNCTION|TABLE|SEQUENCE|TYPE|SCHEMA|PROCEDURE)\s+[^;]*OWNER\s+TO\s+postgres\s*;/gi,
    "-- (OWNER TO postgres skipped)\n",
  );
  return out;
}

fs.mkdirSync(destDir, { recursive: true });

// Preserve foundation / notify; regenerate from supabase
const keep = new Set([
  "000_foundation.sql",
  "998_disable_rls.sql",
  "999_realtime_notify.sql",
]);

const files = fs
  .readdirSync(srcDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

let transformed = 0;
let stubbed = 0;

for (const file of files) {
  const dest = path.join(destDir, file);
  if (STORAGE_ONLY.has(file)) {
    fs.writeFileSync(
      dest,
      `-- Skipped: Supabase Storage migration (${file}). Media is on local disk.\n`,
    );
    stubbed++;
    continue;
  }
  const raw = fs.readFileSync(path.join(srcDir, file), "utf8");
  fs.writeFileSync(dest, transform(raw));
  transformed++;
}

// RLS stays ON for user-scoped queries; 998 is no longer used to disable.
// Rewrite 998 as a no-op note so ordering stays stable if already referenced.
fs.writeFileSync(
  path.join(destDir, "998_disable_rls.sql"),
  `-- RLS remains enabled. auth.uid() reads app.current_user_id set by the app.\n` +
    `-- Admin connections use SET LOCAL row_security = off.\n`,
);

console.log(
  `Transformed ${transformed} migrations, stubbed ${stubbed} storage migrations → ${destDir}`,
);
console.log(`Preserved: ${[...keep].join(", ")}`);

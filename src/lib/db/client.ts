// Compile-time guard: importing this module from a Client Component is a build
// error. The service-role key must never reach the browser bundle, so this is
// the first line of defence — before any human comment can be ignored.
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client (service role).
 *
 * The app reaches Postgres server-side through this client using the
 * service-role key, which bypasses Row Level Security. As of the Auth Foundation
 * milestone (M1.5) the schema is multi-user: career data is owned by an
 * `auth.users` row and per-user RLS policies isolate the `authenticated` role.
 * Those policies govern the public API surface (a leaked anon key, or a future
 * per-user client); the app's own data path still uses the service role, so a
 * per-user authenticated client and login UI are deferred. RLS stays
 * deny-by-default for `anon` (zero policies). Never import this from a Client
 * Component — the service-role key must never reach the browser bundle (the
 * `server-only` import above enforces that).
 *
 * The client is created lazily so `next build` does not require env vars at
 * module-eval time (and so a missing-config error surfaces at the call site,
 * not during a page import).
 */
let cached: SupabaseClient | undefined;

export function getDb(): SupabaseClient {
  if (!cached) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — see .env.example",
      );
    }
    cached = createClient(url, key, { auth: { persistSession: false } });
  }
  return cached;
}

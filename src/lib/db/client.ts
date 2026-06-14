// Compile-time guard: importing this module from a Client Component is a build
// error. The service-role key must never reach the browser bundle, so this is
// the first line of defence — before any human comment can be ignored.
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client.
 *
 * Veritas v1 is a single-user, local-first app with no end-user auth. Data
 * access happens server-side through this client using the service-role key,
 * which bypasses Row Level Security. RLS is nonetheless enabled (deny-by-default,
 * with no anon/authenticated policies) on every table so that the public
 * Supabase API roles cannot read or write career data even if the anon key
 * leaks. Never import this from a Client Component — the key must never reach
 * the browser bundle (the `server-only` import above enforces that).
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

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client.
 *
 * Veritas v1 is a single-user, local-first app with no auth and no RLS, so all
 * data access happens server-side through this client using the service-role
 * key. Never import this from a Client Component — the key must never reach the
 * browser bundle.
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

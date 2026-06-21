import { createBrowserClient } from "@supabase/ssr";

// Per-user BROWSER client for the auth screens (login / signup / logout). It uses ONLY the
// publishable anon key (NEXT_PUBLIC_*, safe in the browser bundle) plus the logged-in user's
// session — never the service-role key. RLS does the enforcing.
//
// This is deliberately separate from the server-only service-role client in
// src/lib/db/client.ts: the app's USER-DATA path must never use the service role (M1.5).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

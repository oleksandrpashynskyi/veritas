import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Per-user SERVER client for the app's data path (Server Components + Server Actions). It
// carries the anon key + the request's session cookies, so Postgres sees the request AS the
// logged-in `authenticated` user and RLS enforces per-user ownership. The service-role client
// (src/lib/db/client.ts) is NOT used for user data — that is the M1.5 principle.
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // `setAll` was called from a Server Component, which cannot set cookies. Safe to
            // ignore — the middleware refreshes the session cookie on every request.
          }
        },
      },
    },
  );
}

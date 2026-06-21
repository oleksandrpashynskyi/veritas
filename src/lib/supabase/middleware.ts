import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the user's session on every request (so Server Components/Actions always read a
// fresh session) AND guards the data path: an unauthenticated request to /facts is redirected
// to /login. Anon key + session cookies only — never the service-role key.
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          supabaseResponse = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            supabaseResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Do NOT run code between createServerClient and getUser() (Supabase SSR guidance): it
  // refreshes the token and a gap here can desync the session.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Route protection for the data path. The page + the create action re-check server-side too.
  if (!user && request.nextUrl.pathname.startsWith("/facts")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

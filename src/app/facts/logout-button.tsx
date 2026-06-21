"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Logout is an auth action → browser client. Clears the session, then returns to /login.
export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="rounded border border-zinc-300 px-3 py-1 text-sm"
      onClick={async () => {
        await createClient().auth.signOut();
        router.push("/login");
        router.refresh();
      }}
    >
      Log out
    </button>
  );
}

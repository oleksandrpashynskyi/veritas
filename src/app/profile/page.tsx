import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LogoutButton } from "../facts/logout-button";
import { saveProfile } from "./actions";

// Candidate IDENTITY — the real person's name + contact, used ONLY on the PDF letterhead/signature so a
// generated résumé/cover letter is addressable. It is author metadata, NOT a fact: it never becomes a
// claim, never enters coverage/citation/generation. The email is shown read-only (it comes from the
// account, not this form). Plain Tailwind + native form submission, consistent with /facts.
export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { error: formError, saved } = await searchParams;

  const supabase = await createClient();

  // Server-side auth re-check (the middleware also guards this route).
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // The user's OWN profile row (RLS scopes this to user_id = auth.uid(); maybeSingle → null if unset).
  const { data: profile } = await supabase
    .from("profile")
    .select("full_name, phone, location, professional_url")
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-8">
      <header className="flex items-center justify-between border-b border-zinc-200 pb-3">
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/facts" className="text-zinc-600 underline">
            Profile
          </Link>
          <Link href="/jobs" className="text-zinc-600 underline">
            Jobs
          </Link>
          <span className="font-medium">Identity</span>
        </nav>
        <div className="flex items-center gap-3">
          <span className="text-sm text-zinc-600">{user.email}</span>
          <LogoutButton />
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Your identity</h1>
        <p className="text-sm text-zinc-500">
          Your name and contact details for the letterhead and signature of your exported résumé and
          cover letter. This is not a résumé claim — it is never cited, matched to requirements, or used
          in generation. Only what you enter here is used; nothing is invented.
        </p>

        <form action={saveProfile} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600">Full name</span>
            <input
              name="full_name"
              required
              defaultValue={profile?.full_name ?? ""}
              placeholder="Alex Dev"
              className="rounded border border-zinc-300 px-3 py-2"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600">Email (from your account)</span>
            <input
              value={user.email ?? ""}
              readOnly
              disabled
              className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-500"
            />
          </label>

          <div className="flex flex-col gap-3 sm:flex-row">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-zinc-600">Phone (optional)</span>
              <input
                name="phone"
                defaultValue={profile?.phone ?? ""}
                placeholder="+1 (555) 010-2024"
                className="rounded border border-zinc-300 px-3 py-2"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-zinc-600">Location (optional)</span>
              <input
                name="location"
                defaultValue={profile?.location ?? ""}
                placeholder="Brooklyn, NY"
                className="rounded border border-zinc-300 px-3 py-2"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-600">Professional URL (optional)</span>
            <input
              name="professional_url"
              defaultValue={profile?.professional_url ?? ""}
              placeholder="https://github.com/alexdev"
              className="rounded border border-zinc-300 px-3 py-2"
            />
          </label>

          <button
            type="submit"
            className="self-start rounded bg-zinc-900 px-4 py-2 text-white"
          >
            Save identity
          </button>
        </form>

        {formError && (
          <p role="alert" className="text-sm text-red-600">
            {formError}
          </p>
        )}
        {saved && !formError && (
          <p className="text-sm text-green-700">Saved.</p>
        )}
      </section>
    </main>
  );
}

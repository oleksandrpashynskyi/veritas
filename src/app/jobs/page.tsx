import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { JobRow } from "./jobs";
import { JobIngest } from "./job-ingest";
import { DeleteButton } from "./delete-button";
import { LogoutButton } from "../facts/logout-button";

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error: formError } = await searchParams;

  const supabase = await createClient();

  // Server-side auth re-check (the middleware also guards this route).
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // "My jobs" — RLS scopes this SELECT to the signed-in user's own rows.
  const { data, error: listError } = await supabase
    .from("job")
    .select("id, company, title, created_at")
    .order("created_at", { ascending: false });
  const jobs = (data ?? []) as JobRow[];

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-8">
      <header className="flex items-center justify-between border-b border-zinc-200 pb-3">
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/facts" className="text-zinc-600 underline">
            Profile
          </Link>
          <span className="font-medium">Jobs</span>
          <Link href="/profile" className="text-zinc-600 underline">
            Identity
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <span className="text-sm text-zinc-600">{user.email}</span>
          <LogoutButton />
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Ingest a job</h1>
        <JobIngest />
        {formError && (
          <p role="alert" className="text-sm text-red-600">
            {formError}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">My jobs ({jobs.length})</h2>
        {listError && (
          <p role="alert" className="text-sm text-red-600">
            Could not load jobs: {listError.message}
          </p>
        )}
        {!listError && jobs.length === 0 && (
          <p className="text-sm text-zinc-500">No jobs yet.</p>
        )}
        <ul className="flex flex-col gap-2">
          {jobs.map((j) => (
            <li
              key={j.id}
              className="flex items-start justify-between gap-3 rounded border border-zinc-200 px-3 py-2"
            >
              <Link href={`/jobs/${j.id}`} className="flex flex-col gap-0.5">
                <span className="font-medium">{j.title ?? "Untitled role"}</span>
                <span className="text-sm text-zinc-500">
                  {j.company ?? "Unknown company"}
                </span>
              </Link>
              <DeleteButton id={j.id} />
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

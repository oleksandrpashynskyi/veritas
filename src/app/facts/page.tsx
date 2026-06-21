import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createFact } from "./actions";
import { LogoutButton } from "./logout-button";

// fact_type enum (supabase/migrations/..._init_veritas_schema.sql).
const FACT_TYPES = [
  "experience",
  "achievement",
  "skill",
  "education",
  "writing_sample",
] as const;

type FactRow = {
  id: string;
  type: string;
  content: string;
  created_at: string;
};

export default async function FactsPage({
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

  // "My facts" — RLS scopes this SELECT to the signed-in user's own rows.
  const { data, error: listError } = await supabase
    .from("fact")
    .select("id, type, content, created_at")
    .order("created_at", { ascending: false });
  const facts = (data ?? []) as FactRow[];

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-8">
      <header className="flex items-center justify-between border-b border-zinc-200 pb-3">
        <span className="text-sm text-zinc-600">
          Signed in as {user.email}
        </span>
        <LogoutButton />
      </header>

      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Add a fact</h1>
        <form action={createFact} className="flex flex-col gap-3">
          <select
            name="type"
            className="rounded border border-zinc-300 px-3 py-2"
            defaultValue="experience"
          >
            {FACT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <textarea
            name="content"
            required
            rows={3}
            placeholder="A truthful, specific fact about your experience…"
            className="rounded border border-zinc-300 px-3 py-2"
          />
          <button
            type="submit"
            className="self-start rounded bg-zinc-900 px-4 py-2 text-white"
          >
            Add fact
          </button>
        </form>
        {formError && (
          <p role="alert" className="text-sm text-red-600">
            {formError}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">My facts ({facts.length})</h2>
        {listError && (
          <p role="alert" className="text-sm text-red-600">
            Could not load facts: {listError.message}
          </p>
        )}
        {!listError && facts.length === 0 && (
          <p className="text-sm text-zinc-500">No facts yet.</p>
        )}
        <ul className="flex flex-col gap-2">
          {facts.map((f) => (
            <li
              key={f.id}
              className="rounded border border-zinc-200 px-3 py-2"
            >
              <span className="mr-2 rounded bg-zinc-100 px-2 py-0.5 text-xs uppercase text-zinc-600">
                {f.type}
              </span>
              {f.content}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

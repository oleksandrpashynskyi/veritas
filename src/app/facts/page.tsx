import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FACT_TYPES, type FactRow, type FactType } from "./facts";
import { FactForm } from "./fact-form";
import { DeleteButton } from "./delete-button";
import { createFact } from "./actions";
import { LogoutButton } from "./logout-button";

const TYPE_LABELS: Record<FactType, string> = {
  experience: "Experience",
  achievement: "Achievements",
  skill: "Skills",
  education: "Education",
  writing_sample: "Writing samples",
};

function dateRange(start: string | null, end: string | null): string | null {
  if (start && end) return `${start} – ${end}`;
  if (start) return `${start} – present`;
  if (end) return `until ${end}`;
  return null;
}

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
    .select(
      "id, type, content, employer, role, date_start, date_end, verified, created_at",
    )
    .order("created_at", { ascending: false });
  const facts = (data ?? []) as FactRow[];

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-8">
      <header className="flex items-center justify-between border-b border-zinc-200 pb-3">
        <span className="text-sm text-zinc-600">Signed in as {user.email}</span>
        <LogoutButton />
      </header>

      <section className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">Add a fact</h1>
        <FactForm action={createFact} />
        {formError && (
          <p role="alert" className="text-sm text-red-600">
            {formError}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">My profile ({facts.length})</h2>
        {listError && (
          <p role="alert" className="text-sm text-red-600">
            Could not load facts: {listError.message}
          </p>
        )}
        {!listError && facts.length === 0 && (
          <p className="text-sm text-zinc-500">No facts yet.</p>
        )}

        {FACT_TYPES.map((type) => {
          const group = facts.filter((f) => f.type === type);
          if (group.length === 0) return null;
          return (
            <div key={type} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                {TYPE_LABELS[type]} ({group.length})
              </h3>
              <ul className="flex flex-col gap-2">
                {group.map((f) => {
                  const meta = [f.role, f.employer].filter(Boolean).join(" · ");
                  const range = dateRange(f.date_start, f.date_end);
                  return (
                    <li
                      key={f.id}
                      className="flex items-start justify-between gap-3 rounded border border-zinc-200 px-3 py-2"
                    >
                      <div className="flex flex-col gap-1">
                        <p className="whitespace-pre-wrap">{f.content}</p>
                        {(meta || range || f.verified) && (
                          <p className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                            {meta && <span>{meta}</span>}
                            {range && <span>{range}</span>}
                            {f.verified && (
                              <span className="rounded bg-green-100 px-1.5 py-0.5 text-green-700">
                                verified
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Link
                          href={`/facts/${f.id}/edit`}
                          className="rounded border border-zinc-300 px-2 py-1 text-xs"
                        >
                          Edit
                        </Link>
                        <DeleteButton id={f.id} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </section>
    </main>
  );
}

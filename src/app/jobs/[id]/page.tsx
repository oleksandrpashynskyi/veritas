import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { type CoverageEntry } from "@/lib/llm/coverage-schema";
import { REQUIREMENT_KINDS, KIND_LABELS, type RequirementRow } from "../jobs";
import { CoverageCompute } from "./coverage-compute";
import { buildCoverageRows, CoverageMap, type ViewFact } from "./coverage-view";

type JobDetail = {
  company: string | null;
  title: string | null;
  raw_text: string;
};

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error: pageError } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS scopes every query to the signed-in user's own rows — a foreign or missing id returns
  // nothing, so we send the user back to /jobs rather than leak existence.
  const { data } = await supabase
    .from("job")
    .select("company, title, raw_text")
    .eq("id", id)
    .single();
  if (!data) redirect("/jobs");
  const job = data as JobDetail;

  const { data: reqData } = await supabase
    .from("requirement")
    .select("id, text, kind")
    .eq("job_id", id)
    .order("kind");
  const requirements = (reqData ?? []) as RequirementRow[];

  // Stored coverage for this job (RLS: child via parent). When present we render the map; the facts
  // resolve cited fact_ids -> evidence content + verified status for the honest display.
  const { data: covData } = await supabase
    .from("coverage")
    .select("requirement_id, status, fact_ids")
    .eq("job_id", id);
  const coverageEntries = (covData ?? []) as CoverageEntry[];

  let coverageRows = null;
  if (coverageEntries.length > 0) {
    const { data: factData } = await supabase
      .from("fact")
      .select("id, type, content, employer, role, verified");
    coverageRows = buildCoverageRows(
      coverageEntries,
      requirements,
      (factData ?? []) as ViewFact[],
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-8">
      <header className="flex items-center justify-between border-b border-zinc-200 pb-3">
        <h1 className="text-xl font-semibold">{job.title ?? "Untitled role"}</h1>
        <Link href="/jobs" className="text-sm text-zinc-600 underline">
          Back
        </Link>
      </header>

      <p className="text-sm text-zinc-500">{job.company ?? "Unknown company"}</p>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Requirements ({requirements.length})</h2>
        {requirements.length === 0 && (
          <p className="text-sm text-zinc-500">No requirements were extracted.</p>
        )}
        {REQUIREMENT_KINDS.map((kind) => {
          const group = requirements.filter((r) => r.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                {KIND_LABELS[kind]} ({group.length})
              </h3>
              <ul className="flex flex-col gap-1">
                {group.map((r) => (
                  <li
                    key={r.id}
                    className="rounded border border-zinc-200 px-3 py-2 text-sm"
                  >
                    {r.text}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Coverage</h2>
        {pageError && (
          <p role="alert" className="text-sm text-red-600">
            {pageError}
          </p>
        )}
        {coverageRows ? (
          <CoverageMap rows={coverageRows} />
        ) : (
          <CoverageCompute jobId={id} />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Original posting
        </h2>
        <p className="whitespace-pre-wrap text-sm text-zinc-600">{job.raw_text}</p>
      </section>
    </main>
  );
}

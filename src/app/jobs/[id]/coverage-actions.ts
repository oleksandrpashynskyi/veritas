"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { matchCoverage } from "@/lib/llm";
import { reconcileCitations, type Coverage } from "@/lib/llm/coverage-schema";
import { persistCoverage } from "@/lib/provenance/coverage";
import type { ViewFact, ViewRequirement } from "./coverage-view";

// computeCoverage is a useActionState reducer: (prevState, formData) -> nextState. It performs the
// ONE billed Haiku match and returns the result for preview — it stores NOTHING. Save is a separate
// step (saveCoverage) so the user reviews the met/partial/unmet map before anything is written. The
// preview carries the requirement + fact views so the client can render evidence by id.
export type CoverageComputeState =
  | { status: "idle" }
  | { status: "error"; error: string }
  | {
      status: "ready";
      jobId: string;
      coverage: Coverage;
      requirements: ViewRequirement[];
      facts: ViewFact[];
    };

export async function computeCoverage(
  _prev: CoverageComputeState,
  formData: FormData,
): Promise<CoverageComputeState> {
  const jobId = String(formData.get("job_id") ?? "").trim();
  if (!jobId) return { status: "error", error: "Missing job id." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS scopes every read to the owner. A foreign/missing job yields no job row (so we error) and no
  // requirements; the user's own facts are the only evidence considered.
  const jobRes = await supabase.from("job").select("id").eq("id", jobId).single();
  if (jobRes.error || !jobRes.data) {
    return { status: "error", error: "Job not found." };
  }

  const reqRes = await supabase
    .from("requirement")
    .select("id, text, kind")
    .eq("job_id", jobId)
    .order("kind");
  if (reqRes.error) return { status: "error", error: reqRes.error.message };
  const requirements = (reqRes.data ?? []) as ViewRequirement[];
  if (requirements.length === 0) {
    return { status: "error", error: "This job has no requirements to assess." };
  }

  // Writing samples are voice-only — they assert nothing about experience, so they are never offered as
  // candidate evidence for a requirement (the same exclusion persistCoverage enforces at save, so the
  // previewed map matches what's stored, and the map can never show a writing sample as evidence that a
  // requirement is met). Coverage still considers verified AND unverified facts (the provisional rule).
  const factRes = await supabase
    .from("fact")
    .select("id, type, content, employer, role, verified")
    .neq("type", "writing_sample")
    .order("created_at", { ascending: false });
  if (factRes.error) return { status: "error", error: factRes.error.message };
  const facts = (factRes.data ?? []) as ViewFact[];

  // Cost guard: with no facts, every requirement is trivially unmet — skip the billed call entirely
  // and build the honest all-unmet map directly.
  if (facts.length === 0) {
    const coverage: Coverage = {
      coverage: requirements.map((r) => ({
        requirement_id: r.id,
        status: "unmet" as const,
        fact_ids: [],
      })),
    };
    return { status: "ready", jobId, coverage, requirements, facts };
  }

  // ONE billed call. `verified` is deliberately not handed to the matcher (display/trust concern,
  // not a matching signal); fail-closed validation happens inside matchCoverage.
  const result = await matchCoverage(
    requirements.map((r) => ({ id: r.id, text: r.text, kind: r.kind })),
    facts.map((f) => ({
      id: f.id,
      type: f.type,
      content: f.content,
      employer: f.employer,
      role: f.role,
    })),
  );
  if (!result.ok) return { status: "error", error: result.error };

  // Provenance at the REVIEW surface: reconcile the matcher's citations against the user's REAL
  // owned facts + this job's requirements — the SAME gate persistCoverage applies at save, built
  // from the same RLS-scoped data already fetched above. The preview must show EXACTLY what Save
  // will store, and must never present a met/partial citing a hallucinated/foreign id. Fail closed:
  // a bad citation -> recompute, identical to save's wholesale rejection. On success the preview
  // carries the reconciled rows (omitted requirements filled as unmet) — preview == save.
  const reconciled = reconcileCitations({
    entries: result.value.coverage,
    ownedFactIds: new Set(facts.map((f) => f.id)),
    jobRequirementIds: new Set(requirements.map((r) => r.id)),
  });
  if (!reconciled.ok) {
    return {
      status: "error",
      error: "The match cited evidence that isn't in your profile. Please compute again.",
    };
  }

  return { status: "ready", jobId, coverage: { coverage: reconciled.rows }, requirements, facts };
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null; // -> validateCoverage rejects "not an object"
  }
}

// Save the previewed coverage. A thin wrapper: auth + per-user client, then persistCoverage does the
// real work (re-validate -> fetch owned/job id sets via this client -> reconcile -> insert), failing
// closed and storing NOTHING on any validation/provenance/DB error. persistCoverage is the function
// verify-m4 exercises directly with a real per-user client.
export async function saveCoverage(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const jobId = String(formData.get("job_id") ?? "").trim();
  if (!jobId) {
    redirect(`/jobs?error=${encodeURIComponent("Missing job id.")}`);
  }

  const res = await persistCoverage(
    supabase,
    user.id,
    jobId,
    parseJson(String(formData.get("coverage") ?? "")),
  );
  if (!res.ok) {
    redirect(`/jobs/${jobId}?error=${encodeURIComponent(res.error)}`);
  }

  revalidatePath(`/jobs/${jobId}`);
  redirect(`/jobs/${jobId}`);
}

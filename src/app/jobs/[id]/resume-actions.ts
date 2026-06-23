"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { generateResume } from "@/lib/llm";
import {
  reconcileResumeCitations,
  type ResumeLine,
} from "@/lib/llm/resume-schema";
import { persistResume } from "@/lib/provenance/resume";
import type { CitedFact } from "./resume-view-logic";

// generateResumeAction is a useActionState reducer: (prevState, formData) -> nextState. It performs
// the ONE billed Sonnet generation and returns the result for preview — it stores NOTHING. Save is a
// separate step (saveResumeAction) so the user approves line-by-line before anything is written. The
// "blocked" status carries honest guidance for the no-LLM-call preconditions (no coverage, no
// verified facts, no verified-backed coverage) — an honest gap, not an error.
export type ResumeGenerateState =
  | { status: "idle" }
  | { status: "error"; error: string }
  | { status: "blocked"; reason: string }
  | { status: "ready"; jobId: string; lines: ResumeLine[]; facts: CitedFact[] };

type CoverageRow = { requirement_id: string; status: string; fact_ids: string[] };

export async function generateResumeAction(
  _prev: ResumeGenerateState,
  formData: FormData,
): Promise<ResumeGenerateState> {
  const jobId = String(formData.get("job_id") ?? "").trim();
  if (!jobId) return { status: "error", error: "Missing job id." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS scopes every read to the owner. A foreign/missing job yields no row -> error, no leak.
  const jobRes = await supabase.from("job").select("id").eq("id", jobId).single();
  if (jobRes.error || !jobRes.data) {
    return { status: "error", error: "Job not found." };
  }

  // One résumé per job (Alex). If one exists, the UI shows it with Delete; block generation here too.
  const existing = await supabase
    .from("document")
    .select("id")
    .eq("job_id", jobId)
    .eq("type", "resume");
  if (existing.error) return { status: "error", error: existing.error.message };
  if ((existing.data?.length ?? 0) > 0) {
    return { status: "error", error: "A résumé already exists for this job. Delete it to regenerate." };
  }

  // Precondition: generation tailors to the stored coverage. No coverage -> compute it first (no call).
  const covRes = await supabase
    .from("coverage")
    .select("requirement_id, status, fact_ids")
    .eq("job_id", jobId);
  if (covRes.error) return { status: "error", error: covRes.error.message };
  const coverage = (covRes.data ?? []) as CoverageRow[];
  if (coverage.length === 0) {
    return {
      status: "blocked",
      reason: "Compute the coverage map for this job first — generation tailors the résumé to it.",
    };
  }

  // The citable pool: the user's VERIFIED facts only (verified-only generation). RLS scopes to owner.
  const factRes = await supabase
    .from("fact")
    .select("id, type, content, employer, role, date_start, date_end, verified")
    .eq("verified", true)
    .order("created_at", { ascending: false });
  if (factRes.error) return { status: "error", error: factRes.error.message };
  const verifiedFacts = factRes.data ?? [];
  // Writing samples are VOICE-ONLY and may never be cited as evidence by a résumé line — the citable
  // pool excludes them (the shared gate enforces the same exclusion at save, so preview == save).
  const citableFacts = verifiedFacts.filter((f) => f.type !== "writing_sample");
  if (citableFacts.length === 0) {
    return {
      status: "blocked",
      reason:
        "You have no verified facts to put on your résumé yet. Verify the experience/skill facts you want first (writing samples shape voice only and can't be cited).",
    };
  }
  // Two sets: verifiedIds (ALL verified) gates the honest "every cited fact is verified" coverage check
  // below; citableIds (verified minus writing samples) is what a line may actually cite — the SAME set
  // the gate reconciles against, so preview == save.
  const verifiedIds = new Set<string>(verifiedFacts.map((f) => f.id as string));
  const citableIds = new Set<string>(citableFacts.map((f) => f.id as string));

  // The tailoring signal: coverage filtered to its VERIFIED-fact-backed entries — met/partial whose
  // every cited fact is verified. A requirement met only via unverified facts is an honest gap here.
  const reqRes = await supabase
    .from("requirement")
    .select("id, text")
    .eq("job_id", jobId);
  if (reqRes.error) return { status: "error", error: reqRes.error.message };
  const reqText = new Map<string, string>(
    (reqRes.data ?? []).map((r) => [r.id as string, r.text as string]),
  );
  const backed = coverage
    .filter(
      (c) =>
        (c.status === "met" || c.status === "partial") &&
        c.fact_ids.length > 0 &&
        c.fact_ids.every((fid) => verifiedIds.has(fid)),
    )
    .map((c) => ({
      requirement: reqText.get(c.requirement_id) ?? "",
      status: c.status,
      // Strip any writing-sample id from the emphasis hint — the model is never offered a writing
      // sample as a citable fact.
      fact_ids: c.fact_ids.filter((fid) => citableIds.has(fid)),
    }))
    .filter((c) => c.requirement.length > 0 && c.fact_ids.length > 0);
  if (backed.length === 0) {
    return {
      status: "blocked",
      reason:
        "No requirement is met or partially met by your verified facts yet. Verify the facts behind your coverage, then generate.",
    };
  }

  // ONE billed Sonnet call. Inputs are personal data; generateResume never logs them and fail-closes
  // (refusal / non-JSON / banned word / off-shape) to a closed result.
  const result = await generateResume(
    citableFacts.map((f) => ({
      id: f.id as string,
      type: f.type as string,
      content: f.content as string,
      employer: f.employer as string | null,
      role: f.role as string | null,
      date_start: f.date_start as string | null,
      date_end: f.date_end as string | null,
    })),
    backed,
  );
  if (!result.ok) return { status: "error", error: result.error };

  // Provenance at the REVIEW surface: reconcile the generated citations against the user's REAL
  // verified+owned facts — the SAME gate persistResume applies at save. The preview must show EXACTLY
  // what Save will store, never a line citing a hallucinated/unverified id. Fail closed -> regenerate.
  const reconciled = reconcileResumeCitations({
    lines: result.value.lines,
    verifiedOwnedFactIds: citableIds,
  });
  if (!reconciled.ok) {
    return {
      status: "error",
      error: "The draft cited evidence that isn't among your verified facts. Please generate again.",
    };
  }
  if (reconciled.lines.length === 0) {
    return {
      status: "blocked",
      reason: "The draft produced no supported lines. Try adding or verifying more relevant facts.",
    };
  }

  // Carry the citable facts (content + verified) so the preview can render evidence by id — a line
  // cites only citable facts, so this is the full evidence pool. preview == save.
  const facts: CitedFact[] = citableFacts.map((f) => ({
    id: f.id as string,
    content: f.content as string,
    verified: f.verified as boolean,
  }));
  return { status: "ready", jobId, lines: reconciled.lines, facts };
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null; // -> validateResume rejects "not an object"
  }
}

// Save the approved subset of the previewed résumé. A thin wrapper: auth + per-user client, then
// persistResume does the real work (re-validate -> verified-fetch via this client -> reconcile ->
// insert document + doc_lines), failing closed and storing NOTHING on any validation/provenance/DB
// error. persistResume is the function verify-m5 exercises directly with a real per-user client.
export async function saveResumeAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const jobId = String(formData.get("job_id") ?? "").trim();
  if (!jobId) {
    redirect(`/jobs?error=${encodeURIComponent("Missing job id.")}`);
  }

  const res = await persistResume(
    supabase,
    user.id,
    jobId,
    parseJson(String(formData.get("lines") ?? "")),
  );
  if (!res.ok) {
    redirect(`/jobs/${jobId}?error=${encodeURIComponent(res.error)}`);
  }

  revalidatePath(`/jobs/${jobId}`);
  redirect(`/jobs/${jobId}`);
}

// Delete the job's résumé (one per job). RLS scopes the delete to documents whose parent job the user
// owns; the FK cascade removes the doc_lines. To redo a résumé, delete then generate again.
export async function deleteResumeAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const jobId = String(formData.get("job_id") ?? "").trim();
  if (!jobId) {
    redirect(`/jobs?error=${encodeURIComponent("Missing job id.")}`);
  }

  const del = await supabase
    .from("document")
    .delete()
    .eq("job_id", jobId)
    .eq("type", "resume");
  if (del.error) {
    redirect(`/jobs/${jobId}?error=${encodeURIComponent(del.error.message)}`);
  }

  revalidatePath(`/jobs/${jobId}`);
  redirect(`/jobs/${jobId}`);
}

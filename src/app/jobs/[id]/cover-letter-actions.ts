"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { generateCoverLetter } from "@/lib/llm";
import { reconcileResumeCitations } from "@/lib/llm/resume-schema";
import { persistCoverLetter } from "@/lib/provenance/cover-letter";
import type {
  ClaimLineForStore,
  ConnectiveSegment,
} from "@/lib/provenance/document";
import type { CitedFact } from "./resume-view-logic";

// generateCoverLetterAction is a useActionState reducer: (prevState, formData) -> nextState. It
// performs the ONE billed Sonnet generation and returns the result for preview — it stores NOTHING.
// Save is a separate step (saveCoverLetterAction) so the user approves block-by-block before anything
// is written. The "blocked" status carries honest guidance for the no-LLM-call preconditions. Mirrors
// generateResumeAction; the only new shape is the connective prose carried alongside the claim lines.
export type CoverLetterGenerateState =
  | { status: "idle" }
  | { status: "error"; error: string }
  | { status: "blocked"; reason: string }
  | {
      status: "ready";
      jobId: string;
      claimLines: ClaimLineForStore[];
      connective: ConnectiveSegment[];
      facts: CitedFact[];
      voiceNote: string | null;
    };

type CoverageRow = { requirement_id: string; status: string; fact_ids: string[] };

export async function generateCoverLetterAction(
  _prev: CoverLetterGenerateState,
  formData: FormData,
): Promise<CoverLetterGenerateState> {
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

  // One cover letter per job (Alex). If one exists, the UI shows it with Delete; block generation here.
  const existing = await supabase
    .from("document")
    .select("id")
    .eq("job_id", jobId)
    .eq("type", "cover_letter");
  if (existing.error) return { status: "error", error: existing.error.message };
  if ((existing.data?.length ?? 0) > 0) {
    return {
      status: "error",
      error: "A cover letter already exists for this job. Delete it to regenerate.",
    };
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
      reason: "Compute the coverage map for this job first — generation tailors the letter to it.",
    };
  }

  // The verified pool. Claims may cite ONLY non-writing-sample verified facts (writing samples are
  // VOICE, never a citation); writing samples are passed separately as style reference WITHOUT ids, so
  // nothing the candidate has done can be sourced to a prose sample.
  const factRes = await supabase
    .from("fact")
    .select("id, type, content, employer, role, date_start, date_end, verified")
    .eq("verified", true)
    .order("created_at", { ascending: false });
  if (factRes.error) return { status: "error", error: factRes.error.message };
  const verifiedFacts = factRes.data ?? [];
  const citableFacts = verifiedFacts.filter((f) => f.type !== "writing_sample");
  const voiceSamples = verifiedFacts.filter((f) => f.type === "writing_sample");
  if (citableFacts.length === 0) {
    return {
      status: "blocked",
      reason:
        "You have no verified facts to cite yet. Verify the experience/skill facts you want the letter to draw on first.",
    };
  }
  // Two sets: verifiedIds (ALL verified) gates the honest "every cited fact is verified" coverage
  // check below; citableIds (verified minus writing samples = citableFacts) is what a claim may
  // actually cite — the SAME set persistCoverLetter reconciles against at save, so preview == save.
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
      // sample as a citable fact (writing samples still flow separately as voice, without ids).
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

  // ONE billed Sonnet call. Inputs are personal data; generateCoverLetter never logs them and
  // fail-closes (refusal / non-JSON / banned word / smuggled citation / off-shape) to a closed result.
  const result = await generateCoverLetter(
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
    voiceSamples.map((f) => ({ content: f.content as string })),
  );
  if (!result.ok) return { status: "error", error: result.error };

  // Provenance at the REVIEW surface: reconcile the generated CLAIM citations against the user's REAL
  // verified+owned facts — the SAME gate persistCoverLetter applies at save. The preview must show
  // EXACTLY what Save will store, never a claim citing a hallucinated/unverified id. Fail closed.
  const reconciled = reconcileResumeCitations({
    lines: result.claimLines,
    verifiedOwnedFactIds: citableIds,
  });
  if (!reconciled.ok) {
    return {
      status: "error",
      error: "The draft cited evidence that isn't among your verified facts. Please generate again.",
    };
  }
  if (result.claimLines.length === 0) {
    return {
      status: "blocked",
      reason: "The draft produced no supported claims. Try adding or verifying more relevant facts.",
    };
  }

  // Carry the citable facts (content + verified) so the preview can render claim evidence by id —
  // preview == save. A claim cites only citable facts, so this is the full evidence pool.
  const facts: CitedFact[] = citableFacts.map((f) => ({
    id: f.id as string,
    content: f.content as string,
    verified: f.verified as boolean,
  }));
  const voiceNote =
    voiceSamples.length === 0
      ? "Add writing samples (facts of type “writing sample”) to sharpen the voice match. The letter still cites only your verified facts; samples change only the wording."
      : null;
  return {
    status: "ready",
    jobId,
    claimLines: result.claimLines,
    connective: result.connective,
    facts,
    voiceNote,
  };
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null; // -> validateCoverLetter rejects "not an object"
  }
}

// Save the approved subset of the previewed cover letter. A thin wrapper: auth + per-user client, then
// persistCoverLetter does the real work (re-validate -> verified-fetch via this client -> reconcile ->
// insert document + doc_lines, with connective on the document), failing closed and storing NOTHING on
// any validation/provenance/DB error. persistCoverLetter is what verify-m6 exercises directly.
export async function saveCoverLetterAction(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const jobId = String(formData.get("job_id") ?? "").trim();
  if (!jobId) {
    redirect(`/jobs?error=${encodeURIComponent("Missing job id.")}`);
  }

  const res = await persistCoverLetter(
    supabase,
    user.id,
    jobId,
    parseJson(String(formData.get("blocks") ?? "")),
  );
  if (!res.ok) {
    redirect(`/jobs/${jobId}?error=${encodeURIComponent(res.error)}`);
  }

  revalidatePath(`/jobs/${jobId}`);
  redirect(`/jobs/${jobId}`);
}

// Delete the job's cover letter (one per job). RLS scopes the delete to documents whose parent job the
// user owns; the FK cascade removes the doc_lines. To redo a letter, delete then generate again.
export async function deleteCoverLetterAction(formData: FormData) {
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
    .eq("type", "cover_letter");
  if (del.error) {
    redirect(`/jobs/${jobId}?error=${encodeURIComponent(del.error.message)}`);
  }

  revalidatePath(`/jobs/${jobId}`);
  redirect(`/jobs/${jobId}`);
}

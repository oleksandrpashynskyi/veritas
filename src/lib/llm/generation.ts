// Verified facts x targeted requirements -> tailored résumé lines. The Anthropic key + SDK live
// solely in ./client (runStructured); this module owns only the generation PROMPT + schema +
// fail-closed validation. It is server-only by transitivity (./client imports "server-only"); shared
// code must import the pure validator/types from "@/lib/llm/resume-schema" instead, never this file.
import { runStructured } from "./client";
import { BANNED_WORDS } from "../provenance/banned";
import {
  RESUME_SCHEMA,
  validateResume,
  type ResumeResult,
} from "./resume-schema";

// Decision locked (Alex): Sonnet — this is the highest-stakes LLM task (the deliverable itself + its
// faithfulness), so unlike the matcher's Haiku it starts here. ONE billed call; client.ts pins
// maxRetries:0, so a transient failure fails closed and the user re-triggers an explicit new action.
const MODEL = "claude-sonnet-4-6";
// Headroom for a full résumé with citations (the validator caps lines at 60); a truncated response
// is non-JSON and fails closed, so we give enough room to avoid spurious truncation of the product.
const MAX_TOKENS = 8192;

// The CITABLE material — only the user's VERIFIED facts. ids are echoed back as citations; employer/
// role/dates let the model write faithful bullets WITHOUT inventing context. Personal data — never logged.
export type GenFact = {
  id: string;
  type: string;
  content: string;
  employer: string | null;
  role: string | null;
  date_start: string | null;
  date_end: string | null;
};

// The TAILORING signal — the job's requirements this résumé should target, drawn from the stored
// coverage filtered to its verified-fact-backed entries. `fact_ids` tells the model which verified
// facts address each requirement; it is a hint for EMPHASIS, never a licence to add unsupported claims.
export type GenCoverageEntry = {
  requirement: string;
  status: string; // "met" | "partial"
  fact_ids: string[];
};

// The product exists to kill inflated claims, so the prompt's whole job is to make the model SELECT
// and REPHRASE without ever ADDING a claim. The conservative bias + the user's per-line approval are
// the faithfulness backstops behind the structural cited-check / banned-word validation in
// validateResume. Voice conditioning is deferred (M6) — plain professional tone here.
const SYSTEM_PROMPT = `You rewrite a candidate's VERIFIED career FACTS into tailored résumé bullet lines for a specific job.

You are given JSON with:
- facts: each has an "id", a "type", and "content" (plus optional employer/role/date_start/date_end). These are the ONLY material you may use; every fact here has been verified by the candidate.
- coverage: requirements this résumé should target, each with the requirement "text", a "status" (met or partial), and the "fact_ids" that support it. Use this ONLY to decide what to EMPHASISE.

Produce a flat list of résumé bullet lines. For EACH line return:
- "text": one concise, professional résumé bullet.
- "fact_ids": the id(s) of the fact(s) this line is derived from. Cite ONLY ids that appear in the provided facts. Every line MUST cite at least one fact id.

Honesty rules — follow them strictly; this product exists so a résumé CANNOT lie:
- You may rephrase, condense, combine, and select facts. You may NOT introduce any claim — a number, metric, percentage, amount, team size, scope, job title, employer, date, or outcome — that is not already stated, verbatim or by clear paraphrase, in the cited facts. If a detail is not in the facts, it does not go in the line.
- A line may combine multiple facts only if it stays faithful to ALL of them and adds nothing beyond them.
- If a requirement cannot be supported by the facts, OMIT it. Do not invent support. An honest gap is correct; a fabricated or inflated line is a catastrophic failure of the product.
- Prefer fewer, well-supported lines over many thin ones. Do not pad.
- Write plainly. Do NOT use these words or phrases: ${BANNED_WORDS.join(", ")}. Avoid generic résumé clichés in general.`;

// One billed generation: verified facts + targeted coverage -> Sonnet (Structured Outputs) -> parse
// -> fail-closed validate (cited-check, banned words, UUID-shaped ids, caps). Returns the SAME shape
// as the pure validator; every failure mode is a closed `{ ok: false }`. Ownership/verification of
// the cited ids is NOT checked here — that is persistResume's job, against the user's real verified
// facts. Inputs are personal data and are never logged.
export async function generateResume(
  facts: GenFact[],
  coverage: GenCoverageEntry[],
): Promise<ResumeResult> {
  const user = JSON.stringify({ facts, coverage });

  const res = await runStructured({
    model: MODEL,
    maxTokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    user,
    schema: RESUME_SCHEMA,
  });
  if (!res.ok) return res;

  return validateResume(res.parsed);
}

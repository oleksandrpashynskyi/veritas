// Job-description -> structured requirements. The Anthropic key + SDK now live solely in ./client
// (runStructured); this module owns only the extraction PROMPT + schema + fail-closed validation, so
// it no longer reads the key or imports the SDK. It stays server-only because it pulls in ./client
// (which is `server-only`); shared code must import the pure vocabulary/validator from
// "@/lib/llm/extraction-schema" instead, never this file.
import { runStructured } from "./client";
import {
  EXTRACTION_SCHEMA,
  validateExtraction,
  type ExtractionResult,
} from "./extraction-schema";

// Decision locked (Alex): Haiku for structured extraction — cheap/fast. Non-streaming with a modest
// max_tokens stays well under the SDK HTTP-timeout threshold.
const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You extract structured hiring requirements from a pasted job description.

Identify:
- company: the hiring company's name (empty string "" if not stated — do NOT guess).
- title: the job title (empty string "" if not stated — do NOT guess).
- requirements: break the posting into atomic items and classify EACH into exactly one kind:
  - "must": a hard/required qualification ("required", "must have", a minimum number of years).
  - "nice": a preferred or bonus qualification ("nice to have", "preferred", "a plus").
  - "responsibility": something the person will DO in the role (a duty or day-to-day task).
  - "keyword": a specific technology, tool, certification, or skill term worth surfacing on its own.

Keep each requirement's text concise and faithful to the posting — one item each. Only output
content grounded in the provided description; never invent requirements, company, or title.`;

// One billed extraction: paste -> Haiku (Structured Outputs) -> parse -> fail-closed validate.
// Returns the SAME ExtractionResult shape as the pure validator. Never throws to the caller and
// never re-calls the API — every failure mode (request error, refusal, non-JSON, off-shape) is a
// closed `{ ok: false }`. The job description is the user's personal data: it is never logged.
export async function extractRequirements(
  rawText: string,
): Promise<ExtractionResult> {
  const text = rawText.trim();
  if (!text) return { ok: false, error: "Job description is empty." };

  const res = await runStructured({
    model: MODEL,
    maxTokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    user: text,
    schema: EXTRACTION_SCHEMA,
  });
  if (!res.ok) return res;

  // Trust the parse, not the prose: re-validate the model's structure fail-closed before returning.
  return validateExtraction(res.parsed);
}

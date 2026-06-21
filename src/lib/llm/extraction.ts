// SERVER-ONLY. The `server-only` import makes importing this module from a Client Component a
// `next build` error — the first line of defence keeping ANTHROPIC_API_KEY out of the browser
// bundle (the same guard src/lib/db/client.ts uses for the service-role key). This is the ONLY
// file that reads the key or imports the Anthropic SDK. Client/shared code must import the pure
// vocabulary + validator from "@/lib/llm/extraction-schema" instead, never this file.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  EXTRACTION_SCHEMA,
  validateExtraction,
  type ExtractionResult,
} from "./extraction-schema";

// Decision locked (Alex): Haiku for structured extraction — cheap/fast. NO `effort` and NO
// `thinking` (effort errors on Haiku 4.5; extraction needs neither). Non-streaming with a modest
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

// Lazy, cached client (mirrors getDb): construction reads the key, so importing this module during
// `next build` does not require the env var, and a missing key surfaces at the call site.
let cached: Anthropic | undefined;
function getClient(): Anthropic {
  if (!cached) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("Missing ANTHROPIC_API_KEY — see .env.example");
    }
    // maxRetries: 0 — exactly ONE HTTP request per Extract, enforcing the "one billed call per
    // paste, no loops, no silent re-extraction" invariant literally. A transient failure fails
    // closed; the user re-clicks Extract (an explicit new paste) rather than us looping.
    cached = new Anthropic({ apiKey, maxRetries: 0 });
  }
  return cached;
}

// One billed extraction: paste -> Haiku (Structured Outputs) -> parse -> fail-closed validate.
// Returns the SAME ExtractionResult shape as the pure validator. Never throws to the caller and
// never re-calls the API — every failure mode (request error, refusal, non-JSON, off-shape) is a
// closed `{ ok: false }`. The job description is the user's personal data: it is never logged.
export async function extractRequirements(
  rawText: string,
): Promise<ExtractionResult> {
  const text = rawText.trim();
  if (!text) return { ok: false, error: "Job description is empty." };

  let message;
  try {
    message = await getClient().messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text }],
      output_config: {
        format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
      },
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Extraction request failed.",
    };
  }

  // Safety classifiers can decline (HTTP 200, stop_reason "refusal") — fail closed.
  if (message.stop_reason === "refusal") {
    return { ok: false, error: "The model declined to process this input." };
  }

  const block = message.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") {
    return { ok: false, error: "No structured output was returned." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(block.text);
  } catch {
    // Truncation (stop_reason "max_tokens") or any non-JSON lands here — fail closed.
    return { ok: false, error: "Model output was not valid JSON." };
  }

  // Trust the parse, not the prose: re-validate the model's structure fail-closed before returning.
  return validateExtraction(parsed);
}

// SERVER-ONLY. The `server-only` import makes importing this module from a Client Component a
// `next build` error — the first line of defence keeping ANTHROPIC_API_KEY out of the browser bundle
// (the same guard src/lib/db/client.ts uses for the service-role key). This is the ONLY file that
// reads the key or imports the Anthropic SDK; extraction.ts and matching.ts call runStructured here
// rather than touching the key/SDK themselves. The verify-m*/key-containment guard's sanctioned file
// is THIS module. Client/shared code must import the pure validators from the *-schema modules.
import "server-only";
import Anthropic from "@anthropic-ai/sdk";

export type StructuredResult =
  | { ok: true; parsed: unknown }
  | { ok: false; error: string };

// Lazy, cached client (mirrors getDb): construction reads the key, so importing this module during
// `next build` does not require the env var, and a missing key surfaces at the call site.
let cached: Anthropic | undefined;
function getClient(): Anthropic {
  if (!cached) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("Missing ANTHROPIC_API_KEY — see .env.example");
    }
    // maxRetries: 0 — exactly ONE HTTP request per call, enforcing the "one billed call per user
    // action, no loops, no silent re-tries" invariant literally. A transient failure fails closed;
    // the user re-triggers an explicit new action rather than us looping.
    cached = new Anthropic({ apiKey, maxRetries: 0 });
  }
  return cached;
}

// One billed Structured-Outputs call: system + user + json_schema -> parse. Returns the parsed (but
// NOT yet domain-validated) value, or a closed `{ ok: false }` for EVERY failure mode — request
// error, refusal, no text block, non-JSON. Never throws to the caller and never re-calls the API.
// Each caller runs its own pure validator on `parsed` ("trust the parse, not the prose"). The user's
// input (job text, facts) is personal data: it is never logged here.
export async function runStructured(args: {
  model: string;
  maxTokens: number;
  system: string;
  user: string;
  schema: Record<string, unknown>;
}): Promise<StructuredResult> {
  let message;
  try {
    message = await getClient().messages.create({
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.system,
      messages: [{ role: "user", content: args.user }],
      output_config: {
        format: { type: "json_schema", schema: args.schema },
      },
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Structured request failed.",
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

  try {
    return { ok: true, parsed: JSON.parse(block.text) };
  } catch {
    // Truncation (stop_reason "max_tokens") or any non-JSON lands here — fail closed.
    return { ok: false, error: "Model output was not valid JSON." };
  }
}

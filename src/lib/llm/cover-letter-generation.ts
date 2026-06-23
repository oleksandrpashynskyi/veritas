// Verified facts x targeted requirements x the user's writing voice -> a tailored cover letter. The
// Anthropic key + SDK live solely in ./client (runStructured); this module owns only the generation
// PROMPT + schema + fail-closed validation. It is server-only by transitivity (./client imports
// "server-only"); shared code must import the pure validator/types from "@/lib/llm/cover-letter-schema"
// instead, never this file. Mirrors generation.ts (the résumé generator).
import { runStructured } from "./client";
import { HARD_BLOCKED_WORDS } from "../provenance/banned";
import {
  ALLOWED_CONNECTIVE_ROLES,
  COVER_LETTER_SCHEMA,
  validateCoverLetter,
} from "./cover-letter-schema";
import type { GenCoverageEntry, GenFact } from "./generation";
import type { DocValidated } from "../provenance/document";

// Decision locked (Alex): Sonnet — generation + voice is the highest-stakes seat (the deliverable
// itself + its faithfulness), same as M5. ONE billed call; client.ts pins maxRetries:0, so a transient
// failure fails closed and the user re-triggers an explicit new action.
const MODEL = "claude-sonnet-4-6";
// Headroom for a full letter with citations; a truncated response is non-JSON and fails closed, so we
// give enough room to avoid spurious truncation of the product (the validator caps the real size).
const MAX_TOKENS = 8192;

// VOICE = STYLE ONLY (Alex). A writing sample conditions tone/cadence; it NEVER licenses a claim. The
// samples are passed as TEXT WITHOUT ids — so the model has nothing to cite from them, and the citable
// `facts` remain the only sourcing material. No writing samples -> a neutral professional voice.
export type VoiceSample = { content: string };

const SYSTEM_PROMPT = `You write a tailored COVER LETTER for a specific job, in the candidate's own writing voice, from their VERIFIED career FACTS. This product exists so a cover letter CANNOT lie: every experiential claim must be sourced to a verified fact.

You are given JSON with:
- facts: each has an "id", a "type", and "content" (plus optional employer/role/date_start/date_end). These are the ONLY material you may cite; every fact here has been verified by the candidate.
- coverage: requirements this letter should target, each with the requirement "text", a "status" (met or partial), and the "fact_ids" that support it. Use this ONLY to decide what to EMPHASISE.
- writing_samples: examples of the candidate's own writing. Use them ONLY to match TONE and CADENCE. They are NOT facts: do not cite them, do not treat their content as something the candidate has done, and do not import any claim from them. If writing_samples is empty, write in a neutral, professional voice.

Produce a flat, ordered list of "blocks" that read top-to-bottom as a letter. Each block is exactly one of:
- A CLAIM block: { "kind": "claim", "text": <one sentence asserting something the candidate has done/built/led/knows>, "fact_ids": [<ids of the verified fact(s) it is derived from>], "role": "" }. Every claim block MUST cite at least one fact id, and cite ONLY ids that appear in the provided facts.
- A CONNECTIVE block: { "kind": "connective", "text": <framing prose>, "fact_ids": [], "role": <one of: ${ALLOWED_CONNECTIVE_ROLES.join(", ")}> }. Connective is the framing a letter needs — the greeting, the statement of interest, why the role/mission fits, a paragraph's topic sentence, the closing courtesy, the sign-off. A connective block asserts NO fact about the candidate's experience and carries NO citation.

THE CRITICAL RULE — an experiential claim may NEVER hide inside connective prose. If a sentence states anything the candidate has done, built, shipped, led, or knows, it is a CLAIM block and must cite a fact — even when it is dressed as enthusiasm or fit. Example of the trap: "Your mission resonates with me, having shipped three production ML systems." The tail "having shipped three production ML systems" is an experiential claim: either make it its own cited claim block, or remove it. Connective may say the mission resonates; it may NOT say what the candidate has shipped.

Honesty rules for CLAIM blocks — follow them strictly:
- REPHRASE ONLY WHAT THE FACT STATES. You may shorten, reword, and select. You may NOT add any action, responsibility, role, seniority, scope, collaboration, coordination, leadership, motivation, outcome, metric, number, or qualifier that the fact does not explicitly state.
- Use a number, metric, percentage, amount, team size, job title, or employer ONLY if the cited fact provides it. Mention a date or timeframe ONLY when the fact supplies date_start/date_end; never invent or infer a timeframe.
- A claim may combine multiple facts only if it stays faithful to ALL of them and adds nothing beyond them.
- If a requirement cannot be supported by the facts, OMIT it. An honest gap is correct; a fabricated or inflated line is a catastrophic failure of the product.

General:
- Prefer a short, genuine letter over a padded one. A natural shape: greeting; a sentence of interest/fit; a few cited claims that address the role; a brief closing; a sign-off.
- Write plainly and in the candidate's voice. Do NOT use these words or phrases anywhere (claim or connective): ${HARD_BLOCKED_WORDS.join(", ")}. Avoid generic cover-letter clichés in general.`;

// One billed generation: verified citable facts + targeted coverage + writing samples -> Sonnet
// (Structured Outputs) -> parse -> fail-closed validate (the cited-check on claims, the connective
// structural rule, banned words, caps). Returns the SAME split shape the gate consumes; every failure
// mode is a closed `{ ok: false }`. Ownership/verification of the cited ids is NOT checked here — that
// is persistCoverLetter's job, against the user's real verified facts. Inputs are personal data and
// are never logged.
export async function generateCoverLetter(
  facts: GenFact[],
  coverage: GenCoverageEntry[],
  writingSamples: VoiceSample[],
): Promise<DocValidated> {
  const user = JSON.stringify({
    facts,
    coverage,
    writing_samples: writingSamples.map((s) => s.content),
  });

  const res = await runStructured({
    model: MODEL,
    maxTokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    user,
    schema: COVER_LETTER_SCHEMA,
  });
  if (!res.ok) return res;

  return validateCoverLetter(res.parsed);
}

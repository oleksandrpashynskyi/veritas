// The provenance layer is the heart of Veritas (AGENTS.md: "Touch with reverence").
//
// The core invariant — every doc_line must cite >=1 valid fact, and generated text
// must contain no banned words — is enforced HERE, structurally, not by asking the
// model nicely. Citation enforcement (verify each line cites real, supporting facts;
// reject uncited or banned-word content with reasons) lands in M5.
//
// The banned-words half is split into a fatal hard-block tier and an advisory warn tier (M5 / Codex
// FIX 4): findBannedWords reports the hard-blocked fluff that fails validation; findWarnWords reports
// ambiguous technical words that must never reject a truthful, sourced line.
export {
  HARD_BLOCKED_WORDS,
  WARN_WORDS,
  findBannedWords,
  findWarnWords,
} from "./banned";

// The provenance layer is the heart of Veritas (AGENTS.md: "Touch with reverence").
//
// The core invariant — every doc_line must cite >=1 valid fact, and generated text
// must contain no banned words — is enforced HERE, structurally, not by asking the
// model nicely. Citation enforcement (verify each line cites real, supporting facts;
// reject uncited or banned-word content with reasons) lands in M5.
//
// For M1, only the banned-words half exists.
export { BANNED_WORDS, findBannedWords } from "./banned";

// Server-side LLM entrypoint. Importing this barrel (or ./extraction, ./matching, ./client) from a
// Client Component is a `next build` error — ./client imports "server-only". Client/shared code must
// import the pure vocabulary, types, and validators from "@/lib/llm/extraction-schema" /
// "@/lib/llm/coverage-schema" directly, never from here.
export { extractRequirements } from "./extraction";
export { matchCoverage } from "./matching";

// Server-side LLM entrypoint. Importing this barrel (or ./extraction) from a Client Component is a
// `next build` error — ./extraction imports "server-only". Client/shared code must import the pure
// vocabulary, types, and validator from "@/lib/llm/extraction-schema" directly, never from here.
export { extractRequirements } from "./extraction";

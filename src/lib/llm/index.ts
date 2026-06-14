// Anthropic API calls (structured extraction & generation) live here.
//
// Every generation step must use Anthropic structured outputs and return fact-ID
// citations alongside its text (AGENTS.md). Note: app-runtime calls are API-billed,
// so generation steps stay few and cached (PROJECT_PLAN §4). First real use is M3
// (job-requirement extraction); generation with enforced citations arrives in M5.
export {};

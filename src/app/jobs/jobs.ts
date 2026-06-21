// Shared job/requirement vocabulary for the /jobs UI + server actions (mirrors facts.ts).
// The canonical requirement kinds live in the LLM module — the validator/schema source of truth —
// so the UI re-exports them here rather than redefining the enum.
import { REQUIREMENT_KINDS, type RequirementKind } from "@/lib/llm/extraction-schema";

export { REQUIREMENT_KINDS, type RequirementKind };

export const KIND_LABELS: Record<RequirementKind, string> = {
  must: "Must-have",
  nice: "Nice-to-have",
  responsibility: "Responsibilities",
  keyword: "Keywords",
};

// A job as surfaced to the per-user (RLS-scoped) list. `owner` is never sent to the client — RLS
// already scopes every selected row to the signed-in user. `raw_text` is shown only on the detail
// page, not in the list.
export type JobRow = {
  id: string;
  company: string | null;
  title: string | null;
  created_at: string;
};

export type RequirementRow = {
  id: string;
  text: string;
  kind: RequirementKind;
};

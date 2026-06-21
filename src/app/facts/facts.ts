// Shared fact vocabulary for the master-profile UI + server actions.
// Mirrors the fact_type enum + fact columns in supabase/migrations/..._init_veritas_schema.sql.

export const FACT_TYPES = [
  "experience",
  "achievement",
  "skill",
  "education",
  "writing_sample",
] as const;

export type FactType = (typeof FACT_TYPES)[number];

// A fact as surfaced to the per-user (RLS-scoped) master-profile UI. `metrics_json` is omitted
// from this cut's UI (column left null); `owner` is never sent to the client — RLS already scopes
// every selected row to the signed-in user.
export type FactRow = {
  id: string;
  type: FactType;
  content: string;
  employer: string | null;
  role: string | null;
  date_start: string | null;
  date_end: string | null;
  verified: boolean;
  created_at: string;
};

// Pure view logic for the coverage map — split out of coverage-view.tsx so it is unit-testable
// (coverage-view-logic.test.ts) WITHOUT a DOM or the `@/` alias: every import here is `import type`
// (erased at runtime), so the module has no runtime dependencies. The honest-display rules live
// here so the live preview (coverage-compute.tsx) and the stored map (page.tsx) can never drift.
import type { RequirementKind } from "@/lib/llm/extraction-schema";
import type { CoverageEntry, CoverageStatus } from "@/lib/llm/coverage-schema";
import type { FactType } from "../../facts/facts";

export type ViewRequirement = { id: string; text: string; kind: RequirementKind };
export type ViewFact = {
  id: string;
  type: FactType;
  content: string;
  employer: string | null;
  role: string | null;
  verified: boolean;
};
export type CoverageRow = {
  requirement: ViewRequirement;
  status: CoverageStatus;
  evidence: ViewFact[];
};

// Build one row PER requirement (in the given requirement order), resolving each requirement's
// assessment + cited evidence by id. A requirement the matcher omitted defaults to unmet — the same
// honest default reconcileCitations applies at save time, so the preview matches what gets stored.
export function buildCoverageRows(
  entries: CoverageEntry[],
  requirements: ViewRequirement[],
  facts: ViewFact[],
): CoverageRow[] {
  const factById = new Map(facts.map((f) => [f.id, f]));
  const entryByReq = new Map(entries.map((e) => [e.requirement_id, e]));
  return requirements.map((requirement) => {
    const entry = entryByReq.get(requirement.id);
    const status: CoverageStatus = entry?.status ?? "unmet";
    const evidence = (entry?.fact_ids ?? [])
      .map((id) => factById.get(id))
      .filter((f): f is ViewFact => Boolean(f));
    return { requirement, status, evidence };
  });
}

// A met/partial is PROVISIONAL if ANY cited fact is unverified: the model cites a JOINT set of facts
// to support the requirement, so a single unconfirmed fact means we cannot assert the full claim is
// confirmed. Only a met/partial whose evidence is ENTIRELY verified reads as solid. (unmet is never
// provisional — it makes no claim.)
export function isProvisional(row: CoverageRow): boolean {
  return (
    (row.status === "met" || row.status === "partial") &&
    row.evidence.length > 0 &&
    row.evidence.some((f) => !f.verified)
  );
}

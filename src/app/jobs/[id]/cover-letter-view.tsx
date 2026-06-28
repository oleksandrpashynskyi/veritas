// Presentational cover-letter view — shared by the live preview (cover-letter-compute.tsx, client) and
// the stored letter (page.tsx, server). No "use client", no hooks, so it renders in either
// environment. The PURE logic (buildCoverLetterRows / view types) lives in ./cover-letter-view-logic so
// it is unit-testable without a DOM; this file is the JSX shell. Mirrors resume-view.tsx.
//
// Each CLAIM row shows the verified facts it is sourced from (the provenance made visible, via the same
// Evidence component as the résumé). Each CONNECTIVE row is framing that asserts nothing — shown with a
// subtle role label and NO fact badges, so a reader can always tell a sourced claim from framing.
import {
  buildCoverLetterRows,
  type ClaimRowInput,
  type ConnectiveRowInput,
  type CoverLetterRow,
} from "./cover-letter-view-logic";
import { Evidence } from "./resume-view";
import { CoverLetterDeleteButton } from "./cover-letter-delete-button";

// Re-export the pure logic + types so consumers keep importing from "./cover-letter-view".
export { buildCoverLetterRows };
export type { ClaimRowInput, ConnectiveRowInput, CoverLetterRow };

// One row's body, WITHOUT any accept checkbox — shared by the preview and the stored view so they can
// never drift. A claim shows its text + cited evidence; a connective shows a role label + its text.
export function CoverLetterRowBody({ row }: { row: CoverLetterRow }) {
  if (row.kind === "connective") {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          {row.role.replace(/_/g, " ")} · framing
        </span>
        <p className="text-sm text-zinc-700">{row.text}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">{row.text}</p>
      <Evidence facts={row.evidence} />
    </div>
  );
}

export function CoverLetterView({
  jobId,
  rows,
}: {
  jobId: string;
  rows: CoverLetterRow[];
}) {
  const claimCount = rows.filter((r) => r.kind === "claim").length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-500">
          {claimCount} cited {claimCount === 1 ? "claim" : "claims"} woven with framing — every claim
          sourced from a verified fact.
        </p>
        <div className="flex items-center gap-2">
          {/* On-demand PDF of exactly this approved letter (same shared resolution as this view). */}
          <a
            href={`/jobs/${jobId}/export/cover-letter`}
            download
            className="rounded border border-zinc-300 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-50"
          >
            Download PDF
          </a>
          <CoverLetterDeleteButton jobId={jobId} />
        </div>
      </div>
      <div className="flex flex-col gap-3 rounded border border-zinc-200 px-4 py-3">
        {rows.map((row, i) => (
          <div
            key={i}
            className={row.kind === "claim" ? "border-l-2 border-zinc-200 pl-3" : ""}
          >
            <CoverLetterRowBody row={row} />
          </div>
        ))}
      </div>
    </div>
  );
}

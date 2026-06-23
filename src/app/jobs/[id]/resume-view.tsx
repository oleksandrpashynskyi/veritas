// Presentational résumé view — shared by the live preview (resume-compute.tsx, client) and the stored
// résumé (page.tsx, server). No "use client", no hooks, so it renders in either environment. The PURE
// logic (buildResumeRows / view types) lives in ./resume-view-logic so it is unit-testable without a
// DOM; this file is the JSX shell. Every line shows the verified facts it is sourced from — the
// provenance made visible.
import {
  buildResumeRows,
  type CitedFact,
  type ResumeLineView,
} from "./resume-view-logic";
import { ResumeDeleteButton } from "./resume-delete-button";

// Re-export the pure logic so consumers keep importing from "./resume-view".
export { buildResumeRows };
export type { CitedFact, ResumeLineView };

// The cited evidence beneath a line: the source fact's content + a verified badge. Every cited fact
// is verified by construction; the badge reads honestly from the data rather than asserting it.
export function Evidence({ facts }: { facts: CitedFact[] }) {
  if (facts.length === 0) {
    // The cited-check + persistResume guarantee a stored/previewed line cites ≥1 resolvable fact.
    return <p className="text-xs text-red-600">No cited evidence.</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {facts.map((f) => (
        <li
          key={f.id}
          className="flex items-start justify-between gap-2 rounded bg-zinc-50 px-2 py-1 text-xs text-zinc-600"
        >
          <span className="whitespace-pre-wrap">{f.content}</span>
          {f.verified ? (
            <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-green-700">
              verified
            </span>
          ) : (
            <span className="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 text-zinc-500">
              unverified
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ResumeView({ jobId, rows }: { jobId: string; rows: ResumeLineView[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-500">
          {rows.length} approved {rows.length === 1 ? "line" : "lines"} — every one sourced from a verified fact.
        </p>
        <ResumeDeleteButton jobId={jobId} />
      </div>
      <ul className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <li
            key={i}
            className="flex flex-col gap-2 rounded border border-zinc-200 px-3 py-2"
          >
            <p className="text-sm">{row.text}</p>
            <Evidence facts={row.evidence} />
          </li>
        ))}
      </ul>
    </div>
  );
}

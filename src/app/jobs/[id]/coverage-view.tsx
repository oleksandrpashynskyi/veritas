// Presentational coverage map — shared by the live preview (coverage-compute.tsx, client) and the
// stored map (page.tsx, server). No "use client", no hooks, so it renders in either environment. The
// PURE logic (buildCoverageRows / isProvisional / view types) lives in ./coverage-view-logic so it
// is unit-testable without a DOM; this file is the JSX shell. Honest-display rules:
//   - every requirement is shown, in order, with its status — gaps (unmet) are never hidden.
//   - status-level confirmation (Q1): a met/partial with ANY unverified cited fact reads as
//     "provisional" (amber, dashed), visually distinct from a fully-verified met (green/solid).
import type { CoverageStatus } from "@/lib/llm/coverage-schema";
import { KIND_LABELS } from "../jobs";
import {
  buildCoverageRows,
  isProvisional,
  type CoverageRow,
  type ViewFact,
  type ViewRequirement,
} from "./coverage-view-logic";

// Re-export the pure logic so consumers keep importing from "./coverage-view".
export { buildCoverageRows };
export type { CoverageRow, ViewFact, ViewRequirement };

const STATUS_SOLID: Record<CoverageStatus, string> = {
  met: "bg-green-100 text-green-700",
  partial: "bg-amber-100 text-amber-800",
  unmet: "bg-zinc-100 text-zinc-600",
};

export function CoverageMap({ rows }: { rows: CoverageRow[] }) {
  const counts = { met: 0, partial: 0, unmet: 0 } as Record<CoverageStatus, number>;
  for (const r of rows) counts[r.status]++;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-zinc-500">
        {counts.met} met · {counts.partial} partial · {counts.unmet} unmet
      </p>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const provisional = isProvisional(row);
          const badgeClass = provisional
            ? "border border-dashed border-amber-400 bg-amber-50 text-amber-700"
            : STATUS_SOLID[row.status];
          return (
            <li
              key={row.requirement.id}
              className="flex flex-col gap-2 rounded border border-zinc-200 px-3 py-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm">{row.requirement.text}</p>
                  <span className="text-xs uppercase tracking-wide text-zinc-400">
                    {KIND_LABELS[row.requirement.kind]}
                  </span>
                </div>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${badgeClass}`}
                >
                  {row.status}
                  {provisional ? " · provisional" : ""}
                </span>
              </div>

              {provisional && (
                <p className="text-xs text-amber-700">
                  Evidence not yet confirmed — verify the cited facts to make this solid.
                </p>
              )}

              {row.evidence.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {row.evidence.map((f) => (
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
              ) : (
                <p className="text-xs text-zinc-500">No supporting evidence yet.</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

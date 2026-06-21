"use client";

import { useActionState } from "react";
import {
  computeCoverage,
  saveCoverage,
  type CoverageComputeState,
} from "./coverage-actions";
import { buildCoverageRows, CoverageMap } from "./coverage-view";

// Compute (one billed match) -> review the met/partial/unmet map -> Save on confirm. Nothing is
// stored until Save. The preview carries the validated coverage in a hidden JSON field that
// persistCoverage RE-validates and provenance-checks before storing.
const INITIAL: CoverageComputeState = { status: "idle" };

export function CoverageCompute({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(computeCoverage, INITIAL);

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="job_id" value={jobId} />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {pending ? "Computing…" : "Compute coverage"}
        </button>
        <p className="text-xs text-zinc-500">
          Runs one AI matching pass over your profile facts. Classification is conservative —
          ambiguous evidence is partial or unmet, never an inflated met.
        </p>
      </form>

      {state.status === "error" && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      {state.status === "ready" && (
        <div className="flex flex-col gap-4 rounded border border-zinc-200 p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">Review coverage before saving</h2>
            <p className="text-sm text-zinc-500">
              Unmet requirements are shown plainly — nothing is hidden, nothing is inflated.
            </p>
          </div>

          <CoverageMap
            rows={buildCoverageRows(
              state.coverage.coverage,
              state.requirements,
              state.facts,
            )}
          />

          <form action={saveCoverage}>
            <input type="hidden" name="job_id" value={state.jobId} />
            <input
              type="hidden"
              name="coverage"
              value={JSON.stringify(state.coverage)}
            />
            <button
              type="submit"
              className="self-start rounded bg-zinc-900 px-4 py-2 text-white"
            >
              Save coverage
            </button>
          </form>
          <p className="text-xs text-zinc-500">
            To redo, click Compute coverage again.
          </p>
        </div>
      )}
    </div>
  );
}

"use client";

import { useActionState, useState } from "react";
import {
  generateCoverLetterAction,
  saveCoverLetterAction,
  type CoverLetterGenerateState,
} from "./cover-letter-actions";
import {
  buildCoverLetterRows,
  CoverLetterRowBody,
  type CoverLetterRow,
} from "./cover-letter-view";

// Generate (one billed Sonnet call) -> approve block-by-block -> Save the approved subset. Nothing is
// stored until Save. The Save form carries the accepted blocks in a hidden JSON field that
// persistCoverLetter RE-validates and provenance-checks (verified+owned on claims) before storing. The
// approval checkboxes ARE the faithfulness gate — only ticked blocks are sent, and the experiential
// advisory points the eye at any connective that may be smuggling a claim. Mirrors resume-compute.tsx.
const INITIAL: CoverLetterGenerateState = { status: "idle" };

// Reconstruct a submittable block from a rendered row (claims drop role; connective drops citations).
// validateCoverLetter re-derives positions from the submitted order, so a rejected block simply leaves
// the remaining order intact.
function rowToBlock(row: CoverLetterRow) {
  if (row.kind === "claim") {
    return { kind: "claim", text: row.text, fact_ids: row.fact_ids, role: "" };
  }
  return { kind: "connective", text: row.text, role: row.role, fact_ids: [] };
}

export function CoverLetterGenerate({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(generateCoverLetterAction, INITIAL);
  // One accept flag per previewed block, reset to all-accepted whenever a NEW result arrives (the same
  // render-time "adjust state when a value changes" pattern resume-compute.tsx documents).
  const [accepted, setAccepted] = useState<boolean[]>([]);
  const [trackedState, setTrackedState] = useState(state);

  const claimLines = state.status === "ready" ? state.claimLines : [];
  const connective = state.status === "ready" ? state.connective : [];
  const facts = state.status === "ready" ? state.facts : [];
  const rows = buildCoverLetterRows(claimLines, connective, facts);

  if (state !== trackedState) {
    setTrackedState(state);
    setAccepted(rows.map(() => true));
  }

  const isAccepted = (i: number) => accepted[i] ?? true;
  const acceptedBlocks = rows.filter((_, i) => isAccepted(i)).map(rowToBlock);
  // A cover letter must keep at least one CITED claim (the gate refuses an all-framing document).
  const acceptedClaimCount = rows.filter(
    (r, i) => isAccepted(i) && r.kind === "claim",
  ).length;

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="job_id" value={jobId} />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {pending ? "Generating…" : "Generate cover letter"}
        </button>
        <p className="text-xs text-zinc-500">
          One AI pass writes a letter in your voice. Every claim about your experience cites the
          verified facts it draws from; the framing around it adds nothing you didn&apos;t already say.
        </p>
      </form>

      {state.status === "error" && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      {state.status === "blocked" && (
        <p className="text-sm text-amber-700">{state.reason}</p>
      )}

      {state.status === "ready" && (
        <div className="flex flex-col gap-4 rounded border border-zinc-200 p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">Approve each line before saving</h2>
            <p className="text-sm text-zinc-500">
              Keep the lines that read true; uncheck any you don&apos;t want. Only approved lines are
              saved — and every claim stays sourced to its verified facts.
            </p>
            {state.voiceNote && (
              <p className="text-xs text-amber-700">{state.voiceNote}</p>
            )}
          </div>

          <ul className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <li
                key={i}
                className={`flex flex-col gap-2 rounded border px-3 py-2 ${
                  isAccepted(i) ? "border-zinc-200" : "border-zinc-100 bg-zinc-50 opacity-60"
                }`}
              >
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={isAccepted(i)}
                    onChange={(e) =>
                      setAccepted((prev) => {
                        const next = rows.map((_, j) => prev[j] ?? true);
                        next[i] = e.target.checked;
                        return next;
                      })
                    }
                    className="mt-1"
                  />
                  <div className="flex flex-1 flex-col gap-1">
                    <CoverLetterRowBody row={row} />
                    {row.kind === "connective" && row.warn.length > 0 && (
                      <p className="text-xs text-amber-700">
                        This framing may state experience ({row.warn.join(", ")}). Read it as
                        interest/fit only — if it says what you&apos;ve done, uncheck it and let a
                        cited claim carry that instead.
                      </p>
                    )}
                  </div>
                </label>
              </li>
            ))}
          </ul>

          <form action={saveCoverLetterAction}>
            <input type="hidden" name="job_id" value={state.jobId} />
            <input
              type="hidden"
              name="blocks"
              value={JSON.stringify({ blocks: acceptedBlocks })}
            />
            <button
              type="submit"
              disabled={acceptedClaimCount === 0}
              className="self-start rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-50"
            >
              Save cover letter ({acceptedBlocks.length}{" "}
              {acceptedBlocks.length === 1 ? "line" : "lines"})
            </button>
            {acceptedClaimCount === 0 && (
              <p className="mt-1 text-xs text-amber-700">
                Keep at least one cited claim — a letter can&apos;t be only framing.
              </p>
            )}
          </form>
          <p className="text-xs text-zinc-500">To redo, click Generate cover letter again.</p>
        </div>
      )}
    </div>
  );
}

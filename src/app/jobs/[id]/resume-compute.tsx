"use client";

import { useActionState, useState } from "react";
import {
  generateResumeAction,
  saveResumeAction,
  type ResumeGenerateState,
} from "./resume-actions";
import { buildResumeRows, Evidence } from "./resume-view";

// Generate (one billed Sonnet call) -> approve line-by-line -> Save the approved subset. Nothing is
// stored until Save. The Save form carries the accepted lines in a hidden JSON field that
// persistResume RE-validates and provenance-checks (verified+owned) before storing. The approval
// checkboxes ARE the faithfulness gate — only ticked lines are sent.
const INITIAL: ResumeGenerateState = { status: "idle" };

export function ResumeGenerate({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(generateResumeAction, INITIAL);
  // One accept flag per previewed line, reset to all-accepted whenever a NEW result arrives. This is
  // React's documented render-time "adjust state when a value changes" pattern, not an effect:
  // `state` from useActionState keeps a stable identity until the next action result, so a checkbox
  // toggle (which does not change `state`) preserves the user's choices while a fresh generation
  // resets them. (https://react.dev/learn/you-might-not-need-an-effect)
  const [accepted, setAccepted] = useState<boolean[]>([]);
  const [trackedState, setTrackedState] = useState(state);
  if (state !== trackedState) {
    setTrackedState(state);
    setAccepted(state.status === "ready" ? state.lines.map(() => true) : []);
  }

  const lines = state.status === "ready" ? state.lines : [];
  const facts = state.status === "ready" ? state.facts : [];
  const rows = buildResumeRows(lines, facts);
  const isAccepted = (i: number) => accepted[i] ?? true; // default-accepted before the effect runs
  const acceptedLines = lines.filter((_, i) => isAccepted(i));

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="job_id" value={jobId} />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {pending ? "Generating…" : "Generate résumé"}
        </button>
        <p className="text-xs text-zinc-500">
          One AI pass rewrites only your verified facts into tailored lines, each citing the facts it
          draws from. Nothing is added that your facts don&apos;t already say.
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
              saved — and every saved line stays sourced to its verified facts.
            </p>
          </div>

          <ul className="flex flex-col gap-2">
            {rows.map((row, i) => (
              <li
                key={i}
                className={`flex flex-col gap-2 rounded border px-3 py-2 ${
                  isAccepted(i) ? "border-zinc-200" : "border-zinc-100 bg-zinc-50 opacity-60"
                }`}
              >
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={isAccepted(i)}
                    onChange={(e) =>
                      setAccepted((prev) => {
                        const next = lines.map((_, j) => prev[j] ?? true);
                        next[i] = e.target.checked;
                        return next;
                      })
                    }
                    className="mt-1"
                  />
                  <span>{row.text}</span>
                </label>
                <Evidence facts={row.evidence} />
              </li>
            ))}
          </ul>

          <form action={saveResumeAction}>
            <input type="hidden" name="job_id" value={state.jobId} />
            <input
              type="hidden"
              name="lines"
              value={JSON.stringify({ lines: acceptedLines })}
            />
            <button
              type="submit"
              disabled={acceptedLines.length === 0}
              className="self-start rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-50"
            >
              Save résumé ({acceptedLines.length} {acceptedLines.length === 1 ? "line" : "lines"})
            </button>
          </form>
          <p className="text-xs text-zinc-500">To redo, click Generate résumé again.</p>
        </div>
      )}
    </div>
  );
}

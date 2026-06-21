"use client";

import { useActionState, useState } from "react";
import { extractJob, saveJob, type ExtractState } from "./actions";
import { REQUIREMENT_KINDS, KIND_LABELS } from "./jobs";

// Paste -> Extract (one billed call) -> review preview -> Save on confirm. Nothing is stored until
// Save. The textarea is CONTROLLED so its content survives the action (React 19 resets uncontrolled
// fields after a form action) — the user can tweak and re-extract. The preview carries the validated
// extraction in a hidden JSON field that saveJob RE-validates before storing.
const INITIAL: ExtractState = { status: "idle" };

export function JobIngest() {
  const [state, formAction, pending] = useActionState(extractJob, INITIAL);
  const [text, setText] = useState("");

  return (
    <div className="flex flex-col gap-4">
      <form action={formAction} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-600">Job description</span>
          <textarea
            name="raw_text"
            required
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste the full job posting here…"
            className="rounded border border-zinc-300 px-3 py-2 font-mono text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={pending || text.trim() === ""}
          className="self-start rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {pending ? "Extracting…" : "Extract requirements"}
        </button>
      </form>

      {state.status === "error" && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      {state.status === "ready" && (
        <div className="flex flex-col gap-4 rounded border border-zinc-200 p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold">Review before saving</h2>
            <p className="text-sm text-zinc-500">
              {state.extraction.title ?? "Untitled role"}
              {" · "}
              {state.extraction.company ?? "Unknown company"}
            </p>
          </div>

          {state.extraction.requirements.length === 0 ? (
            <p className="text-sm text-zinc-500">
              No requirements were found. You can still save this job, or re-paste a fuller
              description and extract again.
            </p>
          ) : (
            REQUIREMENT_KINDS.map((kind) => {
              const group = state.extraction.requirements.filter((r) => r.kind === kind);
              if (group.length === 0) return null;
              return (
                <div key={kind} className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                    {KIND_LABELS[kind]} ({group.length})
                  </h3>
                  <ul className="flex flex-col gap-1">
                    {group.map((r, i) => (
                      <li
                        key={`${kind}-${i}`}
                        className="rounded border border-zinc-200 px-3 py-2 text-sm"
                      >
                        {r.text}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}

          <form action={saveJob}>
            <input
              type="hidden"
              name="extraction"
              value={JSON.stringify(state.extraction)}
            />
            <input type="hidden" name="raw_text" value={state.rawText} />
            <button
              type="submit"
              className="self-start rounded bg-zinc-900 px-4 py-2 text-white"
            >
              Save job
            </button>
          </form>
          <p className="text-xs text-zinc-500">
            To redo, edit the description above and click Extract again.
          </p>
        </div>
      )}
    </div>
  );
}

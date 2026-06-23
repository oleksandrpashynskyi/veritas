"use client";

import { deleteCoverLetterAction } from "./cover-letter-actions";

// Delete is destructive → confirm before the server action fires (mirrors the résumé delete button).
// The server action + RLS (document delete scoped via the parent job's owner) do the real delete; the
// FK cascade removes the letter's doc_lines (and the connective rides on the document row, so it goes
// too). Deleting then generating again is how v1 "regenerates".
export function CoverLetterDeleteButton({ jobId }: { jobId: string }) {
  return (
    <form
      action={deleteCoverLetterAction}
      onSubmit={(e) => {
        if (!confirm("Delete this cover letter? This cannot be undone.")) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="job_id" value={jobId} />
      <button
        type="submit"
        className="rounded border border-red-300 px-2 py-1 text-xs text-red-600"
      >
        Delete cover letter
      </button>
    </form>
  );
}

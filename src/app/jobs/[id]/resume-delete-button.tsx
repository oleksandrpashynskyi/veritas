"use client";

import { deleteResumeAction } from "./resume-actions";

// Delete is destructive → confirm before the server action fires (mirrors jobs/facts delete-button).
// The server action + RLS (document delete scoped via the parent job's owner) do the real delete; the
// FK cascade removes the résumé's doc_lines. Deleting then generating again is how v1 "regenerates".
export function ResumeDeleteButton({ jobId }: { jobId: string }) {
  return (
    <form
      action={deleteResumeAction}
      onSubmit={(e) => {
        if (!confirm("Delete this résumé? This cannot be undone.")) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="job_id" value={jobId} />
      <button
        type="submit"
        className="rounded border border-red-300 px-2 py-1 text-xs text-red-600"
      >
        Delete résumé
      </button>
    </form>
  );
}

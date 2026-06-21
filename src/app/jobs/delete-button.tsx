"use client";

import { deleteJob } from "./actions";

// Delete is destructive → confirm before the server action fires (mirrors facts/delete-button).
// The server action + RLS `USING (auth.uid() = owner)` do the real, owner-scoped delete; the FK
// cascade removes the job's requirements.
export function DeleteButton({ id }: { id: string }) {
  return (
    <form
      action={deleteJob}
      onSubmit={(e) => {
        if (!confirm("Delete this job and its requirements? This cannot be undone.")) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="rounded border border-red-300 px-2 py-1 text-xs text-red-600"
      >
        Delete
      </button>
    </form>
  );
}

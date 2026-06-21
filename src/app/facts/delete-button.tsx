"use client";

import { deleteFact } from "./actions";

// Delete is destructive → confirm before the server action fires. Client component (mirrors
// logout-button.tsx); the server action + RLS `USING (auth.uid() = owner)` do the real,
// owner-scoped delete.
export function DeleteButton({ id }: { id: string }) {
  return (
    <form
      action={deleteFact}
      onSubmit={(e) => {
        if (!confirm("Delete this fact? This cannot be undone.")) {
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

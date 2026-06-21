import { FACT_TYPES, type FactRow } from "./facts";

// Reusable fact form for BOTH create and edit. `action` is the server action to submit to; pass
// `fact` to pre-fill (edit mode). Server component, native form submission (no client JS) —
// matching the existing /facts conventions.
export function FactForm({
  action,
  fact,
}: {
  action: (formData: FormData) => void | Promise<void>;
  fact?: FactRow;
}) {
  const editing = fact != null;
  return (
    <form action={action} className="flex flex-col gap-3">
      {editing && <input type="hidden" name="id" defaultValue={fact.id} />}

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-600">Type</span>
        <select
          name="type"
          defaultValue={fact?.type ?? "experience"}
          className="rounded border border-zinc-300 px-3 py-2"
        >
          {FACT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t.replace("_", " ")}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-600">Content</span>
        <textarea
          name="content"
          required
          rows={3}
          defaultValue={fact?.content ?? ""}
          placeholder="A truthful, specific fact about your experience…"
          className="rounded border border-zinc-300 px-3 py-2"
        />
      </label>

      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-zinc-600">Employer (optional)</span>
          <input
            name="employer"
            defaultValue={fact?.employer ?? ""}
            className="rounded border border-zinc-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-zinc-600">Role (optional)</span>
          <input
            name="role"
            defaultValue={fact?.role ?? ""}
            className="rounded border border-zinc-300 px-3 py-2"
          />
        </label>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-zinc-600">Start date (optional)</span>
          <input
            type="date"
            name="date_start"
            defaultValue={fact?.date_start ?? ""}
            className="rounded border border-zinc-300 px-3 py-2"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-zinc-600">End date (optional)</span>
          <input
            type="date"
            name="date_end"
            defaultValue={fact?.date_end ?? ""}
            className="rounded border border-zinc-300 px-3 py-2"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm text-zinc-700">
        <input
          type="checkbox"
          name="verified"
          defaultChecked={fact?.verified ?? false}
        />
        Verified — I confirm this is true and accurate
      </label>

      <button
        type="submit"
        className="self-start rounded bg-zinc-900 px-4 py-2 text-white"
      >
        {editing ? "Save changes" : "Add fact"}
      </button>
    </form>
  );
}

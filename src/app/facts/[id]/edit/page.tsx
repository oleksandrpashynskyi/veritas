import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FactForm } from "../../fact-form";
import { updateFact } from "../../actions";
import type { FactRow } from "../../facts";

export default async function EditFactPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error: formError } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS scopes this to the signed-in user's own rows — a foreign or missing id returns nothing,
  // so we send the user back to /facts rather than leak existence.
  const { data } = await supabase
    .from("fact")
    .select(
      "id, type, content, employer, role, date_start, date_end, verified, created_at",
    )
    .eq("id", id)
    .single();
  if (!data) redirect("/facts");
  const fact = data as FactRow;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-8">
      <header className="flex items-center justify-between border-b border-zinc-200 pb-3">
        <h1 className="text-xl font-semibold">Edit fact</h1>
        <Link href="/facts" className="text-sm text-zinc-600 underline">
          Cancel
        </Link>
      </header>

      <FactForm action={updateFact} fact={fact} />
      {formError && (
        <p role="alert" className="text-sm text-red-600">
          {formError}
        </p>
      )}
    </main>
  );
}

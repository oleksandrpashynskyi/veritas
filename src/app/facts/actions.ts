"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Create one fact, via the per-user SERVER client. The owner is stamped from the session user
// (never trusted from the form); RLS `WITH CHECK (auth.uid() = owner)` is the real enforcement.
export async function createFact(formData: FormData) {
  const type = String(formData.get("type") ?? "");
  const content = String(formData.get("content") ?? "").trim();

  const supabase = await createClient();

  // Re-check the user server-side (defence in depth beyond the middleware redirect).
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (!content) {
    redirect(`/facts?error=${encodeURIComponent("Content is required.")}`);
  }

  const { error } = await supabase
    .from("fact")
    .insert({ type, content, owner: user.id });

  if (error) {
    redirect(`/facts?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/facts");
  redirect("/facts");
}

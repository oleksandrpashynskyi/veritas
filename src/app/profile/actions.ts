"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { parseProfileFields } from "./profile-fields";

// Save the signed-in user's IDENTITY (profile) via the per-user SERVER client. One row per user, so this
// is an UPSERT keyed on user_id (PK). `user_id` is stamped from the session — NEVER trusted from the
// form — and RLS `WITH CHECK (auth.uid() = user_id)` is the real enforcement. This is author metadata
// for the PDF letterhead/signature only: it is NOT a fact and never enters coverage/citation/generation.
export async function saveProfile(formData: FormData) {
  const parsed = parseProfileFields({
    full_name: formData.get("full_name"),
    phone: formData.get("phone"),
    location: formData.get("location"),
    professional_url: formData.get("professional_url"),
  });
  if ("error" in parsed) {
    redirect(`/profile?error=${encodeURIComponent(parsed.error)}`);
  }

  const supabase = await createClient();

  // Re-check the user server-side (defence in depth beyond the middleware redirect).
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("profile")
    .upsert({ user_id: user.id, ...parsed.fields }, { onConflict: "user_id" });

  if (error) {
    redirect(`/profile?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/profile");
  redirect("/profile?saved=1");
}

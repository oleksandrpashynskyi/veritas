"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FACT_TYPES } from "./facts";

// Optional free-text field: trim, and store empty as NULL (never an empty string).
function optionalText(value: FormDataEntryValue | null): string | null {
  const s = String(value ?? "").trim();
  return s === "" ? null : s;
}

// The writable fact fields parsed from a form. `owner` is NEVER here — it is stamped from the
// session on create and never rewritten on update (RLS WITH CHECK is the real guard).
type FactFields = {
  type: string;
  content: string;
  employer: string | null;
  role: string | null;
  date_start: string | null;
  date_end: string | null;
  verified: boolean;
};

// Basic validation only (M2): required content, valid type, sane date order. Banned-words /
// provenance enforcement is M5 generation — facts are the source of truth and cite nothing.
function parseFactFields(
  formData: FormData,
): { fields: FactFields } | { error: string } {
  const type = String(formData.get("type") ?? "");
  const content = String(formData.get("content") ?? "").trim();
  const employer = optionalText(formData.get("employer"));
  const role = optionalText(formData.get("role"));
  const date_start = optionalText(formData.get("date_start"));
  const date_end = optionalText(formData.get("date_end"));
  const verified = formData.get("verified") != null; // checkbox: present === on

  if (!content) return { error: "Content is required." };
  if (!(FACT_TYPES as readonly string[]).includes(type)) {
    return { error: "Invalid fact type." };
  }
  // ISO date strings compare lexicographically; the DB CHECK (date_end >= date_start) is the
  // real guard — this just gives a friendlier message before the round-trip.
  if (date_start && date_end && date_end < date_start) {
    return { error: "End date must not be before start date." };
  }
  return {
    fields: { type, content, employer, role, date_start, date_end, verified },
  };
}

// Create one fact via the per-user SERVER client. `owner` is stamped from the session user (never
// trusted from the form); RLS `WITH CHECK (auth.uid() = owner)` is the real enforcement.
export async function createFact(formData: FormData) {
  const parsed = parseFactFields(formData);
  if ("error" in parsed) {
    redirect(`/facts?error=${encodeURIComponent(parsed.error)}`);
  }

  const supabase = await createClient();

  // Re-check the user server-side (defence in depth beyond the middleware redirect).
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("fact")
    .insert({ ...parsed.fields, owner: user.id });

  if (error) {
    redirect(`/facts?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/facts");
  redirect("/facts");
}

// Update one of the user's OWN facts. `owner` is never written; RLS `USING (auth.uid() = owner)`
// scopes the UPDATE, so a tampered/foreign id is a silent no-op — the hidden id is safe.
export async function updateFact(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) {
    redirect(`/facts?error=${encodeURIComponent("Missing fact id.")}`);
  }

  const parsed = parseFactFields(formData);
  if ("error" in parsed) {
    redirect(`/facts/${id}/edit?error=${encodeURIComponent(parsed.error)}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase
    .from("fact")
    .update(parsed.fields)
    .eq("id", id);

  if (error) {
    redirect(`/facts/${id}/edit?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/facts");
  redirect("/facts");
}

// Delete one of the user's OWN facts. RLS `USING (auth.uid() = owner)` scopes the DELETE.
export async function deleteFact(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) {
    redirect(`/facts?error=${encodeURIComponent("Missing fact id.")}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("fact").delete().eq("id", id);

  if (error) {
    redirect(`/facts?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/facts");
  redirect("/facts");
}

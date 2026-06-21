"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { extractRequirements } from "@/lib/llm";
import { validateExtraction, type Extraction } from "@/lib/llm/extraction-schema";

// extractJob is a useActionState reducer: (prevState, formData) -> nextState. It performs the ONE
// billed Haiku call and returns the parsed result for preview — it stores NOTHING. Save is a
// separate step (saveJob) so the user reviews before anything is written.
export type ExtractState =
  | { status: "idle" }
  | { status: "error"; error: string }
  | { status: "ready"; extraction: Extraction; rawText: string };

export async function extractJob(
  _prev: ExtractState,
  formData: FormData,
): Promise<ExtractState> {
  const rawText = String(formData.get("raw_text") ?? "").trim();
  if (!rawText) return { status: "error", error: "Paste a job description first." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // One call per paste; fail-closed validation happens inside extractRequirements.
  const result = await extractRequirements(rawText);
  if (!result.ok) return { status: "error", error: result.error };

  return { status: "ready", extraction: result.value, rawText };
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null; // -> validateExtraction rejects "not an object"
  }
}

// Save the previewed extraction. Re-validates the CLIENT-SUBMITTED payload (never trust submitted
// structure) before storing, then writes the job + its requirements via the per-user client.
// `owner` is stamped from the session — never from the form; RLS WITH CHECK is the real guard.
export async function saveJob(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const rawText = String(formData.get("raw_text") ?? "").trim();
  if (!rawText) {
    redirect(`/jobs?error=${encodeURIComponent("Missing job description.")}`);
  }

  const result = validateExtraction(
    parseJson(String(formData.get("extraction") ?? "")),
  );
  if (!result.ok) {
    redirect(`/jobs?error=${encodeURIComponent(result.error)}`);
  }
  const { company, title, requirements } = result.value;

  const { data: job, error: jobErr } = await supabase
    .from("job")
    .insert({ raw_text: rawText, company, title, owner: user.id })
    .select("id")
    .single();
  if (jobErr || !job) {
    redirect(
      `/jobs?error=${encodeURIComponent(jobErr?.message ?? "Could not save the job.")}`,
    );
  }

  if (requirements.length > 0) {
    const { error: reqErr } = await supabase
      .from("requirement")
      .insert(
        requirements.map((r) => ({ job_id: job.id, text: r.text, kind: r.kind })),
      );
    if (reqErr) {
      // All-or-nothing without an RPC: remove the just-created job (owner-scoped) so no orphan
      // job persists, then surface the error.
      await supabase.from("job").delete().eq("id", job.id);
      redirect(`/jobs?error=${encodeURIComponent(reqErr.message)}`);
    }
  }

  revalidatePath("/jobs");
  redirect(`/jobs/${job.id}`);
}

// Delete one of the user's OWN jobs (cascades its requirements via the FK). RLS
// `USING (auth.uid() = owner)` scopes the DELETE — a foreign/missing id is a silent no-op.
export async function deleteJob(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) {
    redirect(`/jobs?error=${encodeURIComponent("Missing job id.")}`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { error } = await supabase.from("job").delete().eq("id", id);
  if (error) {
    redirect(`/jobs?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/jobs");
  redirect("/jobs");
}

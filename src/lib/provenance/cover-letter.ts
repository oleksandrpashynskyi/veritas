// Cover-letter persistence — a thin wrapper over the shared provenance gate (persistDocument), the
// twin of persistResume. The gate is the SINGLE enforcement site for the doc_line invariant; this file
// only supplies the cover letter's caller-specific shaping (type "cover_letter", the cover-letter
// validator, which also yields the connective prose the gate stores on the document row).
//
// persistCoverLetter is the function the saveCoverLetter action wraps and that verify-m6 imports +
// drives directly with a real per-user client — so the proof exercises the true validate ->
// verified-fetch -> reconcile -> insert wiring through the SAME gate the résumé passes through.
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateCoverLetter } from "@/lib/llm/cover-letter-schema";
import { persistDocument, type PersistResult } from "./document";

export type { PersistResult };

export async function persistCoverLetter(
  client: SupabaseClient,
  userId: string,
  jobId: string,
  submitted: unknown,
): Promise<PersistResult> {
  // validateCoverLetter returns DocValidated directly (cited claim lines + connective segments), so it
  // drops straight into the gate. The cited-check / banned-word / connective structural rule run there;
  // the empty-document rejection and the verified+owned reconcile (claims only) happen in the gate.
  return persistDocument(client, userId, jobId, {
    type: "cover_letter",
    submitted,
    validate: validateCoverLetter,
  });
}

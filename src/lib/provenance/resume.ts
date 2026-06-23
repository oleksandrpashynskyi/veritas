// Résumé persistence — the M5 provenance gate, and the heart of this milestone.
//
// Deliberately FREE of `next/*` and `server-only`, and it does NOT import @/lib/db: it takes the
// per-user (RLS) client as a PARAMETER. That is what lets the real function run in two places —
// inside the Next saveResume action AND inside verify-m5 under a TS loader, with B's actual per-user
// client — so the proof exercises the true validate -> verified-fetch -> reconcile -> insert wiring,
// not a re-implementation (AGENTS.md: "Touch [provenance] with reverence").
//
// The load-bearing facts:
//   * The DB trigger doc_line_fact_ids_exist enforces fact EXISTENCE, not OWNERSHIP and not VERIFIED.
//     The verified+owned set below (built via the per-user client with `.eq("verified", true)`, so
//     RLS makes a foreign id absent and the filter makes an unverified id absent) is the real gate:
//     reconcileResumeCitations rejects any cited id outside it. This enforces "the résumé cites
//     verified facts only" — the hard verified-gate M4 deferred to here.
//   * A résumé spans TWO tables (document + its doc_lines). We insert the document first, then all
//     lines in one statement; if the lines fail, we compensating-delete the document (cascade clears
//     any partial state) so nothing half-written survives. The line insert is itself atomic, so the
//     only seam is document-vs-lines, closed by the compensating delete.
// Fail closed on anything: store NOTHING.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  reconcileResumeCitations,
  validateResume,
} from "@/lib/llm/resume-schema";

export type PersistResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

export async function persistResume(
  client: SupabaseClient,
  userId: string,
  jobId: string,
  submitted: unknown,
): Promise<PersistResult> {
  // 1. Structural re-validate of the client-submitted accepted-subset — never trust submitted
  //    structure. Catches an uncited line (empty fact_ids), a banned word, a non-uuid id, off-shape.
  const validated = validateResume(submitted);
  if (!validated.ok) return { ok: false, error: validated.error };

  // 2. Business rule: a résumé must have at least one line. Refusing the empty set here means
  //    persistResume never creates an empty document (a document with zero doc_lines).
  if (validated.value.lines.length === 0) {
    return { ok: false, error: "A résumé needs at least one approved line." };
  }

  // 3. Defence in depth: confirm the passed client's session really is this user. RLS is the real
  //    gate; this only catches a caller threading a mismatched (client, userId) pair. Fail closed.
  const auth = await client.auth.getUser();
  if (auth.error || !auth.data.user) return { ok: false, error: "Not authenticated." };
  if (auth.data.user.id !== userId) return { ok: false, error: "Session/user mismatch." };

  // 4. Confirm the job is real + owned, via the per-user client. RLS returns the row only if the
  //    user owns it — so a foreign or non-existent jobId yields null and fails closed here.
  const jobRes = await client.from("job").select("id").eq("id", jobId).maybeSingle();
  if (jobRes.error) return { ok: false, error: jobRes.error.message };
  if (!jobRes.data) return { ok: false, error: "Job not found." };

  // 5. One résumé per job (v1, Alex). RLS scopes this to the user's own documents; a pre-existing
  //    résumé blocks generation (the UI offers Delete-then-regenerate instead). Authoritative gate.
  const existing = await client
    .from("document")
    .select("id")
    .eq("job_id", jobId)
    .eq("type", "resume");
  if (existing.error) return { ok: false, error: existing.error.message };
  if ((existing.data?.length ?? 0) > 0) {
    return { ok: false, error: "A résumé already exists for this job." };
  }

  // 6. The user's REAL verified + owned fact ids, via the per-user client. RLS scopes to the owner;
  //    `.eq("verified", true)` scopes to verified — so the set is exactly "real AND owned AND
  //    verified", and one membership check closes realness + ownership + the verified-only rule.
  const factRes = await client.from("fact").select("id").eq("verified", true);
  if (factRes.error) return { ok: false, error: factRes.error.message };
  const verifiedOwnedFactIds = new Set<string>(
    (factRes.data ?? []).map((r) => r.id as string),
  );

  // 7. Provenance reconcile — reject the WHOLE payload if any line cites a fact that is not owned,
  //    not verified, or not real. This is the gate the DB trigger (existence-only) cannot give us.
  const reconciled = reconcileResumeCitations({
    lines: validated.value.lines,
    verifiedOwnedFactIds,
  });
  if (!reconciled.ok) return { ok: false, error: reconciled.error };

  // 8. Insert the document first (status 'approved' — only approved lines reach this point in the
  //    preview-then-save flow). RLS WITH CHECK re-confirms job ownership. Store nothing on error.
  const docIns = await client
    .from("document")
    .insert({ job_id: jobId, type: "resume", status: "approved" })
    .select("id")
    .single();
  if (docIns.error) {
    // 23505 = the UNIQUE(job_id, type) constraint (document_one_per_job_type). The step-5 pre-check
    // is the friendly path; this is the atomic backstop for a race where a concurrent save created
    // the résumé after our pre-check. Same guard outcome — nothing stored.
    if (docIns.error.code === "23505") {
      return { ok: false, error: "A résumé already exists for this job." };
    }
    return { ok: false, error: docIns.error.message };
  }
  const documentId = docIns.data.id as string;

  // 9. Insert ALL lines in one statement (atomic). approved=true; position preserves the order the
  //    user approved. RLS WITH CHECK (document -> job -> owner) and the DB triggers (fact existence,
  //    non-empty fact_ids) re-confirm — defence in depth on the gate already applied above.
  const rows = reconciled.lines.map((line, i) => ({
    document_id: documentId,
    text: line.text,
    fact_ids: line.fact_ids,
    approved: true,
    position: i,
  }));
  const lineIns = await client.from("doc_line").insert(rows);
  if (lineIns.error) {
    // Compensating delete: the line insert failed (a race or corruption — the in-app gate already
    // passed), so remove the now-childless document. Cascade clears any partial state.
    const cleanup = await client.from("document").delete().eq("id", documentId);
    if (cleanup.error) {
      // The cleanup ALSO failed: do NOT swallow it. An orphaned empty approved document would
      // silently block regeneration (the one-résumé guard would find it). Surface a distinct,
      // diagnosable error naming the orphan so it is loud and recoverable — deleting the résumé for
      // this job (the existing Delete action) clears it.
      return {
        ok: false,
        error: `Résumé lines failed to save (${lineIns.error.message}); cleanup of the empty document ${documentId} also failed (${cleanup.error.message}). Delete the résumé for this job, then try again.`,
      };
    }
    return { ok: false, error: lineIns.error.message };
  }

  return { ok: true, count: rows.length };
}

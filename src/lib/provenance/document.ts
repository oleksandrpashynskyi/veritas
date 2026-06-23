// The shared provenance gate — the single enforcement site for the doc_line invariant, reached by
// BOTH the résumé (persistResume) and the cover letter (persistCoverLetter). Generalised from M5's
// persistResume so the verified+owned reconcile, the two-table document+doc_lines write with
// compensating-delete, and the 23505 one-per-(job,type) handling CANNOT drift between two copies.
//
// Deliberately FREE of `next/*` and `server-only`, and it does NOT import @/lib/db: it takes the
// per-user (RLS) client as a PARAMETER. That is what lets the real function run in two places — inside
// the Next save actions AND inside verify-m5/verify-m6 under a TS loader, with a real per-user client —
// so the proofs exercise the true validate -> verified-fetch -> reconcile -> insert wiring, not a
// re-implementation (AGENTS.md: "Touch [provenance] with reverence").
//
// The load-bearing facts (unchanged from M5):
//   * The DB trigger doc_line_fact_ids_exist enforces fact EXISTENCE, not OWNERSHIP, not VERIFIED, and
//     not the voice-only exclusion. The CITABLE set below (built via the per-user client with
//     `.eq("verified", true).neq("type", "writing_sample")` — RLS makes a foreign id absent, the
//     verified filter makes an unverified id absent, the type filter makes a writing-sample id absent)
//     is the real gate: reconcileResumeCitations rejects any cited id outside it. Writing samples are
//     VOICE-ONLY — they shape tone, they are NOT credentials and may never be cited as evidence by any
//     claim line in ANY document type; excluding them HERE closes that for the résumé and the letter at
//     one site (a latent hole on the résumé path, which predates writing samples).
//   * A document spans TWO tables (document + its doc_lines). We insert the document first, then all
//     CLAIM lines in one statement; if the lines fail, we compensating-delete the document (cascade
//     clears any partial state) so nothing half-written survives.
//   * CONNECTIVE prose (cover letters only) is stored on the document row, NEVER as a doc_line — so the
//     doc_line invariant stays EXACTLY intact: no stored doc_line ever has empty fact_ids. The résumé
//     passes no connective, so its document insert is byte-identical to M5 (the column default applies).
// Fail closed on anything: store NOTHING.
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileResumeCitations } from "@/lib/llm/resume-schema";

export type PersistResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

// A cited claim line, carrying the POSITION it occupies in the assembled document. For a résumé that
// is simply its index (0..n) — byte-identical to M5's `position: i`. For a cover letter it is the
// line's index in the original ordered block sequence, SHARED with the connective segments below, so a
// single sort by `position` reassembles the letter (claims interleaved with connective) at display.
export type ClaimLineForStore = { text: string; fact_ids: string[]; position: number };

// A connective segment: framing prose that asserts NO experiential fact (greeting / interest / fit /
// closing courtesy / sign-off). It has NO citation slot, so it can never be stored as a claim. Its
// `position` shares the same ordered space as the claim lines (a résumé has no connective at all).
export type ConnectiveSegment = { role: string; text: string; position: number };

// The caller-specific validator's output: the cited CLAIM lines (which pass the verified+owned gate)
// and any CONNECTIVE prose (resume: none). Structural validation (cited-check, banned words, the
// connective rule) is the validator's job; realness/ownership/verified is persistDocument's job.
export type DocValidated =
  | { ok: true; claimLines: ClaimLineForStore[]; connective: ConnectiveSegment[] }
  | { ok: false; error: string };

export type DocType = "resume" | "cover_letter";

export async function persistDocument(
  client: SupabaseClient,
  userId: string,
  jobId: string,
  opts: {
    type: DocType;
    submitted: unknown;
    validate: (raw: unknown) => DocValidated;
  },
): Promise<PersistResult> {
  const { type, submitted, validate } = opts;
  const label = type === "resume" ? "résumé" : "cover letter";
  const Label = type === "resume" ? "Résumé" : "Cover letter";

  // 1. Structural re-validate of the client-submitted accepted-subset — never trust submitted
  //    structure. Catches an uncited claim line (empty fact_ids), a banned word, a non-uuid id,
  //    off-shape, or a connective block that smuggles a citation. Caller-specific shape, shared gate.
  const validated = validate(submitted);
  if (!validated.ok) return { ok: false, error: validated.error };

  // 2. Business rule: a document must have at least one CITED claim line. Refusing the empty set here
  //    means persistDocument never creates a document with zero claim doc_lines (connective-only).
  if (validated.claimLines.length === 0) {
    return { ok: false, error: `A ${label} needs at least one approved line.` };
  }

  // 3. Defence in depth: confirm the passed client's session really is this user. RLS is the real
  //    gate; this only catches a caller threading a mismatched (client, userId) pair. Fail closed.
  const auth = await client.auth.getUser();
  if (auth.error || !auth.data.user) return { ok: false, error: "Not authenticated." };
  if (auth.data.user.id !== userId) return { ok: false, error: "Session/user mismatch." };

  // 4. Confirm the job is real + owned, via the per-user client. RLS returns the row only if the user
  //    owns it — so a foreign or non-existent jobId yields null and fails closed here.
  const jobRes = await client.from("job").select("id").eq("id", jobId).maybeSingle();
  if (jobRes.error) return { ok: false, error: jobRes.error.message };
  if (!jobRes.data) return { ok: false, error: "Job not found." };

  // 5. One document per (job, type) (v1, Alex). RLS scopes this to the user's own documents; a
  //    pre-existing one blocks generation (the UI offers Delete-then-regenerate). Authoritative gate.
  const existing = await client
    .from("document")
    .select("id")
    .eq("job_id", jobId)
    .eq("type", type);
  if (existing.error) return { ok: false, error: existing.error.message };
  if ((existing.data?.length ?? 0) > 0) {
    return { ok: false, error: `A ${label} already exists for this job.` };
  }

  // 6. The user's REAL CITABLE fact ids, via the per-user client. RLS scopes to the owner;
  //    `.eq("verified", true)` scopes to verified; `.neq("type", "writing_sample")` excludes the
  //    voice-only writing samples — so the set is exactly "real AND owned AND verified AND citable",
  //    and one membership check closes realness + ownership + the verified-only rule + the
  //    writing-sample exclusion, for EVERY document type at this single site.
  const factRes = await client
    .from("fact")
    .select("id")
    .eq("verified", true)
    .neq("type", "writing_sample");
  if (factRes.error) return { ok: false, error: factRes.error.message };
  const citableOwnedFactIds = new Set<string>(
    (factRes.data ?? []).map((r) => r.id as string),
  );

  // 7. Provenance reconcile — reject the WHOLE payload if any CLAIM line cites a fact that is not
  //    owned, not verified, not real, or a voice-only writing sample. The DB trigger (existence-only)
  //    cannot give us this. Note: connective prose has no citations, so it is (correctly) never
  //    reconciled.
  const reconciled = reconcileResumeCitations({
    lines: validated.claimLines,
    verifiedOwnedFactIds: citableOwnedFactIds,
  });
  if (!reconciled.ok) return { ok: false, error: reconciled.error };

  // 8. Insert the document first (status 'approved' — only approved content reaches this point in the
  //    preview-then-save flow). Connective prose (cover letters) rides on the document row; the résumé
  //    sends none, so its payload is byte-identical to M5 and the `connective` column default applies.
  //    RLS WITH CHECK re-confirms job ownership. Store nothing on error.
  const docPayload: Record<string, unknown> = {
    job_id: jobId,
    type,
    status: "approved",
  };
  if (validated.connective.length > 0) {
    docPayload.connective = validated.connective;
  }
  const docIns = await client
    .from("document")
    .insert(docPayload)
    .select("id")
    .single();
  if (docIns.error) {
    // 23505 = the UNIQUE(job_id, type) constraint (document_one_per_job_type). The step-5 pre-check is
    // the friendly path; this is the atomic backstop for a race where a concurrent save created the
    // document after our pre-check. Same guard outcome — nothing stored.
    if (docIns.error.code === "23505") {
      return { ok: false, error: `A ${label} already exists for this job.` };
    }
    return { ok: false, error: docIns.error.message };
  }
  const documentId = docIns.data.id as string;

  // 9. Insert ALL claim lines in one statement (atomic). approved=true; each line's `position`
  //    preserves the order the user approved (and, for a cover letter, its slot in the interleaved
  //    block sequence). RLS WITH CHECK (document -> job -> owner) and the DB triggers (fact existence,
  //    non-empty fact_ids) re-confirm — defence in depth on the gate already applied above.
  const rows = validated.claimLines.map((line) => ({
    document_id: documentId,
    text: line.text,
    fact_ids: line.fact_ids,
    approved: true,
    position: line.position,
  }));
  const lineIns = await client.from("doc_line").insert(rows);
  if (lineIns.error) {
    // Compensating delete: the line insert failed (a race or corruption — the in-app gate already
    // passed), so remove the now-childless document. Cascade clears any partial state.
    const cleanup = await client.from("document").delete().eq("id", documentId);
    if (cleanup.error) {
      // The cleanup ALSO failed: do NOT swallow it. An orphaned empty approved document would silently
      // block regeneration (the one-per-(job,type) guard would find it). Surface a distinct,
      // diagnosable error naming the orphan so it is loud and recoverable — deleting the document for
      // this job (the existing Delete action) clears it.
      return {
        ok: false,
        error: `${Label} lines failed to save (${lineIns.error.message}); cleanup of the empty document ${documentId} also failed (${cleanup.error.message}). Delete the ${label} for this job, then try again.`,
      };
    }
    return { ok: false, error: lineIns.error.message };
  }

  return { ok: true, count: rows.length };
}

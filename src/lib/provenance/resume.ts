// Résumé persistence — now a thin wrapper over the shared provenance gate (persistDocument). The gate
// is the single enforcement site for the doc_line invariant; this file only supplies the résumé's
// caller-specific shaping (type "resume", the résumé validator, no connective prose).
//
// persistResume keeps its M5 signature and is still the function the saveResume action wraps and that
// verify-m5 imports + drives directly with a real per-user client — so the proof exercises the true
// validate -> verified-fetch -> reconcile -> insert wiring through the generalised gate, unchanged.
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateResume } from "@/lib/llm/resume-schema";
import { persistDocument, type PersistResult } from "./document";

export type { PersistResult };

export async function persistResume(
  client: SupabaseClient,
  userId: string,
  jobId: string,
  submitted: unknown,
): Promise<PersistResult> {
  return persistDocument(client, userId, jobId, {
    type: "resume",
    submitted,
    // A résumé is `{ lines: [...] }` of cited claim lines and NO connective prose. validateResume is
    // the same pure validator as M5 (cited-check, banned words, UUID, dedup, caps); the empty-document
    // rejection and the verified+owned reconcile happen inside persistDocument.
    validate: (raw) => {
      const v = validateResume(raw);
      if (!v.ok) return v;
      // A résumé has no connective prose; each line's position is simply its index — identical to the
      // M5 `position: i` write, so the résumé path is byte-for-byte unchanged through the shared gate.
      return {
        ok: true,
        claimLines: v.value.lines.map((line, i) => ({ ...line, position: i })),
        connective: [],
      };
    },
  });
}

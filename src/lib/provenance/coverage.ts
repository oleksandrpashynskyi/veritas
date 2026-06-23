// Coverage persistence — the M4 provenance gate, and the heart of this milestone.
//
// Deliberately FREE of `next/*` and `server-only`, and it does NOT import @/lib/db: it takes the
// per-user (RLS) client as a PARAMETER. That is what lets the real function run in two places —
// inside the Next saveCoverage action AND inside verify-m4 under a TS loader, with B's actual
// per-user client — so the proof exercises the true validate -> fetch-owned-sets -> reconcile ->
// insert wiring, not a re-implementation (AGENTS.md: "Touch [provenance] with reverence").
//
// The load-bearing fact: the DB trigger coverage_fact_ids_exist enforces fact EXISTENCE, not
// OWNERSHIP — user B could cite user A's real fact on B's own job and the DB would allow it. The
// owned-set check below is the real ownership gate. Because the owned/job-requirement sets are built
// through the per-user client, RLS makes a foreign or non-existent id simply absent from them, so
// reconcileCitations rejects it. Fail closed on anything: store NOTHING.
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  reconcileCitations,
  validateCoverage,
} from "@/lib/llm/coverage-schema";

export type PersistResult =
  | { ok: true; count: number }
  | { ok: false; error: string };

export async function persistCoverage(
  client: SupabaseClient,
  userId: string,
  jobId: string,
  submitted: unknown,
): Promise<PersistResult> {
  // 1. Structural re-validate of the client-submitted payload — never trust submitted structure
  //    (same posture as saveJob). Catches inflated "met" with no evidence, non-uuid ids, etc.
  const validated = validateCoverage(submitted);
  if (!validated.ok) return { ok: false, error: validated.error };

  // 2. Defence in depth: confirm the passed client's session really is this user. RLS is the real
  //    gate; this only catches a caller threading a mismatched (client, userId) pair. Fail closed.
  const auth = await client.auth.getUser();
  if (auth.error || !auth.data.user) return { ok: false, error: "Not authenticated." };
  if (auth.data.user.id !== userId) return { ok: false, error: "Session/user mismatch." };

  // 3. The job's REAL requirement ids, via the per-user client. RLS (child-via-parent) returns rows
  //    only if the user owns the job — so a foreign jobId yields an empty set and fails closed below.
  const reqRes = await client.from("requirement").select("id").eq("job_id", jobId);
  if (reqRes.error) return { ok: false, error: reqRes.error.message };
  const jobRequirementIds = new Set<string>(
    (reqRes.data ?? []).map((r) => r.id as string),
  );
  if (jobRequirementIds.size === 0) {
    return { ok: false, error: "No requirements found for this job." };
  }

  // 4. The user's REAL owned, CITABLE fact ids, via the per-user client (RLS-scoped to the owner).
  //    `.neq("type", "writing_sample")` excludes the voice-only writing samples — they assert nothing
  //    about experience, so they may never be cited as evidence that a requirement is met (consistent
  //    with being uncitable by any claim line). Coverage still considers verified AND unverified facts
  //    (the provisional-status rule lives in the view); only writing samples are barred as evidence.
  const factRes = await client
    .from("fact")
    .select("id")
    .neq("type", "writing_sample");
  if (factRes.error) return { ok: false, error: factRes.error.message };
  const ownedFactIds = new Set<string>(
    (factRes.data ?? []).map((r) => r.id as string),
  );

  // 5. Provenance reconcile — reject any cited fact not owned or requirement not in this job;
  //    fill omitted requirements as unmet. This is the ownership gate the DB trigger cannot give us.
  const reconciled = reconcileCitations({
    entries: validated.value.coverage,
    ownedFactIds,
    jobRequirementIds,
  });
  if (!reconciled.ok) return { ok: false, error: reconciled.error };

  // 6. Persist as a single insert (atomic statement). RLS WITH CHECK re-confirms job ownership and
  //    the DB triggers re-confirm fact existence — defence in depth. Store nothing on any error.
  const rows = reconciled.rows.map((e) => ({
    job_id: jobId,
    requirement_id: e.requirement_id,
    status: e.status,
    fact_ids: e.fact_ids,
  }));
  const ins = await client.from("coverage").insert(rows);
  if (ins.error) return { ok: false, error: ins.error.message };

  return { ok: true, count: rows.length };
}

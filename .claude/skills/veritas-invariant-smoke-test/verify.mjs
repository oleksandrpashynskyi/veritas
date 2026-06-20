// Bundled with the veritas-invariant-smoke-test skill. A LOCAL MERGE GATE that proves —
// by EXECUTION, never by inspection — that the core Veritas provenance invariant is
// installed by the WORKING-TREE migration FILES: a `doc_line` must cite >=1 real fact, and
// a cited fact cannot vanish.
//
// FRESHNESS IS OWNED, NOT TRUSTED. The proof runs `supabase db reset` itself (re-applying
// the current supabase/migrations/*.sql into the local stack) immediately before the test,
// so it binds to the files you are about to merge — not to whatever schema happens to be
// connected. (Without this, a reset-then-edited migration that drops a trigger would
// false-pass against the stale-but-still-enforcing schema.)
//
// LOCAL ONLY. It is loopback-gated and resets the LOCAL stack (the one `supabase start`
// brings up). It must never reset or test a remote/hosted project. Deploy-time hosted
// verification is a SEPARATE, deferred concern — not this script.
//
// SAME-STACK BINDING. Freshness against "the local stack" is only meaningful if the test
// runs against the very stack the reset reset. So AFTER `db reset` the proof sources its
// connection (API_URL + SERVICE_ROLE_KEY) from `supabase status -o json`, run in the SAME
// cwd as the reset: both `db reset` and `supabase status` resolve the stack from the repo's
// supabase/config.toml, so they are one and the same instance. No env URL is read — there is
// no second target that could silently point at a different (un-reset) local stack.
//
// Uses `@supabase/supabase-js` (already a project dep). `fact`/`job` carry `owner NOT NULL ->
// auth.users`, so it mints a throwaway owner via the Admin API and deletes it after; all probe
// rows are marker-prefixed and swept — and the sweep is VERIFIED, not assumed (a leak fails).
//
// Exit codes:
//   0  invariant installed by the fresh files (3 rejections) AND the DB left clean.
//   1  REGRESSION — a violation was not rejected (a CHECK/trigger is missing/weakened).
//   2  COULD NOT VERIFY — db reset / supabase status / connect / seed failed, non-loopback target, or <3 tests.
//   3  CLEANUP LEAK — invariant held, but the proof did not leave the DB clean.
//
// NO SECRET IS STORED IN THIS FILE.
//
// Usage (local stack up; from the repo root):
//   node .claude/skills/veritas-invariant-smoke-test/verify.mjs        # repo = cwd
//   node .claude/skills/veritas-invariant-smoke-test/verify.mjs <repo-root>
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const REPO = process.argv[2] || process.cwd();
const RANDOM_UUID = "00000000-0000-4000-8000-000000000000";
const MARK_PREFIX = "VERITAS_INVARIANT_SMOKE_";
const MARK = MARK_PREFIX + randomUUID();
const SMOKE_EMAIL = "veritas-invariant-smoke@example.com";

function jwtRole(token) {
  if (typeof token !== "string") return undefined;
  const p = token.split(".");
  if (p.length !== 3) return undefined;
  try { return JSON.parse(Buffer.from(p[1], "base64url").toString("utf8")).role; } catch { return undefined; }
}

function projectRef(url) {
  const m = (url || "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (m) return m[1];
  try { return new URL(url).host; } catch { return "(local)"; }
}

function isLoopbackUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

// PASS only if the forbidden op was REJECTED with the expected SQLSTATE; a SUCCESS (no
// error) — what a missing CHECK/trigger produces — is a FAIL, never a pass.
const results = [];
function record(name, expect, error) {
  if (error) results.push({ name, ok: error.code === expect, expect, got: error.code || "(no SQLSTATE)", msg: (error.message || "").split("\n")[0] });
  else results.push({ name, ok: false, expect, got: "NONE (operation SUCCEEDED)", msg: "NOT rejected — REGRESSION" });
}

// FIX 1: own the freshness — re-apply the working-tree migration files into the local stack.
function dbReset() {
  const res = spawnSync("npx supabase db reset", { cwd: REPO, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: res.status, error: res.error, out: `${res.stdout || ""}\n${res.stderr || ""}` };
}

// SAME-STACK BINDING: read the reset target's OWN creds from the CLI (same cwd as the reset,
// so the same supabase/config.toml → the same stack). The JSON is on stdout; the "Stopped
// services" note and version banner go to stderr — so slice the first `{`…last `}` defensively.
function statusJson() {
  const res = spawnSync("npx supabase status -o json", { cwd: REPO, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { error: res.error };
  const out = res.stdout || "";
  const s = out.indexOf("{"), e = out.lastIndexOf("}");
  let creds = null, parseErr = null;
  if (s !== -1 && e > s) { try { creds = JSON.parse(out.slice(s, e + 1)); } catch (err) { parseErr = err.message; } }
  return { status: res.status, creds, err: `${parseErr ? "parse error: " + parseErr + "\n" : ""}${res.stderr || ""}` };
}

// FIX 2: cleanup that VERIFIES it left nothing behind. Returns a status the tally gates on.
async function cleanup(svc) {
  const errors = [];
  const sweep = async (table, col) => {
    try { const r = await svc.from(table).delete().like(col, MARK_PREFIX + "%"); if (r.error) errors.push(`${table} sweep: ${r.error.code || ""} ${(r.error.message || "").split("\n")[0]}`); }
    catch (e) { errors.push(`${table} sweep threw: ${e.message}`); }
  };
  await sweep("job", "raw_text");   // cascades document -> doc_line, requirement -> coverage
  await sweep("fact", "content");   // now-uncited marked facts
  try {
    const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) errors.push(`listUsers: ${error.message}`);
    for (const u of data?.users || []) if (u.email === SMOKE_EMAIL) { const d = await svc.auth.admin.deleteUser(u.id); if (d.error) errors.push(`deleteUser: ${d.error.message}`); }
  } catch (e) { errors.push(`user delete threw: ${e.message}`); }

  // verify nothing is left — a swallowed failure can't hide here.
  const count = async (table, col) => {
    try { const r = await svc.from(table).select("*", { count: "exact", head: true }).like(col, MARK_PREFIX + "%"); return r.error ? `err:${r.error.code}` : r.count; }
    catch (e) { return "threw"; }
  };
  const leftJobs = await count("job", "raw_text");
  const leftFacts = await count("fact", "content");
  let userPresent = "unknown";
  try { const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 }); userPresent = (data?.users || []).some((u) => u.email === SMOKE_EMAIL); }
  catch (e) { userPresent = "unknown(threw)"; }

  const clean = errors.length === 0 && leftJobs === 0 && leftFacts === 0 && userPresent === false;
  return { clean, errors, leftJobs, leftFacts, userPresent };
}

let fatal = null;
let svc = null;
let cleanupStatus = null;

try {
  // FIX 1: re-apply the working-tree migrations FRESH into the local stack, and own that step.
  console.log("applying the working-tree migrations into the local stack (supabase db reset)...");
  const reset = dbReset();
  if (reset.error) throw new Error(`could not run \`supabase db reset\`: ${reset.error.message} — is the local stack up (\`supabase start\`)?`);
  if (reset.status !== 0) throw new Error(`\`supabase db reset\` FAILED (exit ${reset.status}) — the working-tree migrations did not apply cleanly:\n${reset.out.split("\n").filter(Boolean).slice(-10).join("\n")}`);
  console.log("migrations applied fresh.\n");

  // SAME-STACK BINDING: source the connection from the stack the reset just targeted. `db reset`
  // and `supabase status` both run in this cwd, so both resolve the SAME supabase/config.toml →
  // the SAME instance; the test cannot reach a different (un-reset) stack, and no env URL is read.
  const st = statusJson();
  if (st.error) throw new Error(`could not run \`supabase status\`: ${st.error.message} — is the local stack up (\`supabase start\`)?`);
  if (st.status !== 0) throw new Error(`\`supabase status\` FAILED (exit ${st.status}) — cannot confirm the reset target:\n${(st.err || "").split("\n").filter(Boolean).slice(-6).join("\n")}`);
  if (!st.creds || !st.creds.API_URL || !st.creds.SERVICE_ROLE_KEY) throw new Error("`supabase status -o json` did not surface API_URL + SERVICE_ROLE_KEY — cannot bind the test to the reset target");
  const SB_URL = st.creds.API_URL;
  const SVC = st.creds.SERVICE_ROLE_KEY;
  if (!isLoopbackUrl(SB_URL)) throw new Error(`the reset target's API_URL is not loopback (${SB_URL}) — this is the LOCAL merge gate; refusing to proceed.`);
  if (jwtRole(SVC) === "anon") throw new Error("the reset target's SERVICE_ROLE_KEY decodes to role=anon — seeding (which must reach the CHECK/triggers) would fail");

  svc = createClient(SB_URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });

  // db reset wiped the DB; mint a throwaway owner (fact/job require one).
  const u = await svc.auth.admin.createUser({ email: SMOKE_EMAIL, password: "veritas-invariant-pw-012345", email_confirm: true });
  if (u.error) throw new Error(`admin.createUser after db reset: ${u.error.message} — the reset did not leave a usable auth service; STOP and report`);
  const owner = u.data.user.id;

  const seed = async (table, payload, cols) => {
    const { data, error, status } = await svc.from(table).insert(payload).select(cols).single();
    if (error) throw new Error(`seed ${table} (status ${status}): ${error.message}`);
    return data;
  };
  const job = (await seed("job", { raw_text: MARK, owner }, "id")).id;
  const doc = (await seed("document", { job_id: job, type: "resume" }, "id")).id;
  const fact = (await seed("fact", { type: "experience", content: MARK, owner }, "id")).id;
  console.log(`project ${projectRef(SB_URL)} — seeded under throwaway owner ${owner.slice(0, 8)} (marker ${MARK})\n`);

  // 1. a doc_line with no citations must be rejected by the CHECK.
  { const r = await svc.from("doc_line").insert({ document_id: doc, text: MARK + " uncited", fact_ids: [] }).select("id");
    record("1. empty fact_ids   ", "23514", r.error); }

  // 2. a doc_line citing a fact that does not exist must be rejected by the trigger.
  { const r = await svc.from("doc_line").insert({ document_id: doc, text: MARK + " bogus", fact_ids: [RANDOM_UUID] }).select("id");
    record("2. nonexistent fact ", "23503", r.error); }

  // 3. a fact cited by a valid doc_line cannot be deleted.
  { await seed("doc_line", { document_id: doc, text: MARK + " valid", fact_ids: [fact] }, "id");
    const r = await svc.from("fact").delete().eq("id", fact);
    record("3. delete cited fact", "23503", r.error); }
} catch (e) {
  fatal = e.message;
} finally {
  if (svc) cleanupStatus = await cleanup(svc);
}

console.log("\n=== Veritas invariant smoke-test — FRESH working-tree migrations (local merge gate) ===");

if (cleanupStatus) {
  console.log(cleanupStatus.clean
    ? "  cleanup: DB left clean (marker rows swept, throwaway user deleted, verified)."
    : `  CLEANUP LEAK — left jobs=${cleanupStatus.leftJobs}, facts=${cleanupStatus.leftFacts}, throwaway user present=${cleanupStatus.userPresent}${cleanupStatus.errors.length ? "; errors: " + cleanupStatus.errors.join(" | ") : ""}`);
}

if (fatal || results.length !== 3) {
  console.log(`✗ COULD NOT VERIFY — ${fatal || `only ${results.length}/3 tests ran`}. No proof produced; this is NOT a pass.`);
  process.exit(2);
}
let allPass = true;
for (const t of results) {
  console.log(`  ${t.ok ? "PASS" : "FAIL"}  ${t.name} — expect ${t.expect}, got ${t.got}: ${t.msg}`);
  if (!t.ok) allPass = false;
}
if (!allPass) {
  console.log("\n✗ REGRESSION — a violation was not rejected by the fresh schema. STOP; do not commit.");
  process.exit(1);
}
if (cleanupStatus && !cleanupStatus.clean) {
  console.log("\n✗ CLEANUP LEAK — the invariant held, but the proof did not leave the DB clean (see above). NOT a pass.");
  process.exit(3);
}
console.log("\n✓ INVARIANT ENFORCED BY THE WORKING-TREE MIGRATIONS — and the DB was left clean.");
process.exit(0);

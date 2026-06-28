// seed.mjs — Local-dev re-seed after a Supabase stack reset.
//
// WHY THIS EXISTS: `npx supabase db reset` / a CLI bump / a stack restart can wipe the LOCAL Postgres
// database (all rows + auth users), leaving the schema intact but the data gone. This repopulates a
// realistic test dataset in ONE command so you can sign in and exercise coverage -> resume -> cover
// letter -> PDF export end-to-end without re-typing anything.
//
// HOW IT'S WIRED (mirrors the verify-*.mjs proofs):
//   * It sources LOCAL stack credentials from `npx supabase status -o json` (the ground truth from the
//     running stack) — NEVER from .env and NEVER hardcoded. This matters: .env.local's SUPABASE_URL /
//     SUPABASE_SERVICE_ROLE_KEY point at a HOSTED project, so seeding must NOT read them or it could
//     write to production. Sourcing from `supabase status` guarantees we only ever touch the local stack.
//   * It refuses to run against anything that isn't loopback (127.0.0.1/localhost) — a hard safety stop.
//   * The test user is created via the GoTrue Admin API (service role), pre-confirmed, so it can sign in
//     immediately. Career rows are inserted with the service-role client (BYPASSRLS) and owned by that
//     user, so the app's per-user (RLS) path sees them exactly as a real account would.
//
// IDEMPOTENT: re-running first removes the test user's previous data (jobs first — that cascades the
// documents/doc_lines/coverage and releases fact citations — then facts), deletes the test user, and
// recreates everything fresh. Running it twice never errors or duplicates. It ONLY touches the test
// account (dev@veritas.test); any real account (e.g. your own email) is left completely untouched.
//
// RUN:  node seed.mjs     (local stack must be up: npx supabase start)
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.dirname(fileURLToPath(import.meta.url));

// Clearly TEST credentials — a throwaway local login, safe to document. Not a Supabase key/secret.
const TEST_EMAIL = "dev@veritas.test";
const TEST_PASSWORD = "veritas-dev-2026";

// The seed dataset — enough to drive coverage -> resume -> cover letter -> export. All facts verified so
// they are immediately citable by generation (verified-only gate); the writing_sample conditions voice.
const FACTS = [
  { type: "experience", content: "Built and shipped a billing platform processing $2M per month across 14 microservices.", employer: "Acme Corp", role: "Senior Backend Engineer", date_start: "2021-03-01", date_end: "2024-08-01" },
  { type: "experience", content: "Led the migration from a monolith to event-driven services, cutting p99 latency by 40%.", employer: "Acme Corp", role: "Senior Backend Engineer", date_start: "2021-03-01", date_end: "2024-08-01" },
  { type: "achievement", content: "Cut cloud spend 30% by rightsizing workloads and introducing autoscaling.", employer: "Acme Corp" },
  { type: "skill", content: "TypeScript, Node.js, PostgreSQL, and AWS (ECS, Lambda, RDS)." },
  { type: "education", content: "B.S. in Computer Science.", employer: "State University", date_start: "2013-09-01", date_end: "2017-06-01" },
  { type: "writing_sample", content: "I like building systems that are boring in the best way: predictable, well-tested, and easy for the next person to pick up. A lot of my best work has been quietly removing complexity rather than adding it." },
];

// The candidate IDENTITY (profile) — author metadata for the PDF letterhead/signature, NOT a fact (it
// never enters coverage/citation/generation). One row per user, owned by the test account. These are
// entered values only; nothing is derived or fabricated (the name is NOT taken from the email).
const PROFILE = {
  full_name: "Alex Dev",
  phone: "+1 (555) 010-2024",
  location: "Brooklyn, NY",
  professional_url: "https://github.com/alexdev",
};

const JOB = {
  title: "Senior Backend Engineer",
  company: "Globex",
  raw_text:
    "Globex is hiring a Senior Backend Engineer to own the reliability and scale of our payments platform. " +
    "You will design event-driven services, work primarily in TypeScript and PostgreSQL on AWS, and share " +
    "the on-call rotation. We value engineers who write boring, well-tested code and mentor others.",
};

const REQUIREMENTS = [
  { text: "5+ years building backend services in production", kind: "must" },
  { text: "Strong PostgreSQL and SQL skills", kind: "must" },
  { text: "Experience with event-driven architecture", kind: "nice" },
  { text: "Own service reliability and participate in on-call", kind: "responsibility" },
  { text: "TypeScript", kind: "keyword" },
];

function statusJson() {
  const res = spawnSync("npx supabase status -o json", { cwd: REPO, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`could not run 'supabase status': ${res.error.message} — is the local stack up? (npx supabase start)`);
  const out = res.stdout || "";
  const s = out.indexOf("{"), e = out.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("'supabase status -o json' returned no JSON — is the local stack up? (npx supabase start)");
  try { return JSON.parse(out.slice(s, e + 1)); } catch (err) { throw new Error(`could not parse 'supabase status' JSON: ${err.message}`); }
}
function isLoopback(u) {
  try { const h = new URL(u).hostname.replace(/^\[|\]$/g, ""); return h === "127.0.0.1" || h === "localhost" || h === "::1"; } catch { return false; }
}

async function main() {
  const st = statusJson();
  const URL = st.API_URL, ANON = st.ANON_KEY, SVC = st.SERVICE_ROLE_KEY;
  if (!URL || !ANON || !SVC) throw new Error("'supabase status' did not surface API_URL + ANON_KEY + SERVICE_ROLE_KEY");
  if (!isLoopback(URL)) throw new Error(`target ${URL} is not loopback — refusing to seed (this creates a user + data)`);

  const svc = createClient(URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });

  // 1) Idempotency: remove any prior test user + its data (jobs first to release fact citations, then
  //    facts, then the user). Only ever the test account — real accounts are untouched.
  const { data: list, error: listErr } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) throw new Error(`listUsers failed: ${listErr.message}`);
  for (const u of (list?.users ?? []).filter((u) => u.email === TEST_EMAIL)) {
    const dj = await svc.from("job").delete().eq("owner", u.id);
    if (dj.error) throw new Error(`clearing old jobs failed: ${dj.error.message}`);
    const df = await svc.from("fact").delete().eq("owner", u.id);
    if (df.error) throw new Error(`clearing old facts failed: ${df.error.message}`);
    const dp = await svc.from("profile").delete().eq("user_id", u.id);
    if (dp.error) throw new Error(`clearing old profile failed: ${dp.error.message}`);
    const du = await svc.auth.admin.deleteUser(u.id);
    if (du.error) throw new Error(`deleting old test user failed: ${du.error.message}`);
  }

  // 2) Fresh, pre-confirmed test user.
  const { data: created, error: createErr } = await svc.auth.admin.createUser({ email: TEST_EMAIL, password: TEST_PASSWORD, email_confirm: true });
  if (createErr) throw new Error(`creating test user failed: ${createErr.message}`);
  const userId = created.user.id;

  // 3) Facts (owned + verified).
  const { data: facts, error: factErr } = await svc
    .from("fact")
    .insert(FACTS.map((f) => ({ ...f, owner: userId, verified: true })))
    .select("id");
  if (factErr) throw new Error(`seeding facts failed: ${factErr.message}`);

  // 4) Job + 5) requirements.
  const { data: job, error: jobErr } = await svc.from("job").insert({ ...JOB, owner: userId }).select("id").single();
  if (jobErr) throw new Error(`seeding job failed: ${jobErr.message}`);
  const { data: reqs, error: reqErr } = await svc
    .from("requirement")
    .insert(REQUIREMENTS.map((r) => ({ ...r, job_id: job.id })))
    .select("id");
  if (reqErr) throw new Error(`seeding requirements failed: ${reqErr.message}`);

  // 6) Profile (the candidate's identity for the PDF letterhead/signature — author metadata, not a fact).
  const { error: profErr } = await svc.from("profile").insert({ user_id: userId, ...PROFILE });
  if (profErr) throw new Error(`seeding profile failed: ${profErr.message}`);

  // 7) Self-verify: the test account can sign in AND (as that authenticated user, through RLS) sees its
  //    own seeded data — exactly the path the running app uses.
  const anon = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: signIn, error: signErr } = await anon.auth.signInWithPassword({ email: TEST_EMAIL, password: TEST_PASSWORD });
  const signOk = !signErr && !!signIn?.session;
  const seenFacts = signOk ? await anon.from("fact").select("*", { count: "exact", head: true }) : null;
  const seenJob = signOk ? await anon.from("job").select("*", { count: "exact", head: true }) : null;
  const seenProfile = signOk ? await anon.from("profile").select("*", { count: "exact", head: true }) : null;

  console.log("\n✓ Seeded local dev data.");
  console.log(`  Test login:        ${TEST_EMAIL}  /  ${TEST_PASSWORD}`);
  console.log(`  Facts:             ${facts?.length ?? 0} (incl. 1 writing_sample for voice)`);
  console.log(`  Profile:           ${PROFILE.full_name} (PDF letterhead/signature identity)`);
  console.log(`  Job:               1 — "${JOB.title}" @ ${JOB.company}`);
  console.log(`  Requirements:      ${reqs?.length ?? 0}`);
  console.log(`  Sign-in check:     ${signOk ? "OK" : "FAILED — " + (signErr?.message ?? "no session")}`);
  console.log(`  Authed user sees:  facts=${seenFacts?.count ?? "?"}, job=${seenJob?.count ?? "?"}, profile=${seenProfile?.count ?? "?"} (via RLS, like the app)`);
  console.log("\nNext: npm run dev, open /login, sign in with the test login above, then visit /facts, /jobs and /profile.\n");

  if (!signOk || (seenFacts?.count ?? 0) < 1 || (seenJob?.count ?? 0) < 1 || (seenProfile?.count ?? 0) < 1) {
    throw new Error("post-seed self-check did not confirm a usable, data-visible account");
  }
}

main().catch((e) => {
  console.error(`\n✗ Seed failed: ${e.message}`);
  process.exitCode = 1;
});

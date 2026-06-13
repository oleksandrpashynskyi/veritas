// Bundled with the veritas-security-proof skill. Proves — by EXECUTION, never by
// inspection — the two security properties M1 asserted but only confirmed manually:
//
//   A) RLS deny-by-default: the public `anon` role (the publishable anon KEY, over
//      PostgREST — the real browser-facing surface) can read NO row and write NO row
//      on any of the six tables. Proven against a sentinel row the service-role
//      client provably CAN see, so "anon saw nothing" means "RLS hid it", not "empty
//      table / wrong DB".
//   B) The `server-only` guard in src/lib/db/client.ts holds at BUILD time: a Client
//      Component that imports the DB client makes `next build` fail, attributably.
//
// Prime directive (same as verify.mjs): it must FAIL HONESTLY. A false pass is worse
// than no test. Exit codes:
//   0  every registered check ran AND passed.
//   1  a real regression: anon read/wrote a row, OR the build did NOT fail on the
//      client-boundary violation.
//   2  COULD NOT VERIFY: any precondition/transport/attribution failure. No proof
//      produced; this is NOT a pass.
//
// NO SECRET IS STORED IN THIS FILE. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
// SUPABASE_ANON_KEY are read at run time from <repo>/.env.local. The anon key is the
// public publishable key, but it still lives only in .env.local (gitignored).
//
// Usage (from the repo root; no install needed — @supabase/supabase-js and next are
// already project deps, unlike verify.mjs which had to vendor pg):
//   node .claude/skills/veritas-security-proof/verify-security.mjs        # repo = cwd
//   node .claude/skills/veritas-security-proof/verify-security.mjs <repo-root>
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const REPO = process.argv[2] || process.cwd();
const ENV_FILE = path.join(REPO, ".env.local");
const NEXT_DIR = path.join(REPO, ".next");
const NEXT_BIN = path.join(REPO, "node_modules", "next", "dist", "bin", "next");
// NOTE: must NOT start with "_" — Next.js App Router treats a leading-underscore
// folder as a private folder excluded from routing, so the probe page would never
// compile and the build would (falsely) pass. A plain segment is routed and built.
const PROBE_DIR = path.join(REPO, "src", "app", "security-probe");
const PROBE_FILE = path.join(PROBE_DIR, "page.tsx");

// Shared prefix lets a later run sweep away a crashed run's leftovers; the per-run
// UUID suffix keeps concurrent runs from reading each other's rows.
const MARK_PREFIX = "VERITAS_SECURITY_PROBE_";
const MARK = MARK_PREFIX + randomUUID();

// The probe imports ONLY getDb from the real client path — NOT `server-only`
// directly. If it imported server-only itself, the build would fail even with the
// guard removed from client.ts (a false pass). Importing getDb means the build fails
// solely because client.ts carries the guard. typeof/.name keep it from being
// tree-shaken (dead-code-eliminated) before the server-only import edge is created.
const PROBE_TSX = `"use client";
import { getDb } from "@/lib/db";
export default function SecurityProbe() {
  if (typeof getDb !== "function") throw new Error("probe");
  return <div data-probe={String(getDb.name)} />;
}
`;

const SIG_PKG = "server-only";
const SIG_BOUNDARY = "cannot be imported from a Client Component module";

// The six tables, in FK dependency order (parents before children) for seeding.
const TABLE_NAMES = ["fact", "job", "requirement", "coverage", "document", "doc_line"];

// ── .env.local parsing (mirrors verify.mjs:29-41 — no dotenv dep, no secret here) ──
function envValue(predicate) {
  const txt = readFileSync(ENV_FILE, "utf8");
  for (const ln of txt.split(/\r?\n/)) {
    const m = ln.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    if (predicate(m[1].toUpperCase())) {
      let v = m[2].trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
      return v;
    }
  }
  return undefined;
}
const env = (name) => envValue((k) => k === name);

// Decode a Supabase JWT's `role` claim. Returns undefined for a non-JWT key
// (e.g. the newer sb_publishable_… format) — caller then leans on the svc-vs-anon
// sentinel contrast instead of the role pre-check.
function jwtRole(token) {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role;
  } catch {
    return undefined;
  }
}

function projectRef(url) {
  const m = (url || "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : "(local/unknown)";
}

// ── result tracking ───────────────────────────────────────────────────────────────
const checks = []; // registered security assertions: 12 anon + 1 build = 13
const EXPECTED = 13;
function record(part, name, verdict, detail) {
  checks.push({ part, name, verdict, detail });
}
function line(c) {
  const tag = c.verdict === "PASS" ? "PASS" : c.verdict === "FAIL" ? "FAIL" : "CNV ";
  return `  ${tag}  ${c.name.padEnd(18)} ${c.detail}`;
}

let fatal = null; // a precondition that means we could not even run the proof
function bail(msg) {
  fatal = msg;
}

// ── classifiers (shapes verified against @supabase/postgrest-js) ───────────────────
// A denied read is either an HTTP 200 with an empty body (RLS filtered the row that
// provably exists) OR a 4xx PostgREST error (no table GRANT). A leak is the sentinel
// coming back. status 0 = transport throw = could-not-verify. 404 = missing/[]-trap.
function classifyRead({ data, error, status }) {
  if (status === 0) return ["CNV", `transport failure (status 0): ${error?.message || "fetch failed"}`];
  if (status === 404) return ["CNV", `HTTP 404 — table/route missing or []-rewrite trap; not proof`];
  if (!error && Array.isArray(data) && data.length === 0)
    return ["PASS", `anon read returned 0 rows of a row that provably exists`];
  if (!error && Array.isArray(data) && data.length > 0)
    return ["FAIL", `LEAK — anon read returned ${data.length} sentinel row(s)`];
  const code = error?.code || "";
  const msg = (error?.message || "").split("\n")[0];
  if (error && (code === "42501" || /row-level security|permission denied/i.test(msg)))
    return ["PASS", `anon read denied (${code || status}: ${msg})`];
  // A 401/403 that is NOT a 42501 is an auth failure (invalid / expired / foreign-project
  // key) — it would FALSELY look like "denied". That proves nothing about RLS → CNV.
  if (error && (status === 401 || status === 403))
    return ["CNV", `anon key not authenticating as the anon role (${code || status}: ${msg}) — cannot prove RLS`];
  return ["CNV", `unclassified read (status=${status}, err=${code || "none"})`];
}

// A denied write is a PostgREST error whose SQLSTATE is 42501 (RLS WITH CHECK, or a
// missing INSERT grant — both deny). A success is a leak. A 23xxx (CHECK/FK/trigger)
// rejection is ambiguous — it does NOT prove RLS blocked the row — so could-not-verify.
function classifyWrite({ error, status }, expect) {
  if (status === 0) return ["CNV", `transport failure (status 0): ${error?.message || "fetch failed"}`];
  if (!error) return ["FAIL", `LEAK — anon INSERT succeeded`];
  const code = error.code || "";
  const msg = (error.message || "").split("\n")[0];
  if (code === "42501" || /row-level security|permission denied/i.test(msg))
    return ["PASS", `anon write denied by RLS (${code}: ${msg})`];
  // doc_line carries a BEFORE-INSERT provenance trigger that runs AS the anon role.
  // Since anon cannot see the sentinel fact (RLS on fact), the trigger rejects the
  // row with 23503 BEFORE RLS WITH CHECK is reached. A 23503 citing a fact that
  // provably exists can ONLY happen when fact-RLS is denying anon (if it were open the
  // probe would leak or hit 42501) — so it is a genuine denial; no row was written.
  if (expect === "provenance" && code === "23503")
    return ["PASS", `anon write rejected — it cited an existing fact it cannot see (RLS on fact); the provenance trigger refused the row, none written (${code})`];
  // Auth failure (invalid/foreign key) never reaches Postgres role-mapping, so it can
  // never be a 42501 — do not let it masquerade as an RLS denial.
  if (status === 401 || status === 403)
    return ["CNV", `anon key not authenticating as the anon role (${code || status}: ${msg}) — cannot prove RLS`];
  return ["CNV", `anon write rejected by a non-RLS error (${code}: ${msg}) — ambiguous, not proof`];
}

// ── filesystem cleanup (sync, safe to call from signal handlers) ───────────────────
function cleanupProbeSync() {
  try { rmSync(PROBE_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(NEXT_DIR, { recursive: true, force: true }); } catch {}
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { cleanupProbeSync(); process.exit(2); });
}

// ── DB seed / per-table probes / sweep cleanup ─────────────────────────────────────
const seed = {};

async function sweep(svc) {
  // Delete a marked job (cascades requirement → coverage and document → doc_line),
  // THEN the now-uncited marked facts. Order matters: protect_cited_fact blocks
  // deleting a fact while a doc_line/coverage still cites it. coverage/doc_line have
  // no marker column of their own, so they are only ever removed via the job cascade.
  try { await svc.from("job").delete().like("raw_text", MARK_PREFIX + "%"); } catch (e) { console.error("  sweep warn (job):", e.message); }
  try { await svc.from("fact").delete().like("content", MARK_PREFIX + "%"); } catch (e) { console.error("  sweep warn (fact):", e.message); }
}

async function seedSentinelGraph(svc) {
  const ins = async (table, payload, cols) => {
    const { data, error, status } = await svc.from(table).insert(payload).select(cols).single();
    if (error) throw new Error(`seed ${table} (status ${status}): ${error.message}`);
    return data;
  };
  seed.fact = (await ins("fact", { type: "skill", content: MARK }, "id")).id;
  seed.job = (await ins("job", { raw_text: MARK }, "id")).id;
  seed.requirement = (await ins("requirement", { job_id: seed.job, text: MARK, kind: "must" }, "id")).id;
  // A 2nd requirement gives the anon coverage WRITE probe a non-colliding composite PK,
  // so an (anon-insert-allowed) leak surfaces as a clean FAIL, not a PK-collision CNV.
  seed.requirement2 = (await ins("requirement", { job_id: seed.job, text: MARK, kind: "nice" }, "id")).id;
  seed.document = (await ins("document", { job_id: seed.job, type: "resume" }, "id")).id;
  // coverage has a composite PK (job_id, requirement_id) and no surrogate id.
  await ins("coverage", { job_id: seed.job, requirement_id: seed.requirement, status: "met", fact_ids: [seed.fact] }, "job_id");
  seed.doc_line = (await ins("doc_line", { document_id: seed.document, text: MARK, fact_ids: [seed.fact] }, "id")).id;
}

// Per-table: positive control (svc must see the sentinel), anon read (filtered to the
// sentinel id → empty = denied), and anon write. Write payloads are chosen per table so
// the rejection is attributable: 42501 (RLS) for the trigger-free tables and coverage
// (unmet + empty fact_ids sidesteps the fact trigger), and 23503 for doc_line (its
// mandatory fact_ids trigger, run AS anon, cannot see the fact → genuine denial; see
// classifyWrite's "provenance" branch). doc_line's own RLS is covered by its read check.
function tableProbes(svc, anon) {
  return {
    fact: {
      writeExpect: "rls",
      pc: () => svc.from("fact").select("id").eq("id", seed.fact),
      read: () => anon.from("fact").select("id").eq("id", seed.fact),
      write: () => anon.from("fact").insert({ type: "skill", content: MARK + "_w" }).select("id"),
    },
    job: {
      writeExpect: "rls",
      pc: () => svc.from("job").select("id").eq("id", seed.job),
      read: () => anon.from("job").select("id").eq("id", seed.job),
      write: () => anon.from("job").insert({ raw_text: MARK + "_w" }).select("id"),
    },
    requirement: {
      writeExpect: "rls",
      pc: () => svc.from("requirement").select("id").eq("id", seed.requirement),
      read: () => anon.from("requirement").select("id").eq("id", seed.requirement),
      write: () => anon.from("requirement").insert({ job_id: seed.job, text: MARK + "_w", kind: "nice" }).select("id"),
    },
    coverage: {
      // read: the sentinel coverage at (job, requirement). write: a NON-colliding PK
      // (job, requirement2) with unmet + empty fact_ids (default) — empty avoids the
      // fact-existence trigger (which, run AS anon, would 23503 before RLS), and the
      // fresh PK means RLS WITH CHECK is the only blocker left → 42501 when denied, or
      // a clean insert (FAIL) if anon writes were ever allowed.
      writeExpect: "rls",
      pc: () => svc.from("coverage").select("job_id").eq("job_id", seed.job).eq("requirement_id", seed.requirement),
      read: () => anon.from("coverage").select("job_id").eq("job_id", seed.job).eq("requirement_id", seed.requirement),
      write: () => anon.from("coverage").insert({ job_id: seed.job, requirement_id: seed.requirement2, status: "unmet" }).select("job_id"),
    },
    document: {
      writeExpect: "rls",
      pc: () => svc.from("document").select("id").eq("id", seed.document),
      read: () => anon.from("document").select("id").eq("id", seed.document),
      write: () => anon.from("document").insert({ job_id: seed.job, type: "cover_letter" }).select("id"),
    },
    doc_line: {
      // doc_line.fact_ids is mandatory + non-empty, so its fact-existence trigger
      // ALWAYS fires; run AS anon it cannot see the sentinel fact and rejects with
      // 23503 before RLS WITH CHECK — a genuine denial (see classifyWrite/provenance).
      // doc_line's OWN RLS is proven independently by the read check above.
      writeExpect: "provenance",
      pc: () => svc.from("doc_line").select("id").eq("id", seed.doc_line),
      read: () => anon.from("doc_line").select("id").eq("id", seed.doc_line),
      write: () => anon.from("doc_line").insert({ document_id: seed.document, text: MARK + "_w", fact_ids: [seed.fact] }).select("id"),
    },
  };
}

// ── Part A: anon RLS denial ────────────────────────────────────────────────────────
async function partA() {
  const URL = env("SUPABASE_URL");
  const SVC_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const ANON_KEY = env("SUPABASE_ANON_KEY");

  if (!URL || !SVC_KEY || !ANON_KEY) {
    return bail(
      `missing env in .env.local — need SUPABASE_URL${!URL ? " (absent)" : ""}, ` +
      `SUPABASE_SERVICE_ROLE_KEY${!SVC_KEY ? " (absent)" : ""}, ` +
      `SUPABASE_ANON_KEY${!ANON_KEY ? " (absent)" : ""}`,
    );
  }

  // Refuse to run on a key misconfig that would make the test LIE.
  const anonRole = jwtRole(ANON_KEY);
  const svcRole = jwtRole(SVC_KEY);
  if (ANON_KEY === SVC_KEY) return bail("SUPABASE_ANON_KEY equals SUPABASE_SERVICE_ROLE_KEY — cannot prove anon denial with a service key");
  if (anonRole === "service_role") return bail("SUPABASE_ANON_KEY decodes to role=service_role — it holds the service key, not the anon key");
  if (svcRole === "anon") return bail("SUPABASE_SERVICE_ROLE_KEY decodes to role=anon — service var holds the anon key; seeding would fail");
  if (anonRole && anonRole !== "anon") return bail(`SUPABASE_ANON_KEY decodes to role=${anonRole}, expected anon`);
  const roleNote = anonRole === "anon" ? "role=anon (JWT verified)" : "role pre-check skipped (non-JWT key) — relying on sentinel contrast";

  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const svc = createClient(URL, SVC_KEY, opts);
  const anon = createClient(URL, ANON_KEY, opts);

  console.log(`project ${projectRef(URL)} — anon ${roleNote}`);

  // Recover from any crashed prior run before seeding.
  await sweep(svc);

  try {
    await seedSentinelGraph(svc);
  } catch (e) {
    return bail(`could not seed sentinel graph via service role: ${e.message}`);
  }
  console.log(`seeded sentinel graph (marker ${MARK})\n`);

  const probes = tableProbes(svc, anon);

  // Positive controls: svc MUST see every sentinel, else the environment proves nothing.
  for (const t of TABLE_NAMES) {
    const res = await probes[t].pc();
    const ok = res.status !== 0 && res.status !== 404 && !res.error && Array.isArray(res.data) && res.data.length === 1;
    if (!ok) {
      return bail(`positive control failed for ${t}: service role could not read the sentinel (status=${res.status}, rows=${Array.isArray(res.data) ? res.data.length : "?"}, err=${res.error?.message || "none"})`);
    }
  }

  // The actual security assertions: anon denied a read and a write on every table.
  for (const t of TABLE_NAMES) {
    const [rv, rd] = classifyRead(await probes[t].read());
    record("A", `${t} read`, rv, rd);

    const wres = await probes[t].write();
    const [wv, wd] = classifyWrite(wres, probes[t].writeExpect);
    record("A", `${t} write`, wv, wd);
    // If anon's write LEAKED, the row carries our marker; the finally sweep removes it.
  }
}

// ── Part B: server-only build guard ────────────────────────────────────────────────
function partB() {
  if (existsSync(PROBE_DIR)) cleanupProbeSync(); // refuse to trust a stale probe
  try {
    rmSync(NEXT_DIR, { recursive: true, force: true }); // defeat stale/partial Turbopack cache
    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(PROBE_FILE, PROBE_TSX, "utf8");

    const res = spawnSync(process.execPath, [NEXT_BIN, "build"], {
      cwd: REPO,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
      env: process.env,
    });

    if (res.error) {
      record("B", "build guard", "CNV", `next could not run: ${res.error.message}`);
      return;
    }
    const out = `${res.stdout || ""}\n${res.stderr || ""}`;
    const attributable = out.includes(SIG_PKG) && out.includes(SIG_BOUNDARY);
    if (res.status === 0) {
      record("B", "build guard", "FAIL", "next build SUCCEEDED — a Client Component imported the service-role client without error");
    } else if (attributable) {
      record("B", "build guard", "PASS", `next build failed with the server-only client-boundary error (exit ${res.status})`);
    } else {
      record("B", "build guard", "CNV", `next build failed (exit ${res.status}) WITHOUT the server-only signature — unrelated breakage, not proof`);
    }
  } finally {
    cleanupProbeSync();
  }
}

// ── run ────────────────────────────────────────────────────────────────────────────
{
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  let svcForCleanup;
  try {
    const URL = env("SUPABASE_URL");
    const SVC_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
    if (URL && SVC_KEY && jwtRole(SVC_KEY) !== "anon") svcForCleanup = createClient(URL, SVC_KEY, opts);
  } catch {}

  console.log("=== Veritas security proof — anon RLS denial + server-only build guard ===\n");

  try {
    await partA();
  } catch (e) {
    bail(`unexpected error during Part A: ${e.message}`);
  } finally {
    if (svcForCleanup) await sweep(svcForCleanup); // always leave the DB as we found it
  }

  // Only run the (slow) build if the DB environment actually verified; a precondition
  // failure means "fix your env, then re-run", not "spend 60s building".
  if (!fatal) partB();

  // ── tally ──
  console.log("");
  for (const c of checks) console.log(line(c));
  console.log("");

  const fails = checks.filter((c) => c.verdict === "FAIL");
  const cnvs = checks.filter((c) => c.verdict === "CNV");

  if (fatal) {
    console.log(`✗ COULD NOT VERIFY — ${fatal}. No proof produced; this is NOT a pass.`);
    process.exit(2);
  }
  if (checks.length !== EXPECTED) {
    console.log(`✗ COULD NOT VERIFY — only ${checks.length}/${EXPECTED} checks ran. No proof produced; this is NOT a pass.`);
    process.exit(2);
  }
  if (fails.length) {
    console.log(`✗ REGRESSION — ${fails.length} security check(s) FAILED. A row leaked or the build guard did not hold. STOP; do not merge.`);
    process.exit(1);
  }
  if (cnvs.length) {
    console.log(`✗ COULD NOT VERIFY — ${cnvs.length} check(s) inconclusive. No full proof produced; this is NOT a pass.`);
    process.exit(2);
  }
  console.log("✓ SECURITY PROVED — anon denied a read and a write on all six tables; the server-only client-import build guard holds.");
  process.exit(0);
}

// Bundled with the veritas-security-proof skill. Proves — by EXECUTION, never by
// inspection — the two security properties M1 asserted but only confirmed manually:
//
//   A) RLS deny-by-default: the public `anon` role (the publishable anon KEY, over
//      PostgREST — the real browser-facing surface) can read NO row and write NO row
//      (no INSERT, UPDATE, or DELETE) on any of the six tables. Read denial is proven
//      by an UNFILTERED anon select returning 0 while the service role sees the rows.
//      Write denial is proven by SERVICE-ROLE GROUND TRUTH (did the row actually get
//      created / changed / removed?), never by trusting anon's own maskable response.
//   B) The `server-only` guard in src/lib/db/client.ts holds at BUILD time: a Client
//      Component importing the DB client makes `next build` fail, and the failure is
//      ATTRIBUTABLE — the app builds green without the probe, and fails only with the
//      probe, with the error naming security-probe/page.tsx -> src/lib/db/client.ts.
//
// Prime directive (same as verify.mjs): it must FAIL HONESTLY. A path to a false PASS
// is the worst defect a security proof can have. Exit codes:
//   0  every registered check ran AND passed.
//   1  a real regression: anon read/created/changed/removed a row, OR the build did
//      NOT fail attributably on the client-boundary violation.
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

// Attribution tokens. A PASS requires the server-only boundary error AND that the
// trace names OUR probe page importing the db client — so an UNRELATED server-only
// failure elsewhere cannot satisfy it.
const SIG_BOUNDARY = "cannot be imported from a Client Component module";
const SIG_PKG = "server-only";
const SIG_PROBE = "security-probe";
const SIG_CLIENT = /client\.ts|lib[\/\\]db/;

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
// 6 read + 6 insert + 6 update + 6 delete + 1 build = 25 registered security checks.
const checks = [];
const EXPECTED = 25;
function record(name, verdict, detail) {
  checks.push({ name, verdict, detail });
}
function line(c) {
  const tag = c.verdict === "PASS" ? "PASS" : c.verdict === "FAIL" ? "FAIL" : "CNV ";
  return `  ${tag}  ${c.name.padEnd(18)} ${c.detail}`;
}

let fatal = null; // a precondition that means we could not even run the proof
function bail(msg) {
  fatal = msg;
}

const short = (e) => (e?.message || "").split("\n")[0];

// ── READ classifier (unfiltered anon select; table is non-empty per svc) ───────────
// Denied = HTTP 200 with an empty body (RLS filtered every row) OR a 42501 grant
// error. A returned row = leak. The authoritative denial signal is the 42501 SQLSTATE
// or a 200-empty; ANY other error — including a 401/403 auth failure — is COULD NOT
// VERIFY (an auth/gateway failure must never be read as a real RLS denial).
function classifyRead({ data, error, status }) {
  if (status === 0) return ["CNV", `transport failure (status 0): ${short(error) || "fetch failed"}`];
  if (status === 404) return ["CNV", `HTTP 404 — table/route missing or []-rewrite trap; not proof`];
  if (error) {
    if (error.code === "42501") return ["PASS", `anon read denied (42501: ${short(error)})`];
    return ["CNV", `non-RLS error on anon read (${error.code || status}: ${short(error)}) — auth/gateway/other, not proof`];
  }
  if (Array.isArray(data) && data.length === 0) return ["PASS", `anon UNFILTERED read returned 0 of the rows that provably exist`];
  if (Array.isArray(data) && data.length > 0) return ["FAIL", `LEAK — anon read returned ${data.length} row(s)`];
  return ["CNV", `unclassified read (status=${status})`];
}

// ── INSERT classifier ──────────────────────────────────────────────────────────────
// PASS = the row was NOT created. The authoritative denial is the 42501 SQLSTATE (RLS
// WITH CHECK, or a missing INSERT grant). A success = leak. For doc_line ONLY, the
// fact-existence trigger (run AS anon, which cannot see the cited fact) refuses the
// insert with 23503 BEFORE RLS WITH CHECK — a genuine "no row created" denial, but NOT
// a proof of doc_line's own RLS write-denial (that is proven by its UPDATE/DELETE
// checks). Any other error — incl. 401/403 — is COULD NOT VERIFY, never PASS.
function classifyInsert({ error, status }, expect) {
  if (status === 0) return ["CNV", `transport failure (status 0): ${short(error) || "fetch failed"}`];
  if (!error) return ["FAIL", `LEAK — anon INSERT succeeded (a row was created)`];
  if (error.code === "42501") return ["PASS", `anon INSERT denied by RLS (42501: ${short(error)})`];
  if (expect === "provenance" && error.code === "23503")
    return ["PASS", `anon INSERT refused by the provenance trigger — it cited a fact it cannot read (RLS on fact); no row created (23503). doc_line's own RLS write-denial is shown by its update/delete checks`];
  return ["CNV", `non-RLS error on anon INSERT (${error.code || status}: ${short(error)}) — auth/constraint/other, not proof of RLS denial`];
}

// ── filesystem cleanup (sync, safe to call from signal handlers) ───────────────────
function cleanupProbeSync() {
  try { rmSync(PROBE_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(NEXT_DIR, { recursive: true, force: true }); } catch {}
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { cleanupProbeSync(); process.exit(2); });
}

// ── DB seed / sweep cleanup ────────────────────────────────────────────────────────
const ids = {};

async function sweep(svc) {
  // Delete marked jobs (cascades requirement → coverage and document → doc_line),
  // THEN the now-uncited marked facts. Order matters: protect_cited_fact blocks
  // deleting a fact while a doc_line/coverage still cites it. coverage/doc_line have
  // no marker column of their own, so they are only ever removed via the job cascade.
  try { await svc.from("job").delete().like("raw_text", MARK_PREFIX + "%"); } catch (e) { console.error("  sweep warn (job):", e.message); }
  try { await svc.from("fact").delete().like("content", MARK_PREFIX + "%"); } catch (e) { console.error("  sweep warn (fact):", e.message); }
}

// Seed TWO probe rows per table (so an UNFILTERED anon read proves "every row", and
// update vs delete probes get independent targets). requirement gets a 3rd row with
// no coverage, so the coverage INSERT probe has a non-colliding composite PK.
async function seedRows(svc) {
  const ins = async (table, payload, cols) => {
    const { data, error, status } = await svc.from(table).insert(payload).select(cols).single();
    if (error) throw new Error(`seed ${table} (status ${status}): ${error.message}`);
    return data;
  };
  ids.fact = [(await ins("fact", { type: "skill", content: MARK }, "id")).id,
              (await ins("fact", { type: "skill", content: MARK }, "id")).id];
  ids.job = [(await ins("job", { raw_text: MARK }, "id")).id,
             (await ins("job", { raw_text: MARK }, "id")).id];
  const J = ids.job[0];
  ids.requirement = [(await ins("requirement", { job_id: J, text: MARK, kind: "must" }, "id")).id,
                     (await ins("requirement", { job_id: J, text: MARK, kind: "nice" }, "id")).id,
                     (await ins("requirement", { job_id: J, text: MARK, kind: "keyword" }, "id")).id];
  ids.document = [(await ins("document", { job_id: J, type: "resume" }, "id")).id,
                  (await ins("document", { job_id: J, type: "resume" }, "id")).id];
  // coverage PK is composite (job_id, requirement_id); seed on requirement[0] and [1].
  await ins("coverage", { job_id: J, requirement_id: ids.requirement[0], status: "met", fact_ids: [ids.fact[0]] }, "job_id");
  await ins("coverage", { job_id: J, requirement_id: ids.requirement[1], status: "met", fact_ids: [ids.fact[0]] }, "job_id");
  ids.coverage = [{ job_id: J, requirement_id: ids.requirement[0] }, { job_id: J, requirement_id: ids.requirement[1] }];
  ids.doc_line = [(await ins("doc_line", { document_id: ids.document[0], text: MARK, fact_ids: [ids.fact[0]] }, "id")).id,
                  (await ins("doc_line", { document_id: ids.document[0], text: MARK, fact_ids: [ids.fact[0]] }, "id")).id];
}

// Per-table probe config. keyCol = the column to select for existence/leak checks.
// insertExpect "rls" → expect 42501; "provenance" → doc_line's trigger 23503 is OK.
// updTarget/delTarget are match() objects; updCol/updVal a change distinct from the
// seeded value, so svc ground-truth tells denied (unchanged) from leak (changed).
function tableConfig() {
  const J = ids.job[0];
  return {
    fact:        { keyCol: "id",     insertExpect: "rls",        insertPayload: { type: "skill", content: MARK + "_w" },
                   updTarget: { id: ids.fact[0] },        updCol: "role",   updVal: MARK + "_u", delTarget: { id: ids.fact[1] } },
    job:         { keyCol: "id",     insertExpect: "rls",        insertPayload: { raw_text: MARK + "_w" },
                   updTarget: { id: ids.job[0] },         updCol: "company", updVal: MARK + "_u", delTarget: { id: ids.job[1] } },
    requirement: { keyCol: "id",     insertExpect: "rls",        insertPayload: { job_id: J, text: MARK + "_w", kind: "nice" },
                   updTarget: { id: ids.requirement[0] }, updCol: "kind",   updVal: "keyword",   delTarget: { id: ids.requirement[1] } },
    coverage:    { keyCol: "job_id", insertExpect: "rls",        insertPayload: { job_id: J, requirement_id: ids.requirement[2], status: "unmet" },
                   updTarget: ids.coverage[0],            updCol: "status", updVal: "partial",   delTarget: ids.coverage[1] },
    document:    { keyCol: "id",     insertExpect: "rls",        insertPayload: { job_id: J, type: "cover_letter" },
                   updTarget: { id: ids.document[0] },    updCol: "status", updVal: "approved",  delTarget: { id: ids.document[1] } },
    doc_line:    { keyCol: "id",     insertExpect: "provenance", insertPayload: { document_id: ids.document[0], text: MARK + "_w", fact_ids: [ids.fact[0]] },
                   updTarget: { id: ids.doc_line[0] },    updCol: "approved", updVal: true,      delTarget: { id: ids.doc_line[1] } },
  };
}

// ── Part A: anon RLS denial (read + insert + update + delete) ───────────────────────
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
  const roleNote = anonRole === "anon" ? "role=anon (JWT verified)" : "role pre-check skipped (non-JWT key) — relying on service-role ground truth";

  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const svc = createClient(URL, SVC_KEY, opts);
  const anon = createClient(URL, ANON_KEY, opts);

  console.log(`project ${projectRef(URL)} — anon ${roleNote}`);

  await sweep(svc); // recover from any crashed prior run before seeding
  try {
    await seedRows(svc);
  } catch (e) {
    return bail(`could not seed probe rows via service role: ${e.message}`);
  }
  console.log(`seeded 2 probe rows per table (marker ${MARK})\n`);

  const cfg = tableConfig();

  // ── READ: anon UNFILTERED select must return 0, while svc proves the table is non-empty.
  for (const t of TABLE_NAMES) {
    const c = cfg[t];
    const svcAll = await svc.from(t).select(c.keyCol);
    if (svcAll.error || !Array.isArray(svcAll.data) || svcAll.data.length < 2) {
      record(`${t} read`, "CNV", `svc could not confirm >=2 rows exist (status=${svcAll.status}, rows=${Array.isArray(svcAll.data) ? svcAll.data.length : "?"}, err=${short(svcAll.error) || "none"}) — environment proves nothing`);
      continue;
    }
    const [v, d] = classifyRead(await anon.from(t).select(c.keyCol));
    record(`${t} read`, v, `${d} (svc sees ${svcAll.data.length})`);
  }

  // ── INSERT: anon attempt must be rejected (42501 RLS; doc_line provenance), no row created.
  for (const t of TABLE_NAMES) {
    const c = cfg[t];
    const [v, d] = classifyInsert(await anon.from(t).insert(c.insertPayload).select(c.keyCol), c.insertExpect);
    record(`${t} insert`, v, d);
    // a leaked insert carries our marker; the finally sweep removes it.
  }

  // ── UPDATE: anon attempt, then SERVICE-ROLE GROUND TRUTH — did the column actually change?
  for (const t of TABLE_NAMES) {
    const c = cfg[t];
    const before = await svc.from(t).select(c.updCol).match(c.updTarget).maybeSingle();
    if (before.error || !before.data) { record(`${t} update`, "CNV", `svc could not read update target before (${short(before.error) || "missing"})`); continue; }
    const original = before.data[c.updCol];
    const up = await anon.from(t).update({ [c.updCol]: c.updVal }).match(c.updTarget).select(c.keyCol);
    if (up.status === 0) { record(`${t} update`, "CNV", `transport failure on anon update (status 0)`); continue; }
    const after = await svc.from(t).select(c.updCol).match(c.updTarget).maybeSingle();
    if (after.error || !after.data) { record(`${t} update`, "CNV", `svc could not re-read update target after (${short(after.error) || "missing"})`); continue; }
    const now = after.data[c.updCol];
    if (now === original) record(`${t} update`, "PASS", `anon UPDATE denied — ${c.updCol} unchanged (svc-verified: ${JSON.stringify(now)})`);
    else record(`${t} update`, "FAIL", `LEAK — anon UPDATE changed ${c.updCol} ${JSON.stringify(original)} -> ${JSON.stringify(now)}`);
  }

  // ── DELETE: anon attempt, then SERVICE-ROLE GROUND TRUTH — is the row still there?
  for (const t of TABLE_NAMES) {
    const c = cfg[t];
    const before = await svc.from(t).select(c.keyCol).match(c.delTarget);
    if (before.error || !Array.isArray(before.data) || before.data.length !== 1) { record(`${t} delete`, "CNV", `svc could not confirm delete target exists before (${short(before.error) || "missing"})`); continue; }
    const del = await anon.from(t).delete().match(c.delTarget).select(c.keyCol);
    if (del.status === 0) { record(`${t} delete`, "CNV", `transport failure on anon delete (status 0)`); continue; }
    const after = await svc.from(t).select(c.keyCol).match(c.delTarget);
    if (after.error || !Array.isArray(after.data)) { record(`${t} delete`, "CNV", `svc could not re-read delete target after (${short(after.error)})`); continue; }
    if (after.data.length === 1) record(`${t} delete`, "PASS", `anon DELETE denied — row still present (svc-verified)`);
    else record(`${t} delete`, "FAIL", `LEAK — anon DELETE removed the row`);
  }
}

// ── Part B: server-only build guard (attributable) ─────────────────────────────────
function buildOnce() {
  rmSync(NEXT_DIR, { recursive: true, force: true }); // fresh: defeat stale/partial Turbopack cache
  const res = spawnSync(process.execPath, [NEXT_BIN, "build"], {
    cwd: REPO, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, env: process.env,
  });
  return { status: res.status, error: res.error, out: `${res.stdout || ""}\n${res.stderr || ""}` };
}

function partB() {
  if (existsSync(PROBE_DIR)) cleanupProbeSync(); // refuse to trust a stale probe
  try {
    // Control: with NO probe, the app must build GREEN — else we cannot attribute a
    // later failure to the probe rather than to pre-existing breakage.
    const base = buildOnce();
    if (base.error) { record("build guard", "CNV", `next could not run (baseline): ${base.error.message}`); return; }
    if (base.status !== 0) { record("build guard", "CNV", `baseline build (no probe) FAILED (exit ${base.status}) — app not green; cannot attribute the guard failure`); return; }

    // Now add the Client Component that imports the db client and build again.
    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(PROBE_FILE, PROBE_TSX, "utf8");
    const probe = buildOnce();
    if (probe.error) { record("build guard", "CNV", `next could not run (probe): ${probe.error.message}`); return; }

    const o = probe.out;
    const attributable = o.includes(SIG_BOUNDARY) && o.includes(SIG_PKG) && o.includes(SIG_PROBE) && SIG_CLIENT.test(o);
    if (probe.status === 0) {
      record("build guard", "FAIL", "probe build SUCCEEDED — the server-only guard did NOT block a Client Component importing the service-role client");
    } else if (attributable) {
      record("build guard", "PASS", `baseline built green; probe build failed with the server-only error naming security-probe/page.tsx -> src/lib/db/client.ts (exit ${probe.status})`);
    } else {
      record("build guard", "CNV", `probe build failed (exit ${probe.status}) but NOT attributable to our probe importing client.ts — unrelated breakage, not proof`);
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

  console.log("=== Veritas security proof — anon RLS denial (read+insert+update+delete) + server-only build guard ===\n");

  try {
    await partA();
  } catch (e) {
    bail(`unexpected error during Part A: ${e.message}`);
  } finally {
    if (svcForCleanup) await sweep(svcForCleanup); // always leave the DB as we found it
  }

  // Only run the (slow, 2x) build if the DB environment actually verified; a
  // precondition failure means "fix your env, then re-run", not "spend time building".
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
  console.log("✓ SECURITY PROVED — anon denied read + insert + update + delete on all six tables; the server-only client-import build guard holds attributably.");
  process.exit(0);
}

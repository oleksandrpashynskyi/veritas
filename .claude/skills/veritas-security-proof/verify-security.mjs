// Bundled with the veritas-security-proof skill. Proves — by EXECUTION, never by
// inspection — the two security properties M1 asserted but only confirmed manually:
//
//   A) RLS deny-by-default for the public `anon` role (the publishable anon KEY, over
//      PostgREST — the real browser-facing surface), on all six tables:
//        • READ — an UNFILTERED anon select returns 0 rows while the service role sees
//          the rows, so "anon got nothing" means "RLS hid every row".
//        • WRITE — for a REPRESENTATIVE seeded row of each table, anon INSERT / UPDATE
//          / DELETE are denied, judged SOLELY by SERVICE-ROLE GROUND TRUTH: did a row
//          actually appear / change / disappear? Anon's own response is never trusted
//          to mean "denied" — a leak is a real DB change; a PASS additionally requires
//          the write to have reached Postgres (a clean 2xx no-op, or a SQLSTATE
//          rejection like 42501), so a 401/403/405/gateway/transport error is COULD
//          NOT VERIFY, never "denied". (Exhaustive per-payload-shape write coverage is
//          deferred hardening; this proves a representative write per table.)
//   B) The `server-only` guard in src/lib/db/client.ts holds at BUILD time: a Client
//      Component importing the db client DIRECTLY (`@/lib/db/client`) makes `next
//      build` fail ATTRIBUTABLY — the app builds green without the probe and fails only
//      with it, the error naming security-probe/page.tsx -> client.ts SPECIFICALLY, so
//      the guard cannot escape detection by being relocated off client.ts.
//
// Prime directive (same as verify.mjs): it must FAIL HONESTLY. A path to a false PASS
// is the worst defect a security proof can have. Exit codes:
//   0  every registered check ran AND passed.
//   1  a real regression: anon read a row / a write changed the DB, OR the build did
//      not fail attributably on the client-boundary violation.
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

// The probe imports getDb from the DB CLIENT MODULE DIRECTLY (`@/lib/db/client`), not
// the barrel `@/lib/db` — so the build fails iff `client.ts` itself carries the guard
// (the guard cannot hide by moving to index.ts). It imports ONLY getDb (never
// `server-only` directly), so the failure is caused solely by client.ts's guard.
// typeof/.name keep getDb from being tree-shaken before the server-only edge forms.
const PROBE_TSX = `"use client";
import { getDb } from "@/lib/db/client";
export default function SecurityProbe() {
  if (typeof getDb !== "function") throw new Error("probe");
  return <div data-probe={String(getDb.name)} />;
}
`;

// Attribution tokens. A PASS requires the server-only boundary error AND that the
// trace names OUR probe page AND `client.ts` specifically — so an UNRELATED
// server-only failure, or the guard being relocated off client.ts, cannot satisfy it.
const SIG_BOUNDARY = "cannot be imported from a Client Component module";
const SIG_PKG = "server-only";
const SIG_PROBE = "security-probe";
const SIG_CLIENT = "client.ts";

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
// (e.g. the newer sb_publishable_… format) — caller then leans on service-role ground
// truth instead of the role pre-check.
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

// ── READ classifier (unfiltered anon select; svc has proven the table non-empty) ───
// Denied = HTTP 200 with an empty body (RLS filtered every row) OR a 42501 grant
// error. A returned row = leak. ANY other error — including a 401/403 auth failure —
// is COULD NOT VERIFY (an auth/gateway failure must never be read as an RLS denial).
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

// ── WRITE judging — ground truth only ──────────────────────────────────────────────
// "Did the anon write reach Postgres?" A clean 2xx (executed, RLS filtered to 0 rows)
// or a Postgres SQLSTATE rejection (42501 RLS, 23xxx constraint/trigger) means yes;
// a transport failure (status 0) or a non-SQLSTATE error (401/403 JWT, 405, 5xx
// gateway — error.code like "PGRST301" or empty) means the write never reached RLS.
//
// KNOWN EDGE (Codex review #3): "no error" is not a PERFECT proxy for "reached
// Postgres". postgrest-js PostgrestBuilder.processResponse (node_modules/@supabase/
// postgrest-js/dist/index.mjs:370-385, src/PostgrestBuilder.ts) normalizes some 404s:
// a 404 whose body parses to a JSON ARRAY becomes {data:[], error:null, status:200};
// a 404 with an EMPTY body becomes {error:null, status:204}. So a write that never
// reached Postgres could arrive here error-free. Cheap tightening applied below: a 200
// no-op from a `.select()` write is the genuine deny outcome, but 204 and any residual
// 404 are NOT — treat them as not-processed (→ COULD NOT VERIFY). The array-body→200
// case is indistinguishable from a real RLS-filtered `200 []` and is left as documented
// deferred hardening: it cannot occur for a write in practice (a 404 write body is an
// error object, not an array) and the same-table service-role ground-truth reads would
// themselves CNV if the table were truly missing — so it cannot mask a real leak.
function dbProcessed(res) {
  if (!res || res.status === 0) return false;          // transport — never reached the server
  if (res.status === 404 || res.status === 204) return false; // postgrest-js 404-normalization edge — not a proven RLS denial
  if (!res.error) return true;                          // executed (2xx); RLS filtered to 0 rows
  return /^[0-9A-Z]{5}$/.test(res.error.code || "");    // a Postgres SQLSTATE (42501, 23xxx) — not a PGRST/auth/gateway code
}

// Judge an anon write SOLELY by service-role ground truth: the verdict is the DB's
// before→after state, NEVER anon's self-reported success/error.
//   before/after: a comparable snapshot of the DB state read by the SERVICE role.
//   A changed state = LEAK (FAIL) regardless of what anon's call claimed.
//   Unchanged + the write reached Postgres = denied (PASS).
//   Unchanged but the write never reached RLS, or svc can't read the state = CNV.
function judgeWrite(beforeOk, before, afterOk, after, anonRes, changedMsg) {
  if (!beforeOk) return ["CNV", `svc could not read the DB state before the write — environment proves nothing`];
  if (!afterOk) return ["CNV", `svc could not confirm the DB state after the write — cannot judge by ground truth`];
  if (before !== after) return ["FAIL", `LEAK — ${changedMsg}`];
  if (!dbProcessed(anonRes)) return ["CNV", `anon write did not reach RLS (status=${anonRes?.status}, code=${anonRes?.error?.code || "none"}) — DB unchanged but the denial was not exercised`];
  return ["PASS", `anon write denied — DB unchanged (svc ground truth)`];
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
  // deleting a fact while a doc_line/coverage still cites it. Every probe/leak row is
  // either a marked fact/job or a child of a marked job, so this removes them all.
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
  await ins("coverage", { job_id: J, requirement_id: ids.requirement[0], status: "met", fact_ids: [ids.fact[0]] }, "job_id");
  await ins("coverage", { job_id: J, requirement_id: ids.requirement[1], status: "met", fact_ids: [ids.fact[0]] }, "job_id");
  ids.coverage = [{ job_id: J, requirement_id: ids.requirement[0] }, { job_id: J, requirement_id: ids.requirement[1] }];
  ids.doc_line = [(await ins("doc_line", { document_id: ids.document[0], text: MARK, fact_ids: [ids.fact[0]] }, "id")).id,
                  (await ins("doc_line", { document_id: ids.document[0], text: MARK, fact_ids: [ids.fact[0]] }, "id")).id];
}

// Per-table probe config. keyCol = the column selected for existence checks.
// insertPayload references existing seeded parents so only RLS can reject it (or, for
// doc_line, the fact-existence trigger — both are SQLSTATE rejections that create no
// row). updTarget/delTarget are match() objects; updCol/updVal a change distinct from
// the seeded value, so svc ground-truth tells denied (unchanged) from leak (changed).
function tableConfig() {
  const J = ids.job[0];
  return {
    fact:        { keyCol: "id",     insertPayload: { type: "skill", content: MARK + "_w" },
                   updTarget: { id: ids.fact[0] },        updCol: "role",     updVal: MARK + "_u", delTarget: { id: ids.fact[1] } },
    job:         { keyCol: "id",     insertPayload: { raw_text: MARK + "_w" },
                   updTarget: { id: ids.job[0] },         updCol: "company",  updVal: MARK + "_u", delTarget: { id: ids.job[1] } },
    requirement: { keyCol: "id",     insertPayload: { job_id: J, text: MARK + "_w", kind: "nice" },
                   updTarget: { id: ids.requirement[0] }, updCol: "kind",     updVal: "keyword",   delTarget: { id: ids.requirement[1] } },
    coverage:    { keyCol: "job_id", insertPayload: { job_id: J, requirement_id: ids.requirement[2], status: "unmet" },
                   updTarget: ids.coverage[0],            updCol: "status",   updVal: "partial",   delTarget: ids.coverage[1] },
    document:    { keyCol: "id",     insertPayload: { job_id: J, type: "cover_letter" },
                   updTarget: { id: ids.document[0] },    updCol: "status",   updVal: "approved",  delTarget: { id: ids.document[1] } },
    doc_line:    { keyCol: "id",     insertPayload: { document_id: ids.document[0], text: MARK + "_w", fact_ids: [ids.fact[0]] },
                   updTarget: { id: ids.doc_line[0] },    updCol: "approved", updVal: true,        delTarget: { id: ids.doc_line[1] } },
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
  const svcCount = (t, match) => {
    let q = svc.from(t).select("*", { count: "exact", head: true });
    if (match) q = q.match(match);
    return q;
  };

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

  // ── INSERT: did a NEW row appear? (svc full-table count before/after) ──
  for (const t of TABLE_NAMES) {
    const c = cfg[t];
    const before = await svcCount(t);
    const res = await anon.from(t).insert(c.insertPayload).select(c.keyCol);
    const after = await svcCount(t);
    const [v, d] = judgeWrite(
      before.error == null, before.count,
      after.error == null, after.count,
      res,
      `anon INSERT created a row (count ${before.count} -> ${after.count})`,
    );
    record(`${t} insert`, v, d);
    // a leaked insert is a marked row or a child of the marked job; the finally sweep removes it.
  }

  // ── UPDATE: did the target column change? (svc reads it before/after) ──
  for (const t of TABLE_NAMES) {
    const c = cfg[t];
    const before = await svc.from(t).select(c.updCol).match(c.updTarget).maybeSingle();
    const res = await anon.from(t).update({ [c.updCol]: c.updVal }).match(c.updTarget).select(c.keyCol);
    const after = await svc.from(t).select(c.updCol).match(c.updTarget).maybeSingle();
    const bv = before.data ? JSON.stringify(before.data[c.updCol]) : undefined;
    const av = after.data ? JSON.stringify(after.data[c.updCol]) : undefined;
    const [v, d] = judgeWrite(
      before.error == null && before.data != null, bv,
      after.error == null && after.data != null, av,
      res,
      `anon UPDATE changed ${c.updCol} ${bv} -> ${av}`,
    );
    record(`${t} update`, v, d);
  }

  // ── DELETE: is the target row still present? (svc counts it before/after) ──
  for (const t of TABLE_NAMES) {
    const c = cfg[t];
    const before = await svcCount(t, c.delTarget);
    const res = await anon.from(t).delete().match(c.delTarget).select(c.keyCol);
    const after = await svcCount(t, c.delTarget);
    const [v, d] = judgeWrite(
      before.error == null && before.count === 1, before.count,
      after.error == null, after.count,
      res,
      `anon DELETE removed the row (count ${before.count} -> ${after.count})`,
    );
    record(`${t} delete`, v, d);
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

    // Now add the Client Component that imports the db client DIRECTLY and build again.
    mkdirSync(PROBE_DIR, { recursive: true });
    writeFileSync(PROBE_FILE, PROBE_TSX, "utf8");
    const probe = buildOnce();
    if (probe.error) { record("build guard", "CNV", `next could not run (probe): ${probe.error.message}`); return; }

    const o = probe.out;
    const attributable = o.includes(SIG_BOUNDARY) && o.includes(SIG_PKG) && o.includes(SIG_PROBE) && o.includes(SIG_CLIENT);
    if (probe.status === 0) {
      record("build guard", "FAIL", "probe build SUCCEEDED — the server-only guard did NOT block a Client Component importing the service-role client");
    } else if (attributable) {
      record("build guard", "PASS", `baseline built green; probe build failed with the server-only error naming security-probe/page.tsx -> client.ts (exit ${probe.status})`);
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

  console.log("=== Veritas security proof — anon RLS denial (read + insert/update/delete by ground truth) + server-only build guard ===\n");

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
  console.log("✓ SECURITY PROVED — anon denied every read (unfiltered) and denied insert/update/delete on a representative row of all six tables (service-role ground truth); the server-only client-import build guard holds attributably.");
  process.exit(0);
}

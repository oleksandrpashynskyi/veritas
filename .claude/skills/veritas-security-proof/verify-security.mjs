// Bundled with the veritas-security-proof skill. Proves — by EXECUTION, never by
// inspection — three security properties, against a LOCAL throwaway Supabase stack:
//
//   A) RLS deny-by-default for the public `anon` role (the publishable anon KEY, over
//      PostgREST), on all six tables: anon can READ no row (an UNFILTERED select returns
//      0 while the service role sees the rows) and WRITE no row (insert/update/delete on
//      a representative seeded row of each table, judged SOLELY by SERVICE-ROLE GROUND
//      TRUTH). The anon INSERT probe supplies a VALID owner, so the ONLY thing that can
//      deny it is authorization — and a PASS requires the specific `42501` denial.
//   C) Per-user OWNERSHIP isolation for the `authenticated` role (Auth Foundation /
//      M1.5), run in BOTH directions (A-attacks-B AND B-attacks-A) for EVERY table and
//      EVERY operation — so an asymmetric policy bug (e.g. a leaked/hardcoded uid that
//      lets B reach A but not A reach B) cannot stay green. Per direction per table:
//        • READ — attacker sees its OWN rows and SPECIFICALLY NOT the victim's seeded
//          rows (by exact id); an empty/partial read is CNV, never a denial.
//        • WRITE — INSERT-as-victim and give-away (re-own/re-parent to the victim) are a
//          hard `42501`; cross-user UPDATE/DELETE are a SILENT RLS no-op (request
//          SUCCEEDS with zero rows) leaving the victim's row unchanged/present; any ERROR
//          on these is CNV, not a pass. Positive controls (the owner acting on its OWN
//          rows) confirm every denial is RLS-specific, not universal breakage.
//   B) The `server-only` guard in src/lib/db/client.ts holds at BUILD time: a Client
//      Component importing the db client DIRECTLY (`@/lib/db/client`) makes `next build`
//      fail ATTRIBUTABLY (green without the probe, fails only with it, naming client.ts).
//
// LOCAL-ONLY: `owner` is NOT NULL, so even Part A's seed rows need a real auth.users
// owner — this proof therefore CREATES and DELETES auth users. Safe only on a disposable
// local stack, so it REFUSES to run unless SUPABASE_URL is loopback.
//
// Prime directive: it must FAIL HONESTLY. A path to a false PASS is the worst defect a
// security proof can have. Each write check requires its SPECIFIC expected outcome:
// hard-denials require `42501` + DB unchanged; no-ops require success-with-zero-rows + DB
// unchanged; anything else is CNV. Exit codes:
//   0  every registered check ran AND passed.
//   1  a real regression: a row leaked / a write crossed an isolation boundary, OR the
//      build did not fail attributably on the client-boundary violation.
//   2  COULD NOT VERIFY: any precondition/transport/attribution/ground-truth failure, a
//      non-loopback URL, an unexpected outcome, or fewer than the registered checks ran.
//
// NO SECRET IS STORED IN THIS FILE. SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
// SUPABASE_ANON_KEY are read at run time from <repo>/.env.test.local (preferred) or
// <repo>/.env.local.
//
// Usage (from the repo root):
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
const ENV_FILE = existsSync(path.join(REPO, ".env.test.local"))
  ? path.join(REPO, ".env.test.local")
  : path.join(REPO, ".env.local");
const NEXT_DIR = path.join(REPO, ".next");
const NEXT_BIN = path.join(REPO, "node_modules", "next", "dist", "bin", "next");
const PROBE_DIR = path.join(REPO, "src", "app", "security-probe");
const PROBE_FILE = path.join(PROBE_DIR, "page.tsx");

const MARK_PREFIX = "VERITAS_SECURITY_PROBE_";
const MARK = MARK_PREFIX + randomUUID();

const TEST_USERS = {
  A: { email: "veritas-proof-a@example.com" },
  B: { email: "veritas-proof-b@example.com" },
};
const TEST_PW = "veritas-proof-pw-0192";

const PROBE_TSX = `"use client";
import { getDb } from "@/lib/db/client";
export default function SecurityProbe() {
  if (typeof getDb !== "function") throw new Error("probe");
  return <div data-probe={String(getDb.name)} />;
}
`;

const SIG_BOUNDARY = "cannot be imported from a Client Component module";
const SIG_PKG = "server-only";
const SIG_PROBE = "security-probe";
const SIG_CLIENT = "client.ts";

// The six tables, in FK dependency order (parents before children) for seeding.
const TABLE_NAMES = ["fact", "job", "requirement", "coverage", "document", "doc_line"];

// ── .env parsing (no dotenv dep, no secret here) ────────────────────────────────────
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

function jwtClaims(token) {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}
const jwtRole = (token) => jwtClaims(token)?.role;

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

// ── result tracking ───────────────────────────────────────────────────────────────
// 24 anon (read/insert/update/delete × 6) + 96 cross-user isolation (6 tables × 8 ops ×
// 2 directions) + 1 build guard = 121.
const checks = [];
const EXPECTED = 121;
function record(name, verdict, detail) {
  checks.push({ name, verdict, detail });
}
function line(c) {
  const tag = c.verdict === "PASS" ? "PASS" : c.verdict === "FAIL" ? "FAIL" : "CNV ";
  return `  ${tag}  ${c.name.padEnd(26)} ${c.detail}`;
}

let fatal = null; // a precondition that means we could not even run the proof
function bail(msg) {
  fatal = msg;
}

const short = (e) => (e?.message || "").split("\n")[0];

// ── READ classifier (unfiltered anon select; svc has proven the table non-empty) ───
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

// ── anon WRITE judging (update/delete) — ground truth + reached-Postgres proxy ──────
function dbProcessed(res) {
  if (!res || res.status === 0) return false;          // transport — never reached the server
  if (res.status === 404 || res.status === 204) return false; // postgrest-js 404-normalization edge
  if (!res.error) return true;                          // executed (2xx); RLS filtered to 0 rows
  return /^[0-9A-Z]{5}$/.test(res.error.code || "");    // a Postgres SQLSTATE (42501, 23xxx)
}
function judgeWrite(beforeOk, before, afterOk, after, anonRes, changedMsg) {
  if (!beforeOk) return ["CNV", `svc could not read the DB state before the write — environment proves nothing`];
  if (!afterOk) return ["CNV", `svc could not confirm the DB state after the write — cannot judge by ground truth`];
  if (before !== after) return ["FAIL", `LEAK — ${changedMsg}`];
  if (!dbProcessed(anonRes)) return ["CNV", `anon write did not reach RLS (status=${anonRes?.status}, code=${anonRes?.error?.code || "none"}) — DB unchanged but the denial was not exercised`];
  return ["PASS", `anon write denied — DB unchanged (svc ground truth)`];
}

// anon INSERT must be denied by AUTHORIZATION (42501), not by a column/constraint error
// (the payload now carries a VALID owner, so NOT NULL / FK cannot be what blocks it). A
// constraint or any other SQLSTATE that leaves the DB unchanged is CNV, NOT a pass.
function judgeAnonInsert(beforeOk, before, afterOk, after, res) {
  if (!beforeOk || !afterOk) return ["CNV", `svc could not count rows around the anon insert`];
  if (before !== after) return ["FAIL", `LEAK — anon INSERT created a row (count ${before} -> ${after})`];
  const c = res?.error?.code;
  if (c === "42501") return ["PASS", `anon INSERT denied 42501 (permission denied); no row created`];
  return ["CNV", `anon INSERT left DB unchanged but response was not 42501 (status=${res?.status}, code=${c || "none"}) — not a proven authorization denial`];
}

// A write that SUCCEEDED affecting zero rows: 204 (return=minimal) or 200 [] (the
// return=representation form the harness gets from `.select()`).
function isZeroRowSuccess(res) {
  if (!res || res.error) return false;
  if (res.status === 204) return true;
  if (res.status === 200 && Array.isArray(res.data) && res.data.length === 0) return true;
  return false;
}

// ── Part C judging helpers — ground truth, SPECIFIC outcomes ────────────────────────
// A hard-deny: DB count/value UNCHANGED and the response is the specific SQLSTATE.
function recordHardDeny(label, before, after, res, code, what) {
  if (!before.ok || !after.ok) return record(label, "CNV", `svc could not read ground truth for ${what}`);
  if (before.val !== after.val) return record(label, "FAIL", `LEAK — ${what} changed ${before.val} -> ${after.val}`);
  const c = res?.error?.code;
  if (c === code) return record(label, "PASS", `denied ${code}; ${what} unchanged (svc ground truth)`);
  return record(label, "CNV", `${what} unchanged but response was not ${code} (status=${res?.status}, code=${c || "none"}) — denial not exercised as expected`);
}
// A cross-user UPDATE no-op: victim value UNCHANGED, and the request was a zero-row
// SUCCESS (the genuine RLS filter outcome). An ERROR is CNV — it never exercised the no-op.
function recordNoopUpdate(label, before, after, res, what) {
  if (!before.ok || !after.ok) return record(label, "CNV", `svc could not read ${what} (target may not exist) — cannot prove the write was denied`);
  if (before.val !== after.val) return record(label, "FAIL", `LEAK — ${what} changed ${before.val} -> ${after.val}`);
  if (res?.error) return record(label, "CNV", `${what} unchanged but the non-owner UPDATE ERRORED (status=${res?.status}, code=${res.error.code || "none"}) — not the expected RLS no-op`);
  if (isZeroRowSuccess(res)) return record(label, "PASS", `${what} unchanged; non-owner UPDATE was a silent RLS no-op (status ${res?.status}, 0 rows)`);
  return record(label, "CNV", `${what} unchanged but the UPDATE outcome was unexpected (status=${res?.status}, rows=${Array.isArray(res?.data) ? res.data.length : "?"})`);
}
// A cross-user DELETE no-op: victim row still PRESENT, and the request was a zero-row
// SUCCESS. An ERROR is CNV.
function recordNoopDelete(label, before, after, res, what) {
  if (!before.ok || !after.ok) return record(label, "CNV", `svc could not count ${what}`);
  if (before.val !== 1) return record(label, "CNV", `${what} not present before (count=${before.val}) — cannot prove deletion was denied`);
  if (after.val !== 1) return record(label, "FAIL", `LEAK — ${what} deleted by non-owner (count ${before.val} -> ${after.val})`);
  if (res?.error) return record(label, "CNV", `${what} still present but the non-owner DELETE ERRORED (status=${res?.status}, code=${res.error.code || "none"}) — not the expected RLS no-op`);
  if (isZeroRowSuccess(res)) return record(label, "PASS", `${what} still present; non-owner DELETE was a silent RLS no-op (status ${res?.status}, 0 rows)`);
  return record(label, "CNV", `${what} still present but the DELETE outcome was unexpected (status=${res?.status}, rows=${Array.isArray(res?.data) ? res.data.length : "?"})`);
}
// Positive controls — the owner CAN act on its OWN row. A failure is CNV (env/policy
// misbuilt), which invalidates the corresponding deny proofs.
function recordPositiveAppear(label, before, after, res, what) {
  if (res?.error) return record(label, "CNV", `positive control failed — owner could not create ${what} (${res.error.code || res.status}: ${short(res.error)}); deny checks are not trustworthy`);
  if (!before.ok || !after.ok) return record(label, "CNV", `svc could not count ${what}`);
  if (after.val === before.val + 1) return record(label, "PASS", `owner created ${what} (count ${before.val} -> ${after.val})`);
  return record(label, "CNV", `owner insert returned no error but count ${before.val} -> ${after.val} (expected +1)`);
}
function recordPositiveChange(label, after, expected, res, what) {
  if (res?.error) return record(label, "CNV", `positive control failed — owner could not update ${what} (${res.error.code || res.status}); deny checks not trustworthy`);
  if (!after.ok) return record(label, "CNV", `svc could not read ${what} after the owner update`);
  if (after.val === expected) return record(label, "PASS", `owner updated its own ${what} -> ${expected}`);
  return record(label, "CNV", `owner update returned no error but ${what}=${after.val} (expected ${expected})`);
}
function recordPositiveDelete(label, before, after, res, what) {
  if (res?.error) return record(label, "CNV", `positive control failed — owner could not delete ${what} (${res.error.code || res.status}); deny checks not trustworthy`);
  if (!before.ok || !after.ok) return record(label, "CNV", `svc could not count ${what}`);
  if (before.val === 1 && after.val === 0) return record(label, "PASS", `owner deleted its own ${what} (count 1 -> 0)`);
  return record(label, "CNV", `owner delete returned no error but count ${before.val} -> ${after.val} (expected 1 -> 0)`);
}
// Read isolation: client must see ALL ownIds and NONE of otherIds (by specific id).
async function checkReadIso(client, table, label, ownIds, otherIds, keyCol = "id") {
  const { data, error, status } = await client.from(table).select(keyCol);
  if (error) return record(label, "CNV", `read errored (status ${status}: ${short(error)}) — cannot prove isolation`);
  if (!Array.isArray(data)) return record(label, "CNV", `read returned non-array (status ${status})`);
  const seen = new Set(data.map((r) => r[keyCol]));
  const missingOwn = ownIds.filter((id) => !seen.has(id));
  const leaked = otherIds.filter((id) => seen.has(id));
  if (missingOwn.length) return record(label, "CNV", `attacker could not see ${missingOwn.length}/${ownIds.length} of its OWN seeded rows (saw ${data.length}) — login/RLS misconfigured; an empty/partial read is not a denial`);
  if (leaked.length) return record(label, "FAIL", `LEAK — saw ${leaked.length} of the victim's specific row(s)`);
  return record(label, "PASS", `sees own ${ownIds.length}, none of the victim's ${otherIds.length} (saw ${data.length} total)`);
}

// ── svc (BYPASSRLS) ground-truth readers used by the batteries ──────────────────────
async function insSvc(svc, table, payload, cols = "id") {
  const { data, error, status } = await svc.from(table).insert(payload).select(cols).single();
  if (error) throw new Error(`battery seed ${table} (status ${status}): ${error.message}`);
  return data;
}
async function gtColBy(svc, table, keyCol, keyVal, c) {
  const r = await svc.from(table).select(c).eq(keyCol, keyVal).maybeSingle();
  return { ok: r.error == null && r.data != null, val: r.data ? JSON.stringify(r.data[c]) : undefined };
}
async function gtCol(svc, table, id, c) {
  return gtColBy(svc, table, "id", id, c);
}
async function gtExists(svc, table, id) {
  const r = await svc.from(table).select("*", { count: "exact", head: true }).eq("id", id);
  return { ok: r.error == null, val: r.count };
}
async function gtCntEq(svc, table, col, val) {
  const r = await svc.from(table).select("*", { count: "exact", head: true }).eq(col, val);
  return { ok: r.error == null, val: r.count };
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
const ids = {}; // Part A seeded row ids (+ ids.owner)
let SVC = null; // module-scope service client, so cleanup runs even if setup() bails

async function sweep(svc) {
  // Delete marked jobs (cascades requirement/coverage and document/doc_line), THEN the
  // now-uncited marked facts. Order matters: protect_cited_fact blocks deleting a fact
  // while a doc_line/coverage still cites it.
  try { await svc.from("job").delete().like("raw_text", MARK_PREFIX + "%"); } catch (e) { console.error("  sweep warn (job):", e.message); }
  try { await svc.from("fact").delete().like("content", MARK_PREFIX + "%"); } catch (e) { console.error("  sweep warn (fact):", e.message); }
}

async function deleteTestUsers(svc) {
  try {
    const { data } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const emails = new Set([TEST_USERS.A.email, TEST_USERS.B.email]);
    for (const u of data?.users || []) {
      if (emails.has(u.email)) { try { await svc.auth.admin.deleteUser(u.id); } catch {} }
    }
  } catch {}
}

async function createTestUser(svc, email) {
  const { data, error } = await svc.auth.admin.createUser({ email, password: TEST_PW, email_confirm: true });
  if (error) throw new Error(`admin.createUser(${email}): ${error.message}`);
  return data.user.id;
}

async function signInToken(URL, ANON_KEY, email) {
  const c = createClient(URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email, password: TEST_PW });
  if (error || !data?.session?.access_token) throw new Error(`signIn(${email}): ${error?.message || "no session"}`);
  return data.session.access_token;
}

// A per-user PostgREST client that carries the user's JWT on every request.
function userClient(URL, ANON_KEY, token) {
  return createClient(URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

// Seed TWO probe rows per table for Part A (anon), all owned by `owner`.
async function seedRows(svc, owner) {
  ids.owner = owner; // a valid auth.users id, used in the anon INSERT payloads
  const ins = async (table, payload, cols) => {
    const { data, error, status } = await svc.from(table).insert(payload).select(cols).single();
    if (error) throw new Error(`seed ${table} (status ${status}): ${error.message}`);
    return data;
  };
  ids.fact = [(await ins("fact", { type: "skill", content: MARK, owner }, "id")).id,
              (await ins("fact", { type: "skill", content: MARK, owner }, "id")).id];
  ids.job = [(await ins("job", { raw_text: MARK, owner }, "id")).id,
             (await ins("job", { raw_text: MARK, owner }, "id")).id];
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

// Per-table probe config for Part A (anon). The fact/job INSERT payloads carry a VALID
// owner, so only AUTHORIZATION can deny them (not a NOT NULL / FK constraint).
function tableConfig() {
  const J = ids.job[0];
  return {
    fact:        { keyCol: "id",     insertPayload: { type: "skill", content: MARK + "_w", owner: ids.owner },
                   updTarget: { id: ids.fact[0] },        updCol: "role",     updVal: MARK + "_u", delTarget: { id: ids.fact[1] } },
    job:         { keyCol: "id",     insertPayload: { raw_text: MARK + "_w", owner: ids.owner },
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

// ── shared setup: env, loopback guard, clients, users, Part A seeding ───────────────
async function setup() {
  const URL = env("SUPABASE_URL");
  const SVC_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const ANON_KEY = env("SUPABASE_ANON_KEY");
  if (!URL || !SVC_KEY || !ANON_KEY) {
    bail(`missing env in ${path.basename(ENV_FILE)} — need SUPABASE_URL${!URL ? " (absent)" : ""}, ` +
      `SUPABASE_SERVICE_ROLE_KEY${!SVC_KEY ? " (absent)" : ""}, SUPABASE_ANON_KEY${!ANON_KEY ? " (absent)" : ""}`);
    return null;
  }
  if (!isLoopbackUrl(URL)) {
    bail(`SUPABASE_URL is not loopback (${URL}) — this proof creates and deletes auth users, so it runs only against a local throwaway stack. Point ${path.basename(ENV_FILE)} at \`supabase start\`.`);
    return null;
  }
  const anonRole = jwtRole(ANON_KEY);
  const svcRole = jwtRole(SVC_KEY);
  if (ANON_KEY === SVC_KEY) { bail("SUPABASE_ANON_KEY equals SUPABASE_SERVICE_ROLE_KEY — cannot prove denial with a service key"); return null; }
  if (anonRole === "service_role") { bail("SUPABASE_ANON_KEY decodes to role=service_role — it holds the service key, not the anon key"); return null; }
  if (svcRole === "anon") { bail("SUPABASE_SERVICE_ROLE_KEY decodes to role=anon — service var holds the anon key; seeding would fail"); return null; }
  if (anonRole && anonRole !== "anon") { bail(`SUPABASE_ANON_KEY decodes to role=${anonRole}, expected anon`); return null; }
  const roleNote = anonRole === "anon" ? "role=anon (JWT verified)" : "role pre-check skipped (non-JWT key)";

  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const svc = createClient(URL, SVC_KEY, opts);
  SVC = svc;
  const anon = createClient(URL, ANON_KEY, opts);
  console.log(`project ${projectRef(URL)} (local) — anon ${roleNote}`);

  await sweep(svc);
  await deleteTestUsers(svc);

  let idA, idB, userA, userB;
  try {
    idA = await createTestUser(svc, TEST_USERS.A.email);
    idB = await createTestUser(svc, TEST_USERS.B.email);
  } catch (e) {
    bail(`could not create test users: ${e.message}`);
    return null;
  }
  try {
    const tokenA = await signInToken(URL, ANON_KEY, TEST_USERS.A.email);
    const tokenB = await signInToken(URL, ANON_KEY, TEST_USERS.B.email);
    const cA = jwtClaims(tokenA);
    const cB = jwtClaims(tokenB);
    if (cA?.role !== "authenticated" || cA?.sub !== idA) { bail(`user A token role/sub mismatch (role=${cA?.role}, sub=${cA?.sub}, expected authenticated/${idA})`); return null; }
    if (cB?.role !== "authenticated" || cB?.sub !== idB) { bail(`user B token role/sub mismatch (role=${cB?.role}, sub=${cB?.sub}, expected authenticated/${idB})`); return null; }
    userA = userClient(URL, ANON_KEY, tokenA);
    userB = userClient(URL, ANON_KEY, tokenB);
  } catch (e) {
    bail(`could not sign in test users: ${e.message}`);
    return null;
  }
  try {
    await seedRows(svc, idA);
  } catch (e) {
    bail(`could not seed probe rows via service role: ${e.message}`);
    return null;
  }
  console.log(`seeded Part A probe rows (marker ${MARK}); users A=${idA.slice(0, 8)} B=${idB.slice(0, 8)}\n`);
  return { svc, anon, userA, userB, idA, idB };
}

// ── Part A: anon RLS denial (read + insert + update + delete) ───────────────────────
async function partA(svc, anon) {
  const cfg = tableConfig();
  const svcCount = (t, match) => {
    let q = svc.from(t).select("*", { count: "exact", head: true });
    if (match) q = q.match(match);
    return q;
  };

  // READ: anon UNFILTERED select must return 0, while svc proves the table is non-empty.
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

  // INSERT: payload carries a VALID owner; PASS requires the 42501 authorization denial.
  for (const t of TABLE_NAMES) {
    const c = cfg[t];
    const before = await svcCount(t);
    const res = await anon.from(t).insert(c.insertPayload).select(c.keyCol);
    const after = await svcCount(t);
    const [v, d] = judgeAnonInsert(before.error == null, before.count, after.error == null, after.count, res);
    record(`${t} insert`, v, d);
  }

  // UPDATE: did the target column change? (svc reads it before/after)
  for (const t of TABLE_NAMES) {
    const c = cfg[t];
    const before = await svc.from(t).select(c.updCol).match(c.updTarget).maybeSingle();
    const res = await anon.from(t).update({ [c.updCol]: c.updVal }).match(c.updTarget).select(c.keyCol);
    const after = await svc.from(t).select(c.updCol).match(c.updTarget).maybeSingle();
    const bv = before.data ? JSON.stringify(before.data[c.updCol]) : undefined;
    const av = after.data ? JSON.stringify(after.data[c.updCol]) : undefined;
    const [v, d] = judgeWrite(before.error == null && before.data != null, bv, after.error == null && after.data != null, av, res,
      `anon UPDATE changed ${c.updCol} ${bv} -> ${av}`);
    record(`${t} update`, v, d);
  }

  // DELETE: is the target row still present? (svc counts it before/after)
  for (const t of TABLE_NAMES) {
    const c = cfg[t];
    const before = await svcCount(t, c.delTarget);
    const res = await anon.from(t).delete().match(c.delTarget).select(c.keyCol);
    const after = await svcCount(t, c.delTarget);
    const [v, d] = judgeWrite(before.error == null && before.count === 1, before.count, after.error == null, after.count, res,
      `anon DELETE removed the row (count ${before.count} -> ${after.count})`);
    record(`${t} delete`, v, d);
  }
}

// ── Part C batteries — full 8-op isolation, run in BOTH directions per table ─────────
// Each battery SEEDS its own attacker- and victim-owned rows (via svc), then runs the 8
// ops with `atk` attacking `vic`. partC() calls each with (A,B) then (B,A), so symmetry
// is structural — every direction of every op on every table is exercised.

// ROOTS (fact, job): ownership via the `owner` column; insert ground-truth by marker.
async function rootBattery(svc, table, cfg, tag, atk, atkId, vic, vicId) {
  const aRead = (await insSvc(svc, table, cfg.mkRow(atkId, MARK + `_${tag}_${table}_aRead`))).id;
  const aGive = (await insSvc(svc, table, cfg.mkRow(atkId, MARK + `_${tag}_${table}_aGive`))).id;
  const aUpd = (await insSvc(svc, table, cfg.mkRow(atkId, MARK + `_${tag}_${table}_aUpd`))).id;
  const aDel = (await insSvc(svc, table, cfg.mkRow(atkId, MARK + `_${tag}_${table}_aDel`))).id;
  const vRead = (await insSvc(svc, table, cfg.mkRow(vicId, MARK + `_${tag}_${table}_vRead`))).id;
  const vUpd = (await insSvc(svc, table, cfg.mkRow(vicId, MARK + `_${tag}_${table}_vUpd`))).id;
  const vDel = (await insSvc(svc, table, cfg.mkRow(vicId, MARK + `_${tag}_${table}_vDel`))).id;
  const L = (op) => `${table} ${tag} ${op}`;
  await checkReadIso(atk, table, L("read-iso"), [aRead], [vRead]);
  { const m = MARK + `_${tag}_${table}_insVic`; const b = await gtCntEq(svc, table, cfg.markerCol, m);
    const res = await atk.from(table).insert(cfg.mkRow(vicId, m)).select("id"); const a = await gtCntEq(svc, table, cfg.markerCol, m);
    recordHardDeny(L("ins-as-other"), b, a, res, "42501", `a ${table} owned by the victim`); }
  { const m = MARK + `_${tag}_${table}_insOwn`; const b = await gtCntEq(svc, table, cfg.markerCol, m);
    const res = await atk.from(table).insert(cfg.mkRow(atkId, m)).select("id"); const a = await gtCntEq(svc, table, cfg.markerCol, m);
    recordPositiveAppear(L("ins-own"), b, a, res, `its own ${table}`); }
  { const b = await gtCol(svc, table, aGive, "owner");
    const res = await atk.from(table).update({ owner: vicId }).eq("id", aGive).select("id"); const a = await gtCol(svc, table, aGive, "owner");
    recordHardDeny(L("give-away"), b, a, res, "42501", `${table}.owner`); }
  { const b = await gtCol(svc, table, vUpd, cfg.mutCol);
    const res = await atk.from(table).update({ [cfg.mutCol]: MARK + `_${tag}_hack` }).eq("id", vUpd).select("id"); const a = await gtCol(svc, table, vUpd, cfg.mutCol);
    recordNoopUpdate(L("upd-other"), b, a, res, `victim's ${table}.${cfg.mutCol}`); }
  { const want = JSON.stringify(MARK + `_${tag}_mine`);
    const res = await atk.from(table).update({ [cfg.mutCol]: MARK + `_${tag}_mine` }).eq("id", aUpd).select("id"); const a = await gtCol(svc, table, aUpd, cfg.mutCol);
    recordPositiveChange(L("upd-own"), a, want, res, `${table}.${cfg.mutCol}`); }
  { const b = await gtExists(svc, table, vDel);
    const res = await atk.from(table).delete().eq("id", vDel).select("id"); const a = await gtExists(svc, table, vDel);
    recordNoopDelete(L("del-other"), b, a, res, `victim's ${table}`); }
  { const b = await gtExists(svc, table, aDel);
    const res = await atk.from(table).delete().eq("id", aDel).select("id"); const a = await gtExists(svc, table, aDel);
    recordPositiveDelete(L("del-own"), b, a, res, table); }
}

// ONE-HOP CHILDREN (requirement, document): ownership inherited via the parent job;
// home jobs seeded per role; insert ground-truth by job_id; give-away = re-parent.
async function childBattery(svc, table, cfg, tag, atk, atkId, vic, vicId) {
  const jobA = (await insSvc(svc, "job", { raw_text: MARK + `_${tag}_${table}_homeA`, owner: atkId })).id;
  const jobV = (await insSvc(svc, "job", { raw_text: MARK + `_${tag}_${table}_homeV`, owner: vicId })).id;
  const aRead = (await insSvc(svc, table, cfg.mkRow(jobA, MARK + `_${tag}_${table}_aRead`))).id;
  const aGive = (await insSvc(svc, table, cfg.mkRow(jobA, MARK + `_${tag}_${table}_aGive`))).id;
  const aUpd = (await insSvc(svc, table, cfg.mkRow(jobA, MARK + `_${tag}_${table}_aUpd`))).id;
  const aDel = (await insSvc(svc, table, cfg.mkRow(jobA, MARK + `_${tag}_${table}_aDel`))).id;
  const vRead = (await insSvc(svc, table, cfg.mkRow(jobV, MARK + `_${tag}_${table}_vRead`))).id;
  const vUpd = (await insSvc(svc, table, cfg.mkRow(jobV, MARK + `_${tag}_${table}_vUpd`))).id;
  const vDel = (await insSvc(svc, table, cfg.mkRow(jobV, MARK + `_${tag}_${table}_vDel`))).id;
  const L = (op) => `${table} ${tag} ${op}`;
  await checkReadIso(atk, table, L("read-iso"), [aRead], [vRead]);
  { const b = await gtCntEq(svc, table, "job_id", jobV);
    const res = await atk.from(table).insert(cfg.mkRow(jobV, MARK + `_${tag}_${table}_insVic`)).select("id"); const a = await gtCntEq(svc, table, "job_id", jobV);
    recordHardDeny(L("ins-as-other"), b, a, res, "42501", `a ${table} under the victim's job`); }
  { const b = await gtCntEq(svc, table, "job_id", jobA);
    const res = await atk.from(table).insert(cfg.mkRow(jobA, MARK + `_${tag}_${table}_insOwn`)).select("id"); const a = await gtCntEq(svc, table, "job_id", jobA);
    recordPositiveAppear(L("ins-own"), b, a, res, `a ${table} under its own job`); }
  { const b = await gtCol(svc, table, aGive, "job_id");
    const res = await atk.from(table).update({ job_id: jobV }).eq("id", aGive).select("id"); const a = await gtCol(svc, table, aGive, "job_id");
    recordHardDeny(L("give-away"), b, a, res, "42501", `${table}.job_id`); }
  { const b = await gtCol(svc, table, vUpd, cfg.mutCol);
    const res = await atk.from(table).update({ [cfg.mutCol]: cfg.mutVal }).eq("id", vUpd).select("id"); const a = await gtCol(svc, table, vUpd, cfg.mutCol);
    recordNoopUpdate(L("upd-other"), b, a, res, `victim's ${table}.${cfg.mutCol}`); }
  { const res = await atk.from(table).update({ [cfg.mutCol]: cfg.mutVal }).eq("id", aUpd).select("id"); const a = await gtCol(svc, table, aUpd, cfg.mutCol);
    recordPositiveChange(L("upd-own"), a, JSON.stringify(cfg.mutVal), res, `${table}.${cfg.mutCol}`); }
  { const b = await gtExists(svc, table, vDel);
    const res = await atk.from(table).delete().eq("id", vDel).select("id"); const a = await gtExists(svc, table, vDel);
    recordNoopDelete(L("del-other"), b, a, res, `victim's ${table}`); }
  { const b = await gtExists(svc, table, aDel);
    const res = await atk.from(table).delete().eq("id", aDel).select("id"); const a = await gtExists(svc, table, aDel);
    recordPositiveDelete(L("del-own"), b, a, res, table); }
}

// TWO-HOP CHILD (doc_line): ownership inherited via document -> job. Each role gets a
// home job, a home document, and a citable fact (so the SECURITY INVOKER fact-existence
// trigger passes on its OWN fact and the doc_line RLS WITH CHECK is what denies).
async function docLineBattery(svc, tag, atk, atkId, vic, vicId) {
  const jobA = (await insSvc(svc, "job", { raw_text: MARK + `_${tag}_dl_homeA`, owner: atkId })).id;
  const jobV = (await insSvc(svc, "job", { raw_text: MARK + `_${tag}_dl_homeV`, owner: vicId })).id;
  const docA = (await insSvc(svc, "document", { job_id: jobA, type: "resume" })).id;
  const docV = (await insSvc(svc, "document", { job_id: jobV, type: "resume" })).id;
  const factA = (await insSvc(svc, "fact", { type: "skill", content: MARK + `_${tag}_dl_factA`, owner: atkId })).id;
  const factV = (await insSvc(svc, "fact", { type: "skill", content: MARK + `_${tag}_dl_factV`, owner: vicId })).id;
  const mk = (docId, fid, m) => ({ document_id: docId, text: m, fact_ids: [fid] });
  const aRead = (await insSvc(svc, "doc_line", mk(docA, factA, MARK + `_${tag}_dl_aRead`))).id;
  const aGive = (await insSvc(svc, "doc_line", mk(docA, factA, MARK + `_${tag}_dl_aGive`))).id;
  const aUpd = (await insSvc(svc, "doc_line", mk(docA, factA, MARK + `_${tag}_dl_aUpd`))).id;
  const aDel = (await insSvc(svc, "doc_line", mk(docA, factA, MARK + `_${tag}_dl_aDel`))).id;
  const vRead = (await insSvc(svc, "doc_line", mk(docV, factV, MARK + `_${tag}_dl_vRead`))).id;
  const vUpd = (await insSvc(svc, "doc_line", mk(docV, factV, MARK + `_${tag}_dl_vUpd`))).id;
  const vDel = (await insSvc(svc, "doc_line", mk(docV, factV, MARK + `_${tag}_dl_vDel`))).id;
  const L = (op) => `doc_line ${tag} ${op}`;
  await checkReadIso(atk, "doc_line", L("read-iso"), [aRead], [vRead]);
  { const b = await gtCntEq(svc, "doc_line", "document_id", docV);
    const res = await atk.from("doc_line").insert(mk(docV, factA, MARK + `_${tag}_dl_insVic`)).select("id"); const a = await gtCntEq(svc, "doc_line", "document_id", docV);
    recordHardDeny(L("ins-as-other"), b, a, res, "42501", "a doc_line under the victim's document"); }
  { const b = await gtCntEq(svc, "doc_line", "document_id", docA);
    const res = await atk.from("doc_line").insert(mk(docA, factA, MARK + `_${tag}_dl_insOwn`)).select("id"); const a = await gtCntEq(svc, "doc_line", "document_id", docA);
    recordPositiveAppear(L("ins-own"), b, a, res, "a doc_line under its own document"); }
  { const b = await gtCol(svc, "doc_line", aGive, "document_id");
    const res = await atk.from("doc_line").update({ document_id: docV }).eq("id", aGive).select("id"); const a = await gtCol(svc, "doc_line", aGive, "document_id");
    recordHardDeny(L("give-away"), b, a, res, "42501", "doc_line.document_id"); }
  { const b = await gtCol(svc, "doc_line", vUpd, "approved");
    const res = await atk.from("doc_line").update({ approved: true }).eq("id", vUpd).select("id"); const a = await gtCol(svc, "doc_line", vUpd, "approved");
    recordNoopUpdate(L("upd-other"), b, a, res, "victim's doc_line.approved"); }
  { const res = await atk.from("doc_line").update({ approved: true }).eq("id", aUpd).select("id"); const a = await gtCol(svc, "doc_line", aUpd, "approved");
    recordPositiveChange(L("upd-own"), a, JSON.stringify(true), res, "doc_line.approved"); }
  { const b = await gtExists(svc, "doc_line", vDel);
    const res = await atk.from("doc_line").delete().eq("id", vDel).select("id"); const a = await gtExists(svc, "doc_line", vDel);
    recordNoopDelete(L("del-other"), b, a, res, "victim's doc_line"); }
  { const b = await gtExists(svc, "doc_line", aDel);
    const res = await atk.from("doc_line").delete().eq("id", aDel).select("id"); const a = await gtExists(svc, "doc_line", aDel);
    recordPositiveDelete(L("del-own"), b, a, res, "doc_line"); }
}

// COVERAGE: PK = (job_id, requirement_id), no `id`; status bound to fact_ids by CHECK.
// Each coverage row needs its own requirement under the owning job.
async function coverageBattery(svc, tag, atk, atkId, vic, vicId) {
  const jobA = (await insSvc(svc, "job", { raw_text: MARK + `_${tag}_cov_homeA`, owner: atkId })).id;
  const jobV = (await insSvc(svc, "job", { raw_text: MARK + `_${tag}_cov_homeV`, owner: vicId })).id;
  const factA = (await insSvc(svc, "fact", { type: "skill", content: MARK + `_${tag}_cov_factA`, owner: atkId })).id;
  const factV = (await insSvc(svc, "fact", { type: "skill", content: MARK + `_${tag}_cov_factV`, owner: vicId })).id;
  const req = async (job, s) => (await insSvc(svc, "requirement", { job_id: job, text: MARK + `_${tag}_covreq${s}`, kind: "must" })).id;
  const rqA_read = await req(jobA, "Ar"), rqA_give = await req(jobA, "Ag"), rqA_updOwn = await req(jobA, "Au"), rqA_delOwn = await req(jobA, "Ad"), rqA_insOwn = await req(jobA, "Ai");
  const rqV_read = await req(jobV, "Vr"), rqV_upd = await req(jobV, "Vu"), rqV_del = await req(jobV, "Vd"), rqV_insVic = await req(jobV, "Vi"), rqV_giveLand = await req(jobV, "Vg");
  const cov = async (job, reqId, status, fids) => { await insSvc(svc, "coverage", { job_id: job, requirement_id: reqId, status, fact_ids: fids || [] }, "job_id"); };
  await cov(jobA, rqA_read, "unmet"); await cov(jobA, rqA_give, "unmet"); await cov(jobA, rqA_updOwn, "met", [factA]); await cov(jobA, rqA_delOwn, "unmet");
  await cov(jobV, rqV_read, "unmet"); await cov(jobV, rqV_upd, "met", [factV]); await cov(jobV, rqV_del, "unmet");
  // coverage has no `id`; identify rows by requirement_id (unique per coverage here),
  // reusing the shared ground-truth + read-iso helpers via a key-column override.
  const covCnt = (reqId) => gtCntEq(svc, "coverage", "requirement_id", reqId);
  const covStatus = (reqId) => gtColBy(svc, "coverage", "requirement_id", reqId, "status");
  const L = (op) => `coverage ${tag} ${op}`;
  await checkReadIso(atk, "coverage", L("read-iso"), [rqA_read], [rqV_read], "requirement_id");
  { const b = await covCnt(rqV_insVic);
    const res = await atk.from("coverage").insert({ job_id: jobV, requirement_id: rqV_insVic, status: "unmet" }).select("requirement_id"); const a = await covCnt(rqV_insVic);
    recordHardDeny(L("ins-as-other"), b, a, res, "42501", "a coverage under the victim's job"); }
  { const b = await covCnt(rqA_insOwn);
    const res = await atk.from("coverage").insert({ job_id: jobA, requirement_id: rqA_insOwn, status: "unmet" }).select("requirement_id"); const a = await covCnt(rqA_insOwn);
    recordPositiveAppear(L("ins-own"), b, a, res, "a coverage under its own job"); }
  { const b = await covCnt(rqA_give);
    const res = await atk.from("coverage").update({ job_id: jobV, requirement_id: rqV_giveLand }).match({ job_id: jobA, requirement_id: rqA_give }).select("requirement_id"); const a = await covCnt(rqA_give);
    recordHardDeny(L("give-away"), b, a, res, "42501", "coverage (still keyed under its own job)"); }
  { const b = await covStatus(rqV_upd);
    const res = await atk.from("coverage").update({ status: "partial" }).eq("requirement_id", rqV_upd).select("requirement_id"); const a = await covStatus(rqV_upd);
    recordNoopUpdate(L("upd-other"), b, a, res, "victim's coverage.status"); }
  { const res = await atk.from("coverage").update({ status: "partial" }).eq("requirement_id", rqA_updOwn).select("requirement_id"); const a = await covStatus(rqA_updOwn);
    recordPositiveChange(L("upd-own"), a, JSON.stringify("partial"), res, "coverage.status"); }
  { const b = await covCnt(rqV_del);
    const res = await atk.from("coverage").delete().eq("requirement_id", rqV_del).select("requirement_id"); const a = await covCnt(rqV_del);
    recordNoopDelete(L("del-other"), b, a, res, "victim's coverage"); }
  { const b = await covCnt(rqA_delOwn);
    const res = await atk.from("coverage").delete().eq("requirement_id", rqA_delOwn).select("requirement_id"); const a = await covCnt(rqA_delOwn);
    recordPositiveDelete(L("del-own"), b, a, res, "coverage"); }
}

// ── Part C: per-user ownership isolation, BOTH directions, all six tables ────────────
async function partC(ctx) {
  const { svc, userA, idA, userB, idB } = ctx;
  const factCfg = { mkRow: (o, m) => ({ type: "skill", content: m, owner: o }), mutCol: "role", markerCol: "content" };
  const jobCfg = { mkRow: (o, m) => ({ raw_text: m, owner: o }), mutCol: "company", markerCol: "raw_text" };
  const reqCfg = { mkRow: (j, m) => ({ job_id: j, text: m, kind: "must" }), mutCol: "kind", mutVal: "keyword" };
  const docCfg = { mkRow: (j, m) => ({ job_id: j, type: "resume" }), mutCol: "status", mutVal: "approved" };
  const dirs = [["A>B", userA, idA, userB, idB], ["B>A", userB, idB, userA, idA]];
  for (const [tag, atk, atkId, vic, vicId] of dirs) {
    await rootBattery(svc, "fact", factCfg, tag, atk, atkId, vic, vicId);
    await rootBattery(svc, "job", jobCfg, tag, atk, atkId, vic, vicId);
    await childBattery(svc, "requirement", reqCfg, tag, atk, atkId, vic, vicId);
    await childBattery(svc, "document", docCfg, tag, atk, atkId, vic, vicId);
    await docLineBattery(svc, tag, atk, atkId, vic, vicId);
    await coverageBattery(svc, tag, atk, atkId, vic, vicId);
  }
}

// ── Part B: server-only build guard (attributable) ─────────────────────────────────
function buildOnce() {
  rmSync(NEXT_DIR, { recursive: true, force: true });
  const res = spawnSync(process.execPath, [NEXT_BIN, "build"], {
    cwd: REPO, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, env: process.env,
  });
  return { status: res.status, error: res.error, out: `${res.stdout || ""}\n${res.stderr || ""}` };
}

function partB() {
  if (existsSync(PROBE_DIR)) cleanupProbeSync();
  try {
    const base = buildOnce();
    if (base.error) { record("build guard", "CNV", `next could not run (baseline): ${base.error.message}`); return; }
    if (base.status !== 0) { record("build guard", "CNV", `baseline build (no probe) FAILED (exit ${base.status}) — app not green; cannot attribute the guard failure`); return; }

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
  console.log("=== Veritas security proof — anon RLS denial + authenticated cross-user isolation (BOTH directions) + server-only build guard (LOCAL stack) ===\n");

  let ctx = null;
  try {
    ctx = await setup();
    if (ctx) {
      await partA(ctx.svc, ctx.anon);
      await partC(ctx);
    }
  } catch (e) {
    bail(`unexpected error during Part A/C: ${e.message}`);
  } finally {
    if (SVC) {
      try { await sweep(SVC); } catch {}
      try { await deleteTestUsers(SVC); } catch {}
    }
  }

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
  console.log("✓ SECURITY PROVED — anon denied every read/insert/update/delete on all six tables; authenticated users A and B are isolated on all six tables in BOTH directions (read + write — cross-owner INSERT/give-away → 42501, cross-user UPDATE/DELETE → silent zero-row no-op — by service-role ground truth, with positive controls); the server-only client-import build guard holds attributably.");
  process.exit(0);
}

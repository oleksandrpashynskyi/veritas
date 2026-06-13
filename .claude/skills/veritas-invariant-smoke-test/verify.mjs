// Bundled with the veritas-invariant-smoke-test skill. Proves the Veritas provenance
// invariant by EXECUTION against a fresh application of ALL working-tree migrations in
// a throwaway schema. The can't-false-pass guard is locked in: it exits non-zero with
// "COULD NOT VERIFY" unless all three violation tests actually ran AND each was
// rejected with the expected SQLSTATE.
//
// NO SECRET IS STORED IN THIS FILE. The DB password is read at run time from
// <repo>/.env.local (the var whose name contains PASSWORD and not SERVICE). The
// project ref is derived from SUPABASE_URL in the same file. Host/region are
// non-secret (see the supabase-connection memory) and overridable via env.
//
// Usage (per the skill): install pg into a throwaway dir, copy this file there, then
//   node verify.mjs <repo-root>          # <repo-root> defaults to process.cwd()
// TLS: verifies by default. The Supabase pooler uses a self-signed cert, so choose:
//   VERITAS_CA_CERT=<path>   -> verify-full (strongest), or
//   VERITAS_TLS_INSECURE=1   -> sslmode=require (encrypted, unverified) — explicit.
// With neither set it refuses to connect rather than silently disabling verification.
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const { Client } = pg;
const REPO = process.argv[2] || process.cwd();
const ENV_FILE = path.join(REPO, ".env.local");
const MIGRATIONS_DIR = path.join(REPO, "supabase", "migrations");
const POOLER_HOST = process.env.VERITAS_POOLER_HOST || "aws-1-us-east-2.pooler.supabase.com";
const RANDOM_UUID = "00000000-0000-4000-8000-000000000000";

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

function readPassword() {
  const v = envValue((k) => k.includes("PASSWORD") && !k.includes("SERVICE"));
  if (!v) throw new Error("no *PASSWORD* var found in .env.local");
  return v;
}

function readRef() {
  const url = envValue((k) => k === "SUPABASE_URL");
  const m = url && url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (!m) throw new Error("could not derive project ref from SUPABASE_URL in .env.local");
  return m[1];
}

function tlsConfig() {
  if (process.env.VERITAS_CA_CERT) return { ca: readFileSync(process.env.VERITAS_CA_CERT), rejectUnauthorized: true };
  if (process.env.VERITAS_TLS_INSECURE === "1") return { rejectUnauthorized: false }; // explicit sslmode=require opt-in
  return { rejectUnauthorized: true }; // verify by default; never silently disabled
}

const REF = readRef();
const results = [];
function record(name, expect, err) {
  if (err) results.push({ name, ok: err.code === expect, expect, got: err.code, msg: (err.message || "").split("\n")[0] });
  else results.push({ name, ok: false, expect, got: "NONE (operation SUCCEEDED)", msg: "NOT rejected — REGRESSION" });
}

function makeClient() {
  return new Client({ host: POOLER_HOST, port: 5432, user: `postgres.${REF}`, database: "postgres", password: readPassword(), ssl: tlsConfig() });
}

// Retry only on 28P01 to absorb pooler propagation lag after a password reset.
async function connectWithRetry() {
  const delays = [0, 8000, 12000, 15000, 20000];
  let last;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) { console.log(`  auth rejected (28P01); waiting ${delays[i] / 1000}s for password propagation (try ${i + 1}/${delays.length - 1})...`); await new Promise((r) => setTimeout(r, delays[i])); }
    const c = makeClient();
    try { await c.connect(); return c; } catch (e) { last = e; try { await c.end(); } catch {} if (e.code !== "28P01") throw e; }
  }
  throw last;
}

let client;
let applyError = null;
let fatalError = null;

try {
  client = await connectWithRetry();
  console.log(`connected: postgres.${REF}@${POOLER_HOST}:5432\n`);

  await client.query("drop schema if exists veritas_test cascade");
  await client.query("create schema veritas_test");
  await client.query("set search_path to veritas_test");

  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error("no .sql migrations found in " + MIGRATIONS_DIR);
  for (const f of files) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
    try { await client.query(sql); console.log(`applied ${f} (${sql.length} bytes)`); }
    catch (e) { applyError = Object.assign(e, { migration: f }); throw e; }
  }

  const rls = await client.query("select relname, relrowsecurity from pg_class where relnamespace='veritas_test'::regnamespace and relkind='r' order by relname");
  console.log("RLS enabled on:", rls.rows.filter((r) => r.relrowsecurity).map((r) => r.relname).join(", ") || "(none)", "\n");

  const job = (await client.query("insert into job(raw_text) values('smoke job') returning id")).rows[0];
  const doc = (await client.query("insert into document(job_id,type) values($1,'resume') returning id", [job.id])).rows[0];
  const fact = (await client.query("insert into fact(type,content) values('experience','smoke fact') returning id")).rows[0];

  try { await client.query("insert into doc_line(document_id,text,fact_ids) values($1,'uncited','{}')", [doc.id]); record("1. empty fact_ids", "23514", null); }
  catch (e) { record("1. empty fact_ids", "23514", e); }

  try { await client.query("insert into doc_line(document_id,text,fact_ids) values($1,'bogus',$2::uuid[])", [doc.id, [RANDOM_UUID]]); record("2. nonexistent fact", "23503", null); }
  catch (e) { record("2. nonexistent fact", "23503", e); }

  await client.query("insert into doc_line(document_id,text,fact_ids) values($1,'valid',$2::uuid[])", [doc.id, [fact.id]]);
  try { await client.query("delete from fact where id=$1", [fact.id]); record("3. delete cited fact", "23503", null); }
  catch (e) { record("3. delete cited fact", "23503", e); }
} catch (e) {
  if (!applyError) {
    fatalError = e;
    console.error("FATAL (not a test result):", e.code || "", e.message);
    if (e.code === "SELF_SIGNED_CERT_IN_CHAIN") console.error("  -> set VERITAS_CA_CERT=<Supabase CA path> (verify-full) or VERITAS_TLS_INSECURE=1 (sslmode=require) to proceed.");
  }
} finally {
  if (client) {
    try { await client.query("drop schema if exists veritas_test cascade"); console.log("cleaned up veritas_test (public schema + history untouched)"); }
    catch (e) { console.error("cleanup warning:", e.message); }
    await client.end();
  }
}

console.log("\n=== Veritas invariant smoke-test — all migrations, fresh schema ===");
if (applyError) {
  console.log(`✗ REGRESSION: migration ${applyError.migration} FAILED TO APPLY [${applyError.code || "?"}] ${applyError.message.split("\n")[0]}`);
  process.exit(1);
}
if (fatalError || results.length !== 3) {
  console.log(`✗ COULD NOT VERIFY — ${fatalError ? fatalError.message.split("\n")[0] : `only ${results.length}/3 tests ran`}. No proof produced; this is NOT a pass.`);
  process.exit(2);
}
let allPass = true;
for (const t of results) {
  console.log(`  ${t.ok ? "PASS" : "FAIL"}  ${t.name} — expect ${t.expect}, got ${t.got}: ${t.msg}`);
  if (!t.ok) allPass = false;
}
console.log(allPass ? "\n✓ INVARIANT ENFORCED BY THE DATABASE" : "\n✗ REGRESSION — a violation was not rejected. STOP; do not commit.");
process.exit(allPass ? 0 : 1);

// M2 step-1 verification — the per-user data path.
//
// This script does TWO things, failing closed (non-zero) on any violation:
//
//   [app guard — binds to the REAL tree]
//     (1a) STATIC surface scan: every .ts/.tsx under src/ (recursive) imports NO service-role
//          client — no `getDb`, no `@/lib/db`, no `SUPABASE_SERVICE_ROLE_KEY` — excluding only
//          the sanctioned getDb definition (src/lib/db/client.ts + its index.ts barrel). Fails
//          closed on any read error / empty scan. BOUND: static only — does NOT follow the
//          transitive import graph, and is NOT a runtime exercise (both deferred).
//     (1b) KEY-ROLE: the app's configured NEXT_PUBLIC_SUPABASE_ANON_KEY decodes to anon (or is
//          a publishable key), never the service-role/secret key.
//     Together these catch the two regression vectors: switching createFact() to the
//     service-role client, or misconfiguring the app's anon key to the service-role key.
//
//   [db re-confirmation — a STAND-IN client, NOT the app path]
//     Re-confirms the RLS property the app relies on (owner-stamping + per-user read/write/delete
//     isolation, plus the owner update/delete happy path) using a stand-in per-user client (anon
//     key + a real session). It does NOT import or drive the app's server client / createFact /
//     updateFact / deleteFact, so it is NOT a proof of the app path.
//
// NOT YET DONE (recorded deferral — PROMPTS.md, the CRUD cut): EXERCISE the real /facts routes
// over HTTP through the running app, so the test passes through the actual server client and
// createFact rather than a stand-in.
//
// LOCAL ONLY: sources stack creds from `supabase status -o json` (same cwd), refuses a
// non-loopback target; it creates and deletes auth users. Service-role is used ONLY for ground
// truth + cleanup (as verify-security.mjs) — never as the app data path.
//
// Exit 0 = guards held, DB property re-confirmed, stack left clean; non-zero otherwise.
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REPO = process.argv[2] || process.cwd();
const MARK = "VERITAS_M2_VERIFY_" + randomUUID();
const PW = "veritas-m2-pw-019283";
const A_EMAIL = `veritas-m2-a-${randomUUID().slice(0, 8)}@example.com`;
const B_EMAIL = `veritas-m2-b-${randomUUID().slice(0, 8)}@example.com`;

function statusJson() {
  const res = spawnSync("npx supabase status -o json", { cwd: REPO, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { error: res.error };
  const out = res.stdout || "";
  const s = out.indexOf("{"), e = out.lastIndexOf("}");
  try { return { creds: JSON.parse(out.slice(s, e + 1)) }; } catch (err) { return { error: err }; }
}
function jwtRole(t) { try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8")).role; } catch { return undefined; } }
function isLoopback(u) { try { const h = new URL(u).hostname.replace(/^\[|\]$/g, ""); return h === "127.0.0.1" || h === "localhost" || h === "::1"; } catch { return false; } }

// ── [app guard] static scan of the REAL tree ────────────────────────────────────────
function walkTs(dir, errors) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { errors.push(`readdir ${path.relative(REPO, dir)}: ${short(e)}`); return out; } // fail closed
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p, errors));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
// Strip comments so explanatory mentions of "service-role" / "lib/db" can't false-positive;
// the [^:] guard keeps `://` in URLs intact.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
// Statically assert the app's user-data path imports NO service-role client by SCANNING THE
// ENTIRE SOURCE TREE — every .ts/.tsx under src/ (recursive) — for the import shape of both
// vectors: `getDb` (the only export of the service-role module), the `@/lib/db` module/barrel,
// and any direct SUPABASE_SERVICE_ROLE_KEY use. Rooting at src/ (not an enumerated list of dirs)
// means a service-role helper added ANYWHERE under src — src/components, src/utils, a future
// top-level src/server, the root middleware, ... — is caught by LOCATION, not by being named.
// The ONLY exclusions are the sanctioned getDb DEFINITION surface: src/lib/db/client.ts (defines
// getDb + reads the service-role key) and src/lib/db/index.ts (barrel re-exporting it) — the rule
// is "the app path must not CONSUME service-role," not "it may not be defined." BOUND: a static
// surface scan — it does NOT follow the transitive import graph (dynamic/computed imports) and is
// NOT a runtime exercise (both deferred — see PROMPTS.md). FAILS CLOSED: a read/readdir error on
// any in-scope file, or an empty scan set, fails the guard (never silently skipped).
function staticImportScan() {
  const excluded = new Set(
    [
      path.join(REPO, "src", "lib", "db", "client.ts"), // defines getDb + reads the service-role key
      path.join(REPO, "src", "lib", "db", "index.ts"),  // barrel re-exporting getDb
    ].map((p) => path.resolve(p)),
  );
  const readErrors = [];
  // Root at the ENTIRE src/ tree so any file added anywhere under src (components, utils, a
  // future top-level server dir, the root middleware, ...) is scanned by location.
  const files = walkTs(path.join(REPO, "src"), readErrors);

  const forbidden = [
    [/\bgetDb\b/, "getDb (service-role client)"],
    [/@\/lib\/db\b/, "@/lib/db import (service-role module/barrel)"],
    [/\bSUPABASE_SERVICE_ROLE_KEY\b/, "SUPABASE_SERVICE_ROLE_KEY"],
  ];
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (excluded.has(path.resolve(f))) continue; // sanctioned getDb definition/barrel
    let src;
    try { src = readFileSync(f, "utf8"); } catch (e) { readErrors.push(`read ${path.relative(REPO, f)}: ${short(e)}`); continue; } // fail closed
    scanned++;
    const code = stripComments(src);
    for (const [re, what] of forbidden) if (re.test(code)) hits.push(`${path.relative(REPO, f)} -> ${what}`);
  }
  return { scanned, hits, readErrors };
}
// Read a var the way the app would: shell env wins, then .env.local, then .env.
function readEnvVar(name) {
  if (process.env[name]) return process.env[name];
  for (const fname of [".env.local", ".env"]) {
    let txt;
    try { txt = readFileSync(path.join(REPO, fname), "utf8"); } catch { continue; }
    for (const ln of txt.split(/\r?\n/)) {
      const m = ln.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (m && m[1] === name) {
        let v = m[2].trim();
        if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
        return v;
      }
    }
  }
  return undefined;
}
// The app's NEXT_PUBLIC anon key must be an anon/publishable key, never service-role/secret.
function anonKeyVerdict(key) {
  if (!key) return { ok: false, why: "NEXT_PUBLIC_SUPABASE_ANON_KEY not set" };
  if (key.startsWith("sb_secret_")) return { ok: false, why: "is a secret (service-role) key" };
  const role = jwtRole(key);
  if (role === "service_role") return { ok: false, why: "JWT role=service_role" };
  if (role === "anon") return { ok: true, why: "JWT role=anon" };
  if (key.startsWith("sb_publishable_")) return { ok: true, why: "publishable key" };
  if (role) return { ok: false, why: `JWT role=${role}, expected anon` };
  return { ok: false, why: "unrecognized key (not anon/publishable)" };
}

const checks = [];
const ok = (name, pass, detail) => checks.push({ name, pass, detail });
const short = (e) => (e?.message || String(e || "")).split("\n")[0];

let svc = null;
let fatal = null;
const created = []; // user ids to delete

try {
  const st = statusJson();
  if (st.error) throw new Error(`supabase status failed: ${short(st.error)} — is the local stack up?`);
  const URL = st.creds?.API_URL, ANON = st.creds?.ANON_KEY, SVC = st.creds?.SERVICE_ROLE_KEY;
  if (!URL || !ANON || !SVC) throw new Error("supabase status did not surface API_URL + ANON_KEY + SERVICE_ROLE_KEY");
  if (!isLoopback(URL)) throw new Error(`target ${URL} is not loopback — refusing (this creates/deletes users)`);
  if (jwtRole(ANON) !== "anon") throw new Error(`ANON_KEY role is ${jwtRole(ANON)}, expected anon`);
  if (jwtRole(SVC) === "anon") throw new Error("SERVICE_ROLE_KEY decodes to anon — wrong key");

  // CHECK 1a [app guard, REAL tree]: recursive scan of the WHOLE src/ tree for any service-role
  // consumption. Fails closed on read errors / empty scan.
  const scan = staticImportScan();
  const scanOk = scan.readErrors.length === 0 && scan.scanned > 0 && scan.hits.length === 0;
  ok(
    "[app guard] no service-role import anywhere under src/ (recursive)",
    scanOk,
    scan.readErrors.length ? `READ ERROR — fail closed: ${scan.readErrors.join("; ")}`
      : scan.scanned === 0 ? "scanned 0 files — cannot verify (fail closed)"
      : scan.hits.length ? `VIOLATION: ${scan.hits.join("; ")}`
      : `clean across ${scan.scanned} files (excludes only the sanctioned getDb definition: src/lib/db/client.ts + index.ts; static surface scan, not transitive-graph)`,
  );

  // CHECK 1b [app guard, REAL config]: the app's configured anon key is not the service-role key.
  const verdict = anonKeyVerdict(readEnvVar("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
  ok("[app guard] app NEXT_PUBLIC_SUPABASE_ANON_KEY is not the service-role key", verdict.ok, verdict.why);

  svc = createClient(URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });

  // Build a STAND-IN per-user client with the SAME semantics as the app's server client (anon
  // key + a real session) — for the DB-property re-confirmation below. This is not the app path.
  async function appUser(email) {
    const c = createClient(URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const su = await c.auth.signUp({ email, password: PW });
    if (su.error) throw new Error(`signUp(${email}): ${su.error.message}`);
    if (!su.data.session) { const si = await c.auth.signInWithPassword({ email, password: PW }); if (si.error) throw new Error(`signIn(${email}): ${si.error.message}`); }
    const { data: { user } } = await c.auth.getUser();
    if (!user) throw new Error(`no session for ${email}`);
    created.push(user.id);
    return { c, id: user.id, email };
  }

  // ── [db re-confirmation] STAND-IN per-user client — NOT the app path ─────────────────
  // Re-confirms the RLS property the app relies on. The app-path guarantee comes from the
  // [app guard] checks above; exercising the real /facts routes over HTTP is a deferral.
  const A = await appUser(A_EMAIL);
  const B = await appUser(B_EMAIL);

  // The stand-in create-fact DB op (same shape as createFact): anon+session client, owner stamped.
  const insA = await A.c.from("fact").insert({ type: "skill", content: MARK + "_A", owner: A.id }).select("id").single();
  const insB = await B.c.from("fact").insert({ type: "experience", content: MARK + "_B", owner: B.id }).select("id").single();
  if (insA.error) throw new Error(`A create-fact failed: ${insA.error.message}`);
  if (insB.error) throw new Error(`B create-fact failed: ${insB.error.message}`);
  const factA = insA.data.id, factB = insB.data.id;

  // owner stamping — service-role ground truth says A's row is owned by A.
  const gtA = await svc.from("fact").select("owner, content").eq("id", factA).single();
  ok("[db re-confirm] a per-user insert is owner-stamped to the creator", !gtA.error && gtA.data?.owner === A.id, `svc ground truth: fact ${factA.slice(0, 8)} owner=${gtA.data?.owner?.slice(0, 8)} (A=${A.id.slice(0, 8)})`);

  // read isolation — each stand-in client sees its own row, not the other's.
  const listA = await A.c.from("fact").select("id");
  const listB = await B.c.from("fact").select("id");
  const aIds = new Set((listA.data || []).map((r) => r.id));
  const bIds = new Set((listB.data || []).map((r) => r.id));
  const readIsoOk = !listA.error && !listB.error && aIds.has(factA) && !aIds.has(factB) && bIds.has(factB) && !bIds.has(factA);
  ok("[db re-confirm] per-user read isolation (each sees only its own)", readIsoOk, `A sees own=${aIds.has(factA)} other=${aIds.has(factB)}; B sees own=${bIds.has(factB)} other=${bIds.has(factA)}`);

  // write isolation — B updating A's fact via the stand-in client is a silent RLS no-op.
  const upd = await B.c.from("fact").update({ content: MARK + "_HACKED" }).eq("id", factA).select("id");
  const afterUpd = await svc.from("fact").select("content").eq("id", factA).single();
  const editBlocked = !upd.error && (upd.data?.length ?? 0) === 0 && afterUpd.data?.content === MARK + "_A";
  ok("[db re-confirm] per-user write isolation (cross-user UPDATE is a no-op)", editBlocked, `B update rows=${upd.data?.length ?? "?"} err=${upd.error?.code || "none"}; A.content unchanged=${afterUpd.data?.content === MARK + "_A"}`);

  // owner cannot be spoofed (RLS WITH CHECK) — A inserting as B → 42501.
  const spoof = await A.c.from("fact").insert({ type: "skill", content: MARK + "_SPOOF", owner: B.id }).select("id");
  const spoofCount = await svc.from("fact").select("*", { count: "exact", head: true }).eq("content", MARK + "_SPOOF");
  const spoofBlocked = spoof.error?.code === "42501" && spoofCount.count === 0;
  ok("[db re-confirm] a per-user client cannot spoof owner (insert as another -> 42501)", spoofBlocked, `code=${spoof.error?.code || "none"}, rows created=${spoofCount.count}`);

  // delete isolation — B deleting A's fact via the stand-in client is a silent RLS no-op.
  const del = await B.c.from("fact").delete().eq("id", factA).select("id");
  const afterDel = await svc.from("fact").select("content").eq("id", factA).single();
  const deleteBlocked = !del.error && (del.data?.length ?? 0) === 0 && !afterDel.error && afterDel.data?.content === MARK + "_A";
  ok("[db re-confirm] per-user delete isolation (cross-user DELETE is a no-op)", deleteBlocked, `B delete rows=${del.data?.length ?? "?"} err=${del.error?.code || "none"}; A row still present=${!afterDel.error && afterDel.data?.content === MARK + "_A"}`);

  // owner happy path — A CAN update then delete its OWN fact (what updateFact/deleteFact rely on).
  const ownUpd = await A.c.from("fact").update({ content: MARK + "_A_EDITED" }).eq("id", factA).select("id");
  const afterOwnUpd = await svc.from("fact").select("content").eq("id", factA).single();
  const ownEditOk = !ownUpd.error && (ownUpd.data?.length ?? 0) === 1 && afterOwnUpd.data?.content === MARK + "_A_EDITED";
  ok("[db re-confirm] owner can update its own fact", ownEditOk, `rows=${ownUpd.data?.length ?? "?"} err=${ownUpd.error?.code || "none"}; content updated=${afterOwnUpd.data?.content === MARK + "_A_EDITED"}`);

  const ownDel = await A.c.from("fact").delete().eq("id", factA).select("id");
  const afterOwnDel = await svc.from("fact").select("*", { count: "exact", head: true }).eq("id", factA);
  const ownDeleteOk = !ownDel.error && (ownDel.data?.length ?? 0) === 1 && afterOwnDel.count === 0;
  ok("[db re-confirm] owner can delete its own fact", ownDeleteOk, `rows=${ownDel.data?.length ?? "?"} err=${ownDel.error?.code || "none"}; row gone=${afterOwnDel.count === 0}`);
} catch (e) {
  fatal = short(e);
} finally {
  // Cleanup: delete owned marker facts FIRST, then the throwaway users — the auth admin API
  // refuses to delete a user that still owns rows (same order verify-security uses). Surface
  // every { error } so a swallowed failure can't masquerade as clean.
  let leftFacts = "?", usersLeft = "?";
  const cleanupErrors = [];
  if (svc) {
    try { const r = await svc.from("fact").delete().like("content", "VERITAS_M2_VERIFY_%"); if (r.error) cleanupErrors.push(`fact sweep: ${r.error.message}`); } catch (e) { cleanupErrors.push(`fact sweep threw: ${short(e)}`); }
    for (const id of created) { try { const d = await svc.auth.admin.deleteUser(id); if (d.error) cleanupErrors.push(`deleteUser: ${d.error.message}`); } catch (e) { cleanupErrors.push(`deleteUser threw: ${short(e)}`); } }
    try { const r = await svc.from("fact").select("*", { count: "exact", head: true }).like("content", "VERITAS_M2_VERIFY_%"); leftFacts = r.error ? `err:${r.error.code}` : r.count; } catch { leftFacts = "threw"; }
    try {
      const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) { cleanupErrors.push(`listUsers: ${error.message}`); usersLeft = `unconfirmed(${error.status || ""})`; }
      else { const em = new Set([A_EMAIL, B_EMAIL]); usersLeft = (data?.users || []).filter((u) => em.has(u.email)).length; }
    } catch (e) { cleanupErrors.push(`listUsers threw: ${short(e)}`); usersLeft = "unconfirmed(threw)"; }
  }
  var cleanupClean = cleanupErrors.length === 0 && leftFacts === 0 && usersLeft === 0;
  console.log(`\ncleanup: leftFacts=${leftFacts}, throwaway users left=${usersLeft}${cleanupErrors.length ? "; errors: " + cleanupErrors.join(" | ") : ""} -> ${cleanupClean ? "clean" : "LEAK"}`);
}

console.log("\n=== Veritas M2 — per-user data path verification (local) ===");
if (fatal) { console.log(`✗ COULD NOT VERIFY — ${fatal}`); process.exitCode = 2; }
else {
  let allPass = true;
  for (const c of checks) { console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`); if (!c.pass) allPass = false; }
  if (!allPass) { console.log("\n✗ FAIL — the per-user data path did not hold."); process.exitCode = 1; }
  else if (!cleanupClean) { console.log("\n✗ CLEANUP LEAK — checks passed but throwaway data/users remained."); process.exitCode = 3; }
  else { console.log("\n✓ APP PATH GUARDED (no service-role import; app anon key verified) + DB RLS PROPERTY RE-CONFIRMED via a stand-in per-user client. NOTE: the real /facts routes are not yet exercised over HTTP (deferred — see PROMPTS.md). Stack left clean."); process.exitCode = 0; }
}
// allow the event loop to drain (supabase-js keep-alive sockets) then exit cleanly
setTimeout(() => process.exit(process.exitCode || 0), 3000).unref();

// M3 — Job Ingest verification (LLM STUBBED — no API calls, key-less, deterministic).
//
// Reuses the proven verify-m2 scaffolding (same statusJson/jwtRole/isLoopback/walkTs/static scan/
// appUser/svc/ok/fail-closed cleanup/exit semantics). It does THREE things, failing closed
// (non-zero) on any violation:
//
//   [app guard — binds to the REAL tree]
//     (1a) STATIC service-role scan: every .ts/.tsx under src/ (recursive) imports NO service-role
//          client (no `getDb`, no `@/lib/db`, no `SUPABASE_SERVICE_ROLE_KEY`) — excluding only the
//          sanctioned getDb definition (src/lib/db/client.ts + index.ts). Auto-covers the new
//          src/app/jobs/* and src/lib/llm/* files by LOCATION. Static surface scan only (no
//          transitive import graph, no runtime exercise — both deferred, as in M2).
//     (1b) KEY-ROLE: the app's NEXT_PUBLIC_SUPABASE_ANON_KEY decodes to anon / is publishable.
//     (1c) KEY-CONTAINMENT (M3): the Anthropic key is server-only. `ANTHROPIC_API_KEY` and the
//          `@anthropic-ai/sdk` import appear nowhere under src/ EXCEPT the sanctioned server-only
//          module src/lib/llm/extraction.ts; and NO `NEXT_PUBLIC_ANTHROPIC*` exists anywhere under
//          src/ or in the env files. The `import "server-only"` guard in extraction.ts is the
//          build-time complement (not asserted here; `next build` enforces it).
//
//   [db re-confirmation — a STAND-IN per-user client, NOT the app path]
//     Re-confirms the RLS property the app relies on for job (root) + requirement (child via
//     EXISTS-on-parent): owner-stamping, per-user read/write/delete isolation in BOTH directions,
//     the child-via-parent insert guard, owner-spoof rejection, and the owner happy path
//     (update + cascading delete). Rows are seeded DIRECTLY via the per-user client — the LLM is
//     never called (deterministic, free, no key needed).
//
//   [validation rejection — covered by vitest, not here]
//     The fail-closed "malformed model output is rejected" property is proven by
//     src/lib/llm/extraction-schema.test.ts (run via `npm run test`), TS-native against the pure
//     validator. This proof intentionally does not duplicate that contract in JS.
//
// LOCAL ONLY: sources stack creds from `supabase status -o json` (same cwd), refuses a non-loopback
// target; it creates and deletes auth users. Service-role is used ONLY for ground truth + cleanup
// (never as the app data path). Exit 0 = guards held, DB property re-confirmed, stack left clean.
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REPO = process.argv[2] || process.cwd();
const MARK = "VERITAS_M3_VERIFY_" + randomUUID();
const PW = "veritas-m3-pw-019283";
const A_EMAIL = `veritas-m3-a-${randomUUID().slice(0, 8)}@example.com`;
const B_EMAIL = `veritas-m3-b-${randomUUID().slice(0, 8)}@example.com`;

function statusJson() {
  const res = spawnSync("npx supabase status -o json", { cwd: REPO, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { error: res.error };
  const out = res.stdout || "";
  const s = out.indexOf("{"), e = out.lastIndexOf("}");
  try { return { creds: JSON.parse(out.slice(s, e + 1)) }; } catch (err) { return { error: err }; }
}
function jwtRole(t) { try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8")).role; } catch { return undefined; } }
function isLoopback(u) { try { const h = new URL(u).hostname.replace(/^\[|\]$/g, ""); return h === "127.0.0.1" || h === "localhost" || h === "::1"; } catch { return false; } }

const short = (e) => (e?.message || String(e || "")).split("\n")[0];

// ── [app guard] static scans of the REAL tree ───────────────────────────────────────
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
// Strip comments so explanatory mentions can't false-positive; the [^:] guard keeps `://` intact.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
// (1a) The app's user-data path imports NO service-role client — scan the ENTIRE src/ tree; the
// only exclusions are the sanctioned getDb definition surface. Fails closed on read error / empty.
function serviceRoleScan() {
  const excluded = new Set(
    [
      path.join(REPO, "src", "lib", "db", "client.ts"),
      path.join(REPO, "src", "lib", "db", "index.ts"),
    ].map((p) => path.resolve(p)),
  );
  const readErrors = [];
  const files = walkTs(path.join(REPO, "src"), readErrors);
  const forbidden = [
    [/\bgetDb\b/, "getDb (service-role client)"],
    [/@\/lib\/db\b/, "@/lib/db import (service-role module/barrel)"],
    [/\bSUPABASE_SERVICE_ROLE_KEY\b/, "SUPABASE_SERVICE_ROLE_KEY"],
  ];
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (excluded.has(path.resolve(f))) continue;
    let src;
    try { src = readFileSync(f, "utf8"); } catch (e) { readErrors.push(`read ${path.relative(REPO, f)}: ${short(e)}`); continue; }
    scanned++;
    const code = stripComments(src);
    for (const [re, what] of forbidden) if (re.test(code)) hits.push(`${path.relative(REPO, f)} -> ${what}`);
  }
  return { scanned, hits, readErrors };
}
// (1c) The Anthropic key is server-only. ANTHROPIC_API_KEY and the @anthropic-ai/sdk import may
// appear ONLY in the sanctioned server-only module; no NEXT_PUBLIC_ANTHROPIC* anywhere under src/
// or in env files. Fails closed on read error / empty scan / missing sanctioned module.
function keyContainmentScan() {
  const sanctioned = path.resolve(path.join(REPO, "src", "lib", "llm", "extraction.ts"));
  const readErrors = [];
  const files = walkTs(path.join(REPO, "src"), readErrors);
  const keyHits = [], sdkHits = [], publicHits = [];
  let scanned = 0, sanctionedSeen = false;
  for (const f of files) {
    let src;
    try { src = readFileSync(f, "utf8"); } catch (e) { readErrors.push(`read ${path.relative(REPO, f)}: ${short(e)}`); continue; }
    scanned++;
    const code = stripComments(src);
    const rel = path.relative(REPO, f);
    const isSanctioned = path.resolve(f) === sanctioned;
    if (isSanctioned) sanctionedSeen = true;
    if (/\bANTHROPIC_API_KEY\b/.test(code) && !isSanctioned) keyHits.push(rel);
    if (/@anthropic-ai\/sdk/.test(code) && !isSanctioned) sdkHits.push(rel);
    if (/\bNEXT_PUBLIC_ANTHROPIC[A-Z0-9_]*\b/.test(code)) publicHits.push(rel);
  }
  // Scan EVERY env file at the repo root by DISCOVERY — never an enumerated subset: `.env` and any
  // `.env.*` (.env.local, .env.example, .env.test.local, .env.development.local,
  // .env.production.local, …). Next.js loads env files only from the project root, so root coverage
  // is complete (a NEXT_PUBLIC_ANTHROPIC* hardcoded in source is separately caught by the src/ walk
  // above). FAIL CLOSED: a readdir error, or a read error on ANY discovered env file (a directory
  // named like one, a dangling symlink, a permission error, …), is recorded — never swallowed — so
  // the guard fails rather than skipping a file unread. No type filter: every name-match is read.
  let envFiles;
  try {
    envFiles = readdirSync(REPO).filter((name) => /^\.env(\.|$)/.test(name));
  } catch (e) {
    readErrors.push(`readdir env files: ${short(e)}`);
    envFiles = [];
  }
  for (const fname of envFiles) {
    let txt;
    try {
      txt = readFileSync(path.join(REPO, fname), "utf8");
    } catch (e) {
      readErrors.push(`read ${fname}: ${short(e)}`); // fail closed — never skip an env file unread
      continue;
    }
    if (/\bNEXT_PUBLIC_ANTHROPIC[A-Z0-9_]*\b/.test(txt)) publicHits.push(fname);
  }
  return { scanned, sanctionedSeen, keyHits, sdkHits, publicHits, readErrors };
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

  // CHECK 1a [app guard]: no service-role consumption anywhere under src/ (auto-covers jobs/, llm/).
  const sr = serviceRoleScan();
  const srOk = sr.readErrors.length === 0 && sr.scanned > 0 && sr.hits.length === 0;
  ok(
    "[app guard] no service-role import anywhere under src/ (recursive)",
    srOk,
    sr.readErrors.length ? `READ ERROR — fail closed: ${sr.readErrors.join("; ")}`
      : sr.scanned === 0 ? "scanned 0 files — cannot verify (fail closed)"
      : sr.hits.length ? `VIOLATION: ${sr.hits.join("; ")}`
      : `clean across ${sr.scanned} files (excludes only the sanctioned getDb definition)`,
  );

  // CHECK 1b [app guard]: the app's configured anon key is not the service-role key.
  const verdict = anonKeyVerdict(readEnvVar("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
  ok("[app guard] app NEXT_PUBLIC_SUPABASE_ANON_KEY is not the service-role key", verdict.ok, verdict.why);

  // CHECK 1c [app guard, M3]: the Anthropic key is server-only (containment).
  const kc = keyContainmentScan();
  const kcOk =
    kc.readErrors.length === 0 && kc.scanned > 0 && kc.sanctionedSeen &&
    kc.keyHits.length === 0 && kc.sdkHits.length === 0 && kc.publicHits.length === 0;
  ok(
    "[app guard] ANTHROPIC_API_KEY + @anthropic-ai/sdk are server-only (only in src/lib/llm/extraction.ts; no NEXT_PUBLIC_ANTHROPIC*)",
    kcOk,
    kc.readErrors.length ? `READ ERROR — fail closed: ${kc.readErrors.join("; ")}`
      : kc.scanned === 0 ? "scanned 0 files — cannot verify (fail closed)"
      : !kc.sanctionedSeen ? "sanctioned module src/lib/llm/extraction.ts not found (fail closed)"
      : kc.keyHits.length ? `KEY LEAK: ANTHROPIC_API_KEY in ${kc.keyHits.join(", ")}`
      : kc.sdkHits.length ? `SDK LEAK: @anthropic-ai/sdk imported in ${kc.sdkHits.join(", ")}`
      : kc.publicHits.length ? `PUBLIC VAR: NEXT_PUBLIC_ANTHROPIC* in ${kc.publicHits.join(", ")}`
      : `clean across ${kc.scanned} files (key + SDK confined to extraction.ts; no public Anthropic var)`,
  );

  svc = createClient(URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });

  // STAND-IN per-user client (anon key + a real session) — same semantics as the app server client.
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

  // ── [db re-confirmation] job (root) + requirement (child via EXISTS-on-parent) ─────────
  const A = await appUser(A_EMAIL);
  const B = await appUser(B_EMAIL);

  // A seeds a job + two requirements via the per-user client (LLM is NOT called — seeded directly).
  const jiA = await A.c.from("job").insert({ raw_text: MARK + "_A_JOB", company: "A Co", title: "A Role", owner: A.id }).select("id").single();
  if (jiA.error) throw new Error(`A create-job failed: ${jiA.error.message}`);
  const jobA = jiA.data.id;
  const riA = await A.c.from("requirement").insert([
    { job_id: jobA, text: MARK + "_A_REQ1", kind: "must" },
    { job_id: jobA, text: MARK + "_A_REQ2", kind: "nice" },
  ]).select("id");
  if (riA.error) throw new Error(`A create-requirements failed: ${riA.error.message}`);
  const reqA1 = riA.data[0].id;

  // B seeds its own job + requirement (for read-isolation comparison).
  const jiB = await B.c.from("job").insert({ raw_text: MARK + "_B_JOB", company: "B Co", title: "B Role", owner: B.id }).select("id").single();
  if (jiB.error) throw new Error(`B create-job failed: ${jiB.error.message}`);
  const jobB = jiB.data.id;
  const riB = await B.c.from("requirement").insert({ job_id: jobB, text: MARK + "_B_REQ1", kind: "keyword" }).select("id").single();
  if (riB.error) throw new Error(`B create-requirement failed: ${riB.error.message}`);
  const reqB1 = riB.data.id;

  // owner stamping — service-role ground truth says A's job is owned by A.
  const gtJob = await svc.from("job").select("owner").eq("id", jobA).single();
  ok("[db re-confirm] a per-user job insert is owner-stamped to the creator", !gtJob.error && gtJob.data?.owner === A.id, `svc ground truth: job ${jobA.slice(0, 8)} owner=${gtJob.data?.owner?.slice(0, 8)} (A=${A.id.slice(0, 8)})`);

  // read isolation — jobs.
  const jlA = await A.c.from("job").select("id");
  const jlB = await B.c.from("job").select("id");
  const ajIds = new Set((jlA.data || []).map((r) => r.id));
  const bjIds = new Set((jlB.data || []).map((r) => r.id));
  const jobReadIso = !jlA.error && !jlB.error && ajIds.has(jobA) && !ajIds.has(jobB) && bjIds.has(jobB) && !bjIds.has(jobA);
  ok("[db re-confirm] per-user JOB read isolation (each sees only its own)", jobReadIso, `A sees own=${ajIds.has(jobA)} other=${ajIds.has(jobB)}; B sees own=${bjIds.has(jobB)} other=${bjIds.has(jobA)}`);

  // read isolation — requirements (child scoped via EXISTS-on-parent job).
  const rlA = await A.c.from("requirement").select("id");
  const rlB = await B.c.from("requirement").select("id");
  const arIds = new Set((rlA.data || []).map((r) => r.id));
  const brIds = new Set((rlB.data || []).map((r) => r.id));
  const reqReadIso = !rlA.error && !rlB.error && arIds.has(reqA1) && !arIds.has(reqB1) && brIds.has(reqB1) && !brIds.has(reqA1);
  ok("[db re-confirm] per-user REQUIREMENT read isolation (child via parent job)", reqReadIso, `A sees own=${arIds.has(reqA1)} other=${arIds.has(reqB1)}; B sees own=${brIds.has(reqB1)} other=${brIds.has(reqA1)}`);

  // cross-user write — B updating A's job is a silent RLS no-op.
  const jUpd = await B.c.from("job").update({ company: MARK + "_HACKED" }).eq("id", jobA).select("id");
  const jAfter = await svc.from("job").select("company").eq("id", jobA).single();
  const jobEditBlocked = !jUpd.error && (jUpd.data?.length ?? 0) === 0 && jAfter.data?.company === "A Co";
  ok("[db re-confirm] cross-user JOB update is a no-op (B -> A)", jobEditBlocked, `B update rows=${jUpd.data?.length ?? "?"} err=${jUpd.error?.code || "none"}; A.company unchanged=${jAfter.data?.company === "A Co"}`);

  // cross-user write — B updating A's requirement is a silent RLS no-op.
  const rUpd = await B.c.from("requirement").update({ text: MARK + "_HACKED" }).eq("id", reqA1).select("id");
  const rAfter = await svc.from("requirement").select("text").eq("id", reqA1).single();
  const reqEditBlocked = !rUpd.error && (rUpd.data?.length ?? 0) === 0 && rAfter.data?.text === MARK + "_A_REQ1";
  ok("[db re-confirm] cross-user REQUIREMENT update is a no-op (B -> A)", reqEditBlocked, `B update rows=${rUpd.data?.length ?? "?"} err=${rUpd.error?.code || "none"}; A.text unchanged=${rAfter.data?.text === MARK + "_A_REQ1"}`);

  // cross-user write (other direction) — A updating B's job / requirement is a silent RLS no-op.
  // The policy is symmetric; prove it rather than assume it (mirrors the B -> A probes above).
  const jUpdAB = await A.c.from("job").update({ company: MARK + "_HACKED" }).eq("id", jobB).select("id");
  const jAfterAB = await svc.from("job").select("company").eq("id", jobB).single();
  const jobEditBlockedAB = !jUpdAB.error && (jUpdAB.data?.length ?? 0) === 0 && jAfterAB.data?.company === "B Co";
  ok("[db re-confirm] cross-user JOB update is a no-op (A -> B)", jobEditBlockedAB, `A update rows=${jUpdAB.data?.length ?? "?"} err=${jUpdAB.error?.code || "none"}; B.company unchanged=${jAfterAB.data?.company === "B Co"}`);

  const rUpdAB = await A.c.from("requirement").update({ text: MARK + "_HACKED" }).eq("id", reqB1).select("id");
  const rAfterAB = await svc.from("requirement").select("text").eq("id", reqB1).single();
  const reqEditBlockedAB = !rUpdAB.error && (rUpdAB.data?.length ?? 0) === 0 && rAfterAB.data?.text === MARK + "_B_REQ1";
  ok("[db re-confirm] cross-user REQUIREMENT update is a no-op (A -> B)", reqEditBlockedAB, `A update rows=${rUpdAB.data?.length ?? "?"} err=${rUpdAB.error?.code || "none"}; B.text unchanged=${rAfterAB.data?.text === MARK + "_B_REQ1"}`);

  // child-via-parent insert — B inserting a requirement onto A's job is rejected (WITH CHECK).
  const childIns = await B.c.from("requirement").insert({ job_id: jobA, text: MARK + "_B_INTO_A", kind: "keyword" }).select("id");
  const childCount = await svc.from("requirement").select("*", { count: "exact", head: true }).eq("text", MARK + "_B_INTO_A");
  const childBlocked = childIns.error?.code === "42501" && childCount.count === 0;
  ok("[db re-confirm] cross-user child insert onto another's job is rejected (EXISTS-on-parent -> 42501)", childBlocked, `code=${childIns.error?.code || "none"}, rows created=${childCount.count}`);

  // owner spoof — A inserting a job owned by B is rejected (WITH CHECK).
  const spoof = await A.c.from("job").insert({ raw_text: MARK + "_SPOOF", owner: B.id }).select("id");
  const spoofCount = await svc.from("job").select("*", { count: "exact", head: true }).eq("raw_text", MARK + "_SPOOF");
  const spoofBlocked = spoof.error?.code === "42501" && spoofCount.count === 0;
  ok("[db re-confirm] a per-user client cannot spoof job owner (insert as another -> 42501)", spoofBlocked, `code=${spoof.error?.code || "none"}, rows created=${spoofCount.count}`);

  // cross-user delete — B deleting A's job / requirement is a silent RLS no-op.
  const jDel = await B.c.from("job").delete().eq("id", jobA).select("id");
  const jStill = await svc.from("job").select("id").eq("id", jobA).single();
  const jobDelBlocked = !jDel.error && (jDel.data?.length ?? 0) === 0 && !jStill.error && jStill.data?.id === jobA;
  ok("[db re-confirm] cross-user JOB delete is a no-op (B -> A)", jobDelBlocked, `B delete rows=${jDel.data?.length ?? "?"} err=${jDel.error?.code || "none"}; A job still present=${jStill.data?.id === jobA}`);

  const rDel = await B.c.from("requirement").delete().eq("id", reqA1).select("id");
  const rStill = await svc.from("requirement").select("id").eq("id", reqA1).single();
  const reqDelBlocked = !rDel.error && (rDel.data?.length ?? 0) === 0 && !rStill.error && rStill.data?.id === reqA1;
  ok("[db re-confirm] cross-user REQUIREMENT delete is a no-op (B -> A)", reqDelBlocked, `B delete rows=${rDel.data?.length ?? "?"} err=${rDel.error?.code || "none"}; A requirement still present=${rStill.data?.id === reqA1}`);

  // cross-user delete (other direction) — A deleting B's job / requirement is a silent RLS no-op.
  // Runs BEFORE the owner happy path below; these are no-ops, so B's rows stay intact for cleanup.
  const jDelAB = await A.c.from("job").delete().eq("id", jobB).select("id");
  const jStillAB = await svc.from("job").select("id").eq("id", jobB).single();
  const jobDelBlockedAB = !jDelAB.error && (jDelAB.data?.length ?? 0) === 0 && !jStillAB.error && jStillAB.data?.id === jobB;
  ok("[db re-confirm] cross-user JOB delete is a no-op (A -> B)", jobDelBlockedAB, `A delete rows=${jDelAB.data?.length ?? "?"} err=${jDelAB.error?.code || "none"}; B job still present=${jStillAB.data?.id === jobB}`);

  const rDelAB = await A.c.from("requirement").delete().eq("id", reqB1).select("id");
  const rStillAB = await svc.from("requirement").select("id").eq("id", reqB1).single();
  const reqDelBlockedAB = !rDelAB.error && (rDelAB.data?.length ?? 0) === 0 && !rStillAB.error && rStillAB.data?.id === reqB1;
  ok("[db re-confirm] cross-user REQUIREMENT delete is a no-op (A -> B)", reqDelBlockedAB, `A delete rows=${rDelAB.data?.length ?? "?"} err=${rDelAB.error?.code || "none"}; B requirement still present=${rStillAB.data?.id === reqB1}`);

  // owner happy path — A updates its own job, then deletes it (cascading its requirements away).
  const ownUpd = await A.c.from("job").update({ title: "A Role v2" }).eq("id", jobA).select("id");
  const ownUpdGt = await svc.from("job").select("title").eq("id", jobA).single();
  const ownEditOk = !ownUpd.error && (ownUpd.data?.length ?? 0) === 1 && ownUpdGt.data?.title === "A Role v2";
  ok("[db re-confirm] owner can update its own job", ownEditOk, `rows=${ownUpd.data?.length ?? "?"} err=${ownUpd.error?.code || "none"}; title updated=${ownUpdGt.data?.title === "A Role v2"}`);

  const ownDel = await A.c.from("job").delete().eq("id", jobA).select("id");
  const jGone = await svc.from("job").select("*", { count: "exact", head: true }).eq("id", jobA);
  const reqGone = await svc.from("requirement").select("*", { count: "exact", head: true }).eq("job_id", jobA);
  const ownDeleteOk = !ownDel.error && (ownDel.data?.length ?? 0) === 1 && jGone.count === 0 && reqGone.count === 0;
  ok("[db re-confirm] owner can delete its own job (requirements cascade away)", ownDeleteOk, `rows=${ownDel.data?.length ?? "?"} err=${ownDel.error?.code || "none"}; job gone=${jGone.count === 0}; requirements cascaded=${reqGone.count === 0}`);
} catch (e) {
  fatal = short(e);
} finally {
  // Cleanup: delete owned marker jobs FIRST (cascade removes their requirements), then the throwaway
  // users — the auth admin API refuses to delete a user that still owns rows. Surface every error.
  let leftJobs = "?", leftReqs = "?", usersLeft = "?";
  const cleanupErrors = [];
  if (svc) {
    try { const r = await svc.from("job").delete().like("raw_text", "VERITAS_M3_VERIFY_%"); if (r.error) cleanupErrors.push(`job sweep: ${r.error.message}`); } catch (e) { cleanupErrors.push(`job sweep threw: ${short(e)}`); }
    for (const id of created) { try { const d = await svc.auth.admin.deleteUser(id); if (d.error) cleanupErrors.push(`deleteUser: ${d.error.message}`); } catch (e) { cleanupErrors.push(`deleteUser threw: ${short(e)}`); } }
    try { const r = await svc.from("job").select("*", { count: "exact", head: true }).like("raw_text", "VERITAS_M3_VERIFY_%"); leftJobs = r.error ? `err:${r.error.code}` : r.count; } catch { leftJobs = "threw"; }
    try { const r = await svc.from("requirement").select("*", { count: "exact", head: true }).like("text", "VERITAS_M3_VERIFY_%"); leftReqs = r.error ? `err:${r.error.code}` : r.count; } catch { leftReqs = "threw"; }
    try {
      const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) { cleanupErrors.push(`listUsers: ${error.message}`); usersLeft = `unconfirmed(${error.status || ""})`; }
      else { const em = new Set([A_EMAIL, B_EMAIL]); usersLeft = (data?.users || []).filter((u) => em.has(u.email)).length; }
    } catch (e) { cleanupErrors.push(`listUsers threw: ${short(e)}`); usersLeft = "unconfirmed(threw)"; }
  }
  var cleanupClean = cleanupErrors.length === 0 && leftJobs === 0 && leftReqs === 0 && usersLeft === 0;
  console.log(`\ncleanup: leftJobs=${leftJobs}, leftReqs=${leftReqs}, throwaway users left=${usersLeft}${cleanupErrors.length ? "; errors: " + cleanupErrors.join(" | ") : ""} -> ${cleanupClean ? "clean" : "LEAK"}`);
}

console.log("\n=== Veritas M3 — Job Ingest verification (local, LLM stubbed) ===");
if (fatal) { console.log(`✗ COULD NOT VERIFY — ${fatal}`); process.exitCode = 2; }
else {
  let allPass = true;
  for (const c of checks) { console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`); if (!c.pass) allPass = false; }
  if (!allPass) { console.log("\n✗ FAIL — an M3 guard or the job/requirement RLS property did not hold."); process.exitCode = 1; }
  else if (!cleanupClean) { console.log("\n✗ CLEANUP LEAK — checks passed but throwaway data/users remained."); process.exitCode = 3; }
  else { console.log("\n✓ APP GUARDS HELD (no service-role import; anon key verified; Anthropic key server-only) + JOB/REQUIREMENT RLS RE-CONFIRMED via a stand-in per-user client (LLM stubbed). Validation-rejection is proven by vitest (extraction-schema.test.ts). Stack left clean."); process.exitCode = 0; }
}
// allow the event loop to drain (supabase-js keep-alive sockets) then exit cleanly
setTimeout(() => process.exit(process.exitCode || 0), 3000).unref();

// M4 — Coverage Map verification (LLM STUBBED — no API calls, key-less, deterministic).
//
// Run with `npx tsx verify-m4.mjs` (NOT plain node): this harness imports the REAL persistCoverage
// from src/lib/provenance/coverage.ts, so it runs under the tsx TS loader (which honors the tsconfig
// `@/` paths). M2/M3 stay on plain node. It reuses the proven verify-m2/m3 scaffolding (same
// statusJson/jwtRole/isLoopback/walkTs/static scan/key-containment/appUser/svc/ok/cleanup/exit
// semantics), failing closed (non-zero) on any violation. It does THREE things:
//
//   [app guard — binds to the REAL tree]
//     (1a) STATIC service-role scan: no `getDb` / `@/lib/db` / `SUPABASE_SERVICE_ROLE_KEY` anywhere
//          under src/ except the sanctioned getDb definition. Auto-covers the new coverage files.
//     (1b) KEY-ROLE: the app's NEXT_PUBLIC_SUPABASE_ANON_KEY decodes to anon / is publishable.
//     (1c) KEY-CONTAINMENT: ANTHROPIC_API_KEY + `@anthropic-ai/sdk` appear nowhere under src/ EXCEPT
//          the sanctioned server-only transport src/lib/llm/client.ts (M4: both extraction.ts and
//          matching.ts call it); no NEXT_PUBLIC_ANTHROPIC* under src/ or in env files.
//
//   [db re-confirmation — a STAND-IN per-user client, NOT the app path]
//     coverage (child via parent job): the owner happy path, per-user read isolation, cross-user
//     update + delete no-ops in BOTH directions, and the child-via-parent insert guard. Rows are
//     seeded DIRECTLY via the per-user client — the LLM is never called.
//
//   [provenance — the NEW M4 gate, via the REAL persistCoverage]
//     With B's actual per-user client, persistCoverage must REJECT (fail closed, store NOTHING) a
//     coverage citing (i) another user's fact_id or (ii) a requirement outside the job; and (iii) a
//     positive control proves it STORES when the citation is the user's own fact. This drives the
//     real validate -> fetch-owned-sets-via-RLS -> reconcile -> insert composition, not a re-impl.
//
//   [validation rejection — covered by vitest, not here]
//     The pure fail-closed validator (status enum, shape, evidence-consistency, caps) is proven by
//     src/lib/llm/coverage-schema.test.ts (`npm run test`).
//
// LOCAL ONLY: sources stack creds from `supabase status -o json`, refuses a non-loopback target; it
// creates and deletes auth users. Service-role is used ONLY for ground truth + cleanup (never as the
// app data path). Exit 0 = guards held, coverage RLS + provenance re-confirmed, stack left clean.
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REPO = process.argv[2] || process.cwd();
const MARK = "VERITAS_M4_VERIFY_" + randomUUID();
const PW = "veritas-m4-pw-019283";
const A_EMAIL = `veritas-m4-a-${randomUUID().slice(0, 8)}@example.com`;
const B_EMAIL = `veritas-m4-b-${randomUUID().slice(0, 8)}@example.com`;

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

// ── [app guard] static scans of the REAL tree (copied verbatim from verify-m3) ───────
function walkTs(dir, errors) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { errors.push(`readdir ${path.relative(REPO, dir)}: ${short(e)}`); return out; } // fail closed
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p, errors));
    // Codex M4 fix (low): skip declaration files (*.d.ts/*.d.mts/*.d.cts) — type-only, not
    // executable source — BEFORE the loadable-suffix match (they end in .ts/.mts/.cts too).
    else if (/\.d\.(ts|mts|cts)$/.test(e.name)) continue;
    // Codex M4 fix 1: scan every LOADABLE source suffix, not just .ts/.tsx — a .mjs/.cjs/.js/.jsx/
    // .mts/.cts file under src/ can equally read the key or import the service-role client, so a
    // future file in any of them must not slip past the guard.
    else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
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
// The Anthropic key is server-only: ANTHROPIC_API_KEY + the @anthropic-ai/sdk import may appear ONLY
// in the sanctioned transport src/lib/llm/client.ts; no NEXT_PUBLIC_ANTHROPIC* under src/ or env.
function keyContainmentScan() {
  const sanctioned = path.resolve(path.join(REPO, "src", "lib", "llm", "client.ts"));
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

  // CHECK 1a [app guard]: no service-role consumption anywhere under src/ (auto-covers coverage files).
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

  // CHECK 1c [app guard]: the Anthropic key is server-only (containment), sanctioned file = client.ts.
  const kc = keyContainmentScan();
  const kcOk =
    kc.readErrors.length === 0 && kc.scanned > 0 && kc.sanctionedSeen &&
    kc.keyHits.length === 0 && kc.sdkHits.length === 0 && kc.publicHits.length === 0;
  ok(
    "[app guard] ANTHROPIC_API_KEY + @anthropic-ai/sdk are server-only (only in src/lib/llm/client.ts; no NEXT_PUBLIC_ANTHROPIC*)",
    kcOk,
    kc.readErrors.length ? `READ ERROR — fail closed: ${kc.readErrors.join("; ")}`
      : kc.scanned === 0 ? "scanned 0 files — cannot verify (fail closed)"
      : !kc.sanctionedSeen ? "sanctioned module src/lib/llm/client.ts not found (fail closed)"
      : kc.keyHits.length ? `KEY LEAK: ANTHROPIC_API_KEY in ${kc.keyHits.join(", ")}`
      : kc.sdkHits.length ? `SDK LEAK: @anthropic-ai/sdk imported in ${kc.sdkHits.join(", ")}`
      : kc.publicHits.length ? `PUBLIC VAR: NEXT_PUBLIC_ANTHROPIC* in ${kc.publicHits.join(", ")}`
      : `clean across ${kc.scanned} files (key + SDK confined to client.ts; no public Anthropic var)`,
  );

  svc = createClient(URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });

  // Load the REAL persistCoverage (the function the saveCoverage action wraps). Dynamic import +
  // CJS-interop default: tsx compiles the .ts to CJS, so the named export lands on `.default`.
  const covMod = await import("./src/lib/provenance/coverage.ts");
  const persistCoverage = covMod.persistCoverage ?? covMod.default?.persistCoverage;
  if (typeof persistCoverage !== "function") {
    throw new Error("could not load persistCoverage from src/lib/provenance/coverage.ts");
  }

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

  // ── seed (LLM NOT called — rows inserted directly via the per-user client) ───────────
  const A = await appUser(A_EMAIL);
  const B = await appUser(B_EMAIL);

  // A + B each own one fact.
  const fA = await A.c.from("fact").insert({ type: "skill", content: MARK + "_A_FACT", owner: A.id }).select("id").single();
  if (fA.error) throw new Error(`A create-fact failed: ${fA.error.message}`);
  const factA = fA.data.id;
  const fB = await B.c.from("fact").insert({ type: "skill", content: MARK + "_B_FACT", owner: B.id }).select("id").single();
  if (fB.error) throw new Error(`B create-fact failed: ${fB.error.message}`);
  const factB = fB.data.id;
  // B owns a VERIFIED WRITING SAMPLE — voice-only, must NEVER be storable as coverage evidence.
  const fBws = await B.c.from("fact").insert({ type: "writing_sample", content: MARK + "_B_WS", owner: B.id, verified: true }).select("id").single();
  if (fBws.error) throw new Error(`B create-writing-sample failed: ${fBws.error.message}`);
  const factBws = fBws.data.id;

  // A's job: reqA1 (gets coverage, for isolation) + reqA2 (clean, for the child-insert guard).
  const jA = await A.c.from("job").insert({ raw_text: MARK + "_A_JOB", company: "A Co", title: "A Role", owner: A.id }).select("id").single();
  if (jA.error) throw new Error(`A create-job failed: ${jA.error.message}`);
  const jobA = jA.data.id;
  const rA = await A.c.from("requirement").insert([
    { job_id: jobA, text: MARK + "_A_REQ1", kind: "must" },
    { job_id: jobA, text: MARK + "_A_REQ2", kind: "nice" },
  ]).select("id, text");
  if (rA.error) throw new Error(`A create-reqs failed: ${rA.error.message}`);
  const reqA1 = rA.data.find((r) => r.text === MARK + "_A_REQ1").id;
  const reqA2 = rA.data.find((r) => r.text === MARK + "_A_REQ2").id;

  // B's job: reqB1 (gets coverage, for isolation).
  const jB = await B.c.from("job").insert({ raw_text: MARK + "_B_JOB", company: "B Co", title: "B Role", owner: B.id }).select("id").single();
  if (jB.error) throw new Error(`B create-job failed: ${jB.error.message}`);
  const jobB = jB.data.id;
  const rB = await B.c.from("requirement").insert({ job_id: jobB, text: MARK + "_B_REQ1", kind: "must" }).select("id").single();
  if (rB.error) throw new Error(`B create-requirement failed: ${rB.error.message}`);
  const reqB1 = rB.data.id;

  // B's SECOND job: reqB2x — a CLEAN (no coverage) target for the real-persistCoverage provenance probes.
  const jB2 = await B.c.from("job").insert({ raw_text: MARK + "_B_JOB2", company: "B Co", title: "B Role 2", owner: B.id }).select("id").single();
  if (jB2.error) throw new Error(`B create-job2 failed: ${jB2.error.message}`);
  const jobB2 = jB2.data.id;
  const rB2 = await B.c.from("requirement").insert({ job_id: jobB2, text: MARK + "_B_REQ2X", kind: "must" }).select("id").single();
  if (rB2.error) throw new Error(`B create-requirement2 failed: ${rB2.error.message}`);
  const reqB2x = rB2.data.id;

  // ── [db] owner happy path — A stores coverage on its own job citing its own fact ─────
  const covA = await A.c.from("coverage").insert({ job_id: jobA, requirement_id: reqA1, status: "met", fact_ids: [factA] }).select("requirement_id");
  const covAgt = await svc.from("coverage").select("status, fact_ids").eq("job_id", jobA).eq("requirement_id", reqA1).single();
  const ownerHappy = !covA.error && (covA.data?.length ?? 0) === 1 && !covAgt.error
    && covAgt.data?.status === "met" && Array.isArray(covAgt.data?.fact_ids)
    && covAgt.data.fact_ids.length === 1 && covAgt.data.fact_ids[0] === factA;
  ok("[db] owner can store coverage on its own job citing its own fact (happy path)", ownerHappy,
    `rows=${covA.data?.length ?? "?"} err=${covA.error?.code || "none"}; svc status=${covAgt.data?.status} facts=${covAgt.data?.fact_ids?.length}`);

  // B seeds its own coverage row (for the A -> B cross-direction isolation probes).
  const covB = await B.c.from("coverage").insert({ job_id: jobB, requirement_id: reqB1, status: "met", fact_ids: [factB] }).select("requirement_id");
  if (covB.error || (covB.data?.length ?? 0) !== 1) throw new Error(`B seed-coverage failed: ${covB.error?.message || "no row"}`);

  // read isolation — B cannot see A's coverage; A sees its own (child scoped via EXISTS-on-parent job).
  const aSee = await A.c.from("coverage").select("requirement_id").eq("job_id", jobA);
  const bSeeA = await B.c.from("coverage").select("requirement_id").eq("job_id", jobA);
  const readIso = !aSee.error && !bSeeA.error && (aSee.data?.length ?? 0) === 1 && (bSeeA.data?.length ?? 0) === 0;
  ok("[db] coverage read isolation — B cannot see A's coverage (child via parent job)", readIso,
    `A sees own=${aSee.data?.length ?? "?"}; B sees A's=${bSeeA.data?.length ?? "?"}`);

  // cross-user update no-op — B -> A.
  const upBA = await B.c.from("coverage").update({ status: "unmet", fact_ids: [] }).eq("job_id", jobA).eq("requirement_id", reqA1).select("requirement_id");
  const upBAgt = await svc.from("coverage").select("status").eq("job_id", jobA).eq("requirement_id", reqA1).single();
  const upBAok = !upBA.error && (upBA.data?.length ?? 0) === 0 && upBAgt.data?.status === "met";
  ok("[db] cross-user coverage update is a no-op (B -> A)", upBAok,
    `rows=${upBA.data?.length ?? "?"} err=${upBA.error?.code || "none"}; A.status unchanged=${upBAgt.data?.status === "met"}`);

  // cross-user update no-op — A -> B (symmetric; prove it rather than assume it).
  const upAB = await A.c.from("coverage").update({ status: "unmet", fact_ids: [] }).eq("job_id", jobB).eq("requirement_id", reqB1).select("requirement_id");
  const upABgt = await svc.from("coverage").select("status").eq("job_id", jobB).eq("requirement_id", reqB1).single();
  const upABok = !upAB.error && (upAB.data?.length ?? 0) === 0 && upABgt.data?.status === "met";
  ok("[db] cross-user coverage update is a no-op (A -> B)", upABok,
    `rows=${upAB.data?.length ?? "?"} err=${upAB.error?.code || "none"}; B.status unchanged=${upABgt.data?.status === "met"}`);

  // cross-user delete no-op — B -> A.
  const delBA = await B.c.from("coverage").delete().eq("job_id", jobA).eq("requirement_id", reqA1).select("requirement_id");
  const delBAgt = await svc.from("coverage").select("requirement_id").eq("job_id", jobA).eq("requirement_id", reqA1).single();
  const delBAok = !delBA.error && (delBA.data?.length ?? 0) === 0 && !delBAgt.error && delBAgt.data?.requirement_id === reqA1;
  ok("[db] cross-user coverage delete is a no-op (B -> A)", delBAok,
    `rows=${delBA.data?.length ?? "?"} err=${delBA.error?.code || "none"}; A coverage still present=${delBAgt.data?.requirement_id === reqA1}`);

  // cross-user delete no-op — A -> B.
  const delAB = await A.c.from("coverage").delete().eq("job_id", jobB).eq("requirement_id", reqB1).select("requirement_id");
  const delABgt = await svc.from("coverage").select("requirement_id").eq("job_id", jobB).eq("requirement_id", reqB1).single();
  const delABok = !delAB.error && (delAB.data?.length ?? 0) === 0 && !delABgt.error && delABgt.data?.requirement_id === reqB1;
  ok("[db] cross-user coverage delete is a no-op (A -> B)", delABok,
    `rows=${delAB.data?.length ?? "?"} err=${delAB.error?.code || "none"}; B coverage still present=${delABgt.data?.requirement_id === reqB1}`);

  // child-via-parent insert guard — B inserting coverage onto A's job (reqA2, uncovered) is rejected.
  const childIns = await B.c.from("coverage").insert({ job_id: jobA, requirement_id: reqA2, status: "unmet", fact_ids: [] }).select("requirement_id");
  const childCnt = await svc.from("coverage").select("*", { count: "exact", head: true }).eq("job_id", jobA).eq("requirement_id", reqA2);
  const childBlocked = childIns.error?.code === "42501" && childCnt.count === 0;
  ok("[db] cross-user coverage insert onto another's job is rejected (EXISTS-on-parent -> 42501)", childBlocked,
    `code=${childIns.error?.code || "none"}, rows created=${childCnt.count}`);

  // ── [provenance] the REAL persistCoverage, called with B's actual per-user client ────
  // (i) cite another user's fact_id -> REJECTED, nothing stored.
  const provFact = await persistCoverage(B.c, B.id, jobB2, { coverage: [{ requirement_id: reqB2x, status: "met", fact_ids: [factA] }] });
  const provFactCnt = await svc.from("coverage").select("*", { count: "exact", head: true }).eq("job_id", jobB2).eq("requirement_id", reqB2x);
  const provFactOk = provFact?.ok === false && provFactCnt.count === 0;
  ok("[provenance] persistCoverage REJECTS a coverage citing another user's fact_id; nothing stored", provFactOk,
    `result.ok=${provFact?.ok}; err=${short(provFact?.error || "")}; stored rows=${provFactCnt.count}`);

  // (ii) cite a requirement outside the job -> REJECTED, nothing stored.
  const provReq = await persistCoverage(B.c, B.id, jobB2, { coverage: [{ requirement_id: reqA1, status: "unmet", fact_ids: [] }] });
  const provReqCnt = await svc.from("coverage").select("*", { count: "exact", head: true }).eq("job_id", jobB2).eq("requirement_id", reqA1);
  const provReqOk = provReq?.ok === false && provReqCnt.count === 0;
  ok("[provenance] persistCoverage REJECTS a coverage citing a requirement outside the job; nothing stored", provReqOk,
    `result.ok=${provReq?.ok}; err=${short(provReq?.error || "")}; stored rows=${provReqCnt.count}`);

  // (ii-b) cite a VERIFIED WRITING SAMPLE as coverage evidence -> REJECTED. Writing samples are
  // voice-only; persistCoverage's owned set now excludes type=writing_sample, so a writing sample can
  // never be stored as evidence that a requirement is met — the coverage map can never show it either.
  const provWs = await persistCoverage(B.c, B.id, jobB2, { coverage: [{ requirement_id: reqB2x, status: "met", fact_ids: [factBws] }] });
  const provWsCnt = await svc.from("coverage").select("*", { count: "exact", head: true }).eq("job_id", jobB2).eq("requirement_id", reqB2x);
  const provWsOk = provWs?.ok === false && provWsCnt.count === 0;
  ok("[provenance] persistCoverage REJECTS coverage citing a VERIFIED writing_sample fact (voice-only, never evidence); nothing stored", provWsOk,
    `result.ok=${provWs?.ok}; err=${short(provWs?.error || "")}; stored rows=${provWsCnt.count}`);

  // (iii) positive control — cite the user's OWN fact -> STORED (proves the rejection is meaningful).
  const provPos = await persistCoverage(B.c, B.id, jobB2, { coverage: [{ requirement_id: reqB2x, status: "met", fact_ids: [factB] }] });
  const provPosCnt = await svc.from("coverage").select("*", { count: "exact", head: true }).eq("job_id", jobB2).eq("requirement_id", reqB2x);
  const provPosOk = provPos?.ok === true && provPosCnt.count === 1;
  ok("[provenance] positive control — persistCoverage STORES coverage citing the user's own fact", provPosOk,
    `result.ok=${provPos?.ok}; err=${short(provPos?.error || "")}; stored rows=${provPosCnt.count}`);
} catch (e) {
  fatal = short(e);
} finally {
  // Cleanup: delete marker jobs FIRST (cascade removes their requirements + coverage), THEN the now-
  // uncited facts, THEN the throwaway users (the auth admin API refuses a user that still owns rows).
  let leftJobs = "?", leftFacts = "?", usersLeft = "?";
  const cleanupErrors = [];
  if (svc) {
    try { const r = await svc.from("job").delete().like("raw_text", "VERITAS_M4_VERIFY_%"); if (r.error) cleanupErrors.push(`job sweep: ${r.error.message}`); } catch (e) { cleanupErrors.push(`job sweep threw: ${short(e)}`); }
    try { const r = await svc.from("fact").delete().like("content", "VERITAS_M4_VERIFY_%"); if (r.error) cleanupErrors.push(`fact sweep: ${r.error.message}`); } catch (e) { cleanupErrors.push(`fact sweep threw: ${short(e)}`); }
    for (const id of created) { try { const d = await svc.auth.admin.deleteUser(id); if (d.error) cleanupErrors.push(`deleteUser: ${d.error.message}`); } catch (e) { cleanupErrors.push(`deleteUser threw: ${short(e)}`); } }
    try { const r = await svc.from("job").select("*", { count: "exact", head: true }).like("raw_text", "VERITAS_M4_VERIFY_%"); leftJobs = r.error ? `err:${r.error.code}` : r.count; } catch { leftJobs = "threw"; }
    try { const r = await svc.from("fact").select("*", { count: "exact", head: true }).like("content", "VERITAS_M4_VERIFY_%"); leftFacts = r.error ? `err:${r.error.code}` : r.count; } catch { leftFacts = "threw"; }
    try {
      const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) { cleanupErrors.push(`listUsers: ${error.message}`); usersLeft = `unconfirmed(${error.status || ""})`; }
      else { const em = new Set([A_EMAIL, B_EMAIL]); usersLeft = (data?.users || []).filter((u) => em.has(u.email)).length; }
    } catch (e) { cleanupErrors.push(`listUsers threw: ${short(e)}`); usersLeft = "unconfirmed(threw)"; }
  }
  var cleanupClean = cleanupErrors.length === 0 && leftJobs === 0 && leftFacts === 0 && usersLeft === 0;
  console.log(`\ncleanup: leftJobs=${leftJobs}, leftFacts=${leftFacts}, throwaway users left=${usersLeft}${cleanupErrors.length ? "; errors: " + cleanupErrors.join(" | ") : ""} -> ${cleanupClean ? "clean" : "LEAK"}`);
}

console.log("\n=== Veritas M4 — Coverage Map verification (local, LLM stubbed) ===");
if (fatal) { console.log(`✗ COULD NOT VERIFY — ${fatal}`); process.exitCode = 2; }
else {
  let allPass = true;
  for (const c of checks) { console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`); if (!c.pass) allPass = false; }
  if (!allPass) { console.log("\n✗ FAIL — an M4 app guard, the coverage RLS property, or the fact_id-provenance gate did not hold."); process.exitCode = 1; }
  else if (!cleanupClean) { console.log("\n✗ CLEANUP LEAK — checks passed but throwaway data/users remained."); process.exitCode = 3; }
  else { console.log("\n✓ APP GUARDS HELD (no service-role import; anon key verified; Anthropic key server-only in client.ts) + COVERAGE RLS RE-CONFIRMED (read isolation; update + delete no-ops BOTH directions; child-via-parent insert guard) + fact_id-PROVENANCE enforced FAIL-CLOSED via the REAL persistCoverage (foreign fact + foreign requirement + voice-only writing-sample rejected, owned-fact stored). Pure validator proven by vitest (coverage-schema.test.ts). Stack left clean."); process.exitCode = 0; }
}
// allow the event loop to drain (supabase-js keep-alive sockets) then exit cleanly
setTimeout(() => process.exit(process.exitCode || 0), 3000).unref();

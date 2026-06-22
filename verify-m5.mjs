// M5 — Provenance Generation verification (LLM STUBBED — no API calls, key-less, deterministic).
//
// Run with `npx tsx verify-m5.mjs` (NOT plain node): this harness imports the REAL persistResume
// from src/lib/provenance/resume.ts, so it runs under the tsx TS loader (which honors the tsconfig
// `@/` paths). It reuses the proven verify-m4 scaffolding verbatim (statusJson/jwtRole/isLoopback/
// walkTs/static scan/key-containment/appUser/svc/ok/cleanup/exit semantics), failing closed
// (non-zero) on any violation. It does THREE things:
//
//   [app guard — binds to the REAL tree]
//     (1a) STATIC service-role scan: no `getDb` / `@/lib/db` / `SUPABASE_SERVICE_ROLE_KEY` anywhere
//          under src/ except the sanctioned getDb definition. Auto-covers the new résumé files.
//     (1b) KEY-ROLE: the app's NEXT_PUBLIC_SUPABASE_ANON_KEY decodes to anon / is publishable.
//     (1c) KEY-CONTAINMENT: ANTHROPIC_API_KEY + `@anthropic-ai/sdk` appear nowhere under src/ EXCEPT
//          the sanctioned server-only transport src/lib/llm/client.ts (M5: generation.ts calls it,
//          like extraction.ts/matching.ts); no NEXT_PUBLIC_ANTHROPIC* under src/ or in env files.
//
//   [db re-confirmation — a STAND-IN per-user client, NOT the app path]
//     document (child via parent job) AND doc_line (grandchild via document -> job): the owner happy
//     path, per-user read isolation, cross-user update + delete no-ops in BOTH directions, the
//     child-via-parent insert guard, and a re-parent owner-spoof guard. Rows are seeded DIRECTLY via
//     the per-user client — the LLM is never called.
//
//   [provenance — the NEW M5 gate, via the REAL persistResume]
//     With B's actual per-user client, persistResume must REJECT (fail closed, store NOTHING) a
//     résumé line citing (i) the user's own UNVERIFIED fact [the verified-only gate M4 deferred],
//     (ii) another user's fact, (iii) a nonexistent fact; and an (iv) empty-lines payload and a
//     (v) line with a banned word; a (vi) positive control proves it STORES (document + doc_line)
//     when the citation is the user's own VERIFIED fact; and a (vii) second résumé for the same job
//     is rejected (one-résumé rule). This drives the real validate -> verified-fetch-via-RLS ->
//     reconcile -> insert(document+lines) composition, not a re-impl.
//
//   [validation rejection — covered by vitest, not here]
//     The pure fail-closed validator (cited-check, banned-word, shape, UUID, caps) is proven by
//     src/lib/llm/resume-schema.test.ts (`npm run test`).
//
// LOCAL ONLY: sources stack creds from `supabase status -o json`, refuses a non-loopback target; it
// creates and deletes auth users. Service-role is used ONLY for ground truth + cleanup (never as the
// app data path). Exit 0 = guards held, document+doc_line RLS + provenance re-confirmed, stack clean.
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REPO = process.argv[2] || process.cwd();
const MARK = "VERITAS_M5_VERIFY_" + randomUUID();
const PW = "veritas-m5-pw-019283";
const A_EMAIL = `veritas-m5-a-${randomUUID().slice(0, 8)}@example.com`;
const B_EMAIL = `veritas-m5-b-${randomUUID().slice(0, 8)}@example.com`;

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

// ── [app guard] static scans of the REAL tree (copied verbatim from verify-m4) ───────
function walkTs(dir, errors) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { errors.push(`readdir ${path.relative(REPO, dir)}: ${short(e)}`); return out; } // fail closed
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p, errors));
    // skip declaration files (*.d.ts/*.d.mts/*.d.cts) — type-only, not executable source — BEFORE
    // the loadable-suffix match (they end in .ts/.mts/.cts too).
    else if (/\.d\.(ts|mts|cts)$/.test(e.name)) continue;
    // scan every LOADABLE source suffix, not just .ts/.tsx — a .mjs/.cjs/.js/.jsx/.mts/.cts file
    // under src/ can equally read the key or import the service-role client.
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

  // CHECK 1a [app guard]: no service-role consumption anywhere under src/ (auto-covers résumé files).
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

  // Load the REAL persistResume (the function the saveResume action wraps). Dynamic import +
  // CJS-interop default: tsx compiles the .ts to CJS, so the named export lands on `.default`.
  const resMod = await import("./src/lib/provenance/resume.ts");
  const persistResume = resMod.persistResume ?? resMod.default?.persistResume;
  if (typeof persistResume !== "function") {
    throw new Error("could not load persistResume from src/lib/provenance/resume.ts");
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

  // A owns one VERIFIED fact (cited by A's seeded doc_line + the foreign-fact provenance probe).
  const fAv = await A.c.from("fact").insert({ type: "skill", content: MARK + "_A_FACT_V", owner: A.id, verified: true }).select("id").single();
  if (fAv.error) throw new Error(`A create-fact failed: ${fAv.error.message}`);
  const factAv = fAv.data.id;
  // B owns a VERIFIED fact (positive control) and an UNVERIFIED fact (the new M5 gate).
  const fBv = await B.c.from("fact").insert({ type: "skill", content: MARK + "_B_FACT_V", owner: B.id, verified: true }).select("id").single();
  if (fBv.error) throw new Error(`B create-verified-fact failed: ${fBv.error.message}`);
  const factBv = fBv.data.id;
  const fBu = await B.c.from("fact").insert({ type: "skill", content: MARK + "_B_FACT_U", owner: B.id, verified: false }).select("id").single();
  if (fBu.error) throw new Error(`B create-unverified-fact failed: ${fBu.error.message}`);
  const factBu = fBu.data.id;

  // A's job + a seeded résumé document + doc_line (citing A's verified fact) — for isolation probes.
  const jA = await A.c.from("job").insert({ raw_text: MARK + "_A_JOB", company: "A Co", title: "A Role", owner: A.id }).select("id").single();
  if (jA.error) throw new Error(`A create-job failed: ${jA.error.message}`);
  const jobA = jA.data.id;
  const dA = await A.c.from("document").insert({ job_id: jobA, type: "resume", status: "approved" }).select("id").single();
  if (dA.error) throw new Error(`A create-document failed: ${dA.error.message}`);
  const docA = dA.data.id;
  const lA = await A.c.from("doc_line").insert({ document_id: docA, text: MARK + "_A_LINE", fact_ids: [factAv], approved: true, position: 0 }).select("id").single();
  if (lA.error) throw new Error(`A create-doc_line failed: ${lA.error.message}`);
  const lineA = lA.data.id;

  // B's job + a seeded résumé document + doc_line (citing B's verified fact) — for A -> B symmetry.
  const jB = await B.c.from("job").insert({ raw_text: MARK + "_B_JOB", company: "B Co", title: "B Role", owner: B.id }).select("id").single();
  if (jB.error) throw new Error(`B create-job failed: ${jB.error.message}`);
  const jobB = jB.data.id;
  const dB = await B.c.from("document").insert({ job_id: jobB, type: "resume", status: "approved" }).select("id").single();
  if (dB.error) throw new Error(`B create-document failed: ${dB.error.message}`);
  const docB = dB.data.id;
  const lB = await B.c.from("doc_line").insert({ document_id: docB, text: MARK + "_B_LINE", fact_ids: [factBv], approved: true, position: 0 }).select("id").single();
  if (lB.error) throw new Error(`B create-doc_line failed: ${lB.error.message}`);
  const lineB = lB.data.id;

  // B's SECOND job: a CLEAN (no résumé) target for the real-persistResume provenance probes.
  const jB2 = await B.c.from("job").insert({ raw_text: MARK + "_B_JOB2", company: "B Co", title: "B Role 2", owner: B.id }).select("id").single();
  if (jB2.error) throw new Error(`B create-job2 failed: ${jB2.error.message}`);
  const jobB2 = jB2.data.id;

  // ── [db] DOCUMENT isolation (child via parent job) ───────────────────────────────────
  // owner happy path — A already inserted docA above; confirm it via service-role ground truth.
  const docAgt = await svc.from("document").select("id, type, status").eq("id", docA).single();
  const docOwnerHappy = !docAgt.error && docAgt.data?.type === "resume" && docAgt.data?.status === "approved";
  ok("[db] owner can store a document on its own job (happy path)", docOwnerHappy,
    `svc type=${docAgt.data?.type} status=${docAgt.data?.status} err=${docAgt.error?.code || "none"}`);

  // read isolation — B cannot see A's document; A sees its own (child scoped via EXISTS-on-parent job).
  const aSeeDoc = await A.c.from("document").select("id").eq("id", docA);
  const bSeeDocA = await B.c.from("document").select("id").eq("id", docA);
  const docReadIso = !aSeeDoc.error && !bSeeDocA.error && (aSeeDoc.data?.length ?? 0) === 1 && (bSeeDocA.data?.length ?? 0) === 0;
  ok("[db] document read isolation — B cannot see A's document", docReadIso,
    `A sees own=${aSeeDoc.data?.length ?? "?"}; B sees A's=${bSeeDocA.data?.length ?? "?"}`);

  // cross-user update no-op — B -> A and A -> B (USING filters the foreign row to a silent no-op).
  const upDocBA = await B.c.from("document").update({ status: "draft" }).eq("id", docA).select("id");
  const upDocBAgt = await svc.from("document").select("status").eq("id", docA).single();
  const upDocBAok = !upDocBA.error && (upDocBA.data?.length ?? 0) === 0 && upDocBAgt.data?.status === "approved";
  ok("[db] cross-user document update is a no-op (B -> A)", upDocBAok,
    `rows=${upDocBA.data?.length ?? "?"} err=${upDocBA.error?.code || "none"}; A.status unchanged=${upDocBAgt.data?.status === "approved"}`);

  const upDocAB = await A.c.from("document").update({ status: "draft" }).eq("id", docB).select("id");
  const upDocABgt = await svc.from("document").select("status").eq("id", docB).single();
  const upDocABok = !upDocAB.error && (upDocAB.data?.length ?? 0) === 0 && upDocABgt.data?.status === "approved";
  ok("[db] cross-user document update is a no-op (A -> B)", upDocABok,
    `rows=${upDocAB.data?.length ?? "?"} err=${upDocAB.error?.code || "none"}; B.status unchanged=${upDocABgt.data?.status === "approved"}`);

  // re-parent owner-spoof — B owns docB; re-homing it onto A's job trips WITH CHECK (hard 42501).
  const spoofDoc = await B.c.from("document").update({ job_id: jobA }).eq("id", docB).select("id");
  const spoofDocGt = await svc.from("document").select("job_id").eq("id", docB).single();
  const spoofDocOk = spoofDoc.error?.code === "42501" && spoofDocGt.data?.job_id === jobB;
  ok("[db] document re-parent onto another's job is rejected (owner-spoof -> 42501)", spoofDocOk,
    `code=${spoofDoc.error?.code || "none"}; docB job unchanged=${spoofDocGt.data?.job_id === jobB}`);

  // cross-user delete no-op — B -> A and A -> B.
  const delDocBA = await B.c.from("document").delete().eq("id", docA).select("id");
  const delDocBAgt = await svc.from("document").select("id").eq("id", docA).single();
  const delDocBAok = !delDocBA.error && (delDocBA.data?.length ?? 0) === 0 && !delDocBAgt.error && delDocBAgt.data?.id === docA;
  ok("[db] cross-user document delete is a no-op (B -> A)", delDocBAok,
    `rows=${delDocBA.data?.length ?? "?"} err=${delDocBA.error?.code || "none"}; A document still present=${delDocBAgt.data?.id === docA}`);

  const delDocAB = await A.c.from("document").delete().eq("id", docB).select("id");
  const delDocABgt = await svc.from("document").select("id").eq("id", docB).single();
  const delDocABok = !delDocAB.error && (delDocAB.data?.length ?? 0) === 0 && !delDocABgt.error && delDocABgt.data?.id === docB;
  ok("[db] cross-user document delete is a no-op (A -> B)", delDocABok,
    `rows=${delDocAB.data?.length ?? "?"} err=${delDocAB.error?.code || "none"}; B document still present=${delDocABgt.data?.id === docB}`);

  // child-via-parent insert guard — B inserting a document onto A's job is rejected (EXISTS-on-parent).
  const childDoc = await B.c.from("document").insert({ job_id: jobA, type: "resume", status: "draft" }).select("id");
  const childDocCnt = await svc.from("document").select("*", { count: "exact", head: true }).eq("job_id", jobA);
  const childDocBlocked = childDoc.error?.code === "42501" && childDocCnt.count === 1; // only A's original
  ok("[db] cross-user document insert onto another's job is rejected (EXISTS-on-parent -> 42501)", childDocBlocked,
    `code=${childDoc.error?.code || "none"}; documents on A's job=${childDocCnt.count} (expect 1)`);

  // ── [db] DOC_LINE isolation (grandchild via document -> job, two hops) ────────────────
  // owner happy path — A already inserted lineA above; confirm it via service-role ground truth.
  const lineAgt = await svc.from("doc_line").select("id, approved, fact_ids").eq("id", lineA).single();
  const lineOwnerHappy = !lineAgt.error && lineAgt.data?.approved === true
    && Array.isArray(lineAgt.data?.fact_ids) && lineAgt.data.fact_ids.length === 1 && lineAgt.data.fact_ids[0] === factAv;
  ok("[db] owner can store a doc_line on its own document (happy path)", lineOwnerHappy,
    `svc approved=${lineAgt.data?.approved} facts=${lineAgt.data?.fact_ids?.length} err=${lineAgt.error?.code || "none"}`);

  // read isolation — B cannot see A's doc_line; A sees its own (two-hop EXISTS-on-parent).
  const aSeeLine = await A.c.from("doc_line").select("id").eq("id", lineA);
  const bSeeLineA = await B.c.from("doc_line").select("id").eq("id", lineA);
  const lineReadIso = !aSeeLine.error && !bSeeLineA.error && (aSeeLine.data?.length ?? 0) === 1 && (bSeeLineA.data?.length ?? 0) === 0;
  ok("[db] doc_line read isolation — B cannot see A's doc_line (two-hop via document -> job)", lineReadIso,
    `A sees own=${aSeeLine.data?.length ?? "?"}; B sees A's=${bSeeLineA.data?.length ?? "?"}`);

  // cross-user update no-op — B -> A and A -> B (update `approved`, a non-fact_ids field).
  const upLineBA = await B.c.from("doc_line").update({ approved: false }).eq("id", lineA).select("id");
  const upLineBAgt = await svc.from("doc_line").select("approved").eq("id", lineA).single();
  const upLineBAok = !upLineBA.error && (upLineBA.data?.length ?? 0) === 0 && upLineBAgt.data?.approved === true;
  ok("[db] cross-user doc_line update is a no-op (B -> A)", upLineBAok,
    `rows=${upLineBA.data?.length ?? "?"} err=${upLineBA.error?.code || "none"}; A.approved unchanged=${upLineBAgt.data?.approved === true}`);

  const upLineAB = await A.c.from("doc_line").update({ approved: false }).eq("id", lineB).select("id");
  const upLineABgt = await svc.from("doc_line").select("approved").eq("id", lineB).single();
  const upLineABok = !upLineAB.error && (upLineAB.data?.length ?? 0) === 0 && upLineABgt.data?.approved === true;
  ok("[db] cross-user doc_line update is a no-op (A -> B)", upLineABok,
    `rows=${upLineAB.data?.length ?? "?"} err=${upLineAB.error?.code || "none"}; B.approved unchanged=${upLineABgt.data?.approved === true}`);

  // cross-user delete no-op — B -> A and A -> B.
  const delLineBA = await B.c.from("doc_line").delete().eq("id", lineA).select("id");
  const delLineBAgt = await svc.from("doc_line").select("id").eq("id", lineA).single();
  const delLineBAok = !delLineBA.error && (delLineBA.data?.length ?? 0) === 0 && !delLineBAgt.error && delLineBAgt.data?.id === lineA;
  ok("[db] cross-user doc_line delete is a no-op (B -> A)", delLineBAok,
    `rows=${delLineBA.data?.length ?? "?"} err=${delLineBA.error?.code || "none"}; A doc_line still present=${delLineBAgt.data?.id === lineA}`);

  const delLineAB = await A.c.from("doc_line").delete().eq("id", lineB).select("id");
  const delLineABgt = await svc.from("doc_line").select("id").eq("id", lineB).single();
  const delLineABok = !delLineAB.error && (delLineAB.data?.length ?? 0) === 0 && !delLineABgt.error && delLineABgt.data?.id === lineB;
  ok("[db] cross-user doc_line delete is a no-op (A -> B)", delLineABok,
    `rows=${delLineAB.data?.length ?? "?"} err=${delLineAB.error?.code || "none"}; B doc_line still present=${delLineABgt.data?.id === lineB}`);

  // child-via-parent insert guard — B inserting a doc_line onto A's document is rejected. B cites its
  // OWN verified fact so the existence trigger passes and RLS (two-hop) is the sole rejection (42501).
  const childLine = await B.c.from("doc_line").insert({ document_id: docA, text: MARK + "_B_INTRUDE", fact_ids: [factBv], approved: true, position: 1 }).select("id");
  const childLineCnt = await svc.from("doc_line").select("*", { count: "exact", head: true }).eq("document_id", docA);
  const childLineBlocked = childLine.error?.code === "42501" && childLineCnt.count === 1; // only A's original
  ok("[db] cross-user doc_line insert onto another's document is rejected (two-hop EXISTS -> 42501)", childLineBlocked,
    `code=${childLine.error?.code || "none"}; doc_lines on A's document=${childLineCnt.count} (expect 1)`);

  // ── [provenance] the REAL persistResume, called with B's actual per-user client ──────
  // Helper: how many résumé documents exist on jobB2 (per service-role ground truth).
  const resumeDocs = async () => (await svc.from("document").select("id").eq("job_id", jobB2).eq("type", "resume")).data ?? [];

  // (i) cite the user's OWN UNVERIFIED fact -> REJECTED, nothing stored. THE NEW M5 GATE.
  const provUnv = await persistResume(B.c, B.id, jobB2, { lines: [{ text: "Did real work here", fact_ids: [factBu] }] });
  const provUnvOk = provUnv?.ok === false && (await resumeDocs()).length === 0;
  ok("[provenance] persistResume REJECTS a line citing the user's own UNVERIFIED fact; nothing stored", provUnvOk,
    `result.ok=${provUnv?.ok}; err=${short(provUnv?.error || "")}; résumé docs on job=${(await resumeDocs()).length}`);

  // (ii) cite ANOTHER user's fact_id -> REJECTED, nothing stored.
  const provForeign = await persistResume(B.c, B.id, jobB2, { lines: [{ text: "Did real work here", fact_ids: [factAv] }] });
  const provForeignOk = provForeign?.ok === false && (await resumeDocs()).length === 0;
  ok("[provenance] persistResume REJECTS a line citing another user's fact; nothing stored", provForeignOk,
    `result.ok=${provForeign?.ok}; err=${short(provForeign?.error || "")}; résumé docs on job=${(await resumeDocs()).length}`);

  // (iii) cite a NONEXISTENT fact -> REJECTED, nothing stored.
  const provGhost = await persistResume(B.c, B.id, jobB2, { lines: [{ text: "Did real work here", fact_ids: [randomUUID()] }] });
  const provGhostOk = provGhost?.ok === false && (await resumeDocs()).length === 0;
  ok("[provenance] persistResume REJECTS a line citing a nonexistent fact; nothing stored", provGhostOk,
    `result.ok=${provGhost?.ok}; err=${short(provGhost?.error || "")}; résumé docs on job=${(await resumeDocs()).length}`);

  // (iv) EMPTY-lines payload -> REJECTED (no empty document), nothing stored.
  const provEmpty = await persistResume(B.c, B.id, jobB2, { lines: [] });
  const provEmptyOk = provEmpty?.ok === false && (await resumeDocs()).length === 0;
  ok("[provenance] persistResume REJECTS an empty-lines payload (no empty document); nothing stored", provEmptyOk,
    `result.ok=${provEmpty?.ok}; err=${short(provEmpty?.error || "")}; résumé docs on job=${(await resumeDocs()).length}`);

  // (v) BANNED word in a line citing a valid, verified, owned fact -> REJECTED by the banned gate.
  const provBanned = await persistResume(B.c, B.id, jobB2, { lines: [{ text: "Spearheaded the migration", fact_ids: [factBv] }] });
  const provBannedOk = provBanned?.ok === false && (await resumeDocs()).length === 0;
  ok("[provenance] persistResume REJECTS a line containing a banned word; nothing stored", provBannedOk,
    `result.ok=${provBanned?.ok}; err=${short(provBanned?.error || "")}; résumé docs on job=${(await resumeDocs()).length}`);

  // (vi) positive control — cite the user's OWN VERIFIED fact -> STORED (document + doc_line).
  const provPos = await persistResume(B.c, B.id, jobB2, { lines: [{ text: MARK + "_RESUME_LINE", fact_ids: [factBv] }] });
  const posDocs = await resumeDocs();
  const posLineCnt = posDocs.length === 1
    ? await svc.from("doc_line").select("*", { count: "exact", head: true }).eq("document_id", posDocs[0].id)
    : { count: 0 };
  const provPosOk = provPos?.ok === true && posDocs.length === 1 && posLineCnt.count === 1;
  ok("[provenance] positive control — persistResume STORES a résumé citing the user's own VERIFIED fact", provPosOk,
    `result.ok=${provPos?.ok}; err=${short(provPos?.error || "")}; résumé docs=${posDocs.length}; doc_lines=${posLineCnt.count}`);

  // (vii) second résumé for the same job -> REJECTED (one-résumé rule); still exactly one stored.
  const provDup = await persistResume(B.c, B.id, jobB2, { lines: [{ text: MARK + "_RESUME_LINE_2", fact_ids: [factBv] }] });
  const provDupOk = provDup?.ok === false && (await resumeDocs()).length === 1;
  ok("[provenance] persistResume REJECTS a second résumé for the same job (one-résumé rule)", provDupOk,
    `result.ok=${provDup?.ok}; err=${short(provDup?.error || "")}; résumé docs on job=${(await resumeDocs()).length} (expect 1)`);
} catch (e) {
  fatal = short(e);
} finally {
  // Cleanup: delete marker jobs FIRST (cascade removes their documents + doc_lines, releasing the
  // fact citations), THEN the now-uncited facts, THEN the throwaway users (the auth admin API
  // refuses a user that still owns rows).
  let leftJobs = "?", leftFacts = "?", usersLeft = "?";
  const cleanupErrors = [];
  if (svc) {
    try { const r = await svc.from("job").delete().like("raw_text", "VERITAS_M5_VERIFY_%"); if (r.error) cleanupErrors.push(`job sweep: ${r.error.message}`); } catch (e) { cleanupErrors.push(`job sweep threw: ${short(e)}`); }
    try { const r = await svc.from("fact").delete().like("content", "VERITAS_M5_VERIFY_%"); if (r.error) cleanupErrors.push(`fact sweep: ${r.error.message}`); } catch (e) { cleanupErrors.push(`fact sweep threw: ${short(e)}`); }
    for (const id of created) { try { const d = await svc.auth.admin.deleteUser(id); if (d.error) cleanupErrors.push(`deleteUser: ${d.error.message}`); } catch (e) { cleanupErrors.push(`deleteUser threw: ${short(e)}`); } }
    try { const r = await svc.from("job").select("*", { count: "exact", head: true }).like("raw_text", "VERITAS_M5_VERIFY_%"); leftJobs = r.error ? `err:${r.error.code}` : r.count; } catch { leftJobs = "threw"; }
    try { const r = await svc.from("fact").select("*", { count: "exact", head: true }).like("content", "VERITAS_M5_VERIFY_%"); leftFacts = r.error ? `err:${r.error.code}` : r.count; } catch { leftFacts = "threw"; }
    try {
      const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) { cleanupErrors.push(`listUsers: ${error.message}`); usersLeft = `unconfirmed(${error.status || ""})`; }
      else { const em = new Set([A_EMAIL, B_EMAIL]); usersLeft = (data?.users || []).filter((u) => em.has(u.email)).length; }
    } catch (e) { cleanupErrors.push(`listUsers threw: ${short(e)}`); usersLeft = "unconfirmed(threw)"; }
  }
  var cleanupClean = cleanupErrors.length === 0 && leftJobs === 0 && leftFacts === 0 && usersLeft === 0;
  console.log(`\ncleanup: leftJobs=${leftJobs}, leftFacts=${leftFacts}, throwaway users left=${usersLeft}${cleanupErrors.length ? "; errors: " + cleanupErrors.join(" | ") : ""} -> ${cleanupClean ? "clean" : "LEAK"}`);
}

console.log("\n=== Veritas M5 — Provenance Generation verification (local, LLM stubbed) ===");
if (fatal) { console.log(`✗ COULD NOT VERIFY — ${fatal}`); process.exitCode = 2; }
else {
  let allPass = true;
  for (const c of checks) { console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`); if (!c.pass) allPass = false; }
  if (!allPass) { console.log("\n✗ FAIL — an M5 app guard, a document/doc_line RLS property, or the verified+owned provenance gate did not hold."); process.exitCode = 1; }
  else if (!cleanupClean) { console.log("\n✗ CLEANUP LEAK — checks passed but throwaway data/users remained."); process.exitCode = 3; }
  else { console.log("\n✓ APP GUARDS HELD (no service-role import; anon key verified; Anthropic key server-only in client.ts) + DOCUMENT & DOC_LINE RLS RE-CONFIRMED (read isolation; update + delete no-ops BOTH directions; child-via-parent insert guard; re-parent owner-spoof) + VERIFIED+OWNED PROVENANCE enforced FAIL-CLOSED via the REAL persistResume (unverified + foreign + nonexistent fact rejected, empty-lines + banned-word rejected, own-verified-fact stored, second résumé rejected). Pure validator proven by vitest (resume-schema.test.ts). Stack left clean."); process.exitCode = 0; }
}
// allow the event loop to drain (supabase-js keep-alive sockets) then exit cleanly
setTimeout(() => process.exit(process.exitCode || 0), 3000).unref();

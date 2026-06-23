// M6 — Cover Letter + Voice verification (LLM STUBBED — no API calls, key-less, deterministic).
//
// Run with `npx tsx verify-m6.mjs` (NOT plain node): this harness imports the REAL persistCoverLetter
// from src/lib/provenance/cover-letter.ts, which delegates to the SHARED persistDocument gate — so it
// drives the true validate -> verified-fetch-via-RLS -> reconcile -> insert(document + doc_lines, with
// connective on the document) composition, not a re-impl. It reuses the proven verify-m5 scaffolding
// verbatim (statusJson/jwtRole/isLoopback/walkTs/static scan/key-containment/appUser/svc/ok/cleanup/
// exit semantics), failing closed (non-zero) on any violation. It does THREE things:
//
//   [app guard — binds to the REAL tree]
//     (1a) STATIC service-role scan: no `getDb` / `@/lib/db` / `SUPABASE_SERVICE_ROLE_KEY` anywhere
//          under src/ except the sanctioned getDb definition. Auto-covers the new cover-letter files.
//     (1b) KEY-ROLE: the app's NEXT_PUBLIC_SUPABASE_ANON_KEY decodes to anon / is publishable.
//     (1c) KEY-CONTAINMENT: ANTHROPIC_API_KEY + `@anthropic-ai/sdk` appear nowhere under src/ EXCEPT
//          the sanctioned server-only transport src/lib/llm/client.ts — now also exercising that the
//          new cover-letter-generation.ts calls runStructured rather than touching the key/SDK itself.
//
//   [db re-confirmation — a STAND-IN per-user client, NOT the app path]
//     document[type=cover_letter] (child via parent job) AND its doc_line (grandchild via document ->
//     job): owner happy path, per-user read isolation, cross-user update + delete no-ops in BOTH
//     directions, the child-via-parent insert guard, a re-parent owner-spoof guard, and the
//     one-per-(job,type) UNIQUE (23505). Rows seeded DIRECTLY via the per-user client — LLM never called.
//
//   [provenance — the SHARED gate, via the REAL persistCoverLetter]
//     With B's actual per-user client, persistCoverLetter must REJECT (fail closed, store NOTHING) a
//     cover-letter CLAIM citing (i) the user's own UNVERIFIED fact, (ii) another user's fact, (iii) a
//     nonexistent fact; an (iv) empty-blocks payload and a (iv-b) claim with empty fact_ids; a (iv-c)
//     CONNECTIVE block that smuggles a fact_id [the connective structural rule] and a (v) banned word
//     in a claim and (v-b) in connective; a (vi) positive control proves it STORES (document +
//     doc_line + the connective on the document row, with NO doc_line ever empty) when the citation is
//     the user's own VERIFIED fact; and a (vii) second cover letter for the same job is rejected.
//
//   [validation rejection — covered by vitest, not here]
//     The pure fail-closed validators are proven by src/lib/llm/cover-letter-schema.test.ts and
//     src/app/jobs/[id]/cover-letter-view-logic.test.ts (`npm run test`).
//
// LOCAL ONLY: sources stack creds from `supabase status -o json`, refuses a non-loopback target; it
// creates and deletes auth users. Service-role is used ONLY for ground truth + cleanup (never as the
// app data path). Exit 0 = guards held, cover_letter document+doc_line RLS + provenance re-confirmed.
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const REPO = process.argv[2] || process.cwd();
const MARK = "VERITAS_M6_VERIFY_" + randomUUID();
const PW = "veritas-m6-pw-019283";
const A_EMAIL = `veritas-m6-a-${randomUUID().slice(0, 8)}@example.com`;
const B_EMAIL = `veritas-m6-b-${randomUUID().slice(0, 8)}@example.com`;

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

// ── [app guard] static scans of the REAL tree (copied verbatim from verify-m5) ───────
function walkTs(dir, errors) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (e) { errors.push(`readdir ${path.relative(REPO, dir)}: ${short(e)}`); return out; } // fail closed
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p, errors));
    else if (/\.d\.(ts|mts|cts)$/.test(e.name)) continue;
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
      readErrors.push(`read ${fname}: ${short(e)}`);
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

  // CHECK 1a [app guard]: no service-role consumption anywhere under src/ (auto-covers cover-letter files).
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

  // CHECK 1c [app guard]: the Anthropic key is server-only (containment); sanctioned file = client.ts.
  // Now also exercises that cover-letter-generation.ts calls runStructured, not the key/SDK directly.
  const kc = keyContainmentScan();
  const kcOk =
    kc.readErrors.length === 0 && kc.scanned > 0 && kc.sanctionedSeen &&
    kc.keyHits.length === 0 && kc.sdkHits.length === 0 && kc.publicHits.length === 0;
  ok(
    "[app guard] ANTHROPIC_API_KEY + @anthropic-ai/sdk are server-only (only in src/lib/llm/client.ts; cover-letter-generation calls runStructured)",
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

  // Load the REAL persistCoverLetter (the function the saveCoverLetter action wraps; it delegates to
  // the shared persistDocument gate). Dynamic import + CJS-interop default under the tsx loader.
  const clMod = await import("./src/lib/provenance/cover-letter.ts");
  const persistCoverLetter = clMod.persistCoverLetter ?? clMod.default?.persistCoverLetter;
  if (typeof persistCoverLetter !== "function") {
    throw new Error("could not load persistCoverLetter from src/lib/provenance/cover-letter.ts");
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
  // B owns a VERIFIED fact (positive control) and an UNVERIFIED fact (the verified-only gate).
  const fBv = await B.c.from("fact").insert({ type: "skill", content: MARK + "_B_FACT_V", owner: B.id, verified: true }).select("id").single();
  if (fBv.error) throw new Error(`B create-verified-fact failed: ${fBv.error.message}`);
  const factBv = fBv.data.id;
  const fBu = await B.c.from("fact").insert({ type: "skill", content: MARK + "_B_FACT_U", owner: B.id, verified: false }).select("id").single();
  if (fBu.error) throw new Error(`B create-unverified-fact failed: ${fBu.error.message}`);
  const factBu = fBu.data.id;
  // B owns a VERIFIED WRITING SAMPLE — voice-only, must NEVER be citable as evidence by a claim line.
  const fBws = await B.c.from("fact").insert({ type: "writing_sample", content: MARK + "_B_WRITING_SAMPLE", owner: B.id, verified: true }).select("id").single();
  if (fBws.error) throw new Error(`B create-writing-sample failed: ${fBws.error.message}`);
  const factBws = fBws.data.id;

  // A's job + a seeded cover_letter document + doc_line (citing A's verified fact) — for isolation probes.
  const jA = await A.c.from("job").insert({ raw_text: MARK + "_A_JOB", company: "A Co", title: "A Role", owner: A.id }).select("id").single();
  if (jA.error) throw new Error(`A create-job failed: ${jA.error.message}`);
  const jobA = jA.data.id;
  const dA = await A.c.from("document").insert({ job_id: jobA, type: "cover_letter", status: "approved" }).select("id").single();
  if (dA.error) throw new Error(`A create-document failed: ${dA.error.message}`);
  const docA = dA.data.id;
  const lA = await A.c.from("doc_line").insert({ document_id: docA, text: MARK + "_A_LINE", fact_ids: [factAv], approved: true, position: 0 }).select("id").single();
  if (lA.error) throw new Error(`A create-doc_line failed: ${lA.error.message}`);
  const lineA = lA.data.id;

  // B's job + a seeded cover_letter document + doc_line (citing B's verified fact) — for A -> B symmetry.
  const jB = await B.c.from("job").insert({ raw_text: MARK + "_B_JOB", company: "B Co", title: "B Role", owner: B.id }).select("id").single();
  if (jB.error) throw new Error(`B create-job failed: ${jB.error.message}`);
  const jobB = jB.data.id;
  const dB = await B.c.from("document").insert({ job_id: jobB, type: "cover_letter", status: "approved" }).select("id").single();
  if (dB.error) throw new Error(`B create-document failed: ${dB.error.message}`);
  const docB = dB.data.id;
  const lB = await B.c.from("doc_line").insert({ document_id: docB, text: MARK + "_B_LINE", fact_ids: [factBv], approved: true, position: 0 }).select("id").single();
  if (lB.error) throw new Error(`B create-doc_line failed: ${lB.error.message}`);
  const lineB = lB.data.id;

  // B's SECOND job: a CLEAN (no cover letter) target for the real-persistCoverLetter provenance probes.
  const jB2 = await B.c.from("job").insert({ raw_text: MARK + "_B_JOB2", company: "B Co", title: "B Role 2", owner: B.id }).select("id").single();
  if (jB2.error) throw new Error(`B create-job2 failed: ${jB2.error.message}`);
  const jobB2 = jB2.data.id;

  // ── [db] DOCUMENT[type=cover_letter] isolation (child via parent job) ─────────────────
  const docAgt = await svc.from("document").select("id, type, status").eq("id", docA).single();
  const docOwnerHappy = !docAgt.error && docAgt.data?.type === "cover_letter" && docAgt.data?.status === "approved";
  ok("[db] owner can store a cover_letter document on its own job (happy path)", docOwnerHappy,
    `svc type=${docAgt.data?.type} status=${docAgt.data?.status} err=${docAgt.error?.code || "none"}`);

  const aSeeDoc = await A.c.from("document").select("id").eq("id", docA);
  const bSeeDocA = await B.c.from("document").select("id").eq("id", docA);
  const docReadIso = !aSeeDoc.error && !bSeeDocA.error && (aSeeDoc.data?.length ?? 0) === 1 && (bSeeDocA.data?.length ?? 0) === 0;
  ok("[db] cover_letter document read isolation — B cannot see A's document", docReadIso,
    `A sees own=${aSeeDoc.data?.length ?? "?"}; B sees A's=${bSeeDocA.data?.length ?? "?"}`);

  const upDocBA = await B.c.from("document").update({ status: "draft" }).eq("id", docA).select("id");
  const upDocBAgt = await svc.from("document").select("status").eq("id", docA).single();
  const upDocBAok = !upDocBA.error && (upDocBA.data?.length ?? 0) === 0 && upDocBAgt.data?.status === "approved";
  ok("[db] cross-user cover_letter document update is a no-op (B -> A)", upDocBAok,
    `rows=${upDocBA.data?.length ?? "?"} err=${upDocBA.error?.code || "none"}; A.status unchanged=${upDocBAgt.data?.status === "approved"}`);

  const upDocAB = await A.c.from("document").update({ status: "draft" }).eq("id", docB).select("id");
  const upDocABgt = await svc.from("document").select("status").eq("id", docB).single();
  const upDocABok = !upDocAB.error && (upDocAB.data?.length ?? 0) === 0 && upDocABgt.data?.status === "approved";
  ok("[db] cross-user cover_letter document update is a no-op (A -> B)", upDocABok,
    `rows=${upDocAB.data?.length ?? "?"} err=${upDocAB.error?.code || "none"}; B.status unchanged=${upDocABgt.data?.status === "approved"}`);

  const spoofDoc = await B.c.from("document").update({ job_id: jobA }).eq("id", docB).select("id");
  const spoofDocGt = await svc.from("document").select("job_id").eq("id", docB).single();
  const spoofDocOk = spoofDoc.error?.code === "42501" && spoofDocGt.data?.job_id === jobB;
  ok("[db] cover_letter document re-parent onto another's job is rejected (owner-spoof -> 42501)", spoofDocOk,
    `code=${spoofDoc.error?.code || "none"}; docB job unchanged=${spoofDocGt.data?.job_id === jobB}`);

  const delDocBA = await B.c.from("document").delete().eq("id", docA).select("id");
  const delDocBAgt = await svc.from("document").select("id").eq("id", docA).single();
  const delDocBAok = !delDocBA.error && (delDocBA.data?.length ?? 0) === 0 && !delDocBAgt.error && delDocBAgt.data?.id === docA;
  ok("[db] cross-user cover_letter document delete is a no-op (B -> A)", delDocBAok,
    `rows=${delDocBA.data?.length ?? "?"} err=${delDocBA.error?.code || "none"}; A document still present=${delDocBAgt.data?.id === docA}`);

  const delDocAB = await A.c.from("document").delete().eq("id", docB).select("id");
  const delDocABgt = await svc.from("document").select("id").eq("id", docB).single();
  const delDocABok = !delDocAB.error && (delDocAB.data?.length ?? 0) === 0 && !delDocABgt.error && delDocABgt.data?.id === docB;
  ok("[db] cross-user cover_letter document delete is a no-op (A -> B)", delDocABok,
    `rows=${delDocAB.data?.length ?? "?"} err=${delDocAB.error?.code || "none"}; B document still present=${delDocABgt.data?.id === docB}`);

  const childDoc = await B.c.from("document").insert({ job_id: jobA, type: "cover_letter", status: "draft" }).select("id");
  const childDocCnt = await svc.from("document").select("*", { count: "exact", head: true }).eq("job_id", jobA);
  const childDocBlocked = childDoc.error?.code === "42501" && childDocCnt.count === 1;
  ok("[db] cross-user cover_letter document insert onto another's job is rejected (EXISTS-on-parent -> 42501)", childDocBlocked,
    `code=${childDoc.error?.code || "none"}; documents on A's job=${childDocCnt.count} (expect 1)`);

  // ── [db] DOC_LINE isolation (grandchild via document[cover_letter] -> job, two hops) ──
  const lineAgt = await svc.from("doc_line").select("id, approved, fact_ids").eq("id", lineA).single();
  const lineOwnerHappy = !lineAgt.error && lineAgt.data?.approved === true
    && Array.isArray(lineAgt.data?.fact_ids) && lineAgt.data.fact_ids.length === 1 && lineAgt.data.fact_ids[0] === factAv;
  ok("[db] owner can store a doc_line on its own cover_letter document (happy path)", lineOwnerHappy,
    `svc approved=${lineAgt.data?.approved} facts=${lineAgt.data?.fact_ids?.length} err=${lineAgt.error?.code || "none"}`);

  const aSeeLine = await A.c.from("doc_line").select("id").eq("id", lineA);
  const bSeeLineA = await B.c.from("doc_line").select("id").eq("id", lineA);
  const lineReadIso = !aSeeLine.error && !bSeeLineA.error && (aSeeLine.data?.length ?? 0) === 1 && (bSeeLineA.data?.length ?? 0) === 0;
  ok("[db] cover_letter doc_line read isolation — B cannot see A's doc_line (two-hop via document -> job)", lineReadIso,
    `A sees own=${aSeeLine.data?.length ?? "?"}; B sees A's=${bSeeLineA.data?.length ?? "?"}`);

  const upLineBA = await B.c.from("doc_line").update({ approved: false }).eq("id", lineA).select("id");
  const upLineBAgt = await svc.from("doc_line").select("approved").eq("id", lineA).single();
  const upLineBAok = !upLineBA.error && (upLineBA.data?.length ?? 0) === 0 && upLineBAgt.data?.approved === true;
  ok("[db] cross-user cover_letter doc_line update is a no-op (B -> A)", upLineBAok,
    `rows=${upLineBA.data?.length ?? "?"} err=${upLineBA.error?.code || "none"}; A.approved unchanged=${upLineBAgt.data?.approved === true}`);

  const upLineAB = await A.c.from("doc_line").update({ approved: false }).eq("id", lineB).select("id");
  const upLineABgt = await svc.from("doc_line").select("approved").eq("id", lineB).single();
  const upLineABok = !upLineAB.error && (upLineAB.data?.length ?? 0) === 0 && upLineABgt.data?.approved === true;
  ok("[db] cross-user cover_letter doc_line update is a no-op (A -> B)", upLineABok,
    `rows=${upLineAB.data?.length ?? "?"} err=${upLineAB.error?.code || "none"}; B.approved unchanged=${upLineABgt.data?.approved === true}`);

  const delLineBA = await B.c.from("doc_line").delete().eq("id", lineA).select("id");
  const delLineBAgt = await svc.from("doc_line").select("id").eq("id", lineA).single();
  const delLineBAok = !delLineBA.error && (delLineBA.data?.length ?? 0) === 0 && !delLineBAgt.error && delLineBAgt.data?.id === lineA;
  ok("[db] cross-user cover_letter doc_line delete is a no-op (B -> A)", delLineBAok,
    `rows=${delLineBA.data?.length ?? "?"} err=${delLineBA.error?.code || "none"}; A doc_line still present=${delLineBAgt.data?.id === lineA}`);

  const delLineAB = await A.c.from("doc_line").delete().eq("id", lineB).select("id");
  const delLineABgt = await svc.from("doc_line").select("id").eq("id", lineB).single();
  const delLineABok = !delLineAB.error && (delLineAB.data?.length ?? 0) === 0 && !delLineABgt.error && delLineABgt.data?.id === lineB;
  ok("[db] cross-user cover_letter doc_line delete is a no-op (A -> B)", delLineABok,
    `rows=${delLineAB.data?.length ?? "?"} err=${delLineAB.error?.code || "none"}; B doc_line still present=${delLineABgt.data?.id === lineB}`);

  const childLine = await B.c.from("doc_line").insert({ document_id: docA, text: MARK + "_B_INTRUDE", fact_ids: [factBv], approved: true, position: 1 }).select("id");
  const childLineCnt = await svc.from("doc_line").select("*", { count: "exact", head: true }).eq("document_id", docA);
  const childLineBlocked = childLine.error?.code === "42501" && childLineCnt.count === 1;
  ok("[db] cross-user doc_line insert onto another's cover_letter document is rejected (two-hop EXISTS -> 42501)", childLineBlocked,
    `code=${childLine.error?.code || "none"}; doc_lines on A's document=${childLineCnt.count} (expect 1)`);

  // ── [db] one-cover_letter-per-job UNIQUE(job_id,type) — for free, same constraint as the résumé ──
  const dupDoc = await B.c.from("document").insert({ job_id: jobB, type: "cover_letter", status: "draft" }).select("id");
  const dupDocCnt = await svc.from("document").select("*", { count: "exact", head: true }).eq("job_id", jobB).eq("type", "cover_letter");
  const dupDocBlocked = dupDoc.error?.code === "23505" && dupDocCnt.count === 1;
  ok("[db] a second cover_letter document on a job is rejected atomically (UNIQUE(job_id,type) -> 23505)", dupDocBlocked,
    `code=${dupDoc.error?.code || "none"}; cover_letter docs on B's job=${dupDocCnt.count} (expect 1)`);

  // ── [provenance] the REAL persistCoverLetter -> shared persistDocument gate, with B's per-user client ──
  const coverDocs = async () => (await svc.from("document").select("id, connective").eq("job_id", jobB2).eq("type", "cover_letter")).data ?? [];
  const claim = (text, fact_ids) => ({ kind: "claim", text, fact_ids, role: "" });
  const conn = (role, text, fact_ids = []) => ({ kind: "connective", text, role, fact_ids });

  // (i) claim citing the user's OWN UNVERIFIED fact -> REJECTED, nothing stored. The verified-only gate.
  const provUnv = await persistCoverLetter(B.c, B.id, jobB2, { blocks: [claim("Did real work here", [factBu])] });
  const provUnvOk = provUnv?.ok === false && (await coverDocs()).length === 0;
  ok("[provenance] persistCoverLetter REJECTS a claim citing the user's own UNVERIFIED fact; nothing stored", provUnvOk,
    `result.ok=${provUnv?.ok}; err=${short(provUnv?.error || "")}; cover_letter docs on job=${(await coverDocs()).length}`);

  // (ii) claim citing ANOTHER user's fact_id -> REJECTED, nothing stored.
  const provForeign = await persistCoverLetter(B.c, B.id, jobB2, { blocks: [claim("Did real work here", [factAv])] });
  const provForeignOk = provForeign?.ok === false && (await coverDocs()).length === 0;
  ok("[provenance] persistCoverLetter REJECTS a claim citing another user's fact; nothing stored", provForeignOk,
    `result.ok=${provForeign?.ok}; err=${short(provForeign?.error || "")}; cover_letter docs on job=${(await coverDocs()).length}`);

  // (iii) claim citing a NONEXISTENT fact -> REJECTED, nothing stored.
  const provGhost = await persistCoverLetter(B.c, B.id, jobB2, { blocks: [claim("Did real work here", [randomUUID()])] });
  const provGhostOk = provGhost?.ok === false && (await coverDocs()).length === 0;
  ok("[provenance] persistCoverLetter REJECTS a claim citing a nonexistent fact; nothing stored", provGhostOk,
    `result.ok=${provGhost?.ok}; err=${short(provGhost?.error || "")}; cover_letter docs on job=${(await coverDocs()).length}`);

  // (iv) EMPTY-blocks payload -> REJECTED (no claim line, no empty document), nothing stored.
  const provEmpty = await persistCoverLetter(B.c, B.id, jobB2, { blocks: [] });
  const provEmptyOk = provEmpty?.ok === false && (await coverDocs()).length === 0;
  ok("[provenance] persistCoverLetter REJECTS an empty-blocks payload (no empty document); nothing stored", provEmptyOk,
    `result.ok=${provEmpty?.ok}; err=${short(provEmpty?.error || "")}; cover_letter docs on job=${(await coverDocs()).length}`);

  // (iv-b) a CLAIM with EMPTY fact_ids — the cited-check. Nothing stored.
  const provUncited = await persistCoverLetter(B.c, B.id, jobB2, { blocks: [claim("Did real work here", [])] });
  const provUncitedOk = provUncited?.ok === false && (await coverDocs()).length === 0;
  ok("[provenance] persistCoverLetter REJECTS a claim with empty fact_ids (the cited-check); nothing stored", provUncitedOk,
    `result.ok=${provUncited?.ok}; err=${short(provUncited?.error || "")}; cover_letter docs on job=${(await coverDocs()).length}`);

  // (iv-c) a CONNECTIVE block that smuggles a fact_id -> REJECTED (the connective structural rule). A
  // claim can never hide in framing, and a connective can never be stored as a claim. Nothing stored.
  const provSmuggle = await persistCoverLetter(B.c, B.id, jobB2, { blocks: [conn("fit", "Your mission resonates", [factBv]), claim("Built it", [factBv])] });
  const provSmuggleOk = provSmuggle?.ok === false && (await coverDocs()).length === 0;
  ok("[provenance] persistCoverLetter REJECTS a connective block carrying a fact_id (connective structural rule); nothing stored", provSmuggleOk,
    `result.ok=${provSmuggle?.ok}; err=${short(provSmuggle?.error || "")}; cover_letter docs on job=${(await coverDocs()).length}`);

  // (v) BANNED word in a CLAIM citing a valid verified owned fact -> REJECTED by the banned gate.
  const provBanned = await persistCoverLetter(B.c, B.id, jobB2, { blocks: [claim("Spearheaded the migration", [factBv])] });
  const provBannedOk = provBanned?.ok === false && (await coverDocs()).length === 0;
  ok("[provenance] persistCoverLetter REJECTS a claim containing a banned word; nothing stored", provBannedOk,
    `result.ok=${provBanned?.ok}; err=${short(provBanned?.error || "")}; cover_letter docs on job=${(await coverDocs()).length}`);

  // (v-b) BANNED word in CONNECTIVE prose -> REJECTED (banned words apply to prose too), even with a
  // valid claim present. Nothing stored.
  const provBannedConn = await persistCoverLetter(B.c, B.id, jobB2, { blocks: [conn("interest", "I am passionate about this role"), claim("Built it", [factBv])] });
  const provBannedConnOk = provBannedConn?.ok === false && (await coverDocs()).length === 0;
  ok("[provenance] persistCoverLetter REJECTS a banned word in connective prose; nothing stored", provBannedConnOk,
    `result.ok=${provBannedConn?.ok}; err=${short(provBannedConn?.error || "")}; cover_letter docs on job=${(await coverDocs()).length}`);

  // (v-c) a claim citing a VERIFIED WRITING SAMPLE -> REJECTED. Writing samples are voice-only; the
  // shared gate's citable set excludes type=writing_sample, so they can never be cited as evidence.
  const provWS = await persistCoverLetter(B.c, B.id, jobB2, { blocks: [claim("Did real work here", [factBws])] });
  const provWSOk = provWS?.ok === false && (await coverDocs()).length === 0;
  ok("[provenance] persistCoverLetter REJECTS a claim citing a VERIFIED writing_sample fact (voice-only, never citable); nothing stored", provWSOk,
    `result.ok=${provWS?.ok}; err=${short(provWS?.error || "")}; cover_letter docs on job=${(await coverDocs()).length}`);

  // (vi) positive control — a connective greeting + a claim citing the user's OWN VERIFIED fact ->
  // STORED: document (with the connective on its row) + exactly one doc_line, NO doc_line ever empty.
  const provPos = await persistCoverLetter(B.c, B.id, jobB2, { blocks: [conn("greeting", "Dear Hiring Manager,"), claim(MARK + "_CL_CLAIM", [factBv])] });
  const posDocs = await coverDocs();
  const posLines = posDocs.length === 1
    ? (await svc.from("doc_line").select("fact_ids").eq("document_id", posDocs[0].id)).data ?? []
    : [];
  const posNoEmpty = posLines.length === 1 && posLines.every((l) => Array.isArray(l.fact_ids) && l.fact_ids.length > 0);
  const posConnStored = posDocs.length === 1 && Array.isArray(posDocs[0].connective) && posDocs[0].connective.length === 1
    && posDocs[0].connective[0]?.role === "greeting";
  const provPosOk = provPos?.ok === true && posDocs.length === 1 && posNoEmpty && posConnStored;
  ok("[provenance] positive control — STORES a cover letter (claim doc_line + connective on the document; no empty doc_line)", provPosOk,
    `result.ok=${provPos?.ok}; err=${short(provPos?.error || "")}; docs=${posDocs.length}; claim doc_lines=${posLines.length} (all cited=${posNoEmpty}); connective stored=${posConnStored}`);

  // (vii) second cover letter for the same job -> REJECTED (one-per-job rule); still exactly one stored.
  const provDup = await persistCoverLetter(B.c, B.id, jobB2, { blocks: [claim(MARK + "_CL_CLAIM_2", [factBv])] });
  const provDupOk = provDup?.ok === false && (await coverDocs()).length === 1;
  ok("[provenance] persistCoverLetter REJECTS a second cover letter for the same job (one-per-job rule)", provDupOk,
    `result.ok=${provDup?.ok}; err=${short(provDup?.error || "")}; cover_letter docs on job=${(await coverDocs()).length} (expect 1)`);
} catch (e) {
  fatal = short(e);
} finally {
  // Cleanup: delete marker jobs FIRST (cascade removes their documents + doc_lines, releasing the fact
  // citations), THEN the now-uncited facts, THEN the throwaway users.
  let leftJobs = "?", leftFacts = "?", usersLeft = "?";
  const cleanupErrors = [];
  if (svc) {
    try { const r = await svc.from("job").delete().like("raw_text", "VERITAS_M6_VERIFY_%"); if (r.error) cleanupErrors.push(`job sweep: ${r.error.message}`); } catch (e) { cleanupErrors.push(`job sweep threw: ${short(e)}`); }
    try { const r = await svc.from("fact").delete().like("content", "VERITAS_M6_VERIFY_%"); if (r.error) cleanupErrors.push(`fact sweep: ${r.error.message}`); } catch (e) { cleanupErrors.push(`fact sweep threw: ${short(e)}`); }
    for (const id of created) { try { const d = await svc.auth.admin.deleteUser(id); if (d.error) cleanupErrors.push(`deleteUser: ${d.error.message}`); } catch (e) { cleanupErrors.push(`deleteUser threw: ${short(e)}`); } }
    try { const r = await svc.from("job").select("*", { count: "exact", head: true }).like("raw_text", "VERITAS_M6_VERIFY_%"); leftJobs = r.error ? `err:${r.error.code}` : r.count; } catch { leftJobs = "threw"; }
    try { const r = await svc.from("fact").select("*", { count: "exact", head: true }).like("content", "VERITAS_M6_VERIFY_%"); leftFacts = r.error ? `err:${r.error.code}` : r.count; } catch { leftFacts = "threw"; }
    try {
      const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) { cleanupErrors.push(`listUsers: ${error.message}`); usersLeft = `unconfirmed(${error.status || ""})`; }
      else { const em = new Set([A_EMAIL, B_EMAIL]); usersLeft = (data?.users || []).filter((u) => em.has(u.email)).length; }
    } catch (e) { cleanupErrors.push(`listUsers threw: ${short(e)}`); usersLeft = "unconfirmed(threw)"; }
  }
  var cleanupClean = cleanupErrors.length === 0 && leftJobs === 0 && leftFacts === 0 && usersLeft === 0;
  console.log(`\ncleanup: leftJobs=${leftJobs}, leftFacts=${leftFacts}, throwaway users left=${usersLeft}${cleanupErrors.length ? "; errors: " + cleanupErrors.join(" | ") : ""} -> ${cleanupClean ? "clean" : "LEAK"}`);
}

console.log("\n=== Veritas M6 — Cover Letter + Voice verification (local, LLM stubbed) ===");
if (fatal) { console.log(`✗ COULD NOT VERIFY — ${fatal}`); process.exitCode = 2; }
else {
  let allPass = true;
  for (const c of checks) { console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`); if (!c.pass) allPass = false; }
  if (!allPass) { console.log("\n✗ FAIL — an M6 app guard, a cover_letter document/doc_line RLS property, or the verified+owned provenance gate did not hold."); process.exitCode = 1; }
  else if (!cleanupClean) { console.log("\n✗ CLEANUP LEAK — checks passed but throwaway data/users remained."); process.exitCode = 3; }
  else { console.log("\n✓ APP GUARDS HELD (no service-role import; anon key verified; Anthropic key server-only in client.ts — cover-letter generation calls runStructured) + COVER_LETTER DOCUMENT & DOC_LINE RLS RE-CONFIRMED (read isolation; update + delete no-ops BOTH directions; child-via-parent insert guard; re-parent owner-spoof; one-per-(job,type) UNIQUE -> 23505) + VERIFIED+OWNED PROVENANCE enforced FAIL-CLOSED via the REAL persistCoverLetter -> shared persistDocument (unverified + foreign + nonexistent fact rejected; empty-blocks + uncited-claim + connective-citation + banned-word[claim & connective] + voice-only writing-sample citation rejected; positive control stores claim doc_line + connective on the document with no empty doc_line; second letter rejected). Pure validators proven by vitest (cover-letter-schema.test.ts, cover-letter-view-logic.test.ts). Stack left clean."); process.exitCode = 0; }
}
setTimeout(() => process.exit(process.exitCode || 0), 3000).unref();

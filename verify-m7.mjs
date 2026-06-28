// M7 — Export (PDF) verification (NO renderer, NO LLM — deterministic, key-less).
//
// Run with `npx tsx verify-m7.mjs` (NOT plain node): this harness imports the REAL pure content-assembly
// (assembleResumeExport / assembleCoverLetterExport from src/app/jobs/[id]/export/export-content.ts) —
// the SAME functions the export route handlers feed their renderer — and drives them over data SEEDED
// in the DB and FETCHED back through the per-user client exactly as the route does. So it proves the
// export's FIDELITY at the CONTENT level (not pixels): only approved lines, in position order, citations
// resolved through the SHARED writing_sample-excluded resolver. M7 adds NO new provenance gate and NO
// schema change, so this proof is LIGHTER than M5/M6 — it reuses their proven scaffolding verbatim
// (statusJson/jwtRole/isLoopback/walkTs/static scans/key-containment/appUser/svc/ok/cleanup/exit), and
// fails closed (non-zero) on any violation. It does THREE things:
//
//   [app guard — binds to the REAL tree, auto-covers the new export/** files]
//     (1a) STATIC service-role scan: no `getDb` / `@/lib/db` / `SUPABASE_SERVICE_ROLE_KEY` anywhere
//          under src/ except the sanctioned getDb definition — the export route reads via the per-user
//          client only.
//     (1b) KEY-ROLE: the app's NEXT_PUBLIC_SUPABASE_ANON_KEY decodes to anon / is publishable.
//     (1c) KEY-CONTAINMENT: ANTHROPIC_API_KEY + `@anthropic-ai/sdk` appear nowhere under src/ EXCEPT
//          src/lib/llm/client.ts — confirming the export path adds NO new key/LLM path (export renders,
//          it does not generate).
//
//   [fidelity — the REAL assembly, the same path the route uses]
//     Seed (via A's per-user client) an APPROVED résumé + cover_letter on A's job, each with: approved
//     claim lines at known positions, an out-of-band approved=FALSE "dirty" line, and a line citing a
//     voice-only writing_sample. FETCH them back through the per-user client (the route's fetch shape)
//     and drive the REAL assembly. Assert: only approved lines survive, in position order; the dirty
//     line NEVER appears; a cited writing_sample resolves to NO evidence (its line text still present);
//     a valid verified citation resolves; the cover letter merges connective + claims in position order.
//
//   [isolation — export is per-user]
//     B's per-user client drives the export's document + doc_line fetch against A's résumé → resolves to
//     NOTHING (RLS). A user can export only their OWN document.
//
//   [pure unit cases — covered by vitest, not here]
//     The pure assembly's edge cases (approved-only, ordering, writing_sample/unresolved resolution) are
//     also proven by src/app/jobs/[id]/export/export-content.test.ts (`npm run test`).
//
// LOCAL ONLY: sources stack creds from `supabase status -o json`, refuses a non-loopback target; it
// creates and deletes auth users. Service-role is used ONLY for ground truth + cleanup (never as the
// app data path). Exit 0 = app guards held, export FIDELITY + per-user isolation re-confirmed, clean.
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = process.argv[2] || process.cwd();
const MARK = "VERITAS_M7_VERIFY_" + randomUUID();
const PW = "veritas-m7-pw-019283";
const A_EMAIL = `veritas-m7-a-${randomUUID().slice(0, 8)}@example.com`;
const B_EMAIL = `veritas-m7-b-${randomUUID().slice(0, 8)}@example.com`;

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

// ── [app guard] static scans of the REAL tree (copied verbatim from verify-m6) ───────
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

// [identity wiring] confirm an export route fetches the user's profile via the per-user client AND passes
// it to the PDF template (source-level; the dynamic per-user identity fetch is exercised separately).
function routeWiresIdentity(subdir) {
  const p = path.join(REPO, "src", "app", "jobs", "[id]", "export", subdir, "route.tsx");
  let src;
  try { src = readFileSync(p, "utf8"); } catch (e) { return { ok: false, why: `read ${subdir}/route.tsx: ${short(e)}` }; }
  const fetches = /\.from\(\s*["']profile["']\s*\)/.test(src);
  const passes = /candidateName=/.test(src);
  return { ok: fetches && passes, why: `from('profile')=${fetches}, candidateName=${passes}` };
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

  // CHECK 1a [app guard]: no service-role consumption anywhere under src/ (auto-covers the export/** files).
  const sr = serviceRoleScan();
  const srOk = sr.readErrors.length === 0 && sr.scanned > 0 && sr.hits.length === 0;
  ok(
    "[app guard] no service-role import anywhere under src/ (recursive; covers export/**)",
    srOk,
    sr.readErrors.length ? `READ ERROR — fail closed: ${sr.readErrors.join("; ")}`
      : sr.scanned === 0 ? "scanned 0 files — cannot verify (fail closed)"
      : sr.hits.length ? `VIOLATION: ${sr.hits.join("; ")}`
      : `clean across ${sr.scanned} files (excludes only the sanctioned getDb definition)`,
  );

  // CHECK 1b [app guard]: the app's configured anon key is not the service-role key.
  const verdict = anonKeyVerdict(readEnvVar("NEXT_PUBLIC_SUPABASE_ANON_KEY"));
  ok("[app guard] app NEXT_PUBLIC_SUPABASE_ANON_KEY is not the service-role key", verdict.ok, verdict.why);

  // CHECK 1c [app guard]: the Anthropic key + SDK are server-only — and the export path adds none (it renders).
  const kc = keyContainmentScan();
  const kcOk =
    kc.readErrors.length === 0 && kc.scanned > 0 && kc.sanctionedSeen &&
    kc.keyHits.length === 0 && kc.sdkHits.length === 0 && kc.publicHits.length === 0;
  ok(
    "[app guard] ANTHROPIC_API_KEY + @anthropic-ai/sdk are server-only (only in src/lib/llm/client.ts; export adds no key/LLM path)",
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

  // Load the REAL pure content-assembly — the same functions the export route handlers feed their
  // renderer. pathToFileURL so the `[id]` segment is encoded for the ESM loader. Driven directly: no
  // renderer, no DOM, no env.
  const assemblyUrl = pathToFileURL(path.join(REPO, "src", "app", "jobs", "[id]", "export", "export-content.ts")).href;
  const exp = await import(assemblyUrl);
  const assembleResumeExport = exp.assembleResumeExport ?? exp.default?.assembleResumeExport;
  const assembleCoverLetterExport = exp.assembleCoverLetterExport ?? exp.default?.assembleCoverLetterExport;
  if (typeof assembleResumeExport !== "function" || typeof assembleCoverLetterExport !== "function") {
    throw new Error("could not load assembleResumeExport / assembleCoverLetterExport from export-content.ts");
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

  // ── seed (renderer + LLM NOT involved — rows inserted directly via the per-user client) ──────────────
  const A = await appUser(A_EMAIL);
  const B = await appUser(B_EMAIL);

  // A owns a VERIFIED fact (cited by the approved lines) and a VERIFIED writing_sample (voice-only,
  // never citable as evidence — the dirty citation the shared resolver must drop).
  const fAv = await A.c.from("fact").insert({ type: "skill", content: MARK + "_A_FACT_V", owner: A.id, verified: true }).select("id, content").single();
  if (fAv.error) throw new Error(`A create-fact failed: ${fAv.error.message}`);
  const factAv = fAv.data.id, factAvContent = fAv.data.content;
  const fAws = await A.c.from("fact").insert({ type: "writing_sample", content: MARK + "_A_WS", owner: A.id, verified: true }).select("id").single();
  if (fAws.error) throw new Error(`A create-writing-sample failed: ${fAws.error.message}`);
  const factAws = fAws.data.id;

  // A's job carries BOTH an approved résumé and an approved cover_letter (one per (job,type)).
  const jA = await A.c.from("job").insert({ raw_text: MARK + "_A_JOB", company: "A Co", title: "A Role", owner: A.id }).select("id").single();
  if (jA.error) throw new Error(`A create-job failed: ${jA.error.message}`);
  const jobA = jA.data.id;

  // Résumé document + doc_lines: approved p0/p1, a writing_sample-cited p2 (approved), a DIRTY approved=false p3.
  const RT = { L0: MARK + "_R_LINE0", L1: MARK + "_R_LINE1", WS: MARK + "_R_WSLINE", DIRTY: MARK + "_R_DIRTY" };
  const dR = await A.c.from("document").insert({ job_id: jobA, type: "resume", status: "approved" }).select("id").single();
  if (dR.error) throw new Error(`A create-resume-document failed: ${dR.error.message}`);
  const docR = dR.data.id;
  const insR = await A.c.from("doc_line").insert([
    { document_id: docR, text: RT.L0, fact_ids: [factAv], approved: true, position: 0 },
    { document_id: docR, text: RT.L1, fact_ids: [factAv], approved: true, position: 1 },
    { document_id: docR, text: RT.WS, fact_ids: [factAws], approved: true, position: 2 },
    { document_id: docR, text: RT.DIRTY, fact_ids: [factAv], approved: false, position: 3 },
  ]).select("id");
  if (insR.error) throw new Error(`A seed resume doc_lines failed: ${insR.error.message}`);

  // Cover_letter document (connective on the row) + claim doc_lines: approved p1, writing_sample p2,
  // DIRTY approved=false p4. Connective greeting p0 + closing p3 interleave with the claims by position.
  const CT = { GREET: MARK + "_C_GREET", CLOSE: MARK + "_C_CLOSE", C1: MARK + "_C_CLAIM1", WS: MARK + "_C_WSCLAIM", DIRTY: MARK + "_C_DIRTY" };
  const dC = await A.c.from("document").insert({
    job_id: jobA, type: "cover_letter", status: "approved",
    connective: [
      { role: "greeting", text: CT.GREET, position: 0 },
      { role: "closing", text: CT.CLOSE, position: 3 },
    ],
  }).select("id").single();
  if (dC.error) throw new Error(`A create-cover-document failed: ${dC.error.message}`);
  const docC = dC.data.id;
  const insC = await A.c.from("doc_line").insert([
    { document_id: docC, text: CT.C1, fact_ids: [factAv], approved: true, position: 1 },
    { document_id: docC, text: CT.WS, fact_ids: [factAws], approved: true, position: 2 },
    { document_id: docC, text: CT.DIRTY, fact_ids: [factAv], approved: false, position: 4 },
  ]).select("id");
  if (insC.error) throw new Error(`A seed cover doc_lines failed: ${insC.error.message}`);

  // ── [fidelity:résumé] fetch via A's per-user client (the route's fetch shape) + drive the REAL assembly ──
  const rDoc = await A.c.from("document").select("id, status").eq("job_id", jobA).eq("type", "resume").maybeSingle();
  const rLineData = await A.c.from("doc_line").select("text, fact_ids, position, approved").eq("document_id", docR).order("position");
  const rFactData = await A.c.from("fact").select("id, content, verified, type");
  const resumeRows = assembleResumeExport(rLineData.data ?? [], rFactData.data ?? []);
  const rTexts = resumeRows.map((r) => r.text);

  const rOrderOk = rDoc.data?.status === "approved"
    && JSON.stringify(rTexts) === JSON.stringify([RT.L0, RT.L1, RT.WS])
    && !rTexts.includes(RT.DIRTY);
  ok("[fidelity:résumé] export content = only approved lines, in position order (the unapproved line never appears)",
    rOrderOk, `status=${rDoc.data?.status}; texts=${JSON.stringify(rTexts.map((t) => t.replace(MARK, "…")))}; dirty present=${rTexts.includes(RT.DIRTY)}`);

  const rWsRow = resumeRows.find((r) => r.text === RT.WS);
  const rWsOk = !!rWsRow && Array.isArray(rWsRow.evidence) && rWsRow.evidence.length === 0;
  ok("[fidelity:résumé] a cited writing_sample resolves to NO evidence (the line's text is still present)",
    rWsOk, `WS line present=${!!rWsRow}; evidence count=${rWsRow?.evidence?.length}`);

  const rL0Row = resumeRows.find((r) => r.text === RT.L0);
  const rPosOk = !!rL0Row && rL0Row.evidence.length === 1 && rL0Row.evidence[0].content === factAvContent;
  ok("[fidelity:résumé] a valid verified citation resolves to its evidence (positive control)",
    rPosOk, `evidence count=${rL0Row?.evidence?.length}; content matches=${rL0Row?.evidence?.[0]?.content === factAvContent}`);

  // ── [fidelity:cover letter] fetch via A's per-user client + drive the REAL assembly ──────────────────
  const cDoc = await A.c.from("document").select("id, status, connective").eq("job_id", jobA).eq("type", "cover_letter").maybeSingle();
  const cLineData = await A.c.from("doc_line").select("text, fact_ids, position, approved").eq("document_id", docC).order("position");
  const coverRows = assembleCoverLetterExport(cLineData.data ?? [], cDoc.data?.connective ?? [], rFactData.data ?? []);
  const cPositions = coverRows.map((r) => r.position);
  const cKinds = coverRows.map((r) => r.kind);
  const cTexts = coverRows.map((r) => r.text);

  const cOrderOk = cDoc.data?.status === "approved"
    && JSON.stringify(cPositions) === JSON.stringify([0, 1, 2, 3])
    && JSON.stringify(cKinds) === JSON.stringify(["connective", "claim", "claim", "connective"])
    && !cTexts.includes(CT.DIRTY);
  ok("[fidelity:cover letter] approved claims + connective merged in position order (the unapproved claim never appears)",
    cOrderOk, `positions=${JSON.stringify(cPositions)}; kinds=${JSON.stringify(cKinds)}; dirty present=${cTexts.includes(CT.DIRTY)}`);

  const cWsRow = coverRows.find((r) => r.kind === "claim" && r.text === CT.WS);
  const cWsOk = !!cWsRow && cWsRow.kind === "claim" && cWsRow.evidence.length === 0;
  ok("[fidelity:cover letter] a claim citing a writing_sample resolves to NO evidence",
    cWsOk, `WS claim present=${!!cWsRow}; evidence count=${cWsRow?.evidence?.length}`);

  const cGreet = coverRows.find((r) => r.kind === "connective" && r.text === CT.GREET);
  const cC1 = coverRows.find((r) => r.kind === "claim" && r.text === CT.C1);
  const cPosOk = !!cGreet && cGreet.kind === "connective" && cGreet.role === "greeting" && !("evidence" in cGreet)
    && !!cC1 && cC1.kind === "claim" && cC1.evidence.length === 1 && cC1.evidence[0].content === factAvContent;
  ok("[fidelity:cover letter] connective carries its role (no evidence) and a valid claim resolves (positive control)",
    cPosOk, `greeting role=${cGreet?.role}; greeting has-evidence=${cGreet ? ("evidence" in cGreet) : "n/a"}; claim evidence count=${cC1?.evidence?.length}`);

  // ── [isolation] export is per-user — B drives the export fetch chain against A's résumé → NOTHING ────
  const bSeeDocR = await B.c.from("document").select("id").eq("job_id", jobA).eq("type", "resume").maybeSingle();
  const isoDocOk = !bSeeDocR.error && bSeeDocR.data === null;
  ok("[isolation] B cannot reach A's résumé document via the export fetch (per-user RLS)",
    isoDocOk, `B sees A's resume doc=${bSeeDocR.data === null ? "null" : "VISIBLE"}; err=${bSeeDocR.error?.code || "none"}`);

  const bSeeLinesR = await B.c.from("doc_line").select("id").eq("document_id", docR);
  const isoLineOk = !bSeeLinesR.error && (bSeeLinesR.data?.length ?? 0) === 0;
  ok("[isolation] B cannot reach A's résumé doc_lines via the export fetch (per-user RLS)",
    isoLineOk, `B sees A's lines=${bSeeLinesR.data?.length ?? "?"}; err=${bSeeLinesR.error?.code || "none"}`);

  // ── [identity] the letterhead/signature reads the OWNER's profile via the per-user client (M7 identity) ──
  // The export routes fetch the user's profile (author metadata — name + contact) and feed it to the PDF
  // template's letterhead/signature. This is presentation only (NOT the cited content the assembly above
  // produced; export-content.ts is untouched), so it is proven here at the FETCH level the route uses, not
  // by pixels: the route is wired to fetch+pass it, A's own profile resolves, and B cannot see A's.
  const wireResume = routeWiresIdentity("resume");
  const wireCover = routeWiresIdentity("cover-letter");
  ok("[identity] both export routes fetch from('profile') (per-user) and pass the identity to the template",
    wireResume.ok && wireCover.ok, `resume: ${wireResume.why}; cover-letter: ${wireCover.why}`);

  const pA = await A.c.from("profile").insert({
    user_id: A.id, full_name: MARK + "_A_PROFILE", phone: "+1 555 0100", location: "Test City",
    professional_url: "https://example.com/a",
  }).select("user_id").single();
  if (pA.error) throw new Error(`A create-profile failed: ${pA.error.message}`);

  const aProfile = await A.c
    .from("profile").select("full_name, phone, location, professional_url").eq("user_id", A.id).maybeSingle();
  const aProfileOk = !aProfile.error && aProfile.data?.full_name === MARK + "_A_PROFILE";
  ok("[identity] the export route's per-user profile fetch returns the OWNER's identity (name + contact)",
    aProfileOk, `full_name=${aProfile.data?.full_name?.replace(MARK, "…")}; contact present=${Boolean(aProfile.data?.phone && aProfile.data?.location && aProfile.data?.professional_url)}; err=${aProfile.error?.code || "none"}`);

  const bSeeAProfile = await B.c.from("profile").select("user_id").eq("user_id", A.id).maybeSingle();
  const profIsoOk = !bSeeAProfile.error && bSeeAProfile.data === null;
  ok("[identity:isolation] B cannot read A's profile via the export fetch (the letterhead identity is per-user)",
    profIsoOk, `B sees A's profile=${bSeeAProfile.data === null ? "null" : "VISIBLE"}; err=${bSeeAProfile.error?.code || "none"}`);
} catch (e) {
  fatal = short(e);
} finally {
  // Cleanup: delete marker jobs FIRST (cascade removes their documents + doc_lines, releasing the fact
  // citations), THEN the now-uncited facts, THEN the throwaway users.
  let leftJobs = "?", leftFacts = "?", leftProfiles = "?", usersLeft = "?";
  const cleanupErrors = [];
  if (svc) {
    try { const r = await svc.from("job").delete().like("raw_text", "VERITAS_M7_VERIFY_%"); if (r.error) cleanupErrors.push(`job sweep: ${r.error.message}`); } catch (e) { cleanupErrors.push(`job sweep threw: ${short(e)}`); }
    try { const r = await svc.from("fact").delete().like("content", "VERITAS_M7_VERIFY_%"); if (r.error) cleanupErrors.push(`fact sweep: ${r.error.message}`); } catch (e) { cleanupErrors.push(`fact sweep threw: ${short(e)}`); }
    try { const r = await svc.from("profile").delete().like("full_name", "VERITAS_M7_VERIFY_%"); if (r.error) cleanupErrors.push(`profile sweep: ${r.error.message}`); } catch (e) { cleanupErrors.push(`profile sweep threw: ${short(e)}`); }
    for (const id of created) { try { const d = await svc.auth.admin.deleteUser(id); if (d.error) cleanupErrors.push(`deleteUser: ${d.error.message}`); } catch (e) { cleanupErrors.push(`deleteUser threw: ${short(e)}`); } }
    try { const r = await svc.from("job").select("*", { count: "exact", head: true }).like("raw_text", "VERITAS_M7_VERIFY_%"); leftJobs = r.error ? `err:${r.error.code}` : r.count; } catch { leftJobs = "threw"; }
    try { const r = await svc.from("fact").select("*", { count: "exact", head: true }).like("content", "VERITAS_M7_VERIFY_%"); leftFacts = r.error ? `err:${r.error.code}` : r.count; } catch { leftFacts = "threw"; }
    try { const r = await svc.from("profile").select("*", { count: "exact", head: true }).like("full_name", "VERITAS_M7_VERIFY_%"); leftProfiles = r.error ? `err:${r.error.code}` : r.count; } catch { leftProfiles = "threw"; }
    try {
      const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) { cleanupErrors.push(`listUsers: ${error.message}`); usersLeft = `unconfirmed(${error.status || ""})`; }
      else { const em = new Set([A_EMAIL, B_EMAIL]); usersLeft = (data?.users || []).filter((u) => em.has(u.email)).length; }
    } catch (e) { cleanupErrors.push(`listUsers threw: ${short(e)}`); usersLeft = "unconfirmed(threw)"; }
  }
  var cleanupClean = cleanupErrors.length === 0 && leftJobs === 0 && leftFacts === 0 && leftProfiles === 0 && usersLeft === 0;
  console.log(`\ncleanup: leftJobs=${leftJobs}, leftFacts=${leftFacts}, leftProfiles=${leftProfiles}, throwaway users left=${usersLeft}${cleanupErrors.length ? "; errors: " + cleanupErrors.join(" | ") : ""} -> ${cleanupClean ? "clean" : "LEAK"}`);
}

console.log("\n=== Veritas M7 — Export (PDF) verification (local, no renderer, no LLM) ===");
if (fatal) { console.log(`✗ COULD NOT VERIFY — ${fatal}`); process.exitCode = 2; }
else {
  let allPass = true;
  for (const c of checks) { console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`); if (!c.pass) allPass = false; }
  if (!allPass) { console.log("\n✗ FAIL — an M7 app guard, the export FIDELITY (approved-only/order/writing_sample-excluded), or per-user export isolation did not hold."); process.exitCode = 1; }
  else if (!cleanupClean) { console.log("\n✗ CLEANUP LEAK — checks passed but throwaway data/users remained."); process.exitCode = 3; }
  else { console.log("\n✓ APP GUARDS HELD (no service-role import; anon key verified; Anthropic key + SDK server-only in client.ts — export adds no key/LLM path) + EXPORT FIDELITY re-confirmed via the REAL assembly over per-user-fetched data (résumé + cover letter: only approved lines, in position order; the unapproved/dirty line never appears; a cited writing_sample resolves to NO evidence; valid verified citations resolve; connective merged in order) + PER-USER EXPORT ISOLATION (B cannot reach A's document or doc_lines via the export fetch). Pure assembly cases also proven by vitest (export-content.test.ts). Stack left clean."); process.exitCode = 0; }
}
setTimeout(() => process.exit(process.exitCode || 0), 3000).unref();

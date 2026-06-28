import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import {
  assembleResumeExport,
  type CitedFact,
  type ExportLineInput,
} from "../export-content";
import { ResumeDocument } from "../resume-document";

// On-demand résumé PDF (M7). Rendered fresh per download from the CURRENT approved state — no stored PDF
// to drift. The read is via the PER-USER client, so RLS scopes the document to its owner: a foreign or
// missing id resolves to nothing → 404 (no existence leak). Node runtime: @react-pdf/renderer needs
// fontkit/yoga + Buffer (not Edge-safe). force-dynamic: per-user, cookie-scoped, never cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // 401, not a login redirect: the browser is downloading a file, so an HTML login page returned as the
  // PDF body would be a broken download. The UI only surfaces this link to a signed-in owner.
  if (!user) return new Response("Unauthorized", { status: 401 });

  // The stored résumé for this job — one per (job,type). Only an APPROVED document exports.
  const { data: doc } = await supabase
    .from("document")
    .select("id, status")
    .eq("job_id", id)
    .eq("type", "resume")
    .maybeSingle();
  if (!doc || doc.status !== "approved") return new Response("Not found", { status: 404 });

  // SAME fetch shape as page.tsx (the screen), plus the `approved` column the assembly gates on.
  const { data: lineData } = await supabase
    .from("doc_line")
    .select("text, fact_ids, position, approved")
    .eq("document_id", doc.id)
    .order("position");
  const { data: factData } = await supabase
    .from("fact")
    .select("id, content, verified, type");

  // The SHARED resolver assembles the approved lines in order (writing_sample excluded) — screen == PDF.
  const rows = assembleResumeExport(
    (lineData ?? []) as ExportLineInput[],
    (factData ?? []) as CitedFact[],
  );
  // Fail closed: an approved résumé always has ≥1 cited line; emit no PDF rather than an empty document.
  if (rows.length === 0) return new Response("Not found", { status: 404 });

  // The user's OWN identity for the letterhead — author metadata read via the PER-USER client (RLS
  // scopes it to user_id = auth.uid()). Presentation only: it is NOT part of the cited content the
  // assembly above produced, and never enters coverage/citation/generation. No profile yet → undefined →
  // the template's graceful email-only fallback (a name is never fabricated).
  const { data: profile } = await supabase
    .from("profile")
    .select("full_name, phone, location, professional_url")
    .eq("user_id", user.id)
    .maybeSingle();

  const pdf = await renderToBuffer(
    <ResumeDocument
      rows={rows}
      contactEmail={user.email ?? ""}
      candidateName={profile?.full_name ?? undefined}
      phone={profile?.phone ?? undefined}
      location={profile?.location ?? undefined}
      professionalUrl={profile?.professional_url ?? undefined}
    />,
  );

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="resume.pdf"',
      "Cache-Control": "no-store",
    },
  });
}

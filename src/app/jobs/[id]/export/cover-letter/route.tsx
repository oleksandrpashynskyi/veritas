import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import {
  assembleCoverLetterExport,
  type CitedFact,
  type ConnectiveRowInput,
  type ExportLineInput,
} from "../export-content";
import { CoverLetterDocument } from "../cover-letter-document";

// On-demand cover-letter PDF (M7). Mirrors the résumé route: rendered fresh per download from the CURRENT
// approved state, read via the PER-USER client (RLS → owner only; foreign/missing → 404). The connective
// prose rides on the document row; the shared resolver merges it with the approved claim lines by
// position into one seamless letter. Node runtime + force-dynamic, same reasons as the résumé route.
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
  if (!user) return new Response("Unauthorized", { status: 401 });

  // The stored cover letter for this job — one per (job,type). Only an APPROVED document exports. The
  // connective prose is read from the document row alongside it.
  const { data: doc } = await supabase
    .from("document")
    .select("id, status, connective")
    .eq("job_id", id)
    .eq("type", "cover_letter")
    .maybeSingle();
  if (!doc || doc.status !== "approved") return new Response("Not found", { status: 404 });

  const { data: lineData } = await supabase
    .from("doc_line")
    .select("text, fact_ids, position, approved")
    .eq("document_id", doc.id)
    .order("position");
  const { data: factData } = await supabase
    .from("fact")
    .select("id, content, verified, type");

  // The SHARED resolver merges approved claims + connective in position order — screen == PDF.
  const rows = assembleCoverLetterExport(
    (lineData ?? []) as ExportLineInput[],
    (doc.connective ?? []) as ConnectiveRowInput[],
    (factData ?? []) as CitedFact[],
  );
  // Fail closed: an approved cover letter always has ≥1 cited claim; emit no PDF rather than an empty one.
  if (rows.length === 0) return new Response("Not found", { status: 404 });

  // The user's OWN identity for the letterhead + signature — author metadata read via the PER-USER client
  // (RLS scopes it to user_id = auth.uid()). Presentation only: it is NOT part of the cited content the
  // assembly above produced, and never enters coverage/citation/generation. No profile yet → undefined →
  // the template's graceful email-only fallback (a name is never fabricated).
  const { data: profile } = await supabase
    .from("profile")
    .select("full_name, phone, location, professional_url")
    .eq("user_id", user.id)
    .maybeSingle();

  const pdf = await renderToBuffer(
    <CoverLetterDocument
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
      "Content-Disposition": 'attachment; filename="cover-letter.pdf"',
      "Cache-Control": "no-store",
    },
  });
}

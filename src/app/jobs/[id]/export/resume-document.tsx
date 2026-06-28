import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { ResumeLineView } from "./export-content";
import { buildLetterhead } from "./identity";

// One clean, traditional résumé template (M7, design pass). Built-in Times family (Times-Roman /
// Times-Bold — the 14 standard PDF fonts, so NOTHING is registered or shipped) for a classic,
// conservative, ATS-friendly look, typographically matched to the cover-letter template. Renders the
// APPROVED claim lines (row.text) in order — the employer-facing résumé. The cited evidence carried on
// each row is the on-screen provenance audit and is deliberately NOT printed here: the sent artifact
// inherits the every-line-is-sourced guarantee upstream without printing the audit trail.
//
// RÉSUMÉ STRUCTURE — one honest section, NOT fabricated EXPERIENCE/SKILLS/EDUCATION groups. The data
// carries NO reliable per-line category signal: the résumé generation contract (RESUME_SCHEMA) and the
// stored doc_line are both just { text, fact_ids } — neither tags a line's kind. A category lives only on
// the underlying FACTS (fact.type), but a line may cite 1..N facts of possibly MIXED types, so a line has
// no well-defined section; deriving one (first/majority fact type) would be a guess, and guessing section
// membership is the fabrication this product forbids. So the approved lines render as ONE umbrella section
// ("Summary of Qualifications" — honest for a tailored, cross-category bullet list, where the old
// "Experience" label mis-described skill/education bullets). TRUE sectioning is a FUTURE milestone: it
// needs structured facts — a per-line `kind` emitted by generation and persisted on doc_line (or a
// one-fact-type-per-line invariant) — not text-matching or fact-type guessing in this template.
//
// IDENTITY / LETTERHEAD — identity is the user's OWN profile (full_name + optional phone / location /
// professional_url), supplied by the route from the `profile` table (per-user, RLS-scoped), PLUS the
// authenticated user's EMAIL. It is author metadata, NOT a fact: it never enters citation / coverage /
// generation. buildLetterhead() formats it, fabricating nothing: with a real name it shows the name over
// a contact line (phone · location · email · professional_url — present fields only, no stray
// separators); with NO profile it falls back to the email as a dignified header. We never derive a name
// from the email local-part — that would be a fabrication the product forbids. candidateName / phone /
// location / professionalUrl are all optional, so a profile-less user still exports cleanly.

// The single umbrella heading for the flat (uncategorized) approved lines. A constant so the honest
// label is one obvious knob; see the structure note above for why there is exactly one section today.
const SECTION_HEADING = "Summary of Qualifications";

// Palette — conservative and print-safe: near-black ink on white, restrained grays, no color accent.
const INK = "#1A1A1A"; // primary text
const MUTED = "#5C5C5C"; // contact line + bullet glyph (de-emphasized so the text leads)
const RULE = "#111111"; // strong letterhead rule (the identity divider)
const HAIRLINE = "#C9C9C9"; // light section divider (a subtler tier than the letterhead rule)

const styles = StyleSheet.create({
  page: {
    paddingTop: 56,
    paddingBottom: 56,
    paddingHorizontal: 64, // ~0.9in margins — generous, classic
    fontFamily: "Times-Roman",
    fontSize: 11,
    lineHeight: 1.45,
    color: INK,
  },
  // ── letterhead (identical to the cover letter for a cohesive identity) ──
  header: { marginBottom: 24 },
  name: {
    fontFamily: "Times-Bold",
    fontSize: 20,
    textAlign: "center",
    letterSpacing: 0.5,
    color: INK,
  },
  contact: {
    fontFamily: "Times-Roman",
    fontSize: 10,
    textAlign: "center",
    letterSpacing: 0.3,
    color: MUTED,
    marginTop: 5,
  },
  // The email-only header (no name available): a confident, dignified identity line — not a name-sized
  // line masquerading as a name, and not a bare line floating with no structure.
  identityOnly: {
    fontFamily: "Times-Bold",
    fontSize: 13.5,
    textAlign: "center",
    letterSpacing: 0.3,
    color: INK,
  },
  rule: {
    borderBottomWidth: 1,
    borderBottomColor: RULE,
    marginTop: 12,
  },
  // ── section ─────────────────────────────────────────────────────────
  sectionLabel: {
    fontFamily: "Times-Bold",
    fontSize: 11,
    letterSpacing: 2,
    textTransform: "uppercase",
    color: INK,
  },
  // Full-width hairline beneath the heading — gives the page architecture (a lighter tier than the
  // letterhead rule). A View so it spans the content width predictably regardless of heading length.
  sectionRule: {
    borderBottomWidth: 0.75,
    borderBottomColor: HAIRLINE,
    marginTop: 5,
    marginBottom: 12,
  },
  // ── bullets (hanging indent: muted glyph column + flexed text) ──────
  // Tight intra-bullet leading groups each bullet's wrapped lines; the larger inter-bullet margin keeps
  // the list scannable. The glyph inherits the text size (baseline-aligned) but is muted so text leads.
  bulletRow: { flexDirection: "row", marginBottom: 9 },
  bulletGlyph: { width: 14, color: MUTED },
  bulletText: { flex: 1, color: INK, lineHeight: 1.4 },
});

export function ResumeDocument({
  rows,
  contactEmail,
  candidateName,
  phone,
  location,
  professionalUrl,
}: {
  rows: ResumeLineView[];
  contactEmail: string;
  // The candidate's OWN identity from their profile (all optional; a profile-less user exports with the
  // email-only fallback). Never invented here — full_name comes only from what the user entered.
  candidateName?: string;
  phone?: string;
  location?: string;
  professionalUrl?: string;
}) {
  const { name, contactLine } = buildLetterhead({
    contactEmail,
    candidateName,
    phone,
    location,
    professionalUrl,
  });
  const hasIdentity = Boolean(name || contactLine);
  return (
    <Document title="Résumé" author={name || contactEmail || "Veritas"}>
      <Page size="LETTER" style={styles.page}>
        {hasIdentity ? (
          <View style={styles.header}>
            {name ? (
              <>
                <Text style={styles.name}>{name}</Text>
                {contactLine ? <Text style={styles.contact}>{contactLine}</Text> : null}
              </>
            ) : (
              <Text style={styles.identityOnly}>{contactEmail}</Text>
            )}
            <View style={styles.rule} />
          </View>
        ) : null}
        <Text style={styles.sectionLabel}>{SECTION_HEADING}</Text>
        <View style={styles.sectionRule} />
        {rows.map((row, i) => (
          <View key={i} style={styles.bulletRow} wrap={false}>
            <Text style={styles.bulletGlyph}>•</Text>
            <Text style={styles.bulletText}>{row.text}</Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

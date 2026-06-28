import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { CoverLetterRow } from "./export-content";
import { buildLetterhead } from "./identity";

// One clean, traditional cover-letter template (M7, design pass). Built-in Times family (Times-Roman /
// Times-Bold — standard PDF fonts, nothing registered or shipped) for a classic, professional letter.
// The approved rows — connective prose and cited claims, already merged in position order by the shared
// resolver — render as ONE letter, each row a clean paragraph, with NO evidence annotations (unlike the
// on-screen audit view). The reader sees a letter, not a provenance trail; the every-claim-is-sourced
// guarantee is enforced upstream. Content is rendered VERBATIM and in order: the sign-off ("Sincerely,")
// is itself a generated CONNECTIVE row (role "signoff"), so it prints as content — this template never
// injects its own closing.
//
// IDENTITY / LETTERHEAD + SIGNATURE — identity is the user's OWN profile (full_name + optional phone /
// location / professional_url) supplied by the route from the `profile` table (per-user, RLS-scoped),
// PLUS the authenticated user's EMAIL; see resume-document.tsx for the full rationale. It is author
// metadata, NOT a fact (never cited / matched / generated). The letterhead shows the name over a contact
// line (phone · location · email · professional_url — present fields only) when a name exists, else the
// email as a dignified header. After the body, a signature line carries the candidate's identity beneath
// the (content) sign-off: the real name when available, otherwise the owned email — so "Sincerely," is
// never left dangling without a signer. candidateName / phone / location / professionalUrl are optional,
// so a profile-less user still exports cleanly. No name is ever derived from the email local-part.

// Palette — conservative and print-safe: near-black ink on white, restrained grays, no color accent.
const INK = "#1A1A1A";
const MUTED = "#5C5C5C";
const RULE = "#111111";

const styles = StyleSheet.create({
  page: {
    paddingTop: 64,
    paddingBottom: 64,
    paddingHorizontal: 64, // ~0.9in margins
    fontFamily: "Times-Roman",
    fontSize: 11.5,
    lineHeight: 1.55,
    color: INK,
  },
  // ── letterhead (matches the résumé for a cohesive identity) ─────────
  header: { marginBottom: 26 },
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
  // ── body ────────────────────────────────────────────────────────────
  // Each approved row prints as its own paragraph. (Rows read as discrete sentences rather than flowing
  // paragraphs — that is the connective-vs-claim GENERATION structure, not a template concern.)
  paragraph: { marginBottom: 11, color: INK },
  // The signer beneath the (content) sign-off. The marginTop leaves a deliberate signature space.
  signature: { marginTop: 10, color: INK },
});

export function CoverLetterDocument({
  rows,
  contactEmail,
  candidateName,
  phone,
  location,
  professionalUrl,
}: {
  rows: CoverLetterRow[];
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
    <Document title="Cover letter" author={name || contactEmail || "Veritas"}>
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
        {rows.map((row, i) => (
          <Text key={i} style={styles.paragraph}>
            {row.text}
          </Text>
        ))}
        {hasIdentity ? (
          <Text style={styles.signature}>{name || contactEmail}</Text>
        ) : null}
      </Page>
    </Document>
  );
}

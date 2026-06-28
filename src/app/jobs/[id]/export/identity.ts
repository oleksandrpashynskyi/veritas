// Pure presentation helper for the PDF letterhead/signature (M7 identity). Builds the contact line shown
// beneath the candidate's name from the profile fields the route supplies — present fields ONLY, in the
// order phone · location · email · professional_url, joined so there are no empty slots or stray
// separators. It NEVER derives a name (no email local-part → name): the name is the trimmed
// candidateName, or "" when none was supplied. This is letterhead FORMATTING, not content assembly
// (that is export-content.ts, untouched) — it never touches the provenance/resolution path. Kept pure so
// both templates (résumé + cover letter) share ONE implementation and it is unit-testable without a
// renderer.
export type Identity = {
  contactEmail: string;
  candidateName?: string;
  phone?: string;
  location?: string;
  professionalUrl?: string;
};

export type Letterhead = {
  // The candidate's real name (trimmed) when supplied, else "" — never derived from the email.
  name: string;
  // "phone · location · email · url" with only the present fields, e.g. "Brooklyn, NY · alex@example.com".
  contactLine: string;
};

const SEP = " · ";

export function buildLetterhead(identity: Identity): Letterhead {
  const name = identity.candidateName?.trim() ?? "";
  const contactLine = [
    identity.phone,
    identity.location,
    identity.contactEmail,
    identity.professionalUrl,
  ]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(SEP);
  return { name, contactLine };
}

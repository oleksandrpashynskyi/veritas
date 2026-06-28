// Pure parse/validation for the candidate IDENTITY (profile) form — author metadata for the PDF
// letterhead/signature, NOT a fact (never cited, never coverage, never generation). Kept pure and
// dependency-free so vitest drives it without Next/Supabase. Rules mirror the facts form's optionalText:
// trim everything; an absent optional is stored as NULL, never "". full_name is REQUIRED. Identity is
// never fabricated/derived (e.g. never an email local-part) — full_name comes ONLY from full_name.

export type ProfileFields = {
  full_name: string;
  phone: string | null;
  location: string | null;
  professional_url: string | null;
};

export type ProfileFieldInput = {
  full_name?: unknown;
  phone?: unknown;
  location?: unknown;
  professional_url?: unknown;
};

// Trim, and store empty as NULL (never an empty string) — the facts-form convention.
function optionalText(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return s === "" ? null : s;
}

export function parseProfileFields(
  input: ProfileFieldInput,
): { fields: ProfileFields } | { error: string } {
  const full_name = String(input.full_name ?? "").trim();
  if (!full_name) return { error: "Full name is required." };

  return {
    fields: {
      full_name,
      phone: optionalText(input.phone),
      location: optionalText(input.location),
      professional_url: optionalText(input.professional_url),
    },
  };
}

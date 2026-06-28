import { describe, expect, it } from "vitest";
import { parseProfileFields } from "./profile-fields";

// The candidate IDENTITY validator — author metadata for the PDF letterhead/signature, NOT a fact.
// Pure + dependency-free so vitest drives it without Next/Supabase. Rules mirror the facts form:
// full_name is required (non-empty after trim); phone/location/professional_url are optional and an
// absent optional is stored as NULL (never ""). Identity is NEVER fabricated/derived — these are
// exactly the values the user typed, trimmed.

describe("parseProfileFields", () => {
  it("requires full_name — an empty value is an error", () => {
    const result = parseProfileFields({ full_name: "" });
    expect(result).toEqual({ error: expect.any(String) });
  });

  it("requires full_name — a whitespace-only value is an error", () => {
    const result = parseProfileFields({ full_name: "   " });
    expect("error" in result).toBe(true);
  });

  it("trims full_name", () => {
    const result = parseProfileFields({ full_name: "  Alex Dev  " });
    expect(result).toEqual({
      fields: { full_name: "Alex Dev", phone: null, location: null, professional_url: null },
    });
  });

  it("keeps optional fields, trimmed, when present", () => {
    const result = parseProfileFields({
      full_name: "Alex Dev",
      phone: "  +1 555 0100  ",
      location: " Brooklyn, NY ",
      professional_url: " https://github.com/alexdev ",
    });
    expect(result).toEqual({
      fields: {
        full_name: "Alex Dev",
        phone: "+1 555 0100",
        location: "Brooklyn, NY",
        professional_url: "https://github.com/alexdev",
      },
    });
  });

  it("stores absent optional fields as NULL (empty, whitespace, undefined, null)", () => {
    const result = parseProfileFields({
      full_name: "Alex Dev",
      phone: "",
      location: "   ",
      professional_url: undefined,
    });
    expect(result).toEqual({
      fields: { full_name: "Alex Dev", phone: null, location: null, professional_url: null },
    });
  });

  it("never fabricates a name from other fields — full_name comes only from full_name", () => {
    // An email-looking value in another field must not become the name; missing full_name still errors.
    const result = parseProfileFields({ professional_url: "https://github.com/alexdev" });
    expect("error" in result).toBe(true);
  });
});

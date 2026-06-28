import { describe, expect, it } from "vitest";
import { buildLetterhead } from "./identity";

// The PDF letterhead/signature presentation helper. It formats the contact line from the profile fields
// the route supplies — present fields ONLY, in the order phone · location · email · professional_url,
// with no blank slots or stray separators. It NEVER derives a name (no email local-part); the name is
// the trimmed candidateName or "". Pure (no renderer) so both templates share one implementation.

const SEP = " · ";

describe("buildLetterhead", () => {
  it("joins all present fields in order: phone · location · email · url", () => {
    const lh = buildLetterhead({
      contactEmail: "alex@example.com",
      candidateName: "Alex Dev",
      phone: "+1 555 0100",
      location: "Brooklyn, NY",
      professionalUrl: "https://github.com/alexdev",
    });
    expect(lh.name).toBe("Alex Dev");
    expect(lh.contactLine).toBe(
      ["+1 555 0100", "Brooklyn, NY", "alex@example.com", "https://github.com/alexdev"].join(SEP),
    );
  });

  it("omits absent/blank fields with no stray separators", () => {
    const lh = buildLetterhead({
      contactEmail: "alex@example.com",
      candidateName: "Alex Dev",
      phone: "",
      location: "Brooklyn, NY",
      professionalUrl: "   ",
    });
    expect(lh.contactLine).toBe(["Brooklyn, NY", "alex@example.com"].join(SEP));
  });

  it("with only a name + email, the contact line is just the email", () => {
    const lh = buildLetterhead({ contactEmail: "alex@example.com", candidateName: "Alex Dev" });
    expect(lh.contactLine).toBe("alex@example.com");
  });

  it("never derives a name — no candidateName yields an empty name (email still in the contact line)", () => {
    const lh = buildLetterhead({ contactEmail: "alex@example.com" });
    expect(lh.name).toBe("");
    expect(lh.contactLine).toBe("alex@example.com");
  });

  it("trims the name and the fields", () => {
    const lh = buildLetterhead({
      contactEmail: "  alex@example.com  ",
      candidateName: "  Alex Dev  ",
      location: "  Brooklyn, NY  ",
    });
    expect(lh.name).toBe("Alex Dev");
    expect(lh.contactLine).toBe(["Brooklyn, NY", "alex@example.com"].join(SEP));
  });

  it("with no identity at all, name and contact line are empty", () => {
    const lh = buildLetterhead({ contactEmail: "" });
    expect(lh.name).toBe("");
    expect(lh.contactLine).toBe("");
  });
});

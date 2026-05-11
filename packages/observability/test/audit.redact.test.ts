import { describe, expect, it } from "vitest";
import { redactPhi } from "../src/audit.js";

describe("redactPhi", () => {
  it("redacts known PHI fields on a provider entity", () => {
    const input = {
      id: "abc",
      firstName: "Jane",
      lastName: "Doe",
      dob: "1980-01-01",
      ssn: "123-45-6789",
      email: "jane@example.com",
      npi: "1234567890",
    };
    expect(redactPhi("provider", input)).toEqual({
      id: "abc",
      firstName: "<REDACTED>",
      lastName: "<REDACTED>",
      dob: "<REDACTED>",
      ssn: "<REDACTED>",
      email: "<REDACTED>",
      npi: "1234567890",
    });
  });

  it("leaves unrelated entity types untouched", () => {
    expect(redactPhi("workspace", { name: "Acme" })).toEqual({ name: "Acme" });
  });

  it("walks arrays", () => {
    const out = redactPhi("provider", [{ firstName: "A" }, { firstName: "B" }]);
    expect(out).toEqual([{ firstName: "<REDACTED>" }, { firstName: "<REDACTED>" }]);
  });
});

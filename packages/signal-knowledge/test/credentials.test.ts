import { describe, expect, it } from "vitest";

// A valid 16-char-min SESSION_SECRET before @cred/config caches env.
process.env.SESSION_SECRET ??= "test-session-secret-1234567890";

const { encryptCredential, decryptCredential } = await import("../src/credentials.js");

const WS_A = "11111111-1111-1111-1111-111111111111";
const WS_B = "22222222-2222-2222-2222-222222222222";

describe("credentials", () => {
  it("encrypt/decrypt roundtrips", () => {
    const payload = { apiKey: "bh_sk_live_1", username: "alice" };
    const ct = encryptCredential(WS_A, "bullhorn", payload);
    expect(Buffer.isBuffer(ct)).toBe(true);
    const back = decryptCredential(WS_A, "bullhorn", ct);
    expect(back).toEqual(payload);
  });

  it("different ciphertext each call (random IV)", () => {
    const a = encryptCredential(WS_A, "gmail", { token: "x" });
    const b = encryptCredential(WS_A, "gmail", { token: "x" });
    expect(a.equals(b)).toBe(false);
  });

  it("refuses to decrypt with the wrong workspaceId", () => {
    const ct = encryptCredential(WS_A, "bullhorn", { ok: true });
    expect(() => decryptCredential(WS_B, "bullhorn", ct)).toThrow();
  });

  it("refuses to decrypt with the wrong adapter", () => {
    const ct = encryptCredential(WS_A, "bullhorn", { ok: true });
    expect(() => decryptCredential(WS_A, "gmail", ct)).toThrow();
  });

  it("validates workspaceId shape", () => {
    expect(() => encryptCredential("not-a-uuid", "bullhorn", {})).toThrow();
    expect(() => decryptCredential("not-a-uuid", "bullhorn", Buffer.alloc(32))).toThrow();
  });

  it("validates adapter shape", () => {
    expect(() => encryptCredential(WS_A, "Bad Adapter!", {})).toThrow();
  });
});

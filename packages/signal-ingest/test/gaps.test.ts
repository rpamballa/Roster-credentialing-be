import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL ?? "");

const { closeDb } = await import("@cred/db");
const { enumerateCredentialGaps } = await import("../src/gaps.js");
const { seedProvider, seedVerification, seedWorkspace } = await import("./helpers.js");

describe("enumerateCredentialGaps", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("flags state_csr gap for every licensed state that has no csr verification", async () => {
    const ws = await seedWorkspace();
    const provId = await seedProvider(ws, {
      firstName: "Dr",
      lastName: "Missing",
      npi: "9999999999",
      // Licensed in TX and CA, but we only have a CSR verification
      // for CA — TX should surface as a gap.
      statesLicensed: ["TX", "CA"],
    });
    await seedVerification({
      workspaceId: ws,
      providerId: provId,
      type: "state_csr",
      state: "CA",
      status: "active",
    });

    const gaps = await enumerateCredentialGaps({ workspaceId: ws });
    expect(gaps).toHaveLength(1);
    const providerGap = gaps[0];
    expect(providerGap?.providerId).toBe(provId);
    const csrGap = providerGap?.gaps.find((g) => g.kind === "state_csr");
    expect(csrGap).toBeDefined();
    expect(csrGap?.states).toEqual(["TX"]);
  });

  it("enumerates scalar gaps (dea/sanctions/background/board/acls/imms/drug) when nothing is on file", async () => {
    const ws = await seedWorkspace();
    await seedProvider(ws, {
      firstName: "Dr",
      lastName: "Blank",
      npi: "1111111111",
      statesLicensed: ["TX"],
    });

    const gaps = await enumerateCredentialGaps({ workspaceId: ws });
    expect(gaps).toHaveLength(1);
    const kinds = gaps[0]?.gaps.map((g) => g.kind).sort();
    // state_csr is also present for TX (no CSR seeded).
    expect(kinds).toEqual([
      "acls",
      "background_check",
      "board_cert",
      "dea",
      "drug_screen",
      "immunizations",
      "sanctions",
      "state_csr",
    ]);
  });

  it("omits providers who are completely covered", async () => {
    const ws = await seedWorkspace();
    const provId = await seedProvider(ws, {
      firstName: "Dr",
      lastName: "Perfect",
      npi: "5555555555",
      statesLicensed: ["TX"],
    });
    for (const type of [
      "state_csr",
      "dea",
      "sanctions",
      "background_check",
      "board_cert",
      "acls",
      "immunizations",
      "drug_screen",
    ] as const) {
      const base: { workspaceId: string; providerId: string; type: string; status: string } = {
        workspaceId: ws,
        providerId: provId,
        type,
        status: "active",
      };
      if (type === "state_csr") {
        await seedVerification({ ...base, state: "TX" });
      } else {
        await seedVerification(base);
      }
    }

    const gaps = await enumerateCredentialGaps({ workspaceId: ws });
    expect(gaps).toHaveLength(0);
  });
});

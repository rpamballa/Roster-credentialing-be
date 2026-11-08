import type { signalCredentials, signalJobs, signalProviders } from "@cred/db/schema";
import { describe, expect, it } from "vitest";
import {
  buildCredentialState,
  buildFacilityRequirements,
  providerSubSpecialties,
} from "./projectionAdapter.js";

type ProviderRow = typeof signalProviders.$inferSelect;
type CredentialRow = typeof signalCredentials.$inferSelect;
type JobRow = typeof signalJobs.$inferSelect;

function provider(overrides: Partial<ProviderRow>): ProviderRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    workspaceId: "00000000-0000-0000-0000-00000000aaaa",
    npi: null,
    name: "Stub Provider",
    email: null,
    phone: null,
    specialties: [],
    regionPrefs: [],
    rateBand: null,
    availabilityHint: null,
    mergedFrom: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function credential(overrides: Partial<CredentialRow>): CredentialRow {
  return {
    id: "00000000-0000-0000-0000-000000000010",
    workspaceId: "00000000-0000-0000-0000-00000000aaaa",
    providerId: "00000000-0000-0000-0000-000000000001",
    type: "dea",
    state: null,
    issued: null,
    expires: null,
    status: "active",
    earliestStartProjection: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function job(overrides: Partial<JobRow>): JobRow {
  return {
    id: "00000000-0000-0000-0000-000000000020",
    workspaceId: "00000000-0000-0000-0000-00000000aaaa",
    facilityId: null,
    specialty: "cardiac",
    needDate: "2026-04-01",
    region: "NE",
    pay: "1800.00",
    state: "MA",
    reqOpenedAt: new Date("2026-01-01"),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("projectionAdapter · buildCredentialState", () => {
  it("rolls up flat credential rows into the bridge struct", () => {
    const p = provider({ specialties: ["cardiac", "pain"] });
    const creds: CredentialRow[] = [
      credential({ type: "state_license", state: "MA", status: "active" }),
      credential({ type: "dea", status: "active" }),
      credential({ type: "state_csr", state: "MA", status: "active" }),
      credential({ type: "board_cert", status: "certified" }),
      credential({ type: "acls", status: "active" }),
      credential({ type: "immunizations", status: "complete" }),
      credential({ type: "background_check", status: "clear" }),
      credential({ type: "drug_screen", status: "clear" }),
    ];
    const state = buildCredentialState(p, creds);
    expect(state.licenses).toEqual([{ state: "MA", status: "active" }]);
    expect(state.dea.status).toBe("active");
    expect(state.stateCsr).toEqual([{ state: "MA", status: "active" }]);
    expect(state.boardCert.status).toBe("certified");
    expect(state.acls.valid).toBe(true);
    expect(state.immunizations.complete).toBe(true);
    expect(state.backgroundCheck.status).toBe("clear");
    expect(state.drugScreen.status).toBe("clear");
    expect(state.specialties).toEqual(["cardiac", "pain"]);
  });

  it("falls back to inactive defaults when credentials are missing", () => {
    const p = provider({});
    const state = buildCredentialState(p, []);
    expect(state.dea.status).toBe("none");
    expect(state.boardCert.status).toBe("none");
    expect(state.backgroundCheck.status).toBe("none");
  });

  it("drops unknown sub-specialties rather than forcing them into 'general'", () => {
    const p = provider({ specialties: ["something-exotic"] });
    expect(providerSubSpecialties(p)).toEqual([]);
  });
});

describe("projectionAdapter · buildFacilityRequirements", () => {
  it("derives sub-specialty + state and seeds locum-standard defaults", () => {
    const j = job({ specialty: "cardiac", state: "ma" });
    const reqs = buildFacilityRequirements(j);
    expect(reqs.state).toBe("MA");
    expect(reqs.requiredSubSpecialty).toBe("cardiac");
    expect(reqs.privilegingCycleDays).toBe(90);
    expect(reqs.supportsTemporaryPrivileges).toBe(true);
    expect(reqs.tempPrivilegingDays).toBe(14);
    expect(reqs.requiredCredentials).toContain("state_license");
    expect(reqs.requiredCredentials).toContain("facility_privileges");
  });

  it("flags compact states for the IMLC shortcut lane", () => {
    expect(buildFacilityRequirements(job({ state: "IL" })).isImlcCompactState).toBe(true);
    expect(buildFacilityRequirements(job({ state: "CA" })).isImlcCompactState).toBe(false);
  });

  it("falls back to 'general' sub-specialty when the job's specialty isn't a known tag", () => {
    expect(
      buildFacilityRequirements(job({ specialty: "anesthesiology" })).requiredSubSpecialty,
    ).toBe("general");
  });
});

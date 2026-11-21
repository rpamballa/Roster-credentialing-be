import { describe, expect, it } from "vitest";
import {
  type FacilityRequirements,
  type ProjectionInput,
  type ProviderCredentialState,
  type RequiredCredential,
  projectEarliestStart,
} from "./project.js";

const MS_PER_DAY = 86_400_000;
const TODAY = new Date("2026-01-15T00:00:00.000Z");

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);
}

/** Fully-ready provider in TX, general anesthesia. Tweak per test. */
function baseProvider(overrides: Partial<ProviderCredentialState> = {}): ProviderCredentialState {
  return {
    specialties: ["general"],
    licenses: [{ state: "TX", status: "active" }],
    imlcEligible: true,
    dea: { status: "active" },
    stateCsr: [{ state: "TX", status: "active" }],
    boardCert: { status: "certified", board: "ABA" },
    acls: { valid: true },
    immunizations: { complete: true },
    backgroundCheck: { status: "clear", completedAt: new Date("2025-12-01T00:00:00Z") },
    drugScreen: { status: "clear" },
    ...overrides,
  };
}

/** TX facility, general anesthesia, full credential set required. */
function baseFacility(overrides: Partial<FacilityRequirements> = {}): FacilityRequirements {
  const base: FacilityRequirements = {
    state: "TX",
    requiredSubSpecialty: "general",
    requiredCredentials: [
      "state_license",
      "dea",
      "state_csr",
      "board_cert",
      "acls",
      "immunizations",
      "background_check",
      "drug_screen",
      "facility_privileges",
    ],
    privilegingCycleDays: 90,
    supportsTemporaryPrivileges: false,
    isImlcCompactState: false,
  };
  return { ...base, ...overrides };
}

function makeInput(
  provider: Partial<ProviderCredentialState> = {},
  facility: Partial<FacilityRequirements> = {},
  today: Date = TODAY,
): ProjectionInput {
  return {
    today,
    provider: baseProvider(provider),
    facility: baseFacility(facility),
  };
}

describe("projectEarliestStart · fast-track scenarios", () => {
  it("fast-tracks IMLC + compact state + temp privileges + everything active", () => {
    const result = projectEarliestStart(
      makeInput(
        {},
        {
          isImlcCompactState: true,
          supportsTemporaryPrivileges: true,
          tempPrivilegingDays: 14,
        },
      ),
    );
    // Only temp privileging is non-zero → 14 days, binding on facility_privileges.
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(14);
    expect(result.bindingCredential).toBe("facility_privileges");
    // Binding credential is an estimate → medium confidence.
    expect(result.confidence).toBe("medium");
  });

  it("returns high confidence when every credential is satisfied today and privileges aren't required", () => {
    const result = projectEarliestStart(
      makeInput(
        {},
        {
          requiredCredentials: [
            "state_license",
            "dea",
            "state_csr",
            "board_cert",
            "acls",
            "immunizations",
            "background_check",
            "drug_screen",
          ],
        },
      ),
    );
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(0);
    expect(result.confidence).toBe("high");
  });
});

describe("projectEarliestStart · state license", () => {
  it("blocks ~90 days when no license, no IMLC, non-compact state", () => {
    const result = projectEarliestStart(
      makeInput({
        licenses: [],
        imlcEligible: false,
      }),
    );
    expect(result.bindingCredential).toBe("state_license");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(90);
    expect(result.confidence).toBe("medium");
  });

  it("blocks ~30 days when IMLC-eligible + compact state", () => {
    const result = projectEarliestStart(
      makeInput(
        { licenses: [], imlcEligible: true },
        {
          isImlcCompactState: true,
          // Shrink the privileging cycle below the license timeline so the
          // license is the binding credential rather than privileging.
          supportsTemporaryPrivileges: true,
          tempPrivilegingDays: 14,
          privilegingCycleDays: 10,
        },
      ),
    );
    expect(result.bindingCredential).toBe("state_license");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(30);
  });

  it("blocks ~90 days when IMLC-eligible but facility state is non-compact", () => {
    const result = projectEarliestStart(
      makeInput({ licenses: [], imlcEligible: true }, { isImlcCompactState: false }),
    );
    expect(result.bindingCredential).toBe("state_license");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(90);
  });

  it("recognizes a wrong-state license as 'no license in this state'", () => {
    const result = projectEarliestStart(
      makeInput({
        licenses: [{ state: "CA", status: "active" }],
        imlcEligible: false,
      }),
    );
    expect(result.bindingCredential).toBe("state_license");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(90);
  });
});

describe("projectEarliestStart · DEA / CSR", () => {
  it("blocks on DEA renewal when DEA is expired", () => {
    const result = projectEarliestStart(
      makeInput({ dea: { status: "expired" } }, { privilegingCycleDays: 10 }),
    );
    expect(result.bindingCredential).toBe("dea");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(60);
  });

  it("blocks on state CSR when none in facility state", () => {
    const result = projectEarliestStart(makeInput({ stateCsr: [] }, { privilegingCycleDays: 10 }));
    expect(result.bindingCredential).toBe("state_csr");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(45);
  });
});

describe("projectEarliestStart · background check", () => {
  it("blocks ~14 days when background check is pending", () => {
    const result = projectEarliestStart(
      makeInput({ backgroundCheck: { status: "pending" } }, { privilegingCycleDays: 10 }),
    );
    expect(result.bindingCredential).toBe("background_check");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(14);
  });

  it("blocks ~21 days when no background check on file", () => {
    const result = projectEarliestStart(
      makeInput({ backgroundCheck: { status: "none" } }, { privilegingCycleDays: 10 }),
    );
    expect(result.bindingCredential).toBe("background_check");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(21);
  });

  it("pushes to far future and drops confidence to low when background is FLAGGED", () => {
    const result = projectEarliestStart(makeInput({ backgroundCheck: { status: "flagged" } }));
    expect(result.bindingCredential).toBe("background_check");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBeGreaterThanOrEqual(365 * 5);
    expect(result.confidence).toBe("low");
    const binding = result.breakdown.find((b) => b.isBinding);
    expect(binding?.notes).toMatch(/FLAGGED/);
  });
});

describe("projectEarliestStart · facility privileging", () => {
  it("blocks on full privileging cycle when temp isn't supported", () => {
    const result = projectEarliestStart(
      makeInput({}, { supportsTemporaryPrivileges: false, privilegingCycleDays: 90 }),
    );
    expect(result.bindingCredential).toBe("facility_privileges");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(90);
  });

  it("uses temp privileging days when facility supports temp AND background is clear", () => {
    const result = projectEarliestStart(
      makeInput(
        {},
        {
          supportsTemporaryPrivileges: true,
          tempPrivilegingDays: 14,
          privilegingCycleDays: 90,
        },
      ),
    );
    expect(result.bindingCredential).toBe("facility_privileges");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(14);
  });

  it("falls back to full cycle when facility supports temp but background is NOT clear", () => {
    const result = projectEarliestStart(
      makeInput(
        { backgroundCheck: { status: "pending" } },
        {
          supportsTemporaryPrivileges: true,
          tempPrivilegingDays: 14,
          privilegingCycleDays: 90,
        },
      ),
    );
    // facility_privileges is now 90d (no temp eligibility); bg pending = 14d → facility binds.
    expect(result.bindingCredential).toBe("facility_privileges");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(90);
  });

  it("defaults tempPrivilegingDays to 14 when facility supports temp but omits the value", () => {
    // Construct the facility with the field truly absent (exactOptionalPropertyTypes-safe).
    const facility: FacilityRequirements = {
      state: "TX",
      requiredSubSpecialty: "general",
      requiredCredentials: [
        "state_license",
        "dea",
        "state_csr",
        "board_cert",
        "acls",
        "immunizations",
        "background_check",
        "drug_screen",
        "facility_privileges",
      ],
      privilegingCycleDays: 90,
      supportsTemporaryPrivileges: true,
      isImlcCompactState: false,
    };
    const result = projectEarliestStart({
      today: TODAY,
      provider: baseProvider(),
      facility,
    });
    expect(result.bindingCredential).toBe("facility_privileges");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(14);
  });

  it("honors facility-specific cycle length", () => {
    const result = projectEarliestStart(
      makeInput({}, { supportsTemporaryPrivileges: false, privilegingCycleDays: 120 }),
    );
    expect(result.bindingCredential).toBe("facility_privileges");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(120);
  });
});

describe("projectEarliestStart · sub-specialty mismatch", () => {
  // DECISION: We DO NOT fail the projection on a sub-specialty mismatch —
  // we still return a date and drop confidence to `low` with a note on the
  // binding credential. Rationale: fit is a ranker concern; the bridge
  // reports credential readiness + a clear signal.
  it("still projects a date but drops confidence to low on sub-specialty mismatch", () => {
    const result = projectEarliestStart(
      makeInput(
        { specialties: ["pain"] },
        { requiredSubSpecialty: "cardiac", privilegingCycleDays: 90 },
      ),
    );
    expect(result.confidence).toBe("low");
    const binding = result.breakdown.find((b) => b.isBinding);
    expect(binding?.notes).toMatch(/sub-specialty mismatch/);
  });
});

describe("projectEarliestStart · multi-binding tiebreak", () => {
  it("picks the earliest-listed credential when two tie on readyDate", () => {
    // DEA renewal (60d) and privileging cycle (60d) both resolve on the same day.
    const result = projectEarliestStart(
      makeInput(
        { dea: { status: "expired" } },
        { supportsTemporaryPrivileges: false, privilegingCycleDays: 60 },
      ),
    );
    // DEA is earlier in CREDENTIAL_ORDER than facility_privileges → it wins the tiebreak.
    expect(result.bindingCredential).toBe("dea");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(60);
    expect(result.breakdown.filter((b) => b.isBinding)).toHaveLength(1);
  });

  it("tiebreak is independent of requiredCredentials ordering supplied by the caller", () => {
    const required: RequiredCredential[] = [
      // Reversed order on purpose.
      "facility_privileges",
      "drug_screen",
      "background_check",
      "immunizations",
      "acls",
      "board_cert",
      "state_csr",
      "dea",
      "state_license",
    ];
    const result = projectEarliestStart(
      makeInput(
        { dea: { status: "expired" } },
        {
          requiredCredentials: required,
          supportsTemporaryPrivileges: false,
          privilegingCycleDays: 60,
        },
      ),
    );
    // Still DEA, despite facility_privileges appearing first in the input.
    expect(result.bindingCredential).toBe("dea");
  });
});

describe("projectEarliestStart · board cert / ACLS / immunizations / drug screen", () => {
  it("blocks ~365 days when board cert is lapsed and required", () => {
    const result = projectEarliestStart(
      makeInput({ boardCert: { status: "lapsed", board: "ABA" } }, { privilegingCycleDays: 10 }),
    );
    expect(result.bindingCredential).toBe("board_cert");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(365);
  });

  it("ignores an unrequired board cert even if lapsed", () => {
    const result = projectEarliestStart(
      makeInput(
        { boardCert: { status: "lapsed", board: "ABA" } },
        {
          privilegingCycleDays: 10,
          requiredCredentials: [
            "state_license",
            "dea",
            "state_csr",
            "acls",
            "immunizations",
            "background_check",
            "drug_screen",
            "facility_privileges",
          ],
        },
      ),
    );
    expect(result.bindingCredential).not.toBe("board_cert");
  });

  it("blocks ~7 days on ACLS when expired", () => {
    const result = projectEarliestStart(
      makeInput({ acls: { valid: false } }, { privilegingCycleDays: 2 }),
    );
    expect(result.bindingCredential).toBe("acls");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(7);
  });

  it("blocks ~14 days on immunizations when incomplete", () => {
    const result = projectEarliestStart(
      makeInput({ immunizations: { complete: false } }, { privilegingCycleDays: 2 }),
    );
    expect(result.bindingCredential).toBe("immunizations");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(14);
  });

  it("blocks ~7 days on a pending drug screen", () => {
    const result = projectEarliestStart(
      makeInput({ drugScreen: { status: "pending" } }, { privilegingCycleDays: 2 }),
    );
    expect(result.bindingCredential).toBe("drug_screen");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(7);
  });

  it("drops to low confidence on a flagged drug screen", () => {
    const result = projectEarliestStart(makeInput({ drugScreen: { status: "flagged" } }));
    expect(result.confidence).toBe("low");
    expect(result.bindingCredential).toBe("drug_screen");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBeGreaterThanOrEqual(365 * 5);
  });
});

describe("projectEarliestStart · result shape / determinism", () => {
  it("marks exactly one credential as binding and keeps the breakdown in sync with required list", () => {
    const result = projectEarliestStart(
      makeInput({ dea: { status: "expired" } }, { privilegingCycleDays: 10 }),
    );
    expect(result.breakdown).toHaveLength(9);
    expect(result.breakdown.filter((b) => b.isBinding)).toHaveLength(1);
    const binding = result.breakdown.find((b) => b.isBinding);
    expect(binding?.credential).toBe(result.bindingCredential);
    expect(binding?.readyDate.getTime()).toBe(result.earliestStartDate.getTime());
  });

  it("is deterministic — same input always returns the same output", () => {
    const input = makeInput(
      { dea: { status: "expired" }, backgroundCheck: { status: "pending" } },
      { privilegingCycleDays: 90 },
    );
    const a = projectEarliestStart(input);
    const b = projectEarliestStart(input);
    expect(a.earliestStartDate.getTime()).toBe(b.earliestStartDate.getTime());
    expect(a.bindingCredential).toBe(b.bindingCredential);
    expect(a.confidence).toBe(b.confidence);
  });

  it("does not mutate its input", () => {
    const input = makeInput();
    const beforeToday = input.today.getTime();
    const beforeReq = [...input.facility.requiredCredentials];
    projectEarliestStart(input);
    expect(input.today.getTime()).toBe(beforeToday);
    expect(input.facility.requiredCredentials).toEqual(beforeReq);
  });

  it("handles a degenerate empty requiredCredentials list without crashing", () => {
    const result = projectEarliestStart(makeInput({}, { requiredCredentials: [] }));
    expect(result.earliestStartDate.getTime()).toBe(TODAY.getTime());
    expect(result.confidence).toBe("low");
  });
});

describe("projectEarliestStart · combined real-world scenarios", () => {
  it("a brand-new provider in a new state is bound by the state license, not the ~21d bg check", () => {
    const result = projectEarliestStart(
      makeInput(
        {
          licenses: [],
          imlcEligible: false,
          backgroundCheck: { status: "none" },
          drugScreen: { status: "pending" },
          acls: { valid: false },
          immunizations: { complete: false },
        },
        { privilegingCycleDays: 60 },
      ),
    );
    expect(result.bindingCredential).toBe("state_license");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(90);
  });

  it("an IMLC-compact-state hire with pending bg is bound by the 30d license, not bg (14d)", () => {
    const result = projectEarliestStart(
      makeInput(
        { licenses: [], imlcEligible: true, backgroundCheck: { status: "pending" } },
        {
          isImlcCompactState: true,
          // Temp privileges require a clear bg, so they won't kick in here —
          // use a short full cycle to keep privileging off the critical path.
          supportsTemporaryPrivileges: false,
          privilegingCycleDays: 20,
        },
      ),
    );
    expect(result.bindingCredential).toBe("state_license");
    expect(daysBetween(result.earliestStartDate, TODAY)).toBe(30);
  });
});

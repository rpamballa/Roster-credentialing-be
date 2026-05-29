import { describe, expect, it } from "vitest";

// Test env shims so @cred/config validates at import time.
process.env.NODE_ENV ??= "test";
process.env.SESSION_SECRET ??= "test-session-secret-1234567890";
process.env.DATABASE_URL ??= "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL ??= "redis://localhost:6379/1";
process.env.API_PUBLIC_URL ??= "http://localhost:3001";
process.env.WEB_PUBLIC_URL ??= "http://localhost:3000";

const {
  computeSlaRisk,
  daysToTarget,
  fromFeDocumentType,
  slugify,
  stageFor,
  toFeCaseStatus,
  toFeDocumentType,
  toFeFacilityProfileStatus,
} = await import("../src/graphql/mappings.js");

describe("toFeCaseStatus", () => {
  it("maps backend statuses to frontend canon", () => {
    expect(toFeCaseStatus("intake")).toBe("intake");
    expect(toFeCaseStatus("awaiting_provider")).toBe("documents_pending");
    expect(toFeCaseStatus("in_progress")).toBe("documents_review");
    expect(toFeCaseStatus("awaiting_references")).toBe("references_pending");
    expect(toFeCaseStatus("ready_for_review")).toBe("ready_to_submit");
    expect(toFeCaseStatus("submitted")).toBe("submitted");
    expect(toFeCaseStatus("completed")).toBe("active");
    expect(toFeCaseStatus("withdrawn")).toBe("closed");
  });
});

describe("toFeDocumentType / fromFeDocumentType round-trip", () => {
  it("aliases medical_school_diploma <-> medical_diploma", () => {
    expect(toFeDocumentType("medical_school_diploma")).toBe("medical_diploma");
    expect(fromFeDocumentType("medical_diploma")).toBe("medical_school_diploma");
  });

  it("aliases vaccination_record <-> vaccination", () => {
    expect(toFeDocumentType("vaccination_record")).toBe("vaccination");
    expect(fromFeDocumentType("vaccination")).toBe("vaccination_record");
  });

  it("returns null for non-surfaceable backend types", () => {
    expect(toFeDocumentType("cv")).toBeNull();
    expect(toFeDocumentType("other")).toBeNull();
  });

  it("passes through identity types", () => {
    expect(toFeDocumentType("medical_license")).toBe("medical_license");
    expect(fromFeDocumentType("dea")).toBe("dea");
  });
});

describe("toFeFacilityProfileStatus", () => {
  it("maps approved + archived correctly", () => {
    expect(toFeFacilityProfileStatus("approved")).toBe("approved");
    expect(toFeFacilityProfileStatus("archived")).toBe("superseded");
    expect(toFeFacilityProfileStatus("draft")).toBe("draft");
    expect(toFeFacilityProfileStatus("in_review")).toBe("in_review");
    expect(toFeFacilityProfileStatus("anything-else")).toBe("draft");
  });
});

describe("daysToTarget + computeSlaRisk", () => {
  const fixedNow = new Date("2026-05-28T12:00:00Z");

  it("returns null for missing target", () => {
    expect(daysToTarget(null, fixedNow)).toBeNull();
    expect(computeSlaRisk(null)).toBe("on_track");
  });

  it("computes negative for an overdue target", () => {
    const d = daysToTarget("2026-05-20", fixedNow);
    expect(d).toBe(-8);
    expect(computeSlaRisk(d)).toBe("overdue");
  });

  it("at_risk within 3 days", () => {
    const d = daysToTarget("2026-05-30", fixedNow);
    expect(d).toBe(2);
    expect(computeSlaRisk(d)).toBe("at_risk");
  });

  it("watch between 4 and 7 days", () => {
    const d = daysToTarget("2026-06-02", fixedNow);
    expect(d).toBe(5);
    expect(computeSlaRisk(d)).toBe("watch");
  });

  it("on_track beyond 7 days", () => {
    const d = daysToTarget("2026-06-30", fixedNow);
    expect(d).toBe(33);
    expect(computeSlaRisk(d)).toBe("on_track");
  });
});

describe("stageFor", () => {
  it("returns user-facing stage names", () => {
    expect(stageFor("intake")).toBe("Intake");
    expect(stageFor("awaiting_provider")).toBe("Documents");
    expect(stageFor("ready_for_review")).toBe("Final review");
    expect(stageFor("submitted")).toBe("Submitted");
  });
});

describe("slugify", () => {
  it("stable kebab-style slugs for privilege keys", () => {
    expect(slugify("Cardiology - Electrophysiology")).toBe("cardiology_electrophysiology");
    expect(slugify("ECMO Initiation & Management")).toBe("ecmo_initiation_management");
  });
});

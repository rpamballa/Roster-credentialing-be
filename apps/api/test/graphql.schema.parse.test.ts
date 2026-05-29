import { buildSchema, parse, validate } from "graphql";
import { describe, expect, it } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.SESSION_SECRET ??= "test-session-secret-1234567890";
process.env.DATABASE_URL ??= "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL ??= "redis://localhost:6379/1";
process.env.API_PUBLIC_URL ??= "http://localhost:3001";
process.env.WEB_PUBLIC_URL ??= "http://localhost:3000";

// We import the SDL string rather than the live executable schema —
// graphql-yoga bundles its own graphql instance which confuses
// instanceof checks when paired with the host graphql import. Building a
// fresh schema from the same SDL is equivalent for parse/validate.
const { cockpitTypeDefs } = await import("../src/graphql/schema.js");
const schema = buildSchema(cockpitTypeDefs);

// These query strings are the exact ones the frontend issues
// (apps/web/lib/api/cockpit.ts). Keep them character-for-character; this
// asserts our schema covers every selected field.

const PIPELINE_QUERY = /* GraphQL */ `
  query Pipeline($q: String, $slaRisk: String, $stage: String, $needsReviewOnly: Boolean) {
    pipelineCases(q: $q, slaRisk: $slaRisk, stage: $stage, needsReviewOnly: $needsReviewOnly) {
      id
      status
      slaRisk
      stage
      daysToTarget
      blockerCount
      needsHumanReview
      openedAt
      targetSubmissionDate
      provider { id fullName npi specialty }
      facility { id name }
      assignedSpecialist { id fullName }
    }
  }
`;

const CASE_DETAIL_QUERY = /* GraphQL */ `
  query CaseDetail($id: ID!) {
    case(id: $id) {
      id status slaRisk stage openedAt targetSubmissionDate submittedAt readyForSubmission
      provider { id fullName npi email phone specialty }
      facility { id name profileId }
      assignedSpecialist { id fullName }
      requirements {
        key documentType label state needsReview
        document {
          id type thumbnailUrl pageCount uploadedAt expiresAt
          extractionStatus reusedFromPriorCase
          extractedFields { key label value confidence }
        }
      }
      references { id fullName email organization relationship status completedAt }
      blockers { id kind message documentId requirementKey raisedAt }
      timeline { id kind actor actorName message timestamp }
    }
  }
`;

const DOC_REVIEW_QUERY = /* GraphQL */ `
  query DocumentReview($caseId: ID!, $documentId: ID!) {
    documentReview(caseId: $caseId, documentId: $documentId) {
      document {
        id type pageCount thumbnailUrl uploadedAt expiresAt
        extractionStatus reusedFromPriorCase
      }
      fields { key label value confidence bbox { page bbox } }
      sourceUrl sourceMimeType pageCount
    }
  }
`;

const FACILITY_REVIEW_QUERY = /* GraphQL */ `
  query FacilityReview($id: ID!) {
    facilityProfile(id: $id) {
      id version status reviewQueueCount sourcePacketUrl sourcePageCount
      facility { id name address }
      requirements {
        documents { key documentType count attestationRequired conditions needsReview bbox { page bbox } }
        verifications { key type sourcePriority recencyDays needsReview bbox { page bbox } }
        attestations { key text signerRole format needsReview }
        submission { method recipient deadlineDaysBeforeEffective needsReview }
        privilegeDelineations {
          specialty
          privileges { key name requiresVolume threshold { count periodMonths } needsReview }
        }
      }
    }
  }
`;

const PROVIDER_PROFILE_QUERY = /* GraphQL */ `
  query ProviderProfile($id: ID!) {
    provider(id: $id) {
      id fullName npi email phone dob specialties statesLicensed
      documents {
        document {
          id type pageCount uploadedAt expiresAt extractionStatus reusedFromPriorCase
        }
        reuseCount expirationStatus
      }
      cases {
        id status slaRisk stage daysToTarget blockerCount needsHumanReview
        openedAt targetSubmissionDate
        provider { id fullName npi specialty }
        facility { id name }
        assignedSpecialist { id fullName }
      }
    }
  }
`;

function expectValid(query: string): void {
  const doc = parse(query);
  const errors = validate(schema, doc);
  expect(errors).toEqual([]);
}

describe("Cockpit GraphQL schema matches the frontend query contracts", () => {
  it("Pipeline query", () => expectValid(PIPELINE_QUERY));
  it("CaseDetail query", () => expectValid(CASE_DETAIL_QUERY));
  it("DocumentReview query", () => expectValid(DOC_REVIEW_QUERY));
  it("FacilityReview query", () => expectValid(FACILITY_REVIEW_QUERY));
  it("ProviderProfile query", () => expectValid(PROVIDER_PROFILE_QUERY));
});

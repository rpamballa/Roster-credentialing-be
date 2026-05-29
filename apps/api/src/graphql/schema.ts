import { createSchema } from "graphql-yoga";
import type { GqlContext } from "./context.js";
import { caseDetailResolver } from "./resolvers/caseDetail.js";
import { documentReviewResolver } from "./resolvers/documentReview.js";
import { facilityResolvers } from "./resolvers/facility.js";
import { facilityProfileReviewResolver } from "./resolvers/facilityReview.js";
import { pipelineCasesResolver } from "./resolvers/pipeline.js";
import { providerResolver } from "./resolvers/provider.js";

// Cockpit schema. The expanded `facilityProfile(id)` returns the review
// model; the existing M3 callers fetch a subset of those fields, so the
// transition is non-breaking. The old `FacilityProfileDetail.profile/
// requirements/sourcePacketUri` are exposed as fields on the same return
// type for compatibility.
export const cockpitTypeDefs = /* GraphQL */ `
    scalar JSON

    type Query {
      health: String!

      # Existing M3 fields preserved; facilityProfile returns a superset
      # that supports the cockpit review UI.
      facilityProfiles(status: String): [FacilityProfile!]!
      facilityProfile(id: ID!): FacilityProfileReview

      # Cockpit pipeline (SPEC §5.6).
      pipelineCases(
        q: String
        slaRisk: String
        stage: String
        needsReviewOnly: Boolean
      ): [CaseSummary!]!

      # Cockpit detail screens.
      case(id: ID!): CaseDetail
      documentReview(caseId: ID!, documentId: ID!): DocumentReview
      provider(id: ID!): ProviderProfileDetail
    }

    type Mutation {
      facilityProfileCorrect(input: FacilityProfileCorrectInput!): FacilityProfile!
      facilityProfileApprove(id: ID!): FacilityProfile!
    }

    type FacilityProfile {
      id: ID!
      facilityId: ID!
      facilityName: String!
      version: Int!
      status: String!
      approvedAt: String
      approvedBy: ID
      createdAt: String!
      updatedAt: String!
    }

    type Bbox {
      page: Int!
      bbox: [Float!]!
    }

    # ─── Facility profile review (cockpit) ───────────────────────────────
    type FacilityProfileReview {
      id: ID!
      version: Int!
      status: String!
      facility: Facility!
      sourcePacketUrl: String
      sourcePageCount: Int!
      reviewQueueCount: Int!
      requirements: FacilityProfileRequirements!
    }

    type Facility {
      id: ID!
      name: String!
      address: String
    }

    type FacilityProfileRequirements {
      documents: [FacilityRequirementDoc!]!
      verifications: [FacilityRequirementVerification!]!
      attestations: [FacilityRequirementAttestation!]!
      submission: FacilityRequirementSubmission!
      privilegeDelineations: [FacilityPrivilegeGroup!]!
    }

    type FacilityRequirementDoc {
      key: String!
      documentType: String!
      count: Int!
      attestationRequired: Boolean!
      conditions: [String!]!
      needsReview: Boolean!
      bbox: Bbox
    }

    type FacilityRequirementVerification {
      key: String!
      type: String!
      sourcePriority: [String!]!
      recencyDays: Int!
      needsReview: Boolean!
      bbox: Bbox
    }

    type FacilityRequirementAttestation {
      key: String!
      text: String!
      signerRole: String!
      format: String!
      needsReview: Boolean!
    }

    type FacilityRequirementSubmission {
      method: String!
      recipient: String
      deadlineDaysBeforeEffective: Int
      needsReview: Boolean!
    }

    type FacilityPrivilegeGroup {
      specialty: String!
      privileges: [FacilityPrivilege!]!
    }

    type FacilityPrivilege {
      key: String!
      name: String!
      requiresVolume: Boolean!
      threshold: FacilityPrivilegeThreshold
      needsReview: Boolean!
      bbox: Bbox
    }

    type FacilityPrivilegeThreshold {
      count: Int!
      periodMonths: Int!
    }

    # ─── Pipeline / case detail ──────────────────────────────────────────
    type CaseSummary {
      id: ID!
      status: String!
      slaRisk: String!
      stage: String!
      daysToTarget: Int
      blockerCount: Int!
      needsHumanReview: Boolean!
      openedAt: String!
      targetSubmissionDate: String
      provider: CaseProviderRef!
      facility: CaseFacilityRef!
      assignedSpecialist: SpecialistRef
    }

    type CaseProviderRef {
      id: ID!
      fullName: String!
      npi: String
      specialty: String!
    }

    type CaseFacilityRef {
      id: ID!
      name: String!
    }

    type SpecialistRef {
      id: ID!
      fullName: String!
    }

    type CaseDetail {
      id: ID!
      status: String!
      slaRisk: String!
      stage: String!
      openedAt: String!
      targetSubmissionDate: String
      submittedAt: String
      readyForSubmission: Boolean!
      provider: CaseDetailProvider!
      facility: CaseDetailFacility!
      assignedSpecialist: SpecialistRef
      requirements: [RequirementRow!]!
      references: [Reference!]!
      blockers: [Blocker!]!
      timeline: [TimelineEvent!]!
    }

    type CaseDetailProvider {
      id: ID!
      fullName: String!
      npi: String
      email: String
      phone: String
      specialty: String!
    }

    type CaseDetailFacility {
      id: ID!
      name: String!
      profileId: ID!
    }

    type RequirementRow {
      key: String!
      documentType: String!
      label: String!
      state: String!
      needsReview: Boolean!
      document: DocumentSummary
    }

    type DocumentSummary {
      id: ID!
      type: String!
      thumbnailUrl: String
      pageCount: Int!
      uploadedAt: String!
      expiresAt: String
      extractionStatus: String!
      reusedFromPriorCase: Boolean!
      extractedFields: [ExtractedField!]!
    }

    type ExtractedField {
      key: String!
      label: String!
      value: String!
      confidence: Float!
      bbox: Bbox
    }

    type Reference {
      id: ID!
      fullName: String!
      email: String!
      organization: String!
      relationship: String!
      status: String!
      completedAt: String
    }

    type Blocker {
      id: ID!
      kind: String!
      message: String!
      documentId: ID
      requirementKey: String
      raisedAt: String!
    }

    type TimelineEvent {
      id: ID!
      kind: String!
      actor: String!
      actorName: String
      message: String!
      timestamp: String!
    }

    # ─── Document citation viewer ────────────────────────────────────────
    type DocumentReview {
      document: DocumentSummary!
      fields: [ExtractedField!]!
      sourceUrl: String!
      sourceMimeType: String!
      pageCount: Int!
    }

    # ─── Provider detail ─────────────────────────────────────────────────
    type ProviderProfileDetail {
      id: ID!
      fullName: String!
      npi: String
      email: String
      phone: String
      dob: String
      specialties: [String!]!
      statesLicensed: [String!]!
      documents: [ProviderDocumentRow!]!
      cases: [CaseSummary!]!
    }

    type ProviderDocumentRow {
      document: DocumentSummary!
      reuseCount: Int!
      expirationStatus: String!
    }

    input FacilityProfileCorrectInput {
      id: ID!
      fieldPath: String!
      after: JSON!
    }
  `;

export const cockpitSchema = createSchema<GqlContext>({
  typeDefs: cockpitTypeDefs,
  resolvers: {
    Query: {
      health: () => "ok",
      facilityProfiles: facilityResolvers.list,
      facilityProfile: facilityProfileReviewResolver,
      pipelineCases: pipelineCasesResolver,
      case: caseDetailResolver,
      documentReview: documentReviewResolver,
      provider: providerResolver,
    },
    Mutation: {
      facilityProfileCorrect: facilityResolvers.correct,
      facilityProfileApprove: facilityResolvers.approve,
    },
  },
});

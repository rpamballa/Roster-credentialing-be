// Shared GraphQL resolver return types mirroring apps/web/lib/types/cockpit.ts.

import type {
  FeCaseStatus,
  FeDocumentType,
  FeFacilityProfileStatus,
  SlaRisk,
} from "../mappings.js";

export interface CaseSummaryGql {
  id: string;
  status: FeCaseStatus;
  slaRisk: SlaRisk;
  stage: string;
  daysToTarget: number | null;
  blockerCount: number;
  needsHumanReview: boolean;
  openedAt: string;
  targetSubmissionDate: string | null;
  provider: {
    id: string;
    fullName: string;
    npi: string | null;
    specialty: string;
  };
  facility: { id: string; name: string };
  assignedSpecialist: { id: string; fullName: string } | null;
}

export interface ExtractedFieldGql {
  key: string;
  label: string;
  value: string;
  confidence: number;
  bbox?: { page: number; bbox: [number, number, number, number] } | null;
}

export interface DocumentSummaryGql {
  id: string;
  type: FeDocumentType;
  thumbnailUrl: string | null;
  pageCount: number;
  uploadedAt: string;
  expiresAt: string | null;
  extractionStatus: "pending" | "processing" | "ready" | "failed";
  reusedFromPriorCase: boolean;
  extractedFields: ExtractedFieldGql[];
}

export type RequirementStateGql =
  | "missing"
  | "uploaded"
  | "low_confidence"
  | "fulfilled"
  | "expired";

export interface RequirementRowGql {
  key: string;
  documentType: FeDocumentType;
  label: string;
  state: RequirementStateGql;
  needsReview: boolean;
  document: DocumentSummaryGql | null;
}

export interface BlockerGql {
  id: string;
  kind: string;
  message: string;
  documentId: string | null;
  requirementKey: string | null;
  raisedAt: string;
}

export interface ReferenceGql {
  id: string;
  fullName: string;
  email: string;
  organization: string;
  relationship: string;
  status: string;
  completedAt: string | null;
}

export interface TimelineEventGql {
  id: string;
  kind: string;
  actor: "provider" | "specialist" | "reference" | "agent" | "system";
  actorName: string | null;
  message: string;
  timestamp: string;
}

export interface CaseDetailGql {
  id: string;
  status: FeCaseStatus;
  slaRisk: SlaRisk;
  stage: string;
  openedAt: string;
  targetSubmissionDate: string | null;
  submittedAt: string | null;
  provider: {
    id: string;
    fullName: string;
    npi: string | null;
    email: string | null;
    phone: string | null;
    specialty: string;
  };
  facility: { id: string; name: string; profileId: string };
  assignedSpecialist: { id: string; fullName: string } | null;
  requirements: RequirementRowGql[];
  references: ReferenceGql[];
  blockers: BlockerGql[];
  timeline: TimelineEventGql[];
  readyForSubmission: boolean;
}

export interface DocumentReviewGql {
  document: DocumentSummaryGql;
  fields: ExtractedFieldGql[];
  sourceUrl: string;
  sourceMimeType: string;
  pageCount: number;
}

export interface FacilityProfileRequirementDocGql {
  key: string;
  documentType: FeDocumentType;
  count: number;
  attestationRequired: boolean;
  conditions: string[];
  needsReview: boolean;
  bbox: { page: number; bbox: [number, number, number, number] } | null;
}

export interface FacilityProfileVerificationGql {
  key: string;
  type: string;
  sourcePriority: string[];
  recencyDays: number;
  needsReview: boolean;
  bbox: { page: number; bbox: [number, number, number, number] } | null;
}

export interface FacilityProfileAttestationGql {
  key: string;
  text: string;
  signerRole: "provider" | "department_chair" | "medical_director";
  format: "checkbox" | "signature" | "initials";
  needsReview: boolean;
}

export interface FacilityProfileSubmissionGql {
  method: "platform" | "email" | "fax" | "portal";
  recipient: string | null;
  deadlineDaysBeforeEffective: number | null;
  needsReview: boolean;
}

export interface FacilityProfilePrivilegeGql {
  key: string;
  name: string;
  requiresVolume: boolean;
  threshold: { count: number; periodMonths: number } | null;
  needsReview: boolean;
  bbox: { page: number; bbox: [number, number, number, number] } | null;
}

export interface FacilityProfilePrivilegeGroupGql {
  specialty: string;
  privileges: FacilityProfilePrivilegeGql[];
}

export interface FacilityProfileReviewRequirementsGql {
  documents: FacilityProfileRequirementDocGql[];
  verifications: FacilityProfileVerificationGql[];
  attestations: FacilityProfileAttestationGql[];
  submission: FacilityProfileSubmissionGql;
  privilegeDelineations: FacilityProfilePrivilegeGroupGql[];
}

export interface FacilityProfileReviewGql {
  id: string;
  version: number;
  status: FeFacilityProfileStatus;
  facility: { id: string; name: string; address: string | null };
  sourcePacketUrl: string | null;
  sourcePageCount: number;
  reviewQueueCount: number;
  requirements: FacilityProfileReviewRequirementsGql;
}

export interface ProviderDocumentRowGql {
  document: DocumentSummaryGql;
  reuseCount: number;
  expirationStatus: "current" | "expiring_soon" | "expired";
}

export interface ProviderProfileDetailGql {
  id: string;
  fullName: string;
  npi: string | null;
  email: string | null;
  phone: string | null;
  dob: string | null;
  specialties: string[];
  statesLicensed: string[];
  documents: ProviderDocumentRowGql[];
  cases: CaseSummaryGql[];
}

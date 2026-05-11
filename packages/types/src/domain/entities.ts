import type { FacilityRequirements } from "../facility-requirements.js";
import type {
  ActorType,
  CasePurpose,
  CaseStatus,
  DocumentSource,
  DocumentType,
  ExtractionStatus,
  FacilityProfileStatus,
  MembershipRole,
  WorkspaceType,
} from "./enums.js";
import type { ExtractedField } from "./extraction.js";

export interface WorkspaceSettings {
  confidenceThresholds?: {
    autoFill?: number;
    flag?: number;
  };
  outreachCadenceOverrides?: Record<string, number>;
}

export interface Workspace {
  id: string;
  type: WorkspaceType;
  name: string;
  slug: string;
  emailInAddress: string | null;
  settings: WorkspaceSettings;
  billingStatus: string;
  createdAt: Date;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

export interface Membership {
  userId: string;
  workspaceId: string;
  role: MembershipRole;
  createdAt: Date;
}

export interface Provider {
  id: string;
  npi: string | null;
  firstName: string;
  lastName: string;
  dob: string | null;
  email: string | null;
  phone: string | null;
  specialties: string[];
  statesLicensed: string[];
  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date | null;
}

export interface Document {
  id: string;
  providerId: string;
  documentType: DocumentType;
  fileUri: string;
  originalFilename: string | null;
  mimeType: string | null;
  pageCount: number | null;
  uploadedAt: Date;
  uploadedBy: string | null;
  source: DocumentSource;
  extractionStatus: ExtractionStatus;
  extractedFields: ExtractedField[] | null;
  expiresAt: Date | null;
}

export interface Blocker {
  type: string;
  message: string;
  raisedAt: string;
  raisedBy: ActorType;
  resolvedAt?: string;
}

export interface Case {
  id: string;
  workspaceId: string;
  providerId: string;
  facilityProfileId: string;
  facilityProfileVersion: number;
  specialty: string;
  purpose: CasePurpose;
  status: CaseStatus;
  openedAt: Date;
  targetSubmissionDate: string | null;
  submittedAt: Date | null;
  completedAt: Date | null;
  assignedSpecialistId: string | null;
  blockers: Blocker[];
}

export interface FacilityProfile {
  id: string;
  facilityId: string;
  workspaceId: string;
  version: number;
  status: FacilityProfileStatus;
  sourcePacketUri: string | null;
  requirements: FacilityRequirements;
  approvedAt: Date | null;
  approvedBy: string | null;
}

export interface AuditEntry {
  id: string;
  workspaceId: string | null;
  actorUserId: string | null;
  actorType: ActorType;
  action: string;
  targetEntityType: string;
  targetEntityId: string;
  beforeState: unknown;
  afterState: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  timestamp: Date;
}

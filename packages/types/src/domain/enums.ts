export const WORKSPACE_TYPES = ["agency", "hospital", "solo_provider"] as const;
export type WorkspaceType = (typeof WORKSPACE_TYPES)[number];

export const MEMBERSHIP_ROLES = ["owner", "admin", "specialist", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const CASE_STATUSES = [
  "intake",
  "in_progress",
  "awaiting_provider",
  "awaiting_references",
  "ready_for_review",
  "submitted",
  "completed",
  "withdrawn",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_PURPOSES = ["privileging", "initial_appointment", "reappointment"] as const;
export type CasePurpose = (typeof CASE_PURPOSES)[number];

export const FACILITY_PROFILE_STATUSES = ["draft", "approved", "archived"] as const;
export type FacilityProfileStatus = (typeof FACILITY_PROFILE_STATUSES)[number];

export const ACTOR_TYPES = ["user", "agent", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const DOCUMENT_SOURCES = [
  "provider_upload",
  "facility_email",
  "reference_form",
  "psv_pull",
  "specialist_upload",
] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

export const EXTRACTION_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "needs_review",
  "failed",
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const DOCUMENT_TYPES = [
  "medical_license",
  "dea",
  "board_certification",
  "bls",
  "acls",
  "medical_school_diploma",
  "government_id",
  "vaccination_record",
  "malpractice_insurance",
  "cv",
  "other",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const VERIFICATION_TYPES = [
  "state_license",
  "dea",
  "npdb",
  "abms_board",
  "medical_school",
  "residency",
] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

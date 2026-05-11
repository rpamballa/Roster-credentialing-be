// CONTRACT-LOCKED — see PROMPT §4.6 and SPEC §5.3.
// Do not change without an ADR and a paired migration.
// The frontend agent and the packet assembly engine both depend on this shape.

import type { DocumentType, VerificationType } from "./domain/enums.js";

export interface BboxCitation {
  page: number;
  bbox: [number, number, number, number];
}

export interface RequiredDocument {
  type: DocumentType;
  count: number;
  conditions?: string[];
  attestation_required: boolean;
  bbox_citation?: BboxCitation;
}

export interface RequiredVerification {
  type: VerificationType;
  source_priority: Array<"state_board" | "npdb" | "abms" | "manual">;
  recency_days: number;
  bbox_citation?: BboxCitation;
}

export interface Privilege {
  name: string;
  requires_volume: boolean;
  threshold?: { count: number; period_months: number };
}

export interface PrivilegeDelineation {
  specialty: string;
  privileges: Privilege[];
}

export interface Attestation {
  text: string;
  signer_role: "provider" | "department_chair" | "medical_director";
  format: "checkbox" | "signature" | "initials";
}

export interface SubmissionInstructions {
  method: "platform" | "email" | "fax" | "portal";
  recipient?: string;
  deadline_days_before_effective?: number;
}

export interface FacilityForm {
  form_id: string;
  name: string;
  source_uri: string;
  field_mappings: Record<string, string>;
}

export interface FacilityRequirements {
  required_documents: RequiredDocument[];
  required_verifications: RequiredVerification[];
  privilege_delineations: PrivilegeDelineation[];
  attestations: Attestation[];
  submission: SubmissionInstructions;
  facility_forms: FacilityForm[];
}

// Mappings between backend domain enums (SPEC §5.1) and the cockpit
// frontend's contract (apps/web/lib/types/cockpit.ts). The frontend has
// historically used slightly different vocabulary (e.g. `documents_pending`
// vs the backend's `awaiting_provider`); rather than churn either side, the
// resolvers translate at the GraphQL boundary.

import type { CaseStatus as DomainCaseStatus, DocumentType } from "@cred/types/domain";

// ─── Case status ─────────────────────────────────────────────────────────
// Backend canon: intake, in_progress, awaiting_provider, awaiting_references,
//   ready_for_review, submitted, completed, withdrawn.
// Frontend canon: intake, documents_pending, documents_review,
//   references_pending, attestation_pending, ready_to_submit, submitted,
//   active, closed.
export type FeCaseStatus =
  | "intake"
  | "documents_pending"
  | "documents_review"
  | "references_pending"
  | "attestation_pending"
  | "ready_to_submit"
  | "submitted"
  | "active"
  | "closed";

export function toFeCaseStatus(status: DomainCaseStatus): FeCaseStatus {
  switch (status) {
    case "intake":
      return "intake";
    case "awaiting_provider":
      return "documents_pending";
    case "in_progress":
      return "documents_review";
    case "awaiting_references":
      return "references_pending";
    case "ready_for_review":
      return "ready_to_submit";
    case "submitted":
      return "submitted";
    case "completed":
      return "active";
    case "withdrawn":
      return "closed";
  }
}

// ─── Document type ───────────────────────────────────────────────────────
// Backend canon names the diploma `medical_school_diploma` and the
// vaccination doc `vaccination_record`. The frontend uses shorter aliases.
export type FeDocumentType =
  | "medical_license"
  | "dea"
  | "board_certification"
  | "bls"
  | "acls"
  | "medical_diploma"
  | "government_id"
  | "vaccination"
  | "malpractice_insurance";

export function toFeDocumentType(t: DocumentType): FeDocumentType | null {
  switch (t) {
    case "medical_license":
    case "dea":
    case "board_certification":
    case "bls":
    case "acls":
    case "government_id":
    case "malpractice_insurance":
      return t;
    case "medical_school_diploma":
      return "medical_diploma";
    case "vaccination_record":
      return "vaccination";
    case "cv":
    case "other":
      return null;
  }
}

export function fromFeDocumentType(t: FeDocumentType): DocumentType {
  switch (t) {
    case "medical_diploma":
      return "medical_school_diploma";
    case "vaccination":
      return "vaccination_record";
    default:
      return t;
  }
}

// ─── Facility profile status ─────────────────────────────────────────────
// Backend canon: draft, approved, archived. Frontend: draft, in_review,
// approved, superseded. Until the backend gains an in_review state, draft
// surfaces as `draft` (the FE will treat it interchangeably for queue intent).
export type FeFacilityProfileStatus = "draft" | "in_review" | "approved" | "superseded";

export function toFeFacilityProfileStatus(s: string): FeFacilityProfileStatus {
  if (s === "approved") return "approved";
  if (s === "archived") return "superseded";
  if (s === "in_review") return "in_review";
  return "draft";
}

// ─── SLA risk ────────────────────────────────────────────────────────────
export type SlaRisk = "on_track" | "watch" | "at_risk" | "overdue";

export function computeSlaRisk(daysToTarget: number | null): SlaRisk {
  if (daysToTarget === null) return "on_track";
  if (daysToTarget < 0) return "overdue";
  if (daysToTarget <= 3) return "at_risk";
  if (daysToTarget <= 7) return "watch";
  return "on_track";
}

export function daysToTarget(targetIso: string | null, now: Date = new Date()): number | null {
  if (!targetIso) return null;
  const target = new Date(targetIso);
  if (Number.isNaN(target.getTime())) return null;
  const oneDay = 1000 * 60 * 60 * 24;
  const startOfNow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startOfTarget = Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate(),
  );
  return Math.round((startOfTarget - startOfNow) / oneDay);
}

// ─── Stage ───────────────────────────────────────────────────────────────
// "Stage" in the cockpit is the user-friendly name of the next pending step.
// We derive it from case status since the backend does not yet model an
// explicit step machine.
export function stageFor(status: DomainCaseStatus): string {
  switch (status) {
    case "intake":
      return "Intake";
    case "awaiting_provider":
      return "Documents";
    case "in_progress":
      return "Document review";
    case "awaiting_references":
      return "References";
    case "ready_for_review":
      return "Final review";
    case "submitted":
      return "Submitted";
    case "completed":
      return "Active";
    case "withdrawn":
      return "Closed";
  }
}

// ─── Slugify (stable per-privilege key derivation) ───────────────────────
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

import {
  ACTOR_TYPES,
  CASE_PURPOSES,
  CASE_STATUSES,
  DOCUMENT_SOURCES,
  DOCUMENT_TYPES,
  EXTRACTION_STATUSES,
  MEMBERSHIP_ROLES,
  WORKSPACE_TYPES,
} from "@cred/types/domain";
import { pgEnum } from "drizzle-orm/pg-core";

export const workspaceTypeEnum = pgEnum("workspace_type", WORKSPACE_TYPES);
export const membershipRoleEnum = pgEnum("membership_role", MEMBERSHIP_ROLES);
export const actorTypeEnum = pgEnum("actor_type", ACTOR_TYPES);
export const documentTypeEnum = pgEnum("document_type", DOCUMENT_TYPES);
export const documentSourceEnum = pgEnum("document_source", DOCUMENT_SOURCES);
export const extractionStatusEnum = pgEnum("extraction_status", EXTRACTION_STATUSES);
export const caseStatusEnum = pgEnum("case_status", CASE_STATUSES);
export const casePurposeEnum = pgEnum("case_purpose", CASE_PURPOSES);

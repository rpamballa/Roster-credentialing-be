/**
 * Mode B · ATS-sourced credential state (NOT IMPLEMENTED in v0)
 * -------------------------------------------------------------
 *
 * In v0 the credentialing bridge runs in **Mode A**: a caller reads the
 * provider's credential state out of Roster's own database (the structures in
 * `project.ts`) and hands it to `projectEarliestStart()`.
 *
 * In v1 we will add **Mode B**: a reader that pulls the same shape from the
 * agency's upstream ATS custom fields (Bullhorn, Avionté, LaborEdge, etc.).
 * The ATS is the source of truth for most mature agencies — Mode B lets a
 * Roster workspace project start dates without first migrating credentials
 * into Roster's DB.
 *
 * This file pins the interface now so the projection function doesn't change
 * when Mode B lands. The implementation lives in a follow-up PR; the stub
 * throws so a surprise call site fails loudly rather than silently returning
 * a half-populated provider.
 */

import type { ProviderCredentialState } from "./project.js";

/** Opaque reference the Mode B reader needs to look up a provider in the ATS. */
export interface AtsProviderRef {
  /** Which ATS integration ("bullhorn", "avionte", "laboredge", …). */
  atsVendor: string;
  /** The agency's workspace in Roster — scopes field mappings and auth. */
  workspaceId: string;
  /** The ATS-side provider primary key. */
  atsProviderId: string;
}

/** Field-mapping config: per-workspace, per-vendor. Shape TBD in Mode B PR. */
export interface AtsFieldMapping {
  atsVendor: string;
  workspaceId: string;
  /**
   * Opaque mapping from ATS custom field keys to Roster credential-state
   * slots. Nailed down when Mode B ships.
   */
  fields: Record<string, string>;
}

export interface ModeBCredentialReader {
  /**
   * Fetch credential state from the ATS and shape it into the same
   * `ProviderCredentialState` the projection function already consumes.
   *
   * MUST be side-effect-free except for the network read. MUST NOT write back
   * to the ATS. MUST NOT touch Roster's DB — the projection function is
   * pure, and Mode B stays pure at the shape boundary.
   */
  readProviderState(
    ref: AtsProviderRef,
    mapping: AtsFieldMapping,
  ): Promise<ProviderCredentialState>;
}

/**
 * Mode B is not implemented in v0. The projection function already accepts
 * `ProviderCredentialState` directly, so Mode A callers ignore this file.
 *
 * This stub exists to pin the interface shape and to fail loudly if any
 * caller tries to resolve Mode B before the real reader ships.
 */
export const modeBReaderStub: ModeBCredentialReader = {
  readProviderState(): Promise<ProviderCredentialState> {
    throw new Error("Mode B: not implemented");
  },
};

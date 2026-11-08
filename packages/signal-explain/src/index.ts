/**
 * @cred/signal-explain — structured reason facets for Signal rankings.
 *
 * Every reason carried on a ranking entry (see
 * `packages/db/src/schema/signal/rankings.ts`) is a discriminated union
 * of these facets, not a free-text string. The prose humans see is
 * RENDERED FROM the structured facet — never the other way around.
 * This keeps three properties in step:
 *
 *   1. Explainability: every reason has a canonical `sourceLineageRef`
 *      that resolves through `signal_source_lineage` back to the row
 *      that originated the claim. The reason resolver endpoint
 *      (`GET /v1/signal/reasons/:reason_id/source`) uses this ref.
 *
 *   2. Learnability: the learn worker keys weights by `facet` (the
 *      discriminator tag), so an override against "that candidate was
 *      promoted" can nudge the matching facet's weight up/down in
 *      `signal_weights` without a brittle string match.
 *
 *   3. Localization: prose is a rendering concern; upstream never
 *      stores it, so swapping copy or locale is a renderer change.
 *
 * Pure library. No DB, no network. The ranker instantiates reasons
 * with a `sourceLineageRef` pointing at a (canonicalTable, canonicalId)
 * pair that the caller has already recorded via `recordLineage`.
 */

/** Lineage pointer into `signal_source_lineage`. */
export interface SourceLineageRef {
  canonicalTable: string;
  canonicalId: string;
}

/**
 * The full facet taxonomy. Add new entries here; the renderer and the
 * learn worker's facet-key extractor fall through safely for unknown
 * ones (unknown tag → opaque fallback).
 */
export type ReasonFacet =
  | {
      facet: "LICENSE_IN_STATE";
      state: string;
      sourceLineageRef: SourceLineageRef;
    }
  | {
      facet: "DEA_ACTIVE";
      sourceLineageRef: SourceLineageRef;
    }
  | {
      facet: "STATE_CSR_ACTIVE";
      state: string;
      sourceLineageRef: SourceLineageRef;
    }
  | {
      facet: "AVAILABLE_BY_NEED_DATE";
      earliestStartDate: string; // ISO date yyyy-mm-dd
      needDate: string; // ISO date yyyy-mm-dd
      sourceLineageRef: SourceLineageRef;
    }
  | {
      facet: "BLOCKED_ON_CREDENTIAL";
      credential: string;
      readyDate: string; // ISO
      sourceLineageRef: SourceLineageRef;
    }
  | {
      facet: "SUBSPECIALTY_MATCH";
      subSpecialty: string;
      sourceLineageRef: SourceLineageRef;
    }
  | {
      facet: "SUBSPECIALTY_MISMATCH";
      required: string;
      providerHas: string[];
      sourceLineageRef: SourceLineageRef;
    }
  | {
      facet: "REGION_PREFERENCE";
      region: string;
      sourceLineageRef: SourceLineageRef;
    }
  | {
      facet: "RATE_WITHIN_BAND";
      band: string;
      jobPay: string | null;
      sourceLineageRef: SourceLineageRef;
    }
  | {
      facet: "IMLC_SHORTCUT";
      state: string;
      sourceLineageRef: SourceLineageRef;
    }
  | {
      facet: "TEMP_PRIVILEGES_PATH";
      days: number;
      sourceLineageRef: SourceLineageRef;
    }
  | {
      facet: "BOARD_CERT_PRESENT";
      board: string;
      sourceLineageRef: SourceLineageRef;
    };

/** Public reason — facet + rendered human prose + lineage pointer. */
export interface Reason {
  facet: ReasonFacet;
  humanPhrasing: string;
  sourceLineageRef: SourceLineageRef;
}

/**
 * Stable key for a facet, used by the learn worker to index weights in
 * `signal_weights.facet_key`. Keeping this separate from the TS tag
 * lets us version or namespace the learned weights without perturbing
 * the facet union.
 */
export function facetKey(facet: ReasonFacet): string {
  return facet.facet;
}

/**
 * Render a reason's prose from its structured facet. Pure function —
 * the same facet always produces the same string. New facets fall
 * through to a boring fallback so a half-shipped facet never crashes
 * the ranker.
 */
export function renderFacet(facet: ReasonFacet): string {
  switch (facet.facet) {
    case "LICENSE_IN_STATE":
      return `Active ${facet.state} license on file`;
    case "DEA_ACTIVE":
      return "Active DEA registration on file";
    case "STATE_CSR_ACTIVE":
      return `Active ${facet.state} controlled-substance registration on file`;
    case "AVAILABLE_BY_NEED_DATE":
      return `Available by need date (${facet.earliestStartDate} ≤ ${facet.needDate})`;
    case "BLOCKED_ON_CREDENTIAL":
      return `Blocked on ${facet.credential} (ready ${facet.readyDate})`;
    case "SUBSPECIALTY_MATCH":
      return `Sub-specialty match: ${facet.subSpecialty}`;
    case "SUBSPECIALTY_MISMATCH":
      return `Sub-specialty mismatch: required ${facet.required}, provider has ${
        facet.providerHas.length > 0 ? facet.providerHas.join(", ") : "none listed"
      }`;
    case "REGION_PREFERENCE":
      return `Region preference match: ${facet.region}`;
    case "RATE_WITHIN_BAND":
      return `Rate within band (${facet.band}${facet.jobPay !== null ? `, job pays ${facet.jobPay}` : ""})`;
    case "IMLC_SHORTCUT":
      return `IMLC compact shortcut available for ${facet.state}`;
    case "TEMP_PRIVILEGES_PATH":
      return `Temporary privileges path available (~${facet.days}d)`;
    case "BOARD_CERT_PRESENT":
      return `Board certified (${facet.board})`;
  }
}

/** Build a Reason from a facet. Caller passes the lineage ref inline on the facet. */
export function makeReason(facet: ReasonFacet): Reason {
  return {
    facet,
    humanPhrasing: renderFacet(facet),
    sourceLineageRef: facet.sourceLineageRef,
  };
}

/**
 * Convert a Reason into the on-disk shape stored in
 * `signal_rankings.entries[].reasons[]`. This is the boundary between
 * the typed reason object and the JSON blob.
 */
export interface SerializedReason {
  code: string;
  source_lineage: { table: string; row_id: string };
  facet: ReasonFacet;
  human_phrasing: string;
}

export function serializeReason(r: Reason): SerializedReason {
  return {
    code: r.facet.facet,
    source_lineage: {
      table: r.sourceLineageRef.canonicalTable,
      row_id: r.sourceLineageRef.canonicalId,
    },
    facet: r.facet,
    human_phrasing: r.humanPhrasing,
  };
}

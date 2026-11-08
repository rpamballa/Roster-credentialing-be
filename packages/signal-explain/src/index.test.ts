import { describe, expect, it } from "vitest";
import { type ReasonFacet, facetKey, makeReason, renderFacet, serializeReason } from "./index.js";

describe("signal-explain · facet renderer", () => {
  const lineage = {
    canonicalTable: "signal_providers",
    canonicalId: "11111111-1111-1111-1111-111111111111",
  };

  it("renders every facet to a non-empty human phrase (deterministic)", () => {
    const facets: ReasonFacet[] = [
      { facet: "LICENSE_IN_STATE", state: "CA", sourceLineageRef: lineage },
      { facet: "DEA_ACTIVE", sourceLineageRef: lineage },
      { facet: "STATE_CSR_ACTIVE", state: "NY", sourceLineageRef: lineage },
      {
        facet: "AVAILABLE_BY_NEED_DATE",
        earliestStartDate: "2026-01-01",
        needDate: "2026-02-01",
        sourceLineageRef: lineage,
      },
      {
        facet: "BLOCKED_ON_CREDENTIAL",
        credential: "state_license",
        readyDate: "2026-03-15",
        sourceLineageRef: lineage,
      },
      { facet: "SUBSPECIALTY_MATCH", subSpecialty: "cardiac", sourceLineageRef: lineage },
      {
        facet: "SUBSPECIALTY_MISMATCH",
        required: "ob",
        providerHas: ["pain"],
        sourceLineageRef: lineage,
      },
      { facet: "REGION_PREFERENCE", region: "NE", sourceLineageRef: lineage },
      { facet: "RATE_WITHIN_BAND", band: "A", jobPay: "1800.00", sourceLineageRef: lineage },
      { facet: "IMLC_SHORTCUT", state: "IL", sourceLineageRef: lineage },
      { facet: "TEMP_PRIVILEGES_PATH", days: 14, sourceLineageRef: lineage },
      { facet: "BOARD_CERT_PRESENT", board: "ABA", sourceLineageRef: lineage },
    ];
    for (const f of facets) {
      const out = renderFacet(f);
      expect(out, `empty render for ${f.facet}`).toBeTruthy();
      expect(renderFacet(f)).toBe(out);
    }
  });

  it("facetKey mirrors the discriminator tag — the ranker's weight key", () => {
    const f: ReasonFacet = { facet: "DEA_ACTIVE", sourceLineageRef: lineage };
    expect(facetKey(f)).toBe("DEA_ACTIVE");
  });

  it("makeReason / serializeReason round-trip preserves lineage pointer", () => {
    const facet: ReasonFacet = {
      facet: "SUBSPECIALTY_MATCH",
      subSpecialty: "cardiac",
      sourceLineageRef: lineage,
    };
    const r = makeReason(facet);
    const serialized = serializeReason(r);
    expect(serialized.code).toBe("SUBSPECIALTY_MATCH");
    expect(serialized.source_lineage).toEqual({
      table: lineage.canonicalTable,
      row_id: lineage.canonicalId,
    });
    expect(serialized.human_phrasing).toBe(r.humanPhrasing);
  });
});

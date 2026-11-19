import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/chunk.js";

describe("chunkMarkdown", () => {
  it("emits one chunk for a short document", () => {
    const chunks = chunkMarkdown("# Hello\n\nThis is a short playbook.", {
      maxTokens: 512,
      overlap: 50,
    });
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("short playbook");
  });

  it("splits long documents under the token cap", () => {
    // Build ~2000 words of filler across two sections.
    const section = (title: string) =>
      `# ${title}\n\n${Array.from({ length: 50 }, (_, i) => `paragraph ${i} ${Array.from({ length: 20 }, (_, j) => `word${j}`).join(" ")}`).join("\n\n")}`;
    const doc = `${section("A")}\n\n${section("B")}`;
    const chunks = chunkMarkdown(doc, { maxTokens: 200, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(2);
    // No chunk is wildly oversized — the estimator is approximate so
    // we allow a small overshoot.
    for (const c of chunks) {
      const words = c.split(/\s+/).filter(Boolean).length;
      // 200 tokens / 1.3 ≈ 154 words; +20% slack
      expect(words).toBeLessThan(200);
    }
  });

  it("produces overlap between adjacent chunks", () => {
    const paras = Array.from({ length: 10 }, (_, i) =>
      `para ${i} ${Array.from({ length: 30 }, (_, j) => `w${i}_${j}`).join(" ")}`,
    );
    const chunks = chunkMarkdown(paras.join("\n\n"), { maxTokens: 50, overlap: 15 });
    expect(chunks.length).toBeGreaterThan(1);
    // The tail of chunk N should share at least one token with
    // the head of chunk N+1.
    const tokensOf = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
    for (let i = 1; i < chunks.length; i++) {
      const tail = new Set(Array.from(tokensOf(chunks[i - 1]!)).slice(-30));
      const head = new Set(Array.from(tokensOf(chunks[i]!)).slice(0, 30));
      const overlap = Array.from(tail).filter((t) => head.has(t));
      expect(overlap.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic", () => {
    const doc =
      "# Playbook\n\nWhen a provider cancels, call the facility within 30 minutes.\n\n## Anesthesia\n\nPrefer locums with CRNA plus ACLS.";
    const a = chunkMarkdown(doc);
    const b = chunkMarkdown(doc);
    expect(a).toEqual(b);
  });

  it("handles empty input", () => {
    expect(chunkMarkdown("")).toEqual([]);
    expect(chunkMarkdown("   \n\n  ")).toEqual([]);
  });
});

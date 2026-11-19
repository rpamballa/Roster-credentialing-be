import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, embedChunks, embedQuery, embedText } from "../src/embedding.js";

describe("embedding", () => {
  it("produces vectors of the configured dimension", () => {
    const v = embedText("hello world");
    expect(v.length).toBe(EMBEDDING_DIM);
    expect(v.length).toBe(1536);
  });

  it("is deterministic", () => {
    expect(embedText("same input")).toEqual(embedText("same input"));
  });

  it("is L2-normalized", () => {
    const v = embedText("the quick brown fox jumps over the lazy dog");
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it("different text produces different vectors", () => {
    const a = embedText("anesthesia playbook for weekend coverage");
    const b = embedText("ortho surgery long-term placement");
    // Not identical.
    expect(a).not.toEqual(b);
  });

  it("embedChunks returns one vector per chunk, same dimension", async () => {
    const out = await embedChunks(["one", "two", "three"]);
    expect(out.length).toBe(3);
    for (const v of out) expect(v.length).toBe(EMBEDDING_DIM);
  });

  it("embedQuery is callable and shaped like a chunk embedding", async () => {
    const v = await embedQuery("where is the policy on weekend coverage?");
    expect(v.length).toBe(EMBEDDING_DIM);
  });

  it("handles empty text without producing a zero vector", () => {
    const v = embedText("");
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeGreaterThan(0);
  });
});

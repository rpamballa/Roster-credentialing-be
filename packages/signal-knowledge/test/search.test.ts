import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-session-secret-1234567890";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://cred:cred@localhost:5432/cred_test";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL);

const { db, schema, closeDb } = await import("@cred/db");
const { withWorkspace } = await import("@cred/db/signal");
const { embedChunks, chunkMarkdown, searchKnowledge } = await import("../src/index.js");

interface Seeded {
  workspaceId: string;
}

async function seedWorkspace(slug: string, docs: Array<{ title: string; body: string }>): Promise<Seeded> {
  const [ws] = await db()
    .insert(schema.workspaces)
    .values({ name: `WS ${slug}`, slug, type: "agency", signalEnabled: true })
    .returning({ id: schema.workspaces.id });
  const workspaceId = ws!.id;
  const scoped = withWorkspace(workspaceId);

  for (const doc of docs) {
    const [created] = await db()
      .insert(schema.signalKnowledgeDocuments)
      .values({ workspaceId, title: doc.title, bodyMarkdown: doc.body })
      .returning({ id: schema.signalKnowledgeDocuments.id });
    const chunks = chunkMarkdown(doc.body, { maxTokens: 200, overlap: 20 });
    const embeddings = await embedChunks(chunks);
    await scoped.knowledgeChunks.insertMany(
      chunks.map((text, i) => ({
        documentId: created!.id,
        chunkIndex: i,
        chunkText: text,
        embedding: embeddings[i]!,
      })),
    );
  }
  return { workspaceId };
}

beforeAll(async () => {
  await truncateAll(process.env.DATABASE_URL!);
});

beforeEach(async () => {
  await truncateAll(process.env.DATABASE_URL!);
});

afterAll(async () => {
  await closeDb();
});

describe("searchKnowledge — workspace isolation", () => {
  it("never returns another workspace's chunks, even with identical content", async () => {
    const body = `# Anesthesia playbook
When a cardiac anesthesia case is placed, confirm ACLS currency and verify MA state license status within 24 hours.
If CRNA is covering, the staff anesthesiologist must be on site.`;

    const a = await seedWorkspace("isolation-a", [{ title: "A-shared-doc", body }]);
    const b = await seedWorkspace("isolation-b", [{ title: "B-shared-doc", body }]);

    const hitsA = await searchKnowledge({
      workspaceId: a.workspaceId,
      query: "anesthesia playbook",
      limit: 10,
    });
    expect(hitsA.length).toBeGreaterThan(0);
    for (const hit of hitsA) {
      expect(hit.documentTitle).toBe("A-shared-doc");
    }

    const hitsB = await searchKnowledge({
      workspaceId: b.workspaceId,
      query: "anesthesia playbook",
      limit: 10,
    });
    expect(hitsB.length).toBeGreaterThan(0);
    for (const hit of hitsB) {
      expect(hit.documentTitle).toBe("B-shared-doc");
    }
  });

  it("returns chunks ordered by distance ascending, score descending", async () => {
    const { workspaceId } = await seedWorkspace("rank-a", [
      {
        title: "weekend-coverage",
        body:
          "# Weekend coverage\n\nCall list priority: anesthesia, ortho, cardio.\n\n## Anesthesia\n\nCRNA plus ACLS currency, prefer MA/NH/VT.",
      },
      {
        title: "unrelated",
        body: "# Office hours\n\nClose at 5pm every weekday. Open Saturdays 9am-noon.",
      },
    ]);
    const hits = await searchKnowledge({
      workspaceId,
      query: "weekend anesthesia coverage",
      limit: 5,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.distance).toBeGreaterThanOrEqual(hits[i - 1]!.distance);
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score);
    }
    // Top hit should be the weekend-coverage doc, not the unrelated office-hours one.
    expect(hits[0]!.documentTitle).toBe("weekend-coverage");
  });

  it("excludes soft-deleted documents' chunks", async () => {
    const { workspaceId } = await seedWorkspace("softdel-a", [
      { title: "will-delete", body: "# Playbook\n\nunique_marker_xyzzy policy content here." },
    ]);
    const scoped = withWorkspace(workspaceId);
    const [doc] = await scoped.knowledgeDocuments.list();
    expect(doc).toBeDefined();
    await scoped.knowledgeDocuments.softDelete(doc!.id);

    const hits = await searchKnowledge({ workspaceId, query: "unique_marker_xyzzy", limit: 5 });
    expect(hits).toEqual([]);
  });

  it("refuses an invalid workspaceId", async () => {
    await expect(
      searchKnowledge({ workspaceId: "not-a-uuid", query: "x" }),
    ).rejects.toThrow();
  });
});

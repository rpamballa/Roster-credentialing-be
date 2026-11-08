// Smoke tests the CLI's glue — arg parsing, the placeholder-label
// refusal gate, and the threshold gate exit-code wiring. We call the
// CLI as a subprocess so the test exercises the exit-code contract
// that CI relies on.
//
// The run itself still hits a real Postgres through @cred/db — same
// serial-execution rule applies.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const { ensureSchema, truncateAll } = await import("./setup.js");
await ensureSchema(process.env.DATABASE_URL ?? "");

const { closeDb, db } = await import("@cred/db");
const { workspaces } = await import("@cred/db/schema");

const FIXTURE_PATH = new URL("../fixtures/known-reqs-v0.json", import.meta.url).pathname;
const CLI_PATH = new URL("../bin/signal-eval.ts", import.meta.url).pathname;

async function seedWorkspace(slug: string): Promise<string> {
  const [row] = await db()
    .insert(workspaces)
    .values({ type: "agency", name: slug, slug: `${slug}-${randomUUID().slice(0, 6)}` })
    .returning({ id: workspaces.id });
  if (!row) throw new Error("workspace insert failed");
  return row.id;
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("pnpm", ["exec", "tsx", CLI_PATH, ...args], {
    env: process.env,
    encoding: "utf8",
    cwd: new URL("../", import.meta.url).pathname,
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("signal-eval CLI", () => {
  beforeAll(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  beforeEach(async () => {
    await truncateAll(process.env.DATABASE_URL ?? "");
  });
  afterAll(async () => {
    await closeDb();
  });

  it("exits 0 when precision meets the threshold", async () => {
    const workspaceId = await seedWorkspace("eval");
    await closeDb(); // release pool so subprocess owns Postgres connections
    const r = runCli([
      "--workspace",
      workspaceId,
      "--fixture",
      FIXTURE_PATH,
      "--k",
      "3",
      "--threshold",
      "0.1",
    ]);
    expect(r.status, `stdout:${r.stdout}\nstderr:${r.stderr}`).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report.gate.pass).toBe(true);
    expect(report.gate.thresholdPass).toBe(true);
    // placeholder warning
    expect(r.stderr).toMatch(/ENGINEERING-PLACEHOLDER/);
  });

  it("exits 1 when precision falls below the threshold", async () => {
    const workspaceId = await seedWorkspace("eval");
    await closeDb();
    const r = runCli([
      "--workspace",
      workspaceId,
      "--fixture",
      FIXTURE_PATH,
      "--k",
      "3",
      "--threshold",
      "0.99",
    ]);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.stdout.trim());
    expect(report.gate.pass).toBe(false);
    expect(report.gate.thresholdPass).toBe(false);
  });

  it("exits 1 when --require-consultant-labels is set against the placeholder fixture", async () => {
    const workspaceId = await seedWorkspace("eval");
    await closeDb();
    const r = runCli([
      "--workspace",
      workspaceId,
      "--fixture",
      FIXTURE_PATH,
      "--k",
      "3",
      "--threshold",
      "0.1",
      "--require-consultant-labels",
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/placeholder-engineering-judgment/);
  });

  it("exits 2 on invalid args", async () => {
    const r = runCli(["--workspace", ""]);
    expect(r.status).toBe(2);
  });
});

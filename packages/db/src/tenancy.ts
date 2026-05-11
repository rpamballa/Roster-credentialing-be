import { sql } from "drizzle-orm";
import { db } from "./client.js";

export interface TenancyContext {
  workspaceId: string;
  userId: string | null;
}

// Drizzle's transaction callback receives a tx scoped to the session that ran
// `SET LOCAL`. We expose it as `Tx` so callers can use it like the base db.
export type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`Tenancy: ${label} is not a valid UUID`);
  }
}

/**
 * Run `fn` in a transaction whose session variables drive row-level security.
 * This is the only sanctioned path for tenant-scoped queries (PROMPT §4.1).
 * Raw SQL that skips this must include `// rls: bypass — <reason>`.
 */
export async function withTenancy<T>(ctx: TenancyContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertUuid(ctx.workspaceId, "workspaceId");
  if (ctx.userId !== null) assertUuid(ctx.userId, "userId");

  return db().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_workspace_id', ${ctx.workspaceId}, true)`);
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${ctx.userId ?? ""}, true)`);
    return fn(tx as Tx);
  });
}

/** Read back the tenancy session variables — primarily for assertions in tests. */
export async function currentSettings(tx: Tx): Promise<{
  workspaceId: string | null;
  userId: string | null;
}> {
  const result = await tx.execute(
    sql`SELECT
          NULLIF(current_setting('app.current_workspace_id', true), '') AS workspace_id,
          NULLIF(current_setting('app.current_user_id', true), '') AS user_id`,
  );
  const row = (
    result as unknown as Array<{ workspace_id: string | null; user_id: string | null }>
  )[0];
  return {
    workspaceId: row?.workspace_id ?? null,
    userId: row?.user_id ?? null,
  };
}

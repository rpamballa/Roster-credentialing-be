import { db } from "@cred/db";
import { sql } from "drizzle-orm";

export interface QueueMessage<T> {
  msgId: number;
  readCt: number;
  enqueuedAt: Date;
  vt: Date;
  message: T;
}

// Thin wrapper over the `pgmq` Postgres extension (SPEC §2). Workflows are
// driven by Temporal; pgmq is the small in-cluster queue used for things like
// upload events, extraction retries, and outbox dispatch.

export async function ensureQueue(name: string): Promise<void> {
  // rls: bypass — pgmq is admin DDL, not tenant data.
  await db().execute(sql`SELECT pgmq.create(${name})`);
}

export async function send<T>(queue: string, payload: T): Promise<number> {
  // rls: bypass — queue rows are not tenant tables.
  const rows = await db().execute<{ send: number }>(
    sql`SELECT pgmq.send(${queue}, ${JSON.stringify(payload)}::jsonb) AS send`,
  );
  if (!rows[0]) throw new Error("pgmq.send returned no rows");
  return rows[0].send;
}

export async function read<T>(queue: string, vtSeconds = 30): Promise<QueueMessage<T> | null> {
  // rls: bypass — see above.
  const rows = await db().execute<{
    msg_id: number;
    read_ct: number;
    enqueued_at: Date;
    vt: Date;
    message: T;
  }>(sql`SELECT * FROM pgmq.read(${queue}, ${vtSeconds}, 1)`);
  const row = rows[0];
  if (!row) return null;
  return {
    msgId: row.msg_id,
    readCt: row.read_ct,
    enqueuedAt: row.enqueued_at,
    vt: row.vt,
    message: row.message,
  };
}

export async function deleteMessage(queue: string, msgId: number): Promise<void> {
  // rls: bypass — see above.
  await db().execute(sql`SELECT pgmq.delete(${queue}, ${msgId}::bigint)`);
}

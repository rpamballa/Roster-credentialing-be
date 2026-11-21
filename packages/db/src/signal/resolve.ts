import { and, eq, sql } from "drizzle-orm";
import { db } from "../client.js";
import { type SignalProviderRow, signalProviders } from "../schema/signal/providers.js";
import type { SignalExecutor } from "./lineage.js";

export interface ResolveProviderArgs {
  workspaceId: string;
  name: string;
  phone?: string;
  email?: string;
  npi?: string;
}

export interface ResolveProviderResult {
  providerId: string;
  /** True when this call created a new row; false if we reused one. */
  created: boolean;
  /**
   * Populated when the matched row carries a non-empty `merged_from`
   * — tells the caller the id they got back previously absorbed
   * another record. Useful for audit trails.
   */
  mergedInto?: string;
}

/**
 * Entity resolution v0 for Signal providers.
 *
 * Deliberately conservative: we only auto-reuse an existing row
 * when we have a high-confidence identifier match. "Near-name
 * only" is NOT a match — two providers with the same name and no
 * other identifier stay separate until an operator merges them.
 *
 * Match hierarchy (first non-empty wins):
 *   1. NPI (within the workspace) — strongest identifier.
 *   2. Email (case-insensitive, within the workspace).
 *   3. Phone (normalized to digits-only, within the workspace).
 *
 * If none of those matches, we INSERT a new row — even if an
 * existing row has the same name. The product rule is "prefer
 * false negatives over false positives" because a bad merge is
 * expensive to unwind and shows up in the ranker's reasons.
 *
 * Returns `{ providerId, created, mergedInto? }`. All writes
 * happen on the passed executor (transaction or root db).
 */
export async function resolveProvider(
  args: ResolveProviderArgs,
  executor: SignalExecutor = db(),
): Promise<ResolveProviderResult> {
  const { workspaceId, name, phone, email, npi } = args;

  const normalizedEmail = email ? email.trim().toLowerCase() : undefined;
  const normalizedPhone = phone ? phone.replace(/\D+/g, "") : undefined;
  const normalizedNpi = npi ? npi.trim() : undefined;

  // 1. NPI — strongest signal.
  if (normalizedNpi) {
    const existing = await findOne(
      executor,
      and(eq(signalProviders.workspaceId, workspaceId), eq(signalProviders.npi, normalizedNpi)),
    );
    if (existing) return toReuseResult(existing);
  }

  // 2. Email — case-insensitive.
  if (normalizedEmail) {
    const existing = await findOne(
      executor,
      and(
        eq(signalProviders.workspaceId, workspaceId),
        sql`lower(${signalProviders.email}) = ${normalizedEmail}`,
      ),
    );
    if (existing) return toReuseResult(existing);
  }

  // 3. Phone — digits-only compare, so "(617) 555-0199" ==
  //    "+1-617-555-0199".
  if (normalizedPhone) {
    const existing = await findOne(
      executor,
      and(
        eq(signalProviders.workspaceId, workspaceId),
        sql`regexp_replace(coalesce(${signalProviders.phone}, ''), '\\D', '', 'g') = ${normalizedPhone}`,
      ),
    );
    if (existing) return toReuseResult(existing);
  }

  // No match — create. We intentionally do NOT look at the name
  // alone: two anesthesiologists named "John Smith" are not the
  // same person and the ranker would surface both separately.
  const inserted = await executor
    .insert(signalProviders)
    .values({
      workspaceId,
      name,
      ...(normalizedNpi !== undefined ? { npi: normalizedNpi } : {}),
      ...(normalizedEmail !== undefined ? { email: normalizedEmail } : {}),
      ...(normalizedPhone !== undefined ? { phone: normalizedPhone } : {}),
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("resolveProvider: insert returned no row");
  return { providerId: row.id, created: true };
}

async function findOne(
  executor: SignalExecutor,
  predicate: ReturnType<typeof and>,
): Promise<SignalProviderRow | undefined> {
  const rows = await executor.select().from(signalProviders).where(predicate).limit(1);
  return rows[0];
}

function toReuseResult(row: SignalProviderRow): ResolveProviderResult {
  const base: ResolveProviderResult = { providerId: row.id, created: false };
  if (row.mergedFrom.length > 0) {
    // The surviving row is this row; whoever asked for the merged
    // row previously gets redirected here.
    return { ...base, mergedInto: row.id };
  }
  return base;
}

// ───────────────────────────────────────────────────────────────────────
// Explicit merge — a human-initiated operation (not part of resolve).
// Kept here so the merge format and the ER reader are in the same file.
// ───────────────────────────────────────────────────────────────────────

export interface MergeProvidersArgs {
  workspaceId: string;
  survivingId: string;
  mergedId: string;
}

export interface MergeProvidersResult {
  providerId: string;
  /** JSON-encoded snapshot that was appended to `merged_from`. */
  snapshot: string;
}

/**
 * Merge `mergedId` INTO `survivingId`, preserving enough
 * information on the survivor to reverse the merge.
 *
 * The old provider's row is serialized as JSON and appended to
 * `survivingId.merged_from`, then the old row is deleted. Use
 * `unmergeLastProvider` to recreate it.
 *
 * Both providers must live in the same workspace.
 */
export async function mergeProviders(
  args: MergeProvidersArgs,
  executor: SignalExecutor = db(),
): Promise<MergeProvidersResult> {
  const { workspaceId, survivingId, mergedId } = args;
  if (survivingId === mergedId) {
    throw new Error("mergeProviders: survivingId and mergedId are the same row");
  }

  const [surviving, merged] = await Promise.all([
    executor
      .select()
      .from(signalProviders)
      .where(and(eq(signalProviders.workspaceId, workspaceId), eq(signalProviders.id, survivingId)))
      .limit(1),
    executor
      .select()
      .from(signalProviders)
      .where(and(eq(signalProviders.workspaceId, workspaceId), eq(signalProviders.id, mergedId)))
      .limit(1),
  ]);

  const survivingRow = surviving[0];
  const mergedRow = merged[0];
  if (!survivingRow) throw new Error(`mergeProviders: surviving ${survivingId} not found`);
  if (!mergedRow) throw new Error(`mergeProviders: merged ${mergedId} not found`);

  const snapshot = JSON.stringify(serializeProvider(mergedRow));

  await executor
    .update(signalProviders)
    .set({
      mergedFrom: [...survivingRow.mergedFrom, snapshot],
      updatedAt: sql`now()`,
    })
    .where(and(eq(signalProviders.workspaceId, workspaceId), eq(signalProviders.id, survivingId)));

  await executor
    .delete(signalProviders)
    .where(and(eq(signalProviders.workspaceId, workspaceId), eq(signalProviders.id, mergedId)));

  return { providerId: survivingId, snapshot };
}

export interface UnmergeResult {
  /** Id of the row that was restored. Matches the original pre-merge id. */
  restoredId: string;
}

/**
 * Reverse the most recent merge against `survivingId`: pop the
 * last entry off `merged_from`, re-insert it, and persist the
 * trimmed array back to the survivor.
 *
 * Throws if `survivingId.merged_from` is empty.
 */
export async function unmergeLastProvider(
  args: { workspaceId: string; survivingId: string },
  executor: SignalExecutor = db(),
): Promise<UnmergeResult> {
  const { workspaceId, survivingId } = args;
  const rows = await executor
    .select()
    .from(signalProviders)
    .where(and(eq(signalProviders.workspaceId, workspaceId), eq(signalProviders.id, survivingId)))
    .limit(1);

  const surviving = rows[0];
  if (!surviving) throw new Error(`unmergeLastProvider: ${survivingId} not found`);
  const { mergedFrom } = surviving;
  const last = mergedFrom[mergedFrom.length - 1];
  if (last === undefined) {
    throw new Error(`unmergeLastProvider: ${survivingId} has no merge history to unwind`);
  }

  const snapshot = deserializeProvider(last);

  // Insert the recreated row. We preserve the original id so
  // external references (lineage rows, conversation pointers)
  // keep pointing at the same uuid they did before the merge.
  await executor.insert(signalProviders).values({
    id: snapshot.id,
    workspaceId: snapshot.workspaceId,
    npi: snapshot.npi,
    name: snapshot.name,
    email: snapshot.email,
    phone: snapshot.phone,
    specialties: snapshot.specialties,
    regionPrefs: snapshot.regionPrefs,
    rateBand: snapshot.rateBand,
    availabilityHint: snapshot.availabilityHint,
    mergedFrom: snapshot.mergedFrom,
    createdAt: snapshot.createdAt,
  });

  await executor
    .update(signalProviders)
    .set({
      mergedFrom: mergedFrom.slice(0, -1),
      updatedAt: sql`now()`,
    })
    .where(and(eq(signalProviders.workspaceId, workspaceId), eq(signalProviders.id, survivingId)));

  return { restoredId: snapshot.id };
}

// ─── JSON (de)serializers for merge snapshots ───────────────────────────
//
// We store a snapshot per entry of `merged_from` rather than just
// the id so an unmerge can succeed even if we later garbage-
// collect merge history outside the surviving row. Dates are
// stored as ISO strings; the deserializer parses them back.
interface SerializedProvider {
  id: string;
  workspaceId: string;
  npi: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  specialties: string[];
  regionPrefs: string[];
  rateBand: string | null;
  availabilityHint: Record<string, unknown> | null;
  mergedFrom: string[];
  createdAt: Date;
}

function serializeProvider(row: SignalProviderRow): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    npi: row.npi,
    name: row.name,
    email: row.email,
    phone: row.phone,
    specialties: row.specialties,
    regionPrefs: row.regionPrefs,
    rateBand: row.rateBand,
    availabilityHint: row.availabilityHint,
    mergedFrom: row.mergedFrom,
    createdAt: row.createdAt.toISOString(),
  };
}

function deserializeProvider(json: string): SerializedProvider {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const createdAtRaw = parsed.createdAt;
  const createdAt = typeof createdAtRaw === "string" ? new Date(createdAtRaw) : new Date();
  return {
    id: String(parsed.id),
    workspaceId: String(parsed.workspaceId),
    npi: parsed.npi == null ? null : String(parsed.npi),
    name: String(parsed.name ?? ""),
    email: parsed.email == null ? null : String(parsed.email),
    phone: parsed.phone == null ? null : String(parsed.phone),
    specialties: Array.isArray(parsed.specialties) ? (parsed.specialties as string[]) : [],
    regionPrefs: Array.isArray(parsed.regionPrefs) ? (parsed.regionPrefs as string[]) : [],
    rateBand: parsed.rateBand == null ? null : String(parsed.rateBand),
    availabilityHint:
      parsed.availabilityHint == null ? null : (parsed.availabilityHint as Record<string, unknown>),
    mergedFrom: Array.isArray(parsed.mergedFrom) ? (parsed.mergedFrom as string[]) : [],
    createdAt,
  };
}

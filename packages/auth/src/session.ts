import { createHash, randomBytes } from "node:crypto";
import { env } from "@cred/config";
import { Redis } from "ioredis";

const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_KEY_PREFIX = "session:";

export interface StaffSessionPayload {
  kind: "staff";
  userId: string;
  email: string;
  activeWorkspaceId: string | null;
  createdAt: string;
}

export interface ProviderSessionPayload {
  kind: "provider";
  providerId: string;
  caseId: string;
  caseWorkspaceId: string;
  createdAt: string;
}

export type SessionPayload = StaffSessionPayload | ProviderSessionPayload;

let redis: Redis | undefined;

function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(env().REDIS_URL, { maxRetriesPerRequest: 3 });
  }
  return redis;
}

function hashSid(sid: string): string {
  return createHash("sha256").update(sid).digest("hex");
}

function key(sid: string): string {
  return `${SESSION_KEY_PREFIX}${hashSid(sid)}`;
}

export async function createSession(
  payload: Omit<StaffSessionPayload, "createdAt" | "kind">,
): Promise<string> {
  const full: StaffSessionPayload = {
    kind: "staff",
    ...payload,
    createdAt: new Date().toISOString(),
  };
  return persist(full);
}

export async function createProviderSession(
  payload: Omit<ProviderSessionPayload, "createdAt" | "kind">,
): Promise<string> {
  const full: ProviderSessionPayload = {
    kind: "provider",
    ...payload,
    createdAt: new Date().toISOString(),
  };
  return persist(full);
}

async function persist(full: SessionPayload): Promise<string> {
  const sid = randomBytes(32).toString("base64url");
  await getRedis().setex(key(sid), SESSION_TTL_SECONDS, JSON.stringify(full));
  return sid;
}

export async function readSession(sid: string): Promise<SessionPayload | null> {
  const raw = await getRedis().get(key(sid));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SessionPayload;
    // Older sessions (pre-M2) lack the `kind` discriminator. Treat as staff.
    if (!("kind" in parsed)) {
      return { ...(parsed as unknown as StaffSessionPayload), kind: "staff" };
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function updateSession(
  sid: string,
  patch: Partial<Omit<StaffSessionPayload, "createdAt" | "kind">>,
): Promise<SessionPayload | null> {
  const cur = await readSession(sid);
  if (!cur || cur.kind !== "staff") return null;
  const next: StaffSessionPayload = { ...cur, ...patch };
  await getRedis().setex(key(sid), SESSION_TTL_SECONDS, JSON.stringify(next));
  return next;
}

export async function destroySession(sid: string): Promise<void> {
  await getRedis().del(key(sid));
}

export async function closeSessionStore(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = undefined;
  }
}

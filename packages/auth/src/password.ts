import * as argon2 from "argon2";
import { z } from "zod";

/**
 * Argon2id parameters — libargon2 defaults with a modest memory bump.
 *
 * memoryCost: 2^16 KiB = 64 MiB. High enough to slow GPU attacks, low
 * enough to hash in <200ms on the api container's e2-standard-2.
 * timeCost: 3 (iterations). parallelism: 1 (matches libsodium default).
 *
 * These are baked into the hash string that argon2.verify() reads, so
 * we can bump them later without needing to rehash old passwords — new
 * hashes use the new params, old ones stay verifiable.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id as 2,
  memoryCost: 2 ** 16,
  timeCost: 3,
  parallelism: 1,
  raw: false as const,
};

/**
 * Password policy — shared with the FE via the zod schema below so
 * client-side validation and server-side validation stay in lockstep.
 *
 * Rules:
 *   • ≥ 12 characters
 *   • ≥ 1 uppercase letter
 *   • ≥ 1 lowercase letter
 *   • ≥ 1 digit
 *   • ≥ 1 special character (printable ASCII punctuation)
 *   • ≤ 128 characters (argon2 handles longer, but bounding limits DoS)
 */
const SPECIAL_CHARS = /[!@#$%^&*()_+\-=\[\]{};:"'<>,.?/|\\`~]/;

export const passwordSchema = z
  .string()
  .min(12, { message: "Password must be at least 12 characters." })
  .max(128, { message: "Password must be 128 characters or fewer." })
  .refine((v) => /[A-Z]/.test(v), {
    message: "Password must include at least one uppercase letter.",
  })
  .refine((v) => /[a-z]/.test(v), {
    message: "Password must include at least one lowercase letter.",
  })
  .refine((v) => /[0-9]/.test(v), {
    message: "Password must include at least one number.",
  })
  .refine((v) => SPECIAL_CHARS.test(v), {
    message: "Password must include at least one special character (e.g. ! @ # $).",
  });

/**
 * Hash a plaintext password with Argon2id. Rejects if the password
 * fails the policy — never store a hash of a policy-invalid password,
 * because that means the FE and BE fell out of sync and something
 * upstream is broken.
 */
export async function hashPassword(plain: string): Promise<string> {
  passwordSchema.parse(plain);
  const hash = await argon2.hash(plain, ARGON2_OPTIONS);
  return hash as string;
}

/**
 * Verify a plaintext password against a stored Argon2id hash. Returns
 * false on any hash-parse or mismatch, and never leaks which failed —
 * the caller (login endpoint) returns a single "incorrect email or
 * password" for both "user not found" and "password wrong" so account
 * enumeration is blocked.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Reports whether the stored hash was produced with older parameters
 * than ARGON2_OPTIONS. Callers can opportunistically re-hash on login
 * to lift old users onto current params (later, not in this PR).
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    return true;
  }
}

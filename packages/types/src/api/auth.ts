import { z } from "zod";
import type { MembershipRole } from "../domain/enums.js";

export const MagicLinkRequestSchema = z.object({
  email: z.string().email().toLowerCase(),
  redirectPath: z.string().startsWith("/").optional(),
});
export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;

export const MagicLinkVerifySchema = z.object({
  token: z.string().min(32).max(256),
});
export type MagicLinkVerify = z.infer<typeof MagicLinkVerifySchema>;

export interface MeResponse {
  userId: string;
  email: string;
  name: string | null;
  memberships: Array<{
    workspaceId: string;
    workspaceSlug: string;
    workspaceName: string;
    role: MembershipRole;
  }>;
  /**
   * Populated when this user represents a provider (providers.user_id
   * points at this row). Null for staff-only users. Consumers use it
   * to route between the cockpit (staff) and the provider portal.
   */
  providerId: string | null;
}

import type { MembershipRole } from "../domain/enums.js";

// Magic-link request/verify schemas were removed in 2026-11. The flow
// stranded users (upserted users row without a providers row); password
// auth is now the only user-facing credential flow.

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

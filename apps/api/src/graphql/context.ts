import type { TenancyContext } from "@cred/db";
import type { Context } from "hono";
import type { ApiBindings } from "../types.js";

export interface GqlContext {
  tenancy: TenancyContext;
  requestId: string;
  honoCtx: Context<ApiBindings>;
}

import type { SessionPayload } from "@cred/auth";

export interface AuthContext {
  sid: string;
  session: SessionPayload;
}

export interface ApiBindings {
  Variables: {
    requestId: string;
    auth?: AuthContext;
  };
}

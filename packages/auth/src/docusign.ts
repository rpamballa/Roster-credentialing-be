import { createPrivateKey, createSign } from "node:crypto";
import { env } from "@cred/config";
import { logger } from "@cred/observability/logger";

// Thin DocuSign client. We use the JWT consent flow (server-to-server) so
// the platform can request signatures without a user-mediated OAuth dance.
// In dev mode (no credentials configured) we return a synthetic envelope id
// so the rest of the platform can be exercised end-to-end.

const DOCUSIGN_BASE_URL = "https://demo.docusign.net/restapi/v2.1";

interface AccessToken {
  token: string;
  expiresAt: number;
}

let cached: AccessToken | undefined;

async function fetchAccessToken(): Promise<string | null> {
  const cfg = env();
  if (
    !cfg.DOCUSIGN_INTEGRATION_KEY ||
    !cfg.DOCUSIGN_USER_ID ||
    !cfg.DOCUSIGN_ACCOUNT_ID ||
    !cfg.DOCUSIGN_PRIVATE_KEY
  ) {
    return null;
  }
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: cfg.DOCUSIGN_INTEGRATION_KEY,
    sub: cfg.DOCUSIGN_USER_ID,
    aud: "account-d.docusign.com",
    iat: now,
    exp: now + 3600,
    scope: "signature impersonation",
  };

  const headerB64 = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payloadB64 = b64url(JSON.stringify(claims));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = createPrivateKey(cfg.DOCUSIGN_PRIVATE_KEY);
  const sig = createSign("RSA-SHA256").update(signingInput).sign(key);
  const jwt = `${signingInput}.${b64urlBuf(sig)}`;

  const resp = await fetch("https://account-d.docusign.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    logger.error({ status: resp.status, detail }, "docusign_token_failed");
    throw new Error("docusign token failed");
  }
  const json = (await resp.json()) as { access_token: string; expires_in: number };
  cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cached.token;
}

export interface CreateEnvelopeParams {
  attestationText: string;
  signerEmail: string;
  signerName: string;
  caseId: string;
  workspaceId: string;
}

export async function createAttestationEnvelope(
  params: CreateEnvelopeParams,
): Promise<{ envelopeId: string }> {
  const cfg = env();
  const token = await fetchAccessToken();
  if (!token) {
    // Dev mode: synthesize an envelope id so callers can keep moving.
    const envelopeId = `dev-${params.caseId}-${Date.now()}`;
    logger.info({ envelopeId }, "docusign_dev_envelope");
    return { envelopeId };
  }

  const body = {
    emailSubject: "Provider attestation required",
    documents: [
      {
        documentBase64: Buffer.from(params.attestationText).toString("base64"),
        name: "Attestation.txt",
        fileExtension: "txt",
        documentId: "1",
      },
    ],
    recipients: {
      signers: [
        {
          email: params.signerEmail,
          name: params.signerName,
          recipientId: "1",
          tabs: {
            signHereTabs: [{ documentId: "1", pageNumber: "1", xPosition: "50", yPosition: "200" }],
          },
        },
      ],
    },
    status: "sent",
  };

  const resp = await fetch(`${DOCUSIGN_BASE_URL}/accounts/${cfg.DOCUSIGN_ACCOUNT_ID}/envelopes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    logger.error({ status: resp.status, detail }, "docusign_envelope_failed");
    throw new Error("docusign envelope failed");
  }
  const json = (await resp.json()) as { envelopeId: string };
  return { envelopeId: json.envelopeId };
}

function b64url(s: string): string {
  return Buffer.from(s)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function b64urlBuf(b: Buffer): string {
  return b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

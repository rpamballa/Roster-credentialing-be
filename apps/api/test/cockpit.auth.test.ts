import { describe, expect, it } from "vitest";

process.env.NODE_ENV ??= "test";
process.env.SESSION_SECRET ??= "test-session-secret-1234567890";
process.env.DATABASE_URL ??= "postgres://cred:cred@localhost:5432/cred_test";
process.env.REDIS_URL ??= "redis://localhost:6379/1";
process.env.API_PUBLIC_URL ??= "http://localhost:3001";
process.env.WEB_PUBLIC_URL ??= "http://localhost:3000";

const { buildApp } = await import("../src/app.js");

const app = buildApp();

async function callJson(method: string, path: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.fetch(new Request(`http://localhost${path}`, init));
}

// Every cockpit endpoint hides behind requireStaffAuth + requireTenancy. With
// no session cookie the response must be a 401 RFC 7807 Problem Details body.
const PROTECTED_ENDPOINTS: Array<{ method: string; path: string; body?: unknown }> = [
  { method: "POST", path: "/v1/cockpit/cases/abc/nudge", body: { channel: "email" } },
  { method: "POST", path: "/v1/cockpit/cases/abc/mark-ready" },
  { method: "POST", path: "/v1/cockpit/cases/abc/submit", body: {} },
  {
    method: "POST",
    path: "/v1/cockpit/cases/abc/escalate",
    body: { reason: "other", details: "x" },
  },
  {
    method: "POST",
    path: "/v1/cockpit/cases/abc/request-reupload",
    body: { requirementKey: "k", reason: "r" },
  },
  { method: "POST", path: "/v1/cockpit/cases/abc/references/r/resend" },
  {
    method: "POST",
    path: "/v1/cockpit/bulk-nudge",
    body: { caseIds: ["1"], message: "x" },
  },
  { method: "GET", path: "/v1/cockpit/settings/outreach" },
  {
    method: "PUT",
    path: "/v1/cockpit/settings/outreach",
    body: {
      workspaceId: "00000000-0000-0000-0000-000000000000",
      cadences: [
        {
          audience: "provider",
          steps: [
            {
              key: "invite",
              label: "x",
              daysAfterPrior: 0,
              channel: "email",
              messageOverride: "",
              enabled: true,
              editable: true,
            },
          ],
        },
      ],
      pendingDeploy: false,
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    },
  },
  {
    method: "POST",
    path: "/v1/cockpit/facilities/ingest/sign-upload",
    body: { facilityName: "X", mimeType: "application/pdf", sizeBytes: 100 },
  },
  { method: "POST", path: "/v1/cockpit/facilities/ingest/job/uploaded" },
  { method: "GET", path: "/v1/cockpit/facilities/ingest/job" },
  { method: "POST", path: "/v1/cockpit/facilities/profile/approve" },
  {
    method: "POST",
    path: "/v1/cockpit/providers/p/documents/sign-upload",
    body: { documentType: "medical_license", mimeType: "application/pdf", sizeBytes: 100 },
  },
  { method: "POST", path: "/v1/cockpit/providers/p/documents/d/uploaded" },
];

describe("cockpit endpoints require staff auth + tenancy", () => {
  for (const ep of PROTECTED_ENDPOINTS) {
    it(`${ep.method} ${ep.path} -> 401 without session`, async () => {
      const res = await callJson(ep.method, ep.path, ep.body);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { title: string; status: number };
      expect(body.status).toBe(401);
      expect(body.title).toBe("Unauthorized");
    });
  }
});

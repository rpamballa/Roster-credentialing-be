import { db, schema } from "@cred/db";
import { audit } from "@cred/observability";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { requireWriterOnMutations } from "../middleware/rbac.js";
import { requireStaffAuth } from "../middleware/session.js";
import { requireTenancy } from "../middleware/tenancy.js";
import type { ApiBindings } from "../types.js";

// Cockpit outreach cadence settings. Stored as a JSON blob inside
// `workspaces.settings.outreach`. A future migration could promote this to
// its own table — until then a single JSON column keeps reads cheap.
export const cockpitOutreachRoutes = new Hono<ApiBindings>();

cockpitOutreachRoutes.use(
  "/v1/cockpit/*",
  requireStaffAuth,
  requireTenancy,
  requireWriterOnMutations,
);

const OutreachChannel = z.enum(["sms", "email", "sms_and_email"]);

const OutreachStep = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  daysAfterPrior: z.number().int().min(0).max(120),
  channel: OutreachChannel,
  messageOverride: z.string().max(2000),
  enabled: z.boolean(),
  editable: z.boolean(),
});

const OutreachCadence = z.object({
  audience: z.enum(["provider", "reference"]),
  steps: z.array(OutreachStep).min(1).max(20),
});

const OutreachSettingsBody = z.object({
  workspaceId: z.string().min(1),
  cadences: z.array(OutreachCadence).min(1).max(4),
  pendingDeploy: z.boolean(),
  updatedAt: z.string().min(1),
  updatedBy: z
    .object({ id: z.string().min(1), fullName: z.string().min(1) })
    .nullable(),
});

type OutreachSettings = z.infer<typeof OutreachSettingsBody>;

const DEFAULT_SETTINGS: Omit<OutreachSettings, "workspaceId" | "updatedAt" | "updatedBy"> = {
  pendingDeploy: false,
  cadences: [
    {
      audience: "provider",
      steps: [
        {
          key: "invite",
          label: "Initial invite",
          daysAfterPrior: 0,
          channel: "sms_and_email",
          messageOverride: "",
          enabled: true,
          editable: false,
        },
        {
          key: "reminder_1",
          label: "Soft SMS reminder",
          daysAfterPrior: 3,
          channel: "sms",
          messageOverride: "",
          enabled: true,
          editable: true,
        },
        {
          key: "reminder_2",
          label: "Email follow-up",
          daysAfterPrior: 4,
          channel: "email",
          messageOverride: "",
          enabled: true,
          editable: true,
        },
        {
          key: "specialist_alert",
          label: "Specialist alert",
          daysAfterPrior: 3,
          channel: "email",
          messageOverride: "",
          enabled: true,
          editable: false,
        },
      ],
    },
    {
      audience: "reference",
      steps: [
        {
          key: "invite",
          label: "Initial reference invite",
          daysAfterPrior: 0,
          channel: "email",
          messageOverride: "",
          enabled: true,
          editable: false,
        },
        {
          key: "reminder_1",
          label: "Email reminder",
          daysAfterPrior: 4,
          channel: "email",
          messageOverride: "",
          enabled: true,
          editable: true,
        },
        {
          key: "specialist_alert",
          label: "Specialist alert",
          daysAfterPrior: 5,
          channel: "email",
          messageOverride: "",
          enabled: true,
          editable: false,
        },
      ],
    },
  ],
};

interface SettingsWithOutreach {
  outreach?: OutreachSettings;
}

function readSettings(raw: unknown): OutreachSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const settings = raw as SettingsWithOutreach;
  if (!settings.outreach) return null;
  const parsed = OutreachSettingsBody.safeParse(settings.outreach);
  return parsed.success ? parsed.data : null;
}

cockpitOutreachRoutes.get("/v1/cockpit/settings/outreach", async (c) => {
  const workspaceId = c.var.tenancy.workspaceId;
  // rls: bypass — workspaces is a global table; we filter by the explicit
  // workspaceId from the validated session/tenancy context.
  const [row] = await db()
    .select({ settings: schema.workspaces.settings })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);

  const existing = row ? readSettings(row.settings) : null;
  const out: OutreachSettings = existing ?? {
    workspaceId,
    ...DEFAULT_SETTINGS,
    updatedAt: new Date().toISOString(),
    updatedBy: null,
  };
  return c.json(out);
});

cockpitOutreachRoutes.put(
  "/v1/cockpit/settings/outreach",
  zValidator("json", OutreachSettingsBody),
  async (c) => {
    const auth = c.var.staffAuth;
    const workspaceId = c.var.tenancy.workspaceId;
    const body = c.req.valid("json");

    // rls: bypass — same justification as the GET above.
    const [row] = await db()
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);

    const before = row ? readSettings(row.settings) : null;
    const next: OutreachSettings = {
      ...body,
      workspaceId,
      updatedAt: new Date().toISOString(),
      updatedBy: body.updatedBy ?? { id: auth.session.userId, fullName: "Specialist" },
    };

    const baseSettings =
      row?.settings && typeof row.settings === "object"
        ? (row.settings as Record<string, unknown>)
        : {};
    const nextSettings = { ...baseSettings, outreach: next };

    // rls: bypass — see above.
    await db()
      .update(schema.workspaces)
      .set({ settings: nextSettings as never })
      .where(eq(schema.workspaces.id, workspaceId));

    await audit({
      workspaceId,
      actorUserId: auth.session.userId,
      actorType: "user",
      action: "workspace.outreach_settings_updated",
      targetEntityType: "workspace",
      targetEntityId: workspaceId,
      before: { hadPriorSettings: before !== null },
      after: { cadenceCount: next.cadences.length, pendingDeploy: next.pendingDeploy },
      requestId: c.var.requestId,
    });

    return c.json(next);
  },
);

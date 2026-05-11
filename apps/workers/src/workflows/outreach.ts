import { log, proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "../activities/outreach.js";

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { initialInterval: "5s", backoffCoefficient: 2, maximumAttempts: 3 },
});

export interface OutreachInput {
  threadId: string;
  workspaceId: string;
  // Default cadence: invite immediately, SMS reminder day 3, email reminder
  // day 7, specialist alert day 10 (PROMPT M4 §6.2).
  cadence?: {
    inviteDelayDays?: number;
    smsReminderDays?: number;
    emailReminderDays?: number;
    alertDays?: number;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function outreachWorkflow(input: OutreachInput): Promise<void> {
  const cad = {
    inviteDelayDays: 0,
    smsReminderDays: 3,
    emailReminderDays: 7,
    alertDays: 10,
    ...input.cadence,
  };

  log.info("outreach.start", { threadId: input.threadId });

  if (cad.inviteDelayDays > 0) await sleep(cad.inviteDelayDays * DAY_MS);
  if (!(await acts.isThreadActive(input))) return;
  await acts.sendInviteActivity(input);

  await sleep(cad.smsReminderDays * DAY_MS);
  if (!(await acts.isThreadActive(input))) return;
  await acts.sendReminderActivity({ ...input, channel: "sms", template: "reminder_d3" });

  await sleep((cad.emailReminderDays - cad.smsReminderDays) * DAY_MS);
  if (!(await acts.isThreadActive(input))) return;
  await acts.sendReminderActivity({ ...input, channel: "email", template: "reminder_d7" });

  await sleep((cad.alertDays - cad.emailReminderDays) * DAY_MS);
  if (!(await acts.isThreadActive(input))) return;
  await acts.alertSpecialistActivity(input);
}

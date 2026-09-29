/**
 * Shared mutable buffers that record calls to the outbound delivery
 * primitives (`sendEmail`, `sendSms`, `notifySupportTicket`). The
 * `vi.mock` wiring lives in `../setupMocks.ts` — that file redirects
 * the real modules to push into these arrays instead of calling
 * Resend/Twilio/Slack.
 *
 * Tests that want to assert delivery import these arrays and check
 * `.length` / element shape. Call `resetDeliverySpies()` in a
 * `beforeEach` so previous tests' rows don't leak in.
 */

import type { EmailMessage, SmsMessage } from "@cred/auth";
import type { SupportTicketPayload } from "../../src/services/notifySupportTicket.js";

export const capturedEmails: EmailMessage[] = [];
export const capturedSms: SmsMessage[] = [];
export const capturedTickets: SupportTicketPayload[] = [];

export function resetDeliverySpies(): void {
  capturedEmails.length = 0;
  capturedSms.length = 0;
  capturedTickets.length = 0;
}

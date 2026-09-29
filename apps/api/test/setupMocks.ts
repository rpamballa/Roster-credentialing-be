/**
 * Global test setup — installs `vi.mock` for the three outbound
 * delivery boundaries (`sendEmail`, `sendSms`, `notifySupportTicket`)
 * so route tests can assert what was *actually attempted*, not just
 * what the audit log says.
 *
 * Why this file exists: the earlier test suite reported ~100% coverage
 * of the cockpit action routes, but several handlers were dead —
 * writing an audit row without invoking the side-effect the action
 * advertised (nudge/reupload/escalate/reference-invite). Coverage
 * lines executed = 100%; product intent delivered = 0%. Wiring these
 * mocks turns "handler was called" tests into "handler delivered"
 * tests: the arrays populate only if the source really invoked the
 * transport primitive. See `./support/deliverySpies.ts` for the
 * capture buffers.
 *
 * Vitest applies `vi.mock` in a `setupFiles` entry to every test file
 * in the run, and the hoisting rules mean tests can import the real
 * module names — the substitute installed here is what they get.
 */

import { vi } from "vitest";
import { capturedEmails, capturedSms, capturedTickets } from "./support/deliverySpies.js";

vi.mock("@cred/auth", async () => {
  const actual = await vi.importActual<typeof import("@cred/auth")>("@cred/auth");
  return {
    ...actual,
    sendEmail: vi.fn(async (msg: import("@cred/auth").EmailMessage) => {
      capturedEmails.push(msg);
    }),
    sendSms: vi.fn(async (msg: import("@cred/auth").SmsMessage) => {
      capturedSms.push(msg);
    }),
  };
});

vi.mock("../src/services/notifySupportTicket.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/notifySupportTicket.js")>(
    "../src/services/notifySupportTicket.js",
  );
  return {
    ...actual,
    notifySupportTicket: vi.fn(
      async (payload: import("../src/services/notifySupportTicket.js").SupportTicketPayload) => {
        capturedTickets.push(payload);
      },
    ),
  };
});

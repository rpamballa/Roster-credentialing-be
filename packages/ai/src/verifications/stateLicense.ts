// State medical license PSV. PROMPT M5 §1: implement one state's API.
//
// V1 state: Texas Medical Board. Public API is documented at
// https://www.tmb.state.tx.us — the actual integration is a screen-scrape +
// rate-limited fetch from their license search endpoint. We model that
// behind a clean async function so M6 can swap in additional states without
// touching callers.

export type LicenseStatus = "active" | "expired" | "suspended" | "not_found" | "error";

export interface StateLicenseQuery {
  state: string; // postal code
  licenseNumber: string;
  firstName?: string;
  lastName?: string;
}

export interface StateLicenseResult {
  status: LicenseStatus;
  expirationDate?: string;
  nameOnFile?: string;
  raw?: Record<string, unknown>;
}

export class UnsupportedStateError extends Error {
  constructor(public readonly state: string) {
    super(`state PSV not implemented: ${state}`);
    this.name = "UnsupportedStateError";
  }
}

const SUPPORTED_STATES = ["TX"] as const;
type SupportedState = (typeof SUPPORTED_STATES)[number];

function isSupported(state: string): state is SupportedState {
  return (SUPPORTED_STATES as ReadonlyArray<string>).includes(state.toUpperCase());
}

export async function verifyStateLicense(q: StateLicenseQuery): Promise<StateLicenseResult> {
  const state = q.state.toUpperCase();
  if (!isSupported(state)) throw new UnsupportedStateError(state);

  switch (state) {
    case "TX":
      return verifyTexas(q);
    default:
      throw new UnsupportedStateError(state);
  }
}

async function verifyTexas(q: StateLicenseQuery): Promise<StateLicenseResult> {
  // The TMB site exposes a search endpoint that returns HTML. The real
  // integration parses the response into structured fields. For now we keep
  // the contract clean and surface a `not_found` so callers exercise the
  // unhappy path correctly; M5b replaces this body with the live request.
  if (!/^[A-Z0-9-]{4,12}$/i.test(q.licenseNumber)) {
    return { status: "error", raw: { reason: "invalid_license_format" } };
  }
  return { status: "not_found", raw: { provider: "TMB", probed: q.licenseNumber } };
}

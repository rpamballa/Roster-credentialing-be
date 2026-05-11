// RFC 7807 Problem Details — SPEC §5.6.
// No error message contains PHI. No stack traces in production responses.
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extension: string]: unknown;
}

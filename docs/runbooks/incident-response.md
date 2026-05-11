# Runbook — incident response

## Severity levels

| Level | Definition |
|---|---|
| SEV-1 | Auth broken / data leak / cross-tenant access possible / PHI in logs |
| SEV-2 | Critical user flow broken (provider can't upload, extraction queue stalled) |
| SEV-3 | Degraded — slow but functional |
| SEV-4 | Cosmetic |

## First 15 minutes (SEV-1 / SEV-2)

1. **Acknowledge.** Page goes out via PagerDuty; ack the page.
2. **Confirm scope.**
   - Read the OTel trace for the failing request id; capture both ends.
   - Read `audit_log` for the affected workspace in the last hour.
3. **Tenancy check (SEV-1 only).** If anything looks like a cross-tenant
   leak, run:
   ```sql
   SHOW row_security; -- must be on for the failing connection
   SELECT current_setting('app.current_workspace_id', true);
   ```
   If empty inside a request path, file a SEV-1 immediately and roll back
   the offending deploy.
4. **Containment.** Default to disabling the affected endpoint via the
   feature-flag table before debugging in prod.

## Rollback path

- API: redeploy the previous OCI tag.
- Workers: drain the task queue (`temporal task-queue describe ...`),
  redeploy the previous tag.
- Database: prefer a forward migration that reverses the change. Hard rollback
  of a migration requires an ADR.

## Postmortem

Write within 48 hours. Required sections: trigger, impact, what we knew when,
contributing factors, action items, prevention. PHI must not appear in the
write-up — reference workspace ids, not provider names.

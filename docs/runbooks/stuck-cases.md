# Runbook — stuck case

## When does a case look "stuck"?

- Status hasn't changed in 7+ days
- Outreach thread is `active` with 3+ sent messages and no inbound response
- `assigned_specialist_id` is null
- An `extraction` workflow is in `failed` state for one of its documents

## Triage

1. Confirm the case is real:
   ```sql
   SELECT id, status, opened_at, assigned_specialist_id, blockers
   FROM cases WHERE id = '<case-id>';
   ```
2. Inspect the outreach thread:
   ```sql
   SELECT * FROM outreach_threads WHERE case_id = '<case-id>';
   SELECT * FROM outreach_messages
     WHERE thread_id IN (SELECT id FROM outreach_threads WHERE case_id = '<case-id>')
     ORDER BY created_at DESC LIMIT 20;
   ```
3. Look at the recent audit trail for the case:
   ```sql
   SELECT timestamp, action, actor_type, actor_user_id, after_state
   FROM audit_log
   WHERE target_entity_id = '<case-id>' OR target_entity_id IN
     (SELECT id FROM documents WHERE provider_id =
       (SELECT provider_id FROM cases WHERE id = '<case-id>'))
   ORDER BY timestamp DESC LIMIT 50;
   ```
4. Open Temporal UI (`localhost:8233` in dev) and search for workflow ids
   `extract-<documentId>`, `facility-ingest-*`, `outreach-*` related to the
   case. Inspect failures.

## Common remedies

| Symptom | Remedy |
|---|---|
| Extraction failed on one document | Mark the document `needs_review` and have the specialist enter fields manually via the cockpit. |
| Provider hasn't responded after day 10 | Reassign or pause outreach: `UPDATE outreach_threads SET status='paused' WHERE id='<id>';` and reach out manually. |
| Facility profile is still `draft` | The case cannot reference it. Review the draft in the cockpit and approve. |
| DocuSign envelope stuck on `sent` | Verify the envelope status in the DocuSign console; if completed but not reflected here, the webhook may have been missed — query `attestations` and update manually. |

Document every manual override with a follow-up audit entry by including the
case id in a Linear ticket so we can trace it back through `audit_log` later.

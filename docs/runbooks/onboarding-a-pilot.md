# Runbook — onboarding a pilot customer

## 1. Provision the workspace

```bash
pnpm tsx scripts/provisionWorkspace.ts \
  --type agency \
  --name "Acme Locums" \
  --slug acme \
  --ownerEmail owner@acme.example.com
```

Output is JSON; capture `workspaceId` and `emailInAddress`.

## 2. Configure DNS for inbound email

Point the `requirements+<slug>@platform.example.com` address at Resend's
inbound parse endpoint per the Resend dashboard. Test by sending a tiny PDF —
within five minutes a row should appear in `inbound_emails` and a
`facility_profile` draft should appear in the cockpit.

## 3. Invite the first specialists

The owner uses `POST /auth/magic-link/request` to get themselves in, then
adds memberships via the cockpit's User Settings (UI in the frontend repo).

## 4. Baseline measurement

Record the customer's pre-platform time-per-packet (PROMPT M6 §3). Use the
`/cockpit/metrics/baseline` endpoint to track the rolling 30-day median on
the platform side.

## 5. First 20 packets

For each of the first 20 packets, capture:

- specialist start timestamp (cockpit "open case")
- submission timestamp (cockpit "submit packet")
- any manual overrides applied (cross-reference `audit_log`)

Compare median time vs the baseline. Target: ≥50% reduction.

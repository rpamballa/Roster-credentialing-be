-- Public marketing leads (beta applications + demo requests). Pre-tenancy:
-- visitors aren't in `users` or `workspaces` yet, so this table sits outside
-- the RLS tenancy model. Only platform operators read it (via a future admin
-- surface or direct SQL).

CREATE TABLE IF NOT EXISTS marketing_leads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('beta', 'demo')),
  email             text NOT NULL,
  full_name         text NOT NULL,
  agency            text NOT NULL,
  role              text,
  volume            text,
  free_text         text,
  source_path       text,
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  ip                text,
  user_agent        text,
  turnstile_passed  boolean,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketing_leads_created_at_idx
  ON marketing_leads(created_at DESC);
CREATE INDEX IF NOT EXISTS marketing_leads_kind_idx
  ON marketing_leads(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS marketing_leads_ip_idx
  ON marketing_leads(ip, created_at DESC);

-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS feedback (
  id         bigint PRIMARY KEY,
  tenant_id  uuid REFERENCES tenants(id) ON DELETE SET NULL,
  user_id    uuid,
  type       text NOT NULL CHECK (type IN ('bug','feature','question','billing')),
  title      text NOT NULL,
  body       text NOT NULL,
  status     text NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','resolved','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

-- Tenant members can insert feedback
CREATE POLICY "Tenant members can submit feedback"
  ON feedback FOR INSERT
  WITH CHECK (tenant_id IN (
    SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()
  ));

-- Tenant members can read their own feedback
CREATE POLICY "Tenant members can read own feedback"
  ON feedback FOR SELECT
  USING (tenant_id IN (
    SELECT tenant_id FROM tenant_users WHERE user_id = auth.uid()
  ));

-- Platform admins can update status
CREATE POLICY "Platform admins can update feedback"
  ON feedback FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = auth.uid()
  ));

CREATE INDEX IF NOT EXISTS feedback_tenant_id_idx  ON feedback(tenant_id);
CREATE INDEX IF NOT EXISTS feedback_status_idx     ON feedback(status);
CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback(created_at DESC);

-- Platform admins can read ALL feedback (for the dashboard)
CREATE POLICY "Platform admins can read all feedback"
  ON feedback FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM platform_admins WHERE user_id = auth.uid()
  ));

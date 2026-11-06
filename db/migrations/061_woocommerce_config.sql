-- ============================================================
-- 061_woocommerce_config.sql — WooCommerce Store API grounding
--
-- Account-scoped store URL so the AI reply assistant can live-search
-- products (name, price, size, stock, permalink) at draft / auto-reply
-- time. No secrets: the public Store API product listing is enough.
-- Products are NOT synced into the knowledge base — always fetched live.
--
-- RLS: settings-class, mirroring `ai_configs` / `whatsapp_config` —
-- any member may read (so the Agents setup UI can show status); only
-- admin+ may write. The auto-reply path uses the service-role client.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS woocommerce_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  store_url   text NOT NULL,
  is_active   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE woocommerce_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS woocommerce_configs_select ON woocommerce_configs;
CREATE POLICY woocommerce_configs_select ON woocommerce_configs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS woocommerce_configs_insert ON woocommerce_configs;
CREATE POLICY woocommerce_configs_insert ON woocommerce_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS woocommerce_configs_update ON woocommerce_configs;
CREATE POLICY woocommerce_configs_update ON woocommerce_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS woocommerce_configs_delete ON woocommerce_configs;
CREATE POLICY woocommerce_configs_delete ON woocommerce_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE OR REPLACE FUNCTION public.update_woocommerce_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS woocommerce_configs_updated_at ON woocommerce_configs;
CREATE TRIGGER woocommerce_configs_updated_at
  BEFORE UPDATE ON woocommerce_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_woocommerce_configs_updated_at();

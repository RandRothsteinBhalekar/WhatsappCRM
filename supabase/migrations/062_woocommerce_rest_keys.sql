-- ============================================================
-- 062_woocommerce_rest_keys.sql — WooCommerce REST API credentials
--
-- Optional consumer key + secret for the authenticated REST v3
-- catalogue. Stored AES-256-GCM-encrypted (same scheme as
-- whatsapp_config.access_token). Null means "no REST credentials" —
-- product lookup falls back to the public Store API.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE woocommerce_configs
  ADD COLUMN IF NOT EXISTS consumer_key text;

ALTER TABLE woocommerce_configs
  ADD COLUMN IF NOT EXISTS consumer_secret text;

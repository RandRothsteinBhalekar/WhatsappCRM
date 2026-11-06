-- Postgres NOTIFY for SSE realtime (replaces Supabase postgres_changes)

CREATE OR REPLACE FUNCTION public.wacrm_notify_realtime()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  payload jsonb;
  row_json jsonb;
  acct uuid;
  conv uuid;
  row_id uuid;
BEGIN
  -- Tables differ in PK shape (e.g. member_presence uses user_id, not id).
  -- Read via to_jsonb so missing columns never raise.
  IF TG_OP = 'DELETE' THEN
    row_json := to_jsonb(OLD);
  ELSE
    row_json := to_jsonb(NEW);
  END IF;

  row_id := COALESCE(
    (row_json->>'id')::uuid,
    (row_json->>'user_id')::uuid
  );
  acct := (row_json->>'account_id')::uuid;
  conv := (row_json->>'conversation_id')::uuid;

  -- Include full row as `record` so SSE clients can hydrate without a
  -- follow-up fetch. Omitting it left inbox inserts without created_at
  -- (Invalid time value in message-thread date grouping).
  payload := jsonb_build_object(
    'table', TG_TABLE_NAME,
    'op', TG_OP,
    'id', row_id,
    'account_id', acct,
    'conversation_id', conv,
    'record', row_json
  );

  PERFORM pg_notify('wacrm_realtime', payload::text);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'messages',
    'conversations',
    'notifications',
    'message_reactions',
    'member_presence',
    'broadcasts'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS wacrm_realtime_%s ON %I', t, t);
      EXECUTE format(
        'CREATE TRIGGER wacrm_realtime_%s
         AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION public.wacrm_notify_realtime()',
        t, t
      );
    END IF;
  END LOOP;
END $$;

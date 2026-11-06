-- ============================================================
-- 063_invite_email.sql — email-bound invitations
--
-- Invites are no longer opaque bearer links alone: each row stores
-- the invitee email. Signup must present a valid invite token AND
-- use that exact email (case-insensitive). peek_invitation returns
-- the email so /join can prefill signup.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE account_invitations
  ADD COLUMN IF NOT EXISTS email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_invitations_pending_email
  ON account_invitations (account_id, lower(email))
  WHERE accepted_at IS NULL AND email IS NOT NULL;

-- ============================================================
-- peek_invitation — same contract as 019, plus `email` on ok.
-- Legacy pending rows without email still peek successfully but
-- signup will reject them (assertCanSignUp requires a match).
-- ============================================================
CREATE OR REPLACE FUNCTION public.peek_invitation(
  p_token_hash TEXT
) RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_account_name TEXT;
BEGIN
  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'reason', 'used');
  END IF;

  IF v_inv.expires_at <= NOW() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;

  SELECT name INTO v_account_name
  FROM accounts
  WHERE id = v_inv.account_id;

  RETURN json_build_object(
    'ok', true,
    'account_name', v_account_name,
    'role', v_inv.role,
    'expires_at', v_inv.expires_at,
    'email', v_inv.email
  );
END;
$$;

ALTER FUNCTION public.peek_invitation(TEXT) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.peek_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO anon;
GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO service_role;

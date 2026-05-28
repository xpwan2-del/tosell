ALTER TABLE "merchant_invite_codes"
  ADD COLUMN IF NOT EXISTS "deposit_required_amount_cents" BIGINT;

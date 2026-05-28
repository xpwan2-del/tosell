-- Buyer-created extraction codes are order-scoped secrets. Reusing the same
-- simple code on another order must not block order creation.

DROP INDEX IF EXISTS "order_extract_secrets_claim_code_hash_key";

CREATE INDEX IF NOT EXISTS "order_extract_secrets_order_id_claim_code_hash_idx"
  ON "order_extract_secrets"("order_id", "claim_code_hash");

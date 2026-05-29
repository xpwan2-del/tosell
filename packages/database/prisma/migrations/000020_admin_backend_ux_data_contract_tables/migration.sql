ALTER TABLE "platform_products"
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_instruction" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_wechat_qr_url" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_qq_qr_url" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_wechat_id" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_qq_id" TEXT;

UPDATE "platform_products"
   SET "fulfillment_type" = 'code_pool'
 WHERE "fulfillment_type"::text = 'automatic'
   AND "fulfillment_rule_json"->>'mode' = 'code_pool';

ALTER TABLE "platform_products" DROP CONSTRAINT IF EXISTS "platform_products_product_fulfillment_mode_check";
ALTER TABLE "platform_products"
  ADD CONSTRAINT "platform_products_product_fulfillment_mode_check"
  CHECK (
    "fulfillment_type"::text IN ('manual', 'code_pool')
    AND COALESCE("fulfillment_rule_json"->>'mode', 'manual') IN ('manual', 'code_pool')
  ) NOT VALID;

ALTER TABLE "agent_product_reviews"
  ADD COLUMN IF NOT EXISTS "fulfillment_type" "FulfillmentType" NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_instruction" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_wechat_qr_url" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_qq_qr_url" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_wechat_id" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_qq_id" TEXT;

UPDATE "agent_product_reviews"
   SET "fulfillment_type" = 'code_pool'
 WHERE "fulfillment_rule_json"->>'mode' = 'code_pool';

ALTER TABLE "agent_product_reviews" DROP CONSTRAINT IF EXISTS "agent_product_reviews_fulfillment_mode_check";
ALTER TABLE "agent_product_reviews"
  ADD CONSTRAINT "agent_product_reviews_fulfillment_mode_check"
  CHECK (
    "fulfillment_type"::text IN ('manual', 'code_pool')
    AND COALESCE("fulfillment_rule_json"->>'mode', 'manual') IN ('manual', 'code_pool')
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS "agent_product_reviews_fulfillment_type_status_idx"
  ON "agent_product_reviews"("fulfillment_type", "status");

ALTER TABLE "merchant_product_reviews"
  ADD COLUMN IF NOT EXISTS "fulfillment_type" "FulfillmentType" NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_instruction" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_wechat_qr_url" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_qq_qr_url" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_wechat_id" TEXT,
  ADD COLUMN IF NOT EXISTS "manual_fulfillment_qq_id" TEXT;

UPDATE "merchant_product_reviews"
   SET "fulfillment_type" = 'code_pool'
 WHERE "fulfillment_rule_json"->>'mode' = 'code_pool';

ALTER TABLE "merchant_product_reviews" DROP CONSTRAINT IF EXISTS "merchant_product_reviews_fulfillment_mode_check";
ALTER TABLE "merchant_product_reviews"
  ADD CONSTRAINT "merchant_product_reviews_fulfillment_mode_check"
  CHECK (
    "fulfillment_type"::text IN ('manual', 'code_pool')
    AND COALESCE("fulfillment_rule_json"->>'mode', 'manual') IN ('manual', 'code_pool')
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS "merchant_product_reviews_fulfillment_type_status_idx"
  ON "merchant_product_reviews"("fulfillment_type", "status");

ALTER TABLE "rights_codes"
  ADD COLUMN IF NOT EXISTS "code_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "secret_preview" TEXT,
  ADD COLUMN IF NOT EXISTS "owner_type" "RightsCodeOwnerType" NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS "owner_agent_id" TEXT,
  ADD COLUMN IF NOT EXISTS "owner_merchant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "shop_id" TEXT,
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "import_audit_json" JSONB;

UPDATE "rights_codes" rc
   SET "owner_type" = 'agent',
       "owner_agent_id" = ap."agent_id",
       "shop_id" = ap."shop_id"
  FROM "agent_products" ap
 WHERE rc."agent_product_id" = ap."id";

UPDATE "rights_codes"
   SET "owner_type" = 'platform'
 WHERE "product_id" IS NOT NULL
   AND "agent_product_id" IS NULL;

ALTER TABLE "rights_codes" DROP CONSTRAINT IF EXISTS "rights_codes_owner_metadata_check";
ALTER TABLE "rights_codes"
  ADD CONSTRAINT "rights_codes_owner_metadata_check"
  CHECK (
    (
      "owner_type" = 'platform'
      AND "product_id" IS NOT NULL
      AND "agent_product_id" IS NULL
      AND "owner_agent_id" IS NULL
    )
    OR
    (
      "owner_type" = 'agent'
      AND "product_id" IS NULL
      AND "agent_product_id" IS NOT NULL
      AND "owner_agent_id" IS NOT NULL
    )
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS "rights_codes_owner_type_status_idx" ON "rights_codes"("owner_type", "status");
CREATE INDEX IF NOT EXISTS "rights_codes_owner_agent_id_status_idx" ON "rights_codes"("owner_agent_id", "status");
CREATE INDEX IF NOT EXISTS "rights_codes_owner_merchant_id_status_idx" ON "rights_codes"("owner_merchant_id", "status");
CREATE INDEX IF NOT EXISTS "rights_codes_shop_id_status_idx" ON "rights_codes"("shop_id", "status");
CREATE INDEX IF NOT EXISTS "rights_codes_code_hash_idx" ON "rights_codes"("code_hash");

ALTER TABLE "rights_codes" DROP CONSTRAINT IF EXISTS "rights_codes_owner_agent_id_fkey";
ALTER TABLE "rights_codes"
  ADD CONSTRAINT "rights_codes_owner_agent_id_fkey" FOREIGN KEY ("owner_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rights_codes" DROP CONSTRAINT IF EXISTS "rights_codes_owner_merchant_id_fkey";
ALTER TABLE "rights_codes"
  ADD CONSTRAINT "rights_codes_owner_merchant_id_fkey" FOREIGN KEY ("owner_merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rights_codes" DROP CONSTRAINT IF EXISTS "rights_codes_shop_id_fkey";
ALTER TABLE "rights_codes"
  ADD CONSTRAINT "rights_codes_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "email_delivery_records" (
  "id" TEXT NOT NULL,
  "delivery_no" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "order_item_id" TEXT,
  "email" TEXT NOT NULL,
  "scope" "EmailDeliveryScope" NOT NULL DEFAULT 'extract_link',
  "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'pending',
  "code_count" INTEGER NOT NULL DEFAULT 0,
  "extract_token_hash" TEXT,
  "error_code" TEXT,
  "error_message" TEXT,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "next_retry_at" TIMESTAMP(3),
  "actor_type" "ActorType" NOT NULL DEFAULT 'system',
  "actor_id" TEXT,
  "source" TEXT NOT NULL DEFAULT 'auto_fulfillment',
  "idempotency_key" TEXT NOT NULL,
  "sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_delivery_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_delivery_records_delivery_no_key" ON "email_delivery_records"("delivery_no");
CREATE UNIQUE INDEX IF NOT EXISTS "email_delivery_records_idempotency_key_key" ON "email_delivery_records"("idempotency_key");
CREATE INDEX IF NOT EXISTS "email_delivery_records_order_id_status_idx" ON "email_delivery_records"("order_id", "status");
CREATE INDEX IF NOT EXISTS "email_delivery_records_email_created_at_idx" ON "email_delivery_records"("email", "created_at");
CREATE INDEX IF NOT EXISTS "email_delivery_records_status_next_retry_at_idx" ON "email_delivery_records"("status", "next_retry_at");
CREATE INDEX IF NOT EXISTS "email_delivery_records_actor_type_actor_id_created_at_idx" ON "email_delivery_records"("actor_type", "actor_id", "created_at");

ALTER TABLE "email_delivery_records" DROP CONSTRAINT IF EXISTS "email_delivery_records_code_count_retry_check";
ALTER TABLE "email_delivery_records"
  ADD CONSTRAINT "email_delivery_records_code_count_retry_check" CHECK ("code_count" >= 0 AND "retry_count" >= 0);
ALTER TABLE "email_delivery_records" DROP CONSTRAINT IF EXISTS "email_delivery_records_order_id_fkey";
ALTER TABLE "email_delivery_records"
  ADD CONSTRAINT "email_delivery_records_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "email_delivery_records" DROP CONSTRAINT IF EXISTS "email_delivery_records_order_item_id_fkey";
ALTER TABLE "email_delivery_records"
  ADD CONSTRAINT "email_delivery_records_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION prevent_email_delivery_after_refund()
RETURNS trigger AS $$
DECLARE order_refund_status "RefundStatus";
BEGIN
  SELECT "refund_status" INTO order_refund_status FROM "orders" WHERE "id" = NEW."order_id";
  IF order_refund_status = 'refunded' AND NEW."status" IN ('pending', 'sent') THEN
    RAISE EXCEPTION 'cannot send card-code email after refund';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS email_delivery_records_refund_check ON "email_delivery_records";
CREATE TRIGGER email_delivery_records_refund_check
  BEFORE INSERT OR UPDATE OF status, order_id ON "email_delivery_records"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_email_delivery_after_refund();

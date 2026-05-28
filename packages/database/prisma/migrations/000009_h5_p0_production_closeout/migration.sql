-- H5 P0 production closeout: merchant accounts, self-collection,
-- three-tier price-spread supply, virtual code extraction, coupons, clearing.

DO $$ BEGIN
  CREATE TYPE "MerchantTier" AS ENUM ('first_tier', 'second_tier', 'third_tier');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "MerchantCreationSource" AS ENUM ('admin_manual', 'invite_application', 'self_application', 'migration');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "MerchantAccountRole" AS ENUM ('owner', 'operator');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "MerchantAccountStatus" AS ENUM ('pending_delivery', 'active', 'disabled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "InitialAccountDeliveryStatus" AS ENUM ('pending', 'delivered', 'acknowledged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ChannelRelationType" AS ENUM ('two_tier', 'three_tier');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SaleSourceType" AS ENUM ('agent_product', 'merchant_product', 'platform_shop_product');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CollectionChannelType" AS ENUM ('wechat_qr', 'alipay_qr', 'bank_transfer', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CollectionChannelStatus" AS ENUM ('pending_review', 'active', 'disabled', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "VirtualCodeStatus" AS ENUM ('available', 'reserved', 'issued', 'voided', 'refunded', 'locked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ExtractSecretStatus" AS ENUM ('active', 'locked', 'revoked', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ExtractLogResult" AS ENUM ('success', 'failed', 'locked', 'revoked', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ClearingRecordStatus" AS ENUM ('draft', 'confirmed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ClearingItemType" AS ENUM ('supply_payable', 'service_fee', 'clawback', 'refund_adjustment', 'coupon_subsidy');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ClearingConfirmationStatus" AS ENUM ('pending', 'confirmed', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CouponTemplateStatus" AS ENUM ('draft', 'active', 'inactive', 'voided');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CouponStatus" AS ENUM ('active', 'used', 'expired', 'voided');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CouponDiscountType" AS ENUM ('fixed_amount');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CouponScopeType" AS ENUM ('all_products', 'platform_product', 'merchant_product', 'shop');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE "merchants" (
  "id" TEXT NOT NULL,
  "merchant_no" TEXT NOT NULL,
  "tier" "MerchantTier" NOT NULL DEFAULT 'first_tier',
  "name" TEXT NOT NULL,
  "contact_phone" TEXT,
  "status" "AgentStatus" NOT NULL DEFAULT 'pending_deposit',
  "risk_status" "RiskStatus" NOT NULL DEFAULT 'normal',
  "deposit_status" "DepositStatus" NOT NULL DEFAULT 'pending_payment',
  "creation_source" "MerchantCreationSource" NOT NULL DEFAULT 'self_application',
  "created_by_admin_id" TEXT,
  "initial_account_status" "InitialAccountDeliveryStatus" NOT NULL DEFAULT 'pending',
  "approved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchants_merchant_no_key" ON "merchants"("merchant_no");
CREATE INDEX "merchants_tier_status_idx" ON "merchants"("tier", "status");
CREATE INDEX "merchants_deposit_status_idx" ON "merchants"("deposit_status");
CREATE INDEX "merchants_creation_source_created_at_idx" ON "merchants"("creation_source", "created_at");

ALTER TABLE "merchants"
  ADD CONSTRAINT "merchants_admin_manual_first_tier_check"
  CHECK ("creation_source" <> 'admin_manual' OR "tier" = 'first_tier');

CREATE TABLE "merchant_accounts" (
  "id" TEXT NOT NULL,
  "user_id" TEXT,
  "merchant_id" TEXT,
  "username" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "password_hash" TEXT,
  "role" "MerchantAccountRole" NOT NULL DEFAULT 'owner',
  "status" "MerchantAccountStatus" NOT NULL DEFAULT 'pending_delivery',
  "initial_delivery_status" "InitialAccountDeliveryStatus" NOT NULL DEFAULT 'pending',
  "initial_delivered_at" TIMESTAMP(3),
  "must_change_password" BOOLEAN NOT NULL DEFAULT true,
  "password_changed_at" TIMESTAMP(3),
  "created_by_admin_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "merchant_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_accounts_username_key" ON "merchant_accounts"("username");
CREATE INDEX "merchant_accounts_merchant_id_status_idx" ON "merchant_accounts"("merchant_id", "status");
CREATE INDEX "merchant_accounts_user_id_idx" ON "merchant_accounts"("user_id");

CREATE TABLE "merchant_invite_codes" (
  "id" TEXT NOT NULL,
  "code_hash" TEXT NOT NULL,
  "issuer_merchant_id" TEXT,
  "tier" "MerchantTier" NOT NULL,
  "max_uses" INTEGER NOT NULL DEFAULT 1,
  "used_count" INTEGER NOT NULL DEFAULT 0,
  "status" "ReviewStatus" NOT NULL DEFAULT 'approved',
  "expires_at" TIMESTAMP(3),
  "created_by_admin_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "merchant_invite_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_invite_codes_code_hash_key" ON "merchant_invite_codes"("code_hash");
CREATE UNIQUE INDEX "merchant_invite_codes_idempotency_key_key" ON "merchant_invite_codes"("idempotency_key");
CREATE INDEX "merchant_invite_codes_issuer_merchant_id_status_idx" ON "merchant_invite_codes"("issuer_merchant_id", "status");
CREATE INDEX "merchant_invite_codes_tier_status_expires_at_idx" ON "merchant_invite_codes"("tier", "status", "expires_at");
ALTER TABLE "merchant_invite_codes"
  ADD CONSTRAINT "merchant_invite_codes_usage_check"
  CHECK ("max_uses" > 0 AND "used_count" >= 0 AND "used_count" <= "max_uses");

CREATE TABLE "merchant_applications" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT,
  "user_id" TEXT,
  "invite_code_id" TEXT,
  "tier" "MerchantTier" NOT NULL DEFAULT 'first_tier',
  "identity_info_json" JSONB NOT NULL,
  "contact_info_json" JSONB NOT NULL,
  "customer_service_wechat" TEXT,
  "status" "ReviewStatus" NOT NULL DEFAULT 'pending_review',
  "reject_reason" TEXT,
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "merchant_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_applications_idempotency_key_key" ON "merchant_applications"("idempotency_key");
CREATE INDEX "merchant_applications_tier_status_created_at_idx" ON "merchant_applications"("tier", "status", "created_at");
CREATE INDEX "merchant_applications_merchant_id_idx" ON "merchant_applications"("merchant_id");

ALTER TABLE "shops"
  ADD COLUMN IF NOT EXISTS "merchant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "creation_source" "MerchantCreationSource",
  ADD COLUMN IF NOT EXISTS "created_by_admin_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "shops_merchant_id_key" ON "shops"("merchant_id");
CREATE INDEX IF NOT EXISTS "shops_merchant_id_status_idx" ON "shops"("merchant_id", "status");

ALTER TABLE "shops" DROP CONSTRAINT IF EXISTS "shops_owner_agent_scope_check";
ALTER TABLE "shops"
  ADD CONSTRAINT "shops_owner_scope_check"
  CHECK (
    ("owner_type" = 'platform' AND "agent_id" IS NULL AND "merchant_id" IS NULL)
    OR ("owner_type" = 'agent' AND (("agent_id" IS NOT NULL)::int + ("merchant_id" IS NOT NULL)::int = 1))
  );

CREATE TABLE "shop_collection_channels" (
  "id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "channel_type" "CollectionChannelType" NOT NULL,
  "account_name" TEXT NOT NULL,
  "qr_url" TEXT,
  "note" TEXT,
  "status" "CollectionChannelStatus" NOT NULL DEFAULT 'pending_review',
  "review_status" "ReviewStatus" NOT NULL DEFAULT 'pending_review',
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "idempotency_key" TEXT NOT NULL,
  "created_by_admin_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shop_collection_channels_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "shop_collection_channels_idempotency_key_key" ON "shop_collection_channels"("idempotency_key");
CREATE UNIQUE INDEX "shop_collection_channels_default_active_unique"
  ON "shop_collection_channels"("shop_id") WHERE "is_default" = true AND "status" = 'active';
CREATE INDEX "shop_collection_channels_shop_id_status_idx" ON "shop_collection_channels"("shop_id", "status");
CREATE INDEX "shop_collection_channels_shop_id_is_default_idx" ON "shop_collection_channels"("shop_id", "is_default");

ALTER TABLE "platform_products"
  ADD COLUMN IF NOT EXISTS "extract_code_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "extract_code_ttl_minutes" INTEGER;

CREATE TABLE "merchant_product_reviews" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "platform_product_id" TEXT,
  "name" TEXT NOT NULL,
  "detail_json" JSONB NOT NULL,
  "sale_price_cents" BIGINT NOT NULL,
  "after_sale_rule_json" JSONB NOT NULL,
  "fulfillment_rule_json" JSONB NOT NULL,
  "status" "ReviewStatus" NOT NULL DEFAULT 'pending_review',
  "reject_reason" TEXT,
  "risk_reason" TEXT,
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "merchant_product_reviews_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "merchant_product_reviews_idempotency_key_key" ON "merchant_product_reviews"("idempotency_key");
CREATE INDEX "merchant_product_reviews_merchant_id_status_idx" ON "merchant_product_reviews"("merchant_id", "status");
CREATE INDEX "merchant_product_reviews_shop_id_status_idx" ON "merchant_product_reviews"("shop_id", "status");
ALTER TABLE "merchant_product_reviews"
  ADD CONSTRAINT "merchant_product_reviews_amounts_check" CHECK ("sale_price_cents" >= 0);

CREATE TABLE "merchant_products" (
  "id" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "product_type" "ProductType" NOT NULL,
  "platform_product_id" TEXT,
  "own_product_review_id" TEXT,
  "sale_price_cents" BIGINT NOT NULL,
  "first_tier_supply_price_cents" BIGINT,
  "second_tier_supply_price_cents" BIGINT,
  "status" "AgentProductStatus" NOT NULL DEFAULT 'draft',
  "listed_at" TIMESTAMP(3),
  "delisted_at" TIMESTAMP(3),
  "idempotency_key" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "merchant_products_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "merchant_products_shop_id_product_type_platform_product_id_key" ON "merchant_products"("shop_id", "product_type", "platform_product_id");
CREATE UNIQUE INDEX "merchant_products_own_product_review_id_key" ON "merchant_products"("own_product_review_id");
CREATE UNIQUE INDEX "merchant_products_idempotency_key_key" ON "merchant_products"("idempotency_key");
CREATE INDEX "merchant_products_merchant_id_status_idx" ON "merchant_products"("merchant_id", "status");
CREATE INDEX "merchant_products_shop_id_status_idx" ON "merchant_products"("shop_id", "status");
ALTER TABLE "merchant_products"
  ADD CONSTRAINT "merchant_products_reference_check"
  CHECK (
    ("product_type" = 'platform' AND "platform_product_id" IS NOT NULL AND "own_product_review_id" IS NULL)
    OR ("product_type" = 'agent_owned' AND "platform_product_id" IS NULL AND "own_product_review_id" IS NOT NULL)
  );
ALTER TABLE "merchant_products"
  ADD CONSTRAINT "merchant_products_amounts_check"
  CHECK (
    "sale_price_cents" >= 0
    AND ("first_tier_supply_price_cents" IS NULL OR "first_tier_supply_price_cents" >= 0)
    AND ("second_tier_supply_price_cents" IS NULL OR "second_tier_supply_price_cents" >= 0)
  );

CREATE TABLE "virtual_code_batches" (
  "id" TEXT NOT NULL,
  "batch_no" TEXT NOT NULL,
  "platform_product_id" TEXT NOT NULL,
  "imported_by" TEXT,
  "total_count" INTEGER NOT NULL DEFAULT 0,
  "available_count" INTEGER NOT NULL DEFAULT 0,
  "encrypted_payload_schema" JSONB,
  "status" "ProductStatus" NOT NULL DEFAULT 'active',
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "virtual_code_batches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "virtual_code_batches_batch_no_key" ON "virtual_code_batches"("batch_no");
CREATE UNIQUE INDEX "virtual_code_batches_idempotency_key_key" ON "virtual_code_batches"("idempotency_key");
CREATE INDEX "virtual_code_batches_platform_product_id_status_idx" ON "virtual_code_batches"("platform_product_id", "status");
ALTER TABLE "virtual_code_batches"
  ADD CONSTRAINT "virtual_code_batches_counts_check"
  CHECK ("total_count" >= 0 AND "available_count" >= 0 AND "available_count" <= "total_count");

CREATE TABLE "virtual_codes" (
  "id" TEXT NOT NULL,
  "platform_product_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "account_ciphertext" TEXT,
  "secret_ciphertext" TEXT NOT NULL,
  "secret_fingerprint" TEXT,
  "metadata_json" JSONB,
  "status" "VirtualCodeStatus" NOT NULL DEFAULT 'available',
  "reserved_order_id" TEXT,
  "reserved_order_item_id" TEXT,
  "reserved_until" TIMESTAMP(3),
  "issued_order_id" TEXT,
  "issued_order_item_id" TEXT,
  "issued_at" TIMESTAMP(3),
  "lock_idempotency_key" TEXT,
  "issue_idempotency_key" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "virtual_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "virtual_codes_lock_idempotency_key_key" ON "virtual_codes"("lock_idempotency_key");
CREATE UNIQUE INDEX "virtual_codes_issue_idempotency_key_key" ON "virtual_codes"("issue_idempotency_key");
CREATE UNIQUE INDEX "virtual_codes_batch_id_secret_fingerprint_key" ON "virtual_codes"("batch_id", "secret_fingerprint");
CREATE INDEX "virtual_codes_platform_product_id_status_created_at_idx" ON "virtual_codes"("platform_product_id", "status", "created_at");
CREATE INDEX "virtual_codes_batch_id_status_idx" ON "virtual_codes"("batch_id", "status");
CREATE INDEX "virtual_codes_reserved_order_id_idx" ON "virtual_codes"("reserved_order_id");
CREATE INDEX "virtual_codes_issued_order_id_idx" ON "virtual_codes"("issued_order_id");

CREATE TABLE "order_extract_secrets" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "order_item_id" TEXT NOT NULL,
  "virtual_code_id" TEXT,
  "refund_id" TEXT,
  "claim_code_hash" TEXT NOT NULL,
  "status" "ExtractSecretStatus" NOT NULL DEFAULT 'active',
  "failed_attempts" INTEGER NOT NULL DEFAULT 0,
  "locked_until" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "first_viewed_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "revoke_reason" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "order_extract_secrets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_extract_secrets_claim_code_hash_key" ON "order_extract_secrets"("claim_code_hash");
CREATE UNIQUE INDEX "order_extract_secrets_idempotency_key_key" ON "order_extract_secrets"("idempotency_key");
CREATE INDEX "order_extract_secrets_order_id_status_idx" ON "order_extract_secrets"("order_id", "status");
CREATE INDEX "order_extract_secrets_order_item_id_idx" ON "order_extract_secrets"("order_item_id");
CREATE INDEX "order_extract_secrets_virtual_code_id_idx" ON "order_extract_secrets"("virtual_code_id");
CREATE INDEX "order_extract_secrets_refund_id_idx" ON "order_extract_secrets"("refund_id");
ALTER TABLE "order_extract_secrets"
  ADD CONSTRAINT "order_extract_secrets_attempts_check" CHECK ("failed_attempts" >= 0);

CREATE TABLE "order_extract_logs" (
  "id" TEXT NOT NULL,
  "extract_secret_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "actor_type" "ActorType" NOT NULL,
  "actor_id" TEXT,
  "result" "ExtractLogResult" NOT NULL,
  "reason_code" TEXT,
  "ip" TEXT,
  "user_agent" TEXT,
  "idempotency_key" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_extract_logs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_extract_logs_idempotency_key_key" ON "order_extract_logs"("idempotency_key");
CREATE INDEX "order_extract_logs_extract_secret_id_created_at_idx" ON "order_extract_logs"("extract_secret_id", "created_at");
CREATE INDEX "order_extract_logs_order_id_created_at_idx" ON "order_extract_logs"("order_id", "created_at");

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "merchant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "first_tier_merchant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "second_tier_merchant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "third_tier_merchant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "collection_channel_id" TEXT,
  ADD COLUMN IF NOT EXISTS "collection_snapshot_json" JSONB,
  ADD COLUMN IF NOT EXISTS "coupon_discount_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "coupon_snapshot_json" JSONB;
CREATE INDEX IF NOT EXISTS "orders_merchant_id_created_at_idx" ON "orders"("merchant_id", "created_at");
CREATE INDEX IF NOT EXISTS "orders_first_tier_merchant_id_created_at_idx" ON "orders"("first_tier_merchant_id", "created_at");
CREATE INDEX IF NOT EXISTS "orders_second_tier_merchant_id_created_at_idx" ON "orders"("second_tier_merchant_id", "created_at");
CREATE INDEX IF NOT EXISTS "orders_third_tier_merchant_id_created_at_idx" ON "orders"("third_tier_merchant_id", "created_at");
CREATE INDEX IF NOT EXISTS "orders_collection_channel_id_created_at_idx" ON "orders"("collection_channel_id", "created_at");
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_coupon_discount_check" CHECK ("coupon_discount_cents" >= 0);

ALTER TABLE "order_items"
  ALTER COLUMN "agent_product_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "merchant_product_id" TEXT,
  ADD COLUMN IF NOT EXISTS "platform_shop_product_id" TEXT,
  ADD COLUMN IF NOT EXISTS "sale_source_type" "SaleSourceType" NOT NULL DEFAULT 'agent_product';
CREATE INDEX IF NOT EXISTS "order_items_merchant_product_id_idx" ON "order_items"("merchant_product_id");
CREATE INDEX IF NOT EXISTS "order_items_platform_shop_product_id_idx" ON "order_items"("platform_shop_product_id");
CREATE INDEX IF NOT EXISTS "order_items_sale_source_type_created_at_idx" ON "order_items"("sale_source_type", "created_at");
ALTER TABLE "order_items" DROP CONSTRAINT IF EXISTS "order_items_sale_source_check";
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_sale_source_check"
  CHECK (
    ("sale_source_type" = 'agent_product' AND "agent_product_id" IS NOT NULL AND "merchant_product_id" IS NULL AND "platform_shop_product_id" IS NULL)
    OR ("sale_source_type" = 'merchant_product' AND "agent_product_id" IS NULL AND "merchant_product_id" IS NOT NULL AND "platform_shop_product_id" IS NULL)
    OR ("sale_source_type" = 'platform_shop_product' AND "agent_product_id" IS NULL AND "merchant_product_id" IS NULL AND "platform_shop_product_id" IS NOT NULL)
  );

DROP TRIGGER IF EXISTS order_items_owner_check ON order_items;
DROP FUNCTION IF EXISTS validate_order_item_owner();

ALTER TABLE "fulfillment_records"
  ALTER COLUMN "agent_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "merchant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "shop_id" TEXT,
  ADD COLUMN IF NOT EXISTS "virtual_code_id" TEXT,
  ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "fulfillment_records_idempotency_key_key" ON "fulfillment_records"("idempotency_key");
CREATE INDEX IF NOT EXISTS "fulfillment_records_merchant_id_status_idx" ON "fulfillment_records"("merchant_id", "status");
CREATE INDEX IF NOT EXISTS "fulfillment_records_order_item_id_idx" ON "fulfillment_records"("order_item_id");
CREATE INDEX IF NOT EXISTS "fulfillment_records_virtual_code_id_idx" ON "fulfillment_records"("virtual_code_id");

ALTER TABLE "after_sales" ADD COLUMN IF NOT EXISTS "merchant_id" TEXT;
CREATE INDEX IF NOT EXISTS "after_sales_merchant_id_status_idx" ON "after_sales"("merchant_id", "status");

ALTER TABLE "deposit_accounts"
  ALTER COLUMN "agent_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "merchant_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "deposit_accounts_merchant_id_key" ON "deposit_accounts"("merchant_id");
ALTER TABLE "deposit_accounts" DROP CONSTRAINT IF EXISTS "deposit_accounts_subject_check";
ALTER TABLE "deposit_accounts"
  ADD CONSTRAINT "deposit_accounts_subject_check"
  CHECK (("agent_id" IS NOT NULL)::int + ("merchant_id" IS NOT NULL)::int = 1);

ALTER TABLE "deposit_transactions"
  ALTER COLUMN "agent_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "merchant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "note" TEXT;
CREATE INDEX IF NOT EXISTS "deposit_transactions_merchant_id_created_at_idx" ON "deposit_transactions"("merchant_id", "created_at");
ALTER TABLE "deposit_transactions" DROP CONSTRAINT IF EXISTS "deposit_transactions_subject_check";
ALTER TABLE "deposit_transactions"
  ADD CONSTRAINT "deposit_transactions_subject_check"
  CHECK (("agent_id" IS NOT NULL)::int + ("merchant_id" IS NOT NULL)::int = 1);
DROP TRIGGER IF EXISTS deposit_transactions_owner_check ON deposit_transactions;
DROP FUNCTION IF EXISTS validate_deposit_transaction_owner();

ALTER TABLE "channel_relations"
  ALTER COLUMN "first_tier_agent_id" DROP NOT NULL,
  ALTER COLUMN "second_tier_agent_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "relation_type" "ChannelRelationType" NOT NULL DEFAULT 'two_tier',
  ADD COLUMN IF NOT EXISTS "first_tier_merchant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "second_tier_merchant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "third_tier_merchant_id" TEXT;
CREATE INDEX IF NOT EXISTS "channel_relations_first_tier_merchant_id_status_idx" ON "channel_relations"("first_tier_merchant_id", "status");
CREATE INDEX IF NOT EXISTS "channel_relations_second_tier_merchant_id_status_idx" ON "channel_relations"("second_tier_merchant_id", "status");
CREATE INDEX IF NOT EXISTS "channel_relations_third_tier_merchant_id_status_idx" ON "channel_relations"("third_tier_merchant_id", "status");
ALTER TABLE "channel_relations" DROP CONSTRAINT IF EXISTS "channel_relations_no_self_relation_check";
ALTER TABLE "channel_relations" DROP CONSTRAINT IF EXISTS "channel_relations_no_three_tier_self_relation_check";
ALTER TABLE "channel_relations"
  ADD CONSTRAINT "channel_relations_merchant_shape_check"
  CHECK (
    ("relation_type" = 'two_tier' AND "third_tier_merchant_id" IS NULL)
    OR ("relation_type" = 'three_tier' AND "third_tier_merchant_id" IS NOT NULL)
  );
ALTER TABLE "channel_relations"
  ADD CONSTRAINT "channel_relations_no_fourth_tier_check"
  CHECK ("relation_type" IN ('two_tier', 'three_tier'));
ALTER TABLE "channel_relations"
  ADD CONSTRAINT "channel_relations_no_merchant_self_relation_check"
  CHECK (
    "first_tier_merchant_id" IS NULL
    OR (
      "first_tier_merchant_id" IS DISTINCT FROM "second_tier_merchant_id"
      AND "first_tier_merchant_id" IS DISTINCT FROM "third_tier_merchant_id"
      AND "second_tier_merchant_id" IS DISTINCT FROM "third_tier_merchant_id"
    )
  );

CREATE OR REPLACE FUNCTION channel_relations_active_unique_key_set()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'active' THEN
    IF NEW.third_tier_merchant_id IS NOT NULL THEN
      NEW.active_unique_key := 'three-tier:' || NEW.first_tier_merchant_id || ':' || NEW.second_tier_merchant_id || ':' || NEW.third_tier_merchant_id;
    ELSIF NEW.second_tier_merchant_id IS NOT NULL THEN
      NEW.active_unique_key := 'two-tier:' || NEW.first_tier_merchant_id || ':' || NEW.second_tier_merchant_id;
    ELSE
      NEW.active_unique_key := 'legacy-two-tier:' || NEW.second_tier_agent_id;
    END IF;
  ELSE
    NEW.active_unique_key := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "channel_product_offers"
  ADD COLUMN IF NOT EXISTS "first_tier_supply_price_cents" BIGINT,
  ADD COLUMN IF NOT EXISTS "second_tier_supply_price_cents" BIGINT,
  ADD COLUMN IF NOT EXISTS "terminal_min_sale_price_cents" BIGINT;
ALTER TABLE "channel_product_offers" DROP CONSTRAINT IF EXISTS "channel_product_offers_tier_price_check";
ALTER TABLE "channel_product_offers"
  ADD CONSTRAINT "channel_product_offers_tier_price_check"
  CHECK (
    ("first_tier_supply_price_cents" IS NULL OR "first_tier_supply_price_cents" >= "resell_supply_price_cents")
    AND ("second_tier_supply_price_cents" IS NULL OR "first_tier_supply_price_cents" IS NULL OR "second_tier_supply_price_cents" >= "first_tier_supply_price_cents")
    AND ("terminal_min_sale_price_cents" IS NULL OR "second_tier_supply_price_cents" IS NULL OR "terminal_min_sale_price_cents" >= "second_tier_supply_price_cents")
  );

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "collection_channel_id" TEXT,
  ADD COLUMN IF NOT EXISTS "collection_snapshot_json" JSONB;
CREATE INDEX IF NOT EXISTS "payments_collection_channel_id_idx" ON "payments"("collection_channel_id");

CREATE TABLE "clearing_records" (
  "id" TEXT NOT NULL,
  "clearing_no" TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "shop_id" TEXT,
  "period_start" TIMESTAMP(3) NOT NULL,
  "period_end" TIMESTAMP(3) NOT NULL,
  "status" "ClearingRecordStatus" NOT NULL DEFAULT 'draft',
  "total_supply_payable_cents" BIGINT NOT NULL DEFAULT 0,
  "total_service_fee_cents" BIGINT NOT NULL DEFAULT 0,
  "total_clawback_cents" BIGINT NOT NULL DEFAULT 0,
  "total_coupon_subsidy_cents" BIGINT NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "created_by" TEXT,
  "confirmed_by" TEXT,
  "confirmed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clearing_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "clearing_records_clearing_no_key" ON "clearing_records"("clearing_no");
CREATE UNIQUE INDEX "clearing_records_idempotency_key_key" ON "clearing_records"("idempotency_key");
CREATE UNIQUE INDEX "clearing_records_merchant_period_idempotency_key" ON "clearing_records"("merchant_id", "period_start", "period_end", "idempotency_key");
CREATE INDEX "clearing_records_merchant_id_status_idx" ON "clearing_records"("merchant_id", "status");
CREATE INDEX "clearing_records_status_period_end_idx" ON "clearing_records"("status", "period_end");
ALTER TABLE "clearing_records"
  ADD CONSTRAINT "clearing_records_amounts_check"
  CHECK (
    "total_supply_payable_cents" >= 0
    AND "total_service_fee_cents" >= 0
    AND "total_clawback_cents" >= 0
    AND "total_coupon_subsidy_cents" >= 0
  );

CREATE TABLE "clearing_items" (
  "id" TEXT NOT NULL,
  "clearing_id" TEXT NOT NULL,
  "order_id" TEXT,
  "order_item_id" TEXT,
  "merchant_id" TEXT NOT NULL,
  "item_type" "ClearingItemType" NOT NULL,
  "amount_cents" BIGINT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "snapshot_json" JSONB NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "clearing_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "clearing_items_idempotency_key_key" ON "clearing_items"("idempotency_key");
CREATE INDEX "clearing_items_clearing_id_idx" ON "clearing_items"("clearing_id");
CREATE INDEX "clearing_items_merchant_id_created_at_idx" ON "clearing_items"("merchant_id", "created_at");
CREATE INDEX "clearing_items_source_type_source_id_idx" ON "clearing_items"("source_type", "source_id");
ALTER TABLE "clearing_items"
  ADD CONSTRAINT "clearing_items_amounts_check" CHECK ("amount_cents" >= 0);

CREATE TABLE "clearing_confirmations" (
  "id" TEXT NOT NULL,
  "clearing_id" TEXT NOT NULL,
  "status" "ClearingConfirmationStatus" NOT NULL DEFAULT 'pending',
  "confirmed_by" TEXT,
  "confirmed_at" TIMESTAMP(3),
  "voucher_url" TEXT,
  "note" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "clearing_confirmations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "clearing_confirmations_idempotency_key_key" ON "clearing_confirmations"("idempotency_key");
CREATE UNIQUE INDEX "clearing_confirmations_confirmed_unique"
  ON "clearing_confirmations"("clearing_id") WHERE "status" = 'confirmed';
CREATE INDEX "clearing_confirmations_clearing_id_status_idx" ON "clearing_confirmations"("clearing_id", "status");

CREATE TABLE "coupon_templates" (
  "id" TEXT NOT NULL,
  "coupon_no" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "discount_type" "CouponDiscountType" NOT NULL DEFAULT 'fixed_amount',
  "discount_amount_cents" BIGINT NOT NULL,
  "platform_subsidy_cents" BIGINT NOT NULL DEFAULT 0,
  "threshold_amount_cents" BIGINT NOT NULL DEFAULT 0,
  "stackable" BOOLEAN NOT NULL DEFAULT false,
  "first_registration_only" BOOLEAN NOT NULL DEFAULT false,
  "status" "CouponTemplateStatus" NOT NULL DEFAULT 'draft',
  "valid_from" TIMESTAMP(3) NOT NULL,
  "valid_to" TIMESTAMP(3) NOT NULL,
  "total_limit" INTEGER,
  "issued_count" INTEGER NOT NULL DEFAULT 0,
  "used_count" INTEGER NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "coupon_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "coupon_templates_coupon_no_key" ON "coupon_templates"("coupon_no");
CREATE UNIQUE INDEX "coupon_templates_idempotency_key_key" ON "coupon_templates"("idempotency_key");
CREATE INDEX "coupon_templates_status_valid_from_valid_to_idx" ON "coupon_templates"("status", "valid_from", "valid_to");
ALTER TABLE "coupon_templates"
  ADD CONSTRAINT "coupon_templates_amounts_and_counts_check"
  CHECK (
    "discount_amount_cents" >= 0
    AND "platform_subsidy_cents" >= 0
    AND "threshold_amount_cents" >= 0
    AND ("total_limit" IS NULL OR "total_limit" >= 0)
    AND "issued_count" >= 0
    AND "used_count" >= 0
    AND "used_count" <= "issued_count"
    AND "valid_to" > "valid_from"
  );

CREATE TABLE "coupon_scopes" (
  "id" TEXT NOT NULL,
  "coupon_template_id" TEXT NOT NULL,
  "scope_type" "CouponScopeType" NOT NULL,
  "platform_product_id" TEXT,
  "merchant_product_id" TEXT,
  "shop_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coupon_scopes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "coupon_scopes_coupon_template_id_idx" ON "coupon_scopes"("coupon_template_id");
CREATE INDEX "coupon_scopes_scope_type_platform_product_id_idx" ON "coupon_scopes"("scope_type", "platform_product_id");
CREATE INDEX "coupon_scopes_scope_type_merchant_product_id_idx" ON "coupon_scopes"("scope_type", "merchant_product_id");
CREATE INDEX "coupon_scopes_scope_type_shop_id_idx" ON "coupon_scopes"("scope_type", "shop_id");

CREATE TABLE "user_coupons" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "coupon_template_id" TEXT NOT NULL,
  "status" "CouponStatus" NOT NULL DEFAULT 'active',
  "source_type" TEXT NOT NULL,
  "source_id" TEXT,
  "valid_from" TIMESTAMP(3) NOT NULL,
  "valid_to" TIMESTAMP(3) NOT NULL,
  "void_reason" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_coupons_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_coupons_idempotency_key_key" ON "user_coupons"("idempotency_key");
CREATE INDEX "user_coupons_user_id_status_valid_to_idx" ON "user_coupons"("user_id", "status", "valid_to");
CREATE INDEX "user_coupons_coupon_template_id_status_idx" ON "user_coupons"("coupon_template_id", "status");
ALTER TABLE "user_coupons"
  ADD CONSTRAINT "user_coupons_validity_check" CHECK ("valid_to" > "valid_from");

CREATE TABLE "coupon_grant_records" (
  "id" TEXT NOT NULL,
  "user_coupon_id" TEXT NOT NULL,
  "coupon_template_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_id" TEXT,
  "granted_by" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coupon_grant_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "coupon_grant_records_idempotency_key_key" ON "coupon_grant_records"("idempotency_key");
CREATE INDEX "coupon_grant_records_user_id_created_at_idx" ON "coupon_grant_records"("user_id", "created_at");
CREATE INDEX "coupon_grant_records_coupon_template_id_created_at_idx" ON "coupon_grant_records"("coupon_template_id", "created_at");

CREATE TABLE "coupon_void_records" (
  "id" TEXT NOT NULL,
  "user_coupon_id" TEXT NOT NULL,
  "coupon_template_id" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_id" TEXT,
  "voided_by" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "coupon_void_records_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "coupon_void_records_idempotency_key_key" ON "coupon_void_records"("idempotency_key");
CREATE INDEX "coupon_void_records_user_coupon_id_created_at_idx" ON "coupon_void_records"("user_coupon_id", "created_at");
CREATE INDEX "coupon_void_records_coupon_template_id_created_at_idx" ON "coupon_void_records"("coupon_template_id", "created_at");

CREATE TABLE "coupon_usage" (
  "id" TEXT NOT NULL,
  "user_coupon_id" TEXT NOT NULL,
  "coupon_template_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "discount_cents" BIGINT NOT NULL,
  "subsidy_cents" BIGINT NOT NULL DEFAULT 0,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversed_at" TIMESTAMP(3),
  "reverse_reason" TEXT,
  CONSTRAINT "coupon_usage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "coupon_usage_idempotency_key_key" ON "coupon_usage"("idempotency_key");
CREATE UNIQUE INDEX "coupon_usage_user_coupon_id_order_id_key" ON "coupon_usage"("user_coupon_id", "order_id");
CREATE UNIQUE INDEX "coupon_usage_order_active_unique" ON "coupon_usage"("order_id") WHERE "reversed_at" IS NULL;
CREATE INDEX "coupon_usage_coupon_template_id_created_at_idx" ON "coupon_usage"("coupon_template_id", "created_at");
CREATE INDEX "coupon_usage_order_id_idx" ON "coupon_usage"("order_id");
ALTER TABLE "coupon_usage"
  ADD CONSTRAINT "coupon_usage_amounts_check" CHECK ("discount_cents" >= 0 AND "subsidy_cents" >= 0);

ALTER TABLE "ledger_entries"
  ADD COLUMN IF NOT EXISTS "merchant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "clearing_id" TEXT;
CREATE INDEX IF NOT EXISTS "ledger_entries_merchant_id_created_at_idx" ON "ledger_entries"("merchant_id", "created_at");
CREATE INDEX IF NOT EXISTS "ledger_entries_clearing_id_idx" ON "ledger_entries"("clearing_id");

CREATE TABLE "ledger_accounts" (
  "id" TEXT NOT NULL,
  "subject_type" "LedgerSubjectType" NOT NULL,
  "subject_id" TEXT NOT NULL,
  "account_type" "LedgerAccountType" NOT NULL,
  "balance_cents" BIGINT NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ledger_accounts_subject_type_subject_id_account_type_key"
  ON "ledger_accounts"("subject_type", "subject_id", "account_type");
ALTER TABLE "ledger_accounts"
  ADD CONSTRAINT "ledger_accounts_balance_check" CHECK ("balance_cents" >= 0 AND "version" >= 0);

ALTER TABLE "merchant_accounts"
  ADD CONSTRAINT "merchant_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_accounts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_accounts_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchants"
  ADD CONSTRAINT "merchants_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_invite_codes"
  ADD CONSTRAINT "merchant_invite_codes_issuer_merchant_id_fkey" FOREIGN KEY ("issuer_merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_invite_codes_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_applications"
  ADD CONSTRAINT "merchant_applications_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_applications_invite_code_id_fkey" FOREIGN KEY ("invite_code_id") REFERENCES "merchant_invite_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "shops"
  ADD CONSTRAINT "shops_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "shops_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "shop_collection_channels"
  ADD CONSTRAINT "shop_collection_channels_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "shop_collection_channels_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_product_reviews"
  ADD CONSTRAINT "merchant_product_reviews_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_product_reviews_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_product_reviews_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "merchant_products"
  ADD CONSTRAINT "merchant_products_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_products_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "merchant_products_own_product_review_id_fkey" FOREIGN KEY ("own_product_review_id") REFERENCES "merchant_product_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "virtual_code_batches"
  ADD CONSTRAINT "virtual_code_batches_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "virtual_codes"
  ADD CONSTRAINT "virtual_codes_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "virtual_codes_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "virtual_code_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "virtual_codes_reserved_order_id_fkey" FOREIGN KEY ("reserved_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "virtual_codes_issued_order_id_fkey" FOREIGN KEY ("issued_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "virtual_codes_reserved_order_item_id_fkey" FOREIGN KEY ("reserved_order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "virtual_codes_issued_order_item_id_fkey" FOREIGN KEY ("issued_order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "order_extract_secrets"
  ADD CONSTRAINT "order_extract_secrets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "order_extract_secrets_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "order_extract_secrets_virtual_code_id_fkey" FOREIGN KEY ("virtual_code_id") REFERENCES "virtual_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "order_extract_secrets_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "order_extract_logs"
  ADD CONSTRAINT "order_extract_logs_extract_secret_id_fkey" FOREIGN KEY ("extract_secret_id") REFERENCES "order_extract_secrets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "orders_collection_channel_id_fkey" FOREIGN KEY ("collection_channel_id") REFERENCES "shop_collection_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_merchant_product_id_fkey" FOREIGN KEY ("merchant_product_id") REFERENCES "merchant_products"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "order_items_platform_shop_product_id_fkey" FOREIGN KEY ("platform_shop_product_id") REFERENCES "platform_shop_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "fulfillment_records"
  ADD CONSTRAINT "fulfillment_records_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "fulfillment_records_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "fulfillment_records_virtual_code_id_fkey" FOREIGN KEY ("virtual_code_id") REFERENCES "virtual_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "after_sales"
  ADD CONSTRAINT "after_sales_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "deposit_accounts"
  ADD CONSTRAINT "deposit_accounts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "deposit_transactions"
  ADD CONSTRAINT "deposit_transactions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "channel_relations"
  ADD CONSTRAINT "channel_relations_first_tier_merchant_id_fkey" FOREIGN KEY ("first_tier_merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "channel_relations_second_tier_merchant_id_fkey" FOREIGN KEY ("second_tier_merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "channel_relations_third_tier_merchant_id_fkey" FOREIGN KEY ("third_tier_merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_collection_channel_id_fkey" FOREIGN KEY ("collection_channel_id") REFERENCES "shop_collection_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "clearing_records"
  ADD CONSTRAINT "clearing_records_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "clearing_records_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "clearing_items"
  ADD CONSTRAINT "clearing_items_clearing_id_fkey" FOREIGN KEY ("clearing_id") REFERENCES "clearing_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "clearing_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "clearing_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "clearing_items_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clearing_confirmations"
  ADD CONSTRAINT "clearing_confirmations_clearing_id_fkey" FOREIGN KEY ("clearing_id") REFERENCES "clearing_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "clearing_confirmations_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "coupon_templates"
  ADD CONSTRAINT "coupon_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "coupon_scopes"
  ADD CONSTRAINT "coupon_scopes_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "coupon_scopes_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "coupon_scopes_merchant_product_id_fkey" FOREIGN KEY ("merchant_product_id") REFERENCES "merchant_products"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "coupon_scopes_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_coupons"
  ADD CONSTRAINT "user_coupons_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "user_coupons_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "coupon_grant_records"
  ADD CONSTRAINT "coupon_grant_records_user_coupon_id_fkey" FOREIGN KEY ("user_coupon_id") REFERENCES "user_coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "coupon_grant_records_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "coupon_void_records"
  ADD CONSTRAINT "coupon_void_records_user_coupon_id_fkey" FOREIGN KEY ("user_coupon_id") REFERENCES "user_coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "coupon_void_records_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "coupon_usage"
  ADD CONSTRAINT "coupon_usage_user_coupon_id_fkey" FOREIGN KEY ("user_coupon_id") REFERENCES "user_coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "coupon_usage_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "coupon_usage_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "ledger_entries_clearing_id_fkey" FOREIGN KEY ("clearing_id") REFERENCES "clearing_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

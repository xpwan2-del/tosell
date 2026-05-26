-- Production foundation for H5 identities, platform self-operated listings,
-- controlled two-tier supply, payment channels, settlement roles, and ledger accounts.

CREATE TYPE "UserIdentityType" AS ENUM ('wechat_miniprogram', 'h5_phone', 'h5_guest', 'admin_mock');
CREATE TYPE "ChannelStatus" AS ENUM ('pending_review', 'active', 'frozen', 'closed', 'rejected');
CREATE TYPE "PaymentChannel" AS ENUM ('wechat_miniprogram', 'wechat_h5_jsapi', 'wechat_h5', 'alipay_wap', 'mock');
CREATE TYPE "SettlementRole" AS ENUM ('single_agent', 'first_tier', 'second_tier');

ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'platform_self_operated_revenue';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'platform_self_operated_fulfillment_cost';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'platform_payment_channel_fee';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'platform_self_operated_refund_cost';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'first_tier_pending_income';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'first_tier_payable_income';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'second_tier_pending_income';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'second_tier_payable_income';

ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'ORDER_PLATFORM_SELF_REVENUE';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'ORDER_PLATFORM_SELF_COST';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'ORDER_PAYMENT_CHANNEL_FEE';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'ORDER_FIRST_TIER_INCOME_PENDING';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'ORDER_SECOND_TIER_INCOME_PENDING';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'REFUND_FIRST_TIER_BEAR';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'REFUND_SECOND_TIER_BEAR';

ALTER TABLE "users" ALTER COLUMN "openid" DROP NOT NULL;

CREATE TABLE "user_identities" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "identity_type" "UserIdentityType" NOT NULL,
  "provider" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_identities_identity_type_provider_external_id_key"
  ON "user_identities"("identity_type", "provider", "external_id");
CREATE INDEX "user_identities_user_id_identity_type_idx"
  ON "user_identities"("user_id", "identity_type");

CREATE TABLE "platform_shop_products" (
  "id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "platform_product_id" TEXT NOT NULL,
  "sale_price_cents" BIGINT NOT NULL,
  "fulfillment_cost_cents" BIGINT NOT NULL DEFAULT 0,
  "status" "AgentProductStatus" NOT NULL DEFAULT 'listed',
  "listed_at" TIMESTAMP(3),
  "delisted_at" TIMESTAMP(3),
  "idempotency_key" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_shop_products_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_shop_products_shop_id_platform_product_id_key"
  ON "platform_shop_products"("shop_id", "platform_product_id");
CREATE UNIQUE INDEX "platform_shop_products_idempotency_key_key"
  ON "platform_shop_products"("idempotency_key");
CREATE INDEX "platform_shop_products_shop_id_status_idx"
  ON "platform_shop_products"("shop_id", "status");
CREATE INDEX "platform_shop_products_platform_product_id_status_idx"
  ON "platform_shop_products"("platform_product_id", "status");

CREATE TABLE "channel_authorizations" (
  "id" TEXT NOT NULL,
  "first_tier_agent_id" TEXT NOT NULL,
  "status" "ChannelStatus" NOT NULL DEFAULT 'pending_review',
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "reason" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "channel_authorizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_authorizations_first_tier_agent_id_key"
  ON "channel_authorizations"("first_tier_agent_id");
CREATE UNIQUE INDEX "channel_authorizations_idempotency_key_key"
  ON "channel_authorizations"("idempotency_key");
CREATE INDEX "channel_authorizations_status_created_at_idx"
  ON "channel_authorizations"("status", "created_at");

CREATE TABLE "channel_relations" (
  "id" TEXT NOT NULL,
  "first_tier_agent_id" TEXT NOT NULL,
  "second_tier_agent_id" TEXT NOT NULL,
  "status" "ChannelStatus" NOT NULL DEFAULT 'pending_review',
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "reason" TEXT,
  "active_unique_key" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "channel_relations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_relations_active_unique_key_key"
  ON "channel_relations"("active_unique_key");
CREATE UNIQUE INDEX "channel_relations_idempotency_key_key"
  ON "channel_relations"("idempotency_key");
CREATE INDEX "channel_relations_first_tier_agent_id_status_idx"
  ON "channel_relations"("first_tier_agent_id", "status");
CREATE INDEX "channel_relations_second_tier_agent_id_status_idx"
  ON "channel_relations"("second_tier_agent_id", "status");

CREATE TABLE "channel_product_offers" (
  "id" TEXT NOT NULL,
  "channel_relation_id" TEXT NOT NULL,
  "platform_product_id" TEXT NOT NULL,
  "resell_supply_price_cents" BIGINT NOT NULL,
  "status" "AgentProductStatus" NOT NULL DEFAULT 'listed',
  "listed_at" TIMESTAMP(3),
  "delisted_at" TIMESTAMP(3),
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "channel_product_offers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "channel_product_offers_channel_relation_id_platform_product_id_key"
  ON "channel_product_offers"("channel_relation_id", "platform_product_id");
CREATE UNIQUE INDEX "channel_product_offers_idempotency_key_key"
  ON "channel_product_offers"("idempotency_key");
CREATE INDEX "channel_product_offers_platform_product_id_status_idx"
  ON "channel_product_offers"("platform_product_id", "status");

CREATE TABLE "payment_channel_configs" (
  "id" TEXT NOT NULL,
  "channel" "PaymentChannel" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "fee_bps" INTEGER NOT NULL DEFAULT 0,
  "fixed_fee_cents" BIGINT NOT NULL DEFAULT 0,
  "config_json" JSONB,
  "status_note" TEXT,
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_channel_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_channel_configs_channel_key"
  ON "payment_channel_configs"("channel");

ALTER TABLE "orders"
  ADD COLUMN "client_type" TEXT,
  ADD COLUMN "first_tier_agent_id" TEXT,
  ADD COLUMN "second_tier_agent_id" TEXT,
  ADD COLUMN "channel_relation_id" TEXT;

CREATE INDEX "orders_first_tier_agent_id_created_at_idx" ON "orders"("first_tier_agent_id", "created_at");
CREATE INDEX "orders_second_tier_agent_id_created_at_idx" ON "orders"("second_tier_agent_id", "created_at");
CREATE INDEX "orders_channel_relation_id_created_at_idx" ON "orders"("channel_relation_id", "created_at");

ALTER TABLE "order_amount_snapshots"
  ADD COLUMN "platform_supply_price_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "resell_supply_price_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "final_sale_price_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "first_tier_income_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "second_tier_income_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "fulfillment_cost_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "payment_channel_fee_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "platform_gross_profit_cents" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "payments"
  ADD COLUMN "channel_fee_cents" BIGINT NOT NULL DEFAULT 0,
  ALTER COLUMN "channel" TYPE "PaymentChannel" USING (
    CASE "channel"
      WHEN 'wechat' THEN 'wechat_miniprogram'
      ELSE "channel"
    END
  )::"PaymentChannel";

ALTER TABLE "payment_callbacks"
  ALTER COLUMN "channel" TYPE "PaymentChannel" USING (
    CASE "channel"
      WHEN 'wechat' THEN 'wechat_miniprogram'
      ELSE "channel"
    END
  )::"PaymentChannel";

ALTER TABLE "refund_callbacks"
  ALTER COLUMN "channel" TYPE "PaymentChannel" USING (
    CASE "channel"
      WHEN 'wechat' THEN 'wechat_miniprogram'
      ELSE "channel"
    END
  )::"PaymentChannel";

ALTER TABLE "after_sales"
  ADD COLUMN "first_tier_bear_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "second_tier_bear_cents" BIGINT NOT NULL DEFAULT 0,
  ALTER COLUMN "agent_id" DROP NOT NULL;

ALTER TABLE "settlement_items"
  ALTER COLUMN "settlement_role" DROP DEFAULT,
  ALTER COLUMN "settlement_role" TYPE "SettlementRole" USING "settlement_role"::"SettlementRole",
  ALTER COLUMN "settlement_role" SET DEFAULT 'single_agent';

ALTER TABLE "clawbacks"
  ADD COLUMN "settlement_role" "SettlementRole";

ALTER TABLE "shops"
  ADD CONSTRAINT "shops_owner_agent_scope_check"
  CHECK (
    ("owner_type" = 'platform' AND "agent_id" IS NULL)
    OR ("owner_type" = 'agent' AND "agent_id" IS NOT NULL)
  );

ALTER TABLE "platform_shop_products"
  ADD CONSTRAINT "platform_shop_products_amounts_check"
  CHECK ("sale_price_cents" >= 0 AND "fulfillment_cost_cents" >= 0);

ALTER TABLE "channel_relations"
  ADD CONSTRAINT "channel_relations_no_self_relation_check"
  CHECK ("first_tier_agent_id" <> "second_tier_agent_id");

ALTER TABLE "channel_relations"
  ADD CONSTRAINT "channel_relations_active_unique_key_required_check"
  CHECK ("status" <> 'active' OR "active_unique_key" IS NOT NULL);

ALTER TABLE "channel_product_offers"
  ADD CONSTRAINT "channel_product_offers_amounts_check"
  CHECK ("resell_supply_price_cents" >= 0);

ALTER TABLE "payment_channel_configs"
  ADD CONSTRAINT "payment_channel_configs_amounts_check"
  CHECK ("fee_bps" >= 0 AND "fixed_fee_cents" >= 0);

ALTER TABLE "user_identities"
  ADD CONSTRAINT "user_identities_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "platform_shop_products"
  ADD CONSTRAINT "platform_shop_products_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "platform_shop_products_platform_product_id_fkey"
  FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "channel_authorizations"
  ADD CONSTRAINT "channel_authorizations_first_tier_agent_id_fkey"
  FOREIGN KEY ("first_tier_agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "channel_relations"
  ADD CONSTRAINT "channel_relations_first_tier_agent_id_fkey"
  FOREIGN KEY ("first_tier_agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "channel_relations_second_tier_agent_id_fkey"
  FOREIGN KEY ("second_tier_agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "channel_product_offers"
  ADD CONSTRAINT "channel_product_offers_channel_relation_id_fkey"
  FOREIGN KEY ("channel_relation_id") REFERENCES "channel_relations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "channel_product_offers_platform_product_id_fkey"
  FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_channel_relation_id_fkey"
  FOREIGN KEY ("channel_relation_id") REFERENCES "channel_relations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION channel_relations_active_unique_key_set()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'active' THEN
    NEW.active_unique_key := 'second-tier:' || NEW.second_tier_agent_id;
  ELSE
    NEW.active_unique_key := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER channel_relations_active_unique_key_set
BEFORE INSERT OR UPDATE OF status, second_tier_agent_id, active_unique_key
ON channel_relations
FOR EACH ROW EXECUTE FUNCTION channel_relations_active_unique_key_set();

CREATE OR REPLACE FUNCTION channel_product_offers_supply_price_check()
RETURNS trigger AS $$
DECLARE
  platform_supply BIGINT;
BEGIN
  SELECT supply_price_cents
    INTO platform_supply
    FROM platform_products
    WHERE id = NEW.platform_product_id;

  IF platform_supply IS NULL THEN
    RAISE EXCEPTION 'platform product not found';
  END IF;

  IF NEW.resell_supply_price_cents < platform_supply THEN
    RAISE EXCEPTION 'resell supply price cannot be below platform supply price';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER channel_product_offers_supply_price_check
BEFORE INSERT OR UPDATE OF platform_product_id, resell_supply_price_cents
ON channel_product_offers
FOR EACH ROW EXECUTE FUNCTION channel_product_offers_supply_price_check();

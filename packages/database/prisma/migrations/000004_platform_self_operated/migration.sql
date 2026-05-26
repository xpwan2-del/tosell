-- Platform self-operated shops, customer-service QR codes, and controlled two-tier settlement role keys.

ALTER TYPE "Responsibility" ADD VALUE IF NOT EXISTS 'first_tier';
ALTER TYPE "Responsibility" ADD VALUE IF NOT EXISTS 'second_tier';

CREATE TYPE "ShopOwnerType" AS ENUM ('platform', 'agent');
CREATE TYPE "SalesChannelType" AS ENUM ('platform_self_operated', 'single_agent', 'two_tier');

ALTER TABLE "shops"
  ADD COLUMN "owner_type" "ShopOwnerType" NOT NULL DEFAULT 'agent',
  ADD COLUMN "customer_service_qr_url" TEXT,
  ALTER COLUMN "agent_id" DROP NOT NULL;

CREATE INDEX "shops_owner_type_status_idx" ON "shops"("owner_type", "status");

ALTER TABLE "orders"
  ADD COLUMN "sales_channel_type" "SalesChannelType" NOT NULL DEFAULT 'single_agent',
  ADD COLUMN "platform_shop_id" TEXT,
  ALTER COLUMN "agent_id" DROP NOT NULL;

CREATE INDEX "orders_sales_channel_type_created_at_idx" ON "orders"("sales_channel_type", "created_at");

ALTER TABLE "settlement_items"
  DROP CONSTRAINT IF EXISTS "settlement_items_order_id_key";

DROP INDEX IF EXISTS "settlement_items_order_id_key";

ALTER TABLE "settlement_items"
  ADD COLUMN "settlement_role" TEXT NOT NULL DEFAULT 'single_agent';

CREATE UNIQUE INDEX "settlement_items_order_id_settlement_role_key"
  ON "settlement_items"("order_id", "settlement_role");

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_platform_shop_id_fkey"
  FOREIGN KEY ("platform_shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

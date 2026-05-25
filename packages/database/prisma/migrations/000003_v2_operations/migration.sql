-- V2 non-payment operations: shop decor, product groups, rights-code pool, notifications.

CREATE TYPE "RightsCodeStatus" AS ENUM ('available', 'issued', 'voided');

ALTER TABLE "shops"
  ADD COLUMN "theme_color" TEXT,
  ADD COLUMN "banner_url" TEXT,
  ADD COLUMN "share_title" TEXT;

CREATE TABLE "shop_product_groups" (
  "id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "agent_product_ids" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shop_product_groups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "shop_product_groups_shop_id_sort_order_idx"
  ON "shop_product_groups"("shop_id", "sort_order");

ALTER TABLE "shop_product_groups"
  ADD CONSTRAINT "shop_product_groups_shop_id_fkey"
  FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "platform_products"
  ADD COLUMN "category_name" TEXT,
  ADD COLUMN "tags_json" JSONB;

CREATE TABLE "rights_codes" (
  "id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "code_ciphertext" TEXT NOT NULL,
  "batch_no" TEXT NOT NULL,
  "status" "RightsCodeStatus" NOT NULL DEFAULT 'available',
  "order_id" TEXT,
  "issue_key" TEXT,
  "imported_by" TEXT,
  "issued_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rights_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rights_codes_product_id_code_ciphertext_key"
  ON "rights_codes"("product_id", "code_ciphertext");

CREATE UNIQUE INDEX "rights_codes_issue_key_key"
  ON "rights_codes"("issue_key");

CREATE INDEX "rights_codes_product_id_status_idx"
  ON "rights_codes"("product_id", "status");

CREATE INDEX "rights_codes_batch_no_idx"
  ON "rights_codes"("batch_no");

ALTER TABLE "rights_codes"
  ADD CONSTRAINT "rights_codes_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "platform_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rights_codes"
  ADD CONSTRAINT "rights_codes_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "agent_notifications" (
  "id" TEXT NOT NULL,
  "agent_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_notifications_agent_id_read_at_created_at_idx"
  ON "agent_notifications"("agent_id", "read_at", "created_at");

ALTER TABLE "agent_notifications"
  ADD CONSTRAINT "agent_notifications_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shops"
  ADD CONSTRAINT "shops_theme_color_check"
  CHECK (theme_color IS NULL OR theme_color ~ '^#[0-9A-Fa-f]{6}$');

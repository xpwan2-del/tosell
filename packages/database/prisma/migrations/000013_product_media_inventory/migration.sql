ALTER TABLE "platform_products"
  ADD COLUMN IF NOT EXISTS "image_url" TEXT,
  ADD COLUMN IF NOT EXISTS "specs_json" JSONB,
  ADD COLUMN IF NOT EXISTS "detail_sections_json" JSONB,
  ADD COLUMN IF NOT EXISTS "stock_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "sold_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "platform_products"
  ADD CONSTRAINT "platform_products_stock_count_check" CHECK ("stock_count" >= 0),
  ADD CONSTRAINT "platform_products_sold_count_check" CHECK ("sold_count" >= 0);

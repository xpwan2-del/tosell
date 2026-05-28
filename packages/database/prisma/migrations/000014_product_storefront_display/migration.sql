ALTER TABLE "platform_products"
  ADD COLUMN IF NOT EXISTS "display_badge" TEXT,
  ADD COLUMN IF NOT EXISTS "is_recommended" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "display_sort" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "platform_products_recommended_sort_idx"
  ON "platform_products"("is_recommended", "display_sort");

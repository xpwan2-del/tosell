-- AlterTable
ALTER TABLE "rights_codes" ADD COLUMN IF NOT EXISTS "merchant_product_id" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "rights_codes_merchant_product_id_status_idx" ON "rights_codes"("merchant_product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "rights_codes_merchant_product_id_code_ciphertext_key" ON "rights_codes"("merchant_product_id", "code_ciphertext");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rights_codes_merchant_product_id_fkey'
  ) THEN
    ALTER TABLE "rights_codes"
      ADD CONSTRAINT "rights_codes_merchant_product_id_fkey"
      FOREIGN KEY ("merchant_product_id") REFERENCES "merchant_products"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "rights_codes" ADD COLUMN IF NOT EXISTS "agent_product_id" TEXT;

ALTER TABLE "rights_codes" ALTER COLUMN "product_id" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rights_codes_agent_product_id_fkey'
  ) THEN
    ALTER TABLE "rights_codes"
      ADD CONSTRAINT "rights_codes_agent_product_id_fkey"
      FOREIGN KEY ("agent_product_id") REFERENCES "agent_products"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "rights_codes_agent_product_id_code_ciphertext_key"
  ON "rights_codes"("agent_product_id", "code_ciphertext");

CREATE INDEX IF NOT EXISTS "rights_codes_agent_product_id_status_idx"
  ON "rights_codes"("agent_product_id", "status");

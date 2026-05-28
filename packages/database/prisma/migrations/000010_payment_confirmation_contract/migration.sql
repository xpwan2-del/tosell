-- P0 production contract: manual/self-collection confirmation records.

DO $$ BEGIN
  CREATE TYPE "PaymentConfirmationStatus" AS ENUM ('pending', 'confirmed', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "payment_confirmations" (
  "id" TEXT NOT NULL,
  "confirmation_no" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "payment_id" TEXT,
  "shop_id" TEXT NOT NULL,
  "collection_channel_id" TEXT,
  "amount_cents" BIGINT NOT NULL,
  "payer_name" TEXT,
  "voucher_url" TEXT,
  "note" TEXT,
  "status" "PaymentConfirmationStatus" NOT NULL DEFAULT 'pending',
  "reviewed_by" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "reject_reason" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_confirmations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "payment_confirmations_confirmation_no_key"
  ON "payment_confirmations"("confirmation_no");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_confirmations_idempotency_key_key"
  ON "payment_confirmations"("idempotency_key");
CREATE INDEX IF NOT EXISTS "payment_confirmations_order_id_status_idx"
  ON "payment_confirmations"("order_id", "status");
CREATE INDEX IF NOT EXISTS "payment_confirmations_shop_id_status_created_at_idx"
  ON "payment_confirmations"("shop_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "payment_confirmations_collection_channel_id_idx"
  ON "payment_confirmations"("collection_channel_id");

ALTER TABLE "payment_confirmations" DROP CONSTRAINT IF EXISTS "payment_confirmations_amount_check";
ALTER TABLE "payment_confirmations"
  ADD CONSTRAINT "payment_confirmations_amount_check" CHECK ("amount_cents" > 0);

ALTER TABLE "payment_confirmations" DROP CONSTRAINT IF EXISTS "payment_confirmations_order_id_fkey";
ALTER TABLE "payment_confirmations"
  ADD CONSTRAINT "payment_confirmations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_confirmations" DROP CONSTRAINT IF EXISTS "payment_confirmations_payment_id_fkey";
ALTER TABLE "payment_confirmations"
  ADD CONSTRAINT "payment_confirmations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payment_confirmations" DROP CONSTRAINT IF EXISTS "payment_confirmations_shop_id_fkey";
ALTER TABLE "payment_confirmations"
  ADD CONSTRAINT "payment_confirmations_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_confirmations" DROP CONSTRAINT IF EXISTS "payment_confirmations_collection_channel_id_fkey";
ALTER TABLE "payment_confirmations"
  ADD CONSTRAINT "payment_confirmations_collection_channel_id_fkey" FOREIGN KEY ("collection_channel_id") REFERENCES "shop_collection_channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;

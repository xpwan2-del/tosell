-- Extend controlled channel supply from two-tier to three-tier price-spread resale.

ALTER TYPE "Responsibility" ADD VALUE IF NOT EXISTS 'third_tier';
ALTER TYPE "SalesChannelType" ADD VALUE IF NOT EXISTS 'three_tier';
ALTER TYPE "SettlementRole" ADD VALUE IF NOT EXISTS 'third_tier';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'third_tier_pending_income';
ALTER TYPE "LedgerAccountType" ADD VALUE IF NOT EXISTS 'third_tier_payable_income';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'ORDER_THIRD_TIER_INCOME_PENDING';
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'REFUND_THIRD_TIER_BEAR';

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "third_tier_agent_id" TEXT;

CREATE INDEX IF NOT EXISTS "orders_third_tier_agent_id_created_at_idx"
  ON "orders"("third_tier_agent_id", "created_at");

ALTER TABLE "order_amount_snapshots"
  ADD COLUMN IF NOT EXISTS "first_tier_supply_price_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "second_tier_supply_price_cents" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "third_tier_income_cents" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "after_sales"
  ADD COLUMN IF NOT EXISTS "third_tier_bear_cents" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "channel_relations"
  ADD COLUMN IF NOT EXISTS "third_tier_agent_id" TEXT;

CREATE INDEX IF NOT EXISTS "channel_relations_third_tier_agent_id_status_idx"
  ON "channel_relations"("third_tier_agent_id", "status");

ALTER TABLE "channel_relations"
  ADD CONSTRAINT "channel_relations_third_tier_agent_id_fkey"
  FOREIGN KEY ("third_tier_agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "channel_relations"
  ADD CONSTRAINT "channel_relations_no_three_tier_self_relation_check"
  CHECK (
    "third_tier_agent_id" IS NULL
    OR (
      "first_tier_agent_id" <> "third_tier_agent_id"
      AND "second_tier_agent_id" <> "third_tier_agent_id"
    )
  );

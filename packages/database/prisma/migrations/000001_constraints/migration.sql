-- PostgreSQL constraints that Prisma schema cannot fully express.

ALTER TABLE agent_products
  ADD CONSTRAINT agent_products_type_reference_check
  CHECK (
    (
      product_type = 'platform'
      AND platform_product_id IS NOT NULL
      AND own_product_review_id IS NULL
    )
    OR (
      product_type = 'agent_owned'
      AND platform_product_id IS NULL
      AND own_product_review_id IS NOT NULL
    )
  );

CREATE UNIQUE INDEX risk_freezes_active_target_unique
  ON risk_freezes (target_type, target_id, freeze_type)
  WHERE status = 'active';

CREATE UNIQUE INDEX manual_payouts_paid_settlement_unique
  ON manual_payouts (settlement_id)
  WHERE status = 'paid';

CREATE OR REPLACE FUNCTION prevent_ledger_entry_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries are append-only; create a reversal entry instead';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ledger_entry_mutation();

CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION prevent_ledger_entry_mutation();

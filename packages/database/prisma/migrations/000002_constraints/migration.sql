-- PostgreSQL constraints that Prisma schema cannot fully express.

ALTER TABLE platform_products
  ADD CONSTRAINT platform_products_amounts_check
  CHECK (
    supply_price_cents >= 0
    AND min_sale_price_cents >= 0
    AND suggested_sale_price_cents >= 0
    AND min_sale_price_cents <= suggested_sale_price_cents
  );

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

ALTER TABLE agent_products
  ADD CONSTRAINT agent_products_amounts_check
  CHECK (sale_price_cents >= 0);

ALTER TABLE agent_product_reviews
  ADD CONSTRAINT agent_product_reviews_amounts_check
  CHECK (sale_price_cents >= 0);

ALTER TABLE orders
  ADD CONSTRAINT orders_amounts_check
  CHECK (paid_amount_cents >= 0);

ALTER TABLE order_items
  ADD CONSTRAINT order_items_amounts_check
  CHECK (
    quantity > 0
    AND sale_price_cents >= 0
    AND supply_price_cents >= 0
    AND service_fee_cents >= 0
    AND agent_income_cents >= 0
  );

ALTER TABLE order_items
  ADD CONSTRAINT order_items_totals_check
  CHECK (sale_price_cents * quantity = supply_price_cents * quantity + service_fee_cents + agent_income_cents);

ALTER TABLE order_amount_snapshots
  ADD CONSTRAINT order_amount_snapshots_amounts_check
  CHECK (
    service_fee_bps >= 0
    AND paid_amount_cents >= 0
    AND supply_amount_cents >= 0
    AND service_fee_cents >= 0
    AND agent_expected_income_cents >= 0
  );

ALTER TABLE payments
  ADD CONSTRAINT payments_amounts_check
  CHECK (amount_cents >= 0);

ALTER TABLE after_sales
  ADD CONSTRAINT after_sales_amounts_check
  CHECK (
    requested_refund_cents >= 0
    AND approved_refund_cents >= 0
    AND platform_bear_cents >= 0
    AND agent_bear_cents >= 0
    AND service_fee_refund_cents >= 0
    AND approved_refund_cents <= requested_refund_cents
  );

ALTER TABLE refunds
  ADD CONSTRAINT refunds_amounts_check
  CHECK (amount_cents > 0);

ALTER TABLE settlement_sheets
  ADD CONSTRAINT settlement_sheets_amounts_check
  CHECK (
    total_order_count >= 0
    AND total_paid_cents >= 0
    AND total_service_fee_cents >= 0
    AND total_agent_income_cents >= 0
  );

ALTER TABLE settlement_items
  ADD CONSTRAINT settlement_items_amounts_check
  CHECK (
    paid_amount_cents >= 0
    AND supply_amount_cents >= 0
    AND service_fee_cents >= 0
    AND agent_income_cents >= 0
    AND deducted_cents >= 0
    AND settle_amount_cents >= 0
  );

ALTER TABLE manual_payouts
  ADD CONSTRAINT manual_payouts_amounts_check
  CHECK (amount_cents >= 0);

ALTER TABLE deposit_accounts
  ADD CONSTRAINT deposit_accounts_amounts_check
  CHECK (
    required_amount_cents >= 0
    AND available_amount_cents >= 0
    AND frozen_amount_cents >= 0
    AND deducted_amount_cents >= 0
  );

ALTER TABLE deposit_transactions
  ADD CONSTRAINT deposit_transactions_amounts_check
  CHECK (
    amount_cents >= 0
    AND balance_before_cents >= 0
    AND balance_after_cents >= 0
  );

ALTER TABLE clawbacks
  ADD CONSTRAINT clawbacks_amounts_check
  CHECK (amount_cents > 0);

ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_amounts_check
  CHECK (amount_cents >= 0);

CREATE UNIQUE INDEX risk_freezes_active_target_unique
  ON risk_freezes (target_type, target_id, freeze_type)
  WHERE status = 'active';

CREATE UNIQUE INDEX manual_payouts_paid_settlement_unique
  ON manual_payouts (settlement_id)
  WHERE status = 'paid';

CREATE UNIQUE INDEX shop_customer_service_active_unique
  ON shop_customer_service_bindings (shop_id)
  WHERE status = 'active';

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

CREATE OR REPLACE FUNCTION validate_agent_product_owner()
RETURNS trigger AS $$
DECLARE
  actual_agent_id text;
BEGIN
  SELECT agent_id INTO actual_agent_id FROM shops WHERE id = NEW.shop_id;
  IF actual_agent_id IS NULL OR actual_agent_id <> NEW.agent_id THEN
    RAISE EXCEPTION 'agent_products agent_id must match shop owner';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_products_owner_check
  BEFORE INSERT OR UPDATE OF agent_id, shop_id ON agent_products
  FOR EACH ROW
  EXECUTE FUNCTION validate_agent_product_owner();

CREATE OR REPLACE FUNCTION validate_agent_product_business_rules()
RETURNS trigger AS $$
DECLARE
  platform_min_sale_price bigint;
  platform_status text;
  own_agent_id text;
  own_shop_id text;
  own_review_status text;
  own_min_sale_price bigint;
BEGIN
  IF NEW.product_type = 'platform' THEN
    SELECT min_sale_price_cents, status
      INTO platform_min_sale_price, platform_status
      FROM platform_products
     WHERE id = NEW.platform_product_id;

    IF platform_min_sale_price IS NULL THEN
      RAISE EXCEPTION 'platform product is required';
    END IF;
    IF NEW.sale_price_cents < platform_min_sale_price THEN
      RAISE EXCEPTION 'agent product sale price cannot be below platform minimum sale price';
    END IF;
    IF NEW.status IN ('approved', 'listed') AND platform_status <> 'active' THEN
      RAISE EXCEPTION 'platform product must be active before agent product can be listed';
    END IF;
    RETURN NEW;
  END IF;

  SELECT agent_id, shop_id, status, sale_price_cents
    INTO own_agent_id, own_shop_id, own_review_status, own_min_sale_price
    FROM agent_product_reviews
   WHERE id = NEW.own_product_review_id;

  IF own_agent_id IS NULL
     OR own_agent_id <> NEW.agent_id
     OR own_shop_id <> NEW.shop_id THEN
    RAISE EXCEPTION 'own product review must belong to the same agent/shop';
  END IF;
  IF NEW.sale_price_cents < own_min_sale_price THEN
    RAISE EXCEPTION 'own product sale price cannot be below submitted minimum sale price';
  END IF;
  IF NEW.status IN ('approved', 'listed') AND own_review_status <> 'approved' THEN
    RAISE EXCEPTION 'own product must be approved before listing';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_products_business_rules_check
  BEFORE INSERT OR UPDATE OF product_type, platform_product_id, own_product_review_id, sale_price_cents, status ON agent_products
  FOR EACH ROW
  EXECUTE FUNCTION validate_agent_product_business_rules();

CREATE OR REPLACE FUNCTION validate_order_amount_snapshot_totals()
RETURNS trigger AS $$
DECLARE
  order_paid_amount bigint;
  order_payment_status text;
  item_paid_amount bigint;
  item_supply_amount bigint;
  item_service_fee_amount bigint;
  item_agent_income_amount bigint;
BEGIN
  IF NEW.paid_amount_cents <> NEW.supply_amount_cents + NEW.service_fee_cents + NEW.agent_expected_income_cents THEN
    RAISE EXCEPTION 'order amount snapshot totals do not balance';
  END IF;

  SELECT paid_amount_cents, payment_status
    INTO order_paid_amount, order_payment_status
    FROM orders
   WHERE id = NEW.order_id;

  IF order_payment_status = 'paid' AND order_paid_amount <> NEW.paid_amount_cents THEN
    RAISE EXCEPTION 'order amount snapshot must match paid order amount';
  END IF;

  SELECT
    COALESCE(SUM(sale_price_cents * quantity), 0),
    COALESCE(SUM(supply_price_cents * quantity), 0),
    COALESCE(SUM(service_fee_cents), 0),
    COALESCE(SUM(agent_income_cents), 0)
    INTO item_paid_amount, item_supply_amount, item_service_fee_amount, item_agent_income_amount
    FROM order_items
   WHERE order_id = NEW.order_id;

  IF item_paid_amount > 0
     AND (
       item_paid_amount <> NEW.paid_amount_cents
       OR item_supply_amount <> NEW.supply_amount_cents
       OR item_service_fee_amount <> NEW.service_fee_cents
       OR item_agent_income_amount <> NEW.agent_expected_income_cents
     ) THEN
    RAISE EXCEPTION 'order amount snapshot must match order item totals';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_amount_snapshots_totals_check
  BEFORE INSERT OR UPDATE OF paid_amount_cents, supply_amount_cents, service_fee_cents, agent_expected_income_cents ON order_amount_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION validate_order_amount_snapshot_totals();

CREATE OR REPLACE FUNCTION validate_order_item_owner()
RETURNS trigger AS $$
DECLARE
  order_agent_id text;
  order_shop_id text;
  product_agent_id text;
  product_shop_id text;
BEGIN
  SELECT agent_id, shop_id INTO order_agent_id, order_shop_id FROM orders WHERE id = NEW.order_id;
  SELECT agent_id, shop_id INTO product_agent_id, product_shop_id FROM agent_products WHERE id = NEW.agent_product_id;
  IF order_agent_id IS NULL OR product_agent_id IS NULL
     OR order_agent_id <> product_agent_id
     OR order_shop_id <> product_shop_id THEN
    RAISE EXCEPTION 'order_items agent_product must belong to the same order agent/shop';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_items_owner_check
  BEFORE INSERT OR UPDATE OF order_id, agent_product_id ON order_items
  FOR EACH ROW
  EXECUTE FUNCTION validate_order_item_owner();

CREATE OR REPLACE FUNCTION validate_after_sale_owner()
RETURNS trigger AS $$
DECLARE
  order_user_id text;
  order_agent_id text;
  order_shop_id text;
BEGIN
  SELECT user_id, agent_id, shop_id
    INTO order_user_id, order_agent_id, order_shop_id
    FROM orders
   WHERE id = NEW.order_id;

  IF order_user_id IS NULL
     OR order_user_id <> NEW.user_id
     OR order_agent_id <> NEW.agent_id
     OR order_shop_id <> NEW.shop_id THEN
    RAISE EXCEPTION 'after_sales must match order user/agent/shop';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_sales_owner_check
  BEFORE INSERT OR UPDATE OF order_id, user_id, agent_id, shop_id ON after_sales
  FOR EACH ROW
  EXECUTE FUNCTION validate_after_sale_owner();

CREATE OR REPLACE FUNCTION validate_refund_links()
RETURNS trigger AS $$
DECLARE
  after_sale_order_id text;
  payment_order_id text;
BEGIN
  SELECT order_id INTO after_sale_order_id FROM after_sales WHERE id = NEW.after_sale_id;
  SELECT order_id INTO payment_order_id FROM payments WHERE id = NEW.payment_id;
  IF after_sale_order_id IS NULL OR payment_order_id IS NULL
     OR after_sale_order_id <> NEW.order_id
     OR payment_order_id <> NEW.order_id THEN
    RAISE EXCEPTION 'refunds after_sale/payment must belong to the same order';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refunds_link_check
  BEFORE INSERT OR UPDATE OF after_sale_id, order_id, payment_id ON refunds
  FOR EACH ROW
  EXECUTE FUNCTION validate_refund_links();

CREATE OR REPLACE FUNCTION prevent_refund_over_paid_amount()
RETURNS trigger AS $$
DECLARE
  order_paid_amount bigint;
  active_refund_total bigint;
BEGIN
  SELECT paid_amount_cents INTO order_paid_amount FROM orders WHERE id = NEW.order_id;
  SELECT COALESCE(SUM(amount_cents), 0)
    INTO active_refund_total
    FROM refunds
   WHERE order_id = NEW.order_id
     AND id <> NEW.id
     AND status IN ('pending', 'refunding', 'refunded');

  IF NEW.status IN ('pending', 'refunding', 'refunded') THEN
    active_refund_total := active_refund_total + NEW.amount_cents;
  END IF;

  IF order_paid_amount IS NULL OR active_refund_total > order_paid_amount THEN
    RAISE EXCEPTION 'refund total cannot exceed order paid amount';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refunds_total_check
  BEFORE INSERT OR UPDATE OF order_id, amount_cents, status ON refunds
  FOR EACH ROW
  EXECUTE FUNCTION prevent_refund_over_paid_amount();

CREATE OR REPLACE FUNCTION validate_settlement_item_owner()
RETURNS trigger AS $$
DECLARE
  order_agent_id text;
  order_shop_id text;
  sheet_agent_id text;
BEGIN
  SELECT agent_id, shop_id INTO order_agent_id, order_shop_id FROM orders WHERE id = NEW.order_id;
  SELECT agent_id INTO sheet_agent_id FROM settlement_sheets WHERE id = NEW.settlement_id;
  IF order_agent_id IS NULL OR sheet_agent_id IS NULL
     OR order_agent_id <> NEW.agent_id
     OR order_shop_id <> NEW.shop_id
     OR sheet_agent_id <> NEW.agent_id THEN
    RAISE EXCEPTION 'settlement_items must match order and settlement agent/shop';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlement_items_owner_check
  BEFORE INSERT OR UPDATE OF settlement_id, order_id, agent_id, shop_id ON settlement_items
  FOR EACH ROW
  EXECUTE FUNCTION validate_settlement_item_owner();

CREATE OR REPLACE FUNCTION validate_manual_payout_owner()
RETURNS trigger AS $$
DECLARE
  sheet_agent_id text;
BEGIN
  SELECT agent_id INTO sheet_agent_id FROM settlement_sheets WHERE id = NEW.settlement_id;
  IF sheet_agent_id IS NULL OR sheet_agent_id <> NEW.agent_id THEN
    RAISE EXCEPTION 'manual_payouts agent_id must match settlement_sheets agent_id';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manual_payouts_owner_check
  BEFORE INSERT OR UPDATE OF settlement_id, agent_id ON manual_payouts
  FOR EACH ROW
  EXECUTE FUNCTION validate_manual_payout_owner();

CREATE OR REPLACE FUNCTION validate_deposit_transaction_owner()
RETURNS trigger AS $$
DECLARE
  account_agent_id text;
BEGIN
  SELECT agent_id INTO account_agent_id FROM deposit_accounts WHERE id = NEW.account_id;
  IF account_agent_id IS NULL OR account_agent_id <> NEW.agent_id THEN
    RAISE EXCEPTION 'deposit_transactions agent_id must match deposit account';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deposit_transactions_owner_check
  BEFORE INSERT OR UPDATE OF agent_id, account_id ON deposit_transactions
  FOR EACH ROW
  EXECUTE FUNCTION validate_deposit_transaction_owner();

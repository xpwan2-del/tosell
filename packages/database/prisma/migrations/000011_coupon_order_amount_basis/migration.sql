-- Platform coupons reduce buyer-paid cash but do not reduce the order item
-- sale amount, service-fee basis, supply cost, or agent/channel margin basis.

CREATE OR REPLACE FUNCTION validate_order_amount_snapshot_totals()
RETURNS trigger AS $$
DECLARE
  order_paid_amount bigint;
  order_coupon_discount bigint;
  order_payment_status text;
  item_paid_amount bigint;
  item_supply_amount bigint;
  item_service_fee_amount bigint;
  item_agent_income_amount bigint;
BEGIN
  IF NEW.paid_amount_cents <> NEW.supply_amount_cents + NEW.service_fee_cents + NEW.agent_expected_income_cents THEN
    RAISE EXCEPTION 'order amount snapshot totals do not balance';
  END IF;

  SELECT paid_amount_cents, coupon_discount_cents, payment_status
    INTO order_paid_amount, order_coupon_discount, order_payment_status
    FROM orders
   WHERE id = NEW.order_id;

  IF order_payment_status = 'paid'
     AND (order_paid_amount + COALESCE(order_coupon_discount, 0)) <> NEW.paid_amount_cents THEN
    RAISE EXCEPTION 'order amount snapshot must match paid order amount plus coupon discount';
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

ALTER TABLE "rights_codes"
  ADD CONSTRAINT "rights_codes_owner_shape_check"
  CHECK (
    ("product_id" IS NOT NULL AND "agent_product_id" IS NULL)
    OR
    ("product_id" IS NULL AND "agent_product_id" IS NOT NULL)
  ) NOT VALID;

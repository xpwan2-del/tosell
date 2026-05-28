-- Production auth sessions, manual refund confirmation, and plaintext code access audit.

DO $$ BEGIN
  CREATE TYPE "AuthSubjectType" AS ENUM ('admin', 'merchant', 'agent', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "AuthSessionStatus" AS ENUM ('active', 'revoked', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "CodePlaintextAccessType" AS ENUM ('view', 'export');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "ActorType" ADD VALUE IF NOT EXISTS 'merchant';

CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "id" TEXT NOT NULL,
  "session_no" TEXT NOT NULL,
  "subject_type" "AuthSubjectType" NOT NULL,
  "user_id" TEXT,
  "admin_user_id" TEXT,
  "merchant_account_id" TEXT,
  "merchant_id" TEXT,
  "agent_id" TEXT,
  "token_hash" TEXT NOT NULL,
  "refresh_token_hash" TEXT,
  "status" "AuthSessionStatus" NOT NULL DEFAULT 'active',
  "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "last_seen_at" TIMESTAMP(3),
  "ip" TEXT,
  "user_agent" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_session_no_key" ON "auth_sessions"("session_no");
CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_refresh_token_hash_key" ON "auth_sessions"("refresh_token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_idempotency_key_key" ON "auth_sessions"("idempotency_key");
CREATE INDEX IF NOT EXISTS "auth_sessions_subject_type_status_expires_at_idx" ON "auth_sessions"("subject_type", "status", "expires_at");
CREATE INDEX IF NOT EXISTS "auth_sessions_user_id_status_idx" ON "auth_sessions"("user_id", "status");
CREATE INDEX IF NOT EXISTS "auth_sessions_admin_user_id_status_idx" ON "auth_sessions"("admin_user_id", "status");
CREATE INDEX IF NOT EXISTS "auth_sessions_merchant_account_id_status_idx" ON "auth_sessions"("merchant_account_id", "status");
CREATE INDEX IF NOT EXISTS "auth_sessions_merchant_id_status_idx" ON "auth_sessions"("merchant_id", "status");
CREATE INDEX IF NOT EXISTS "auth_sessions_agent_id_status_idx" ON "auth_sessions"("agent_id", "status");

ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_subject_shape_check";
ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_subject_shape_check"
  CHECK (
    ("subject_type" = 'admin' AND "admin_user_id" IS NOT NULL AND "merchant_account_id" IS NULL AND "merchant_id" IS NULL AND "agent_id" IS NULL)
    OR ("subject_type" = 'merchant' AND "merchant_account_id" IS NOT NULL AND "merchant_id" IS NOT NULL AND "admin_user_id" IS NULL AND "agent_id" IS NULL)
    OR ("subject_type" = 'agent' AND "agent_id" IS NOT NULL AND "admin_user_id" IS NULL AND "merchant_account_id" IS NULL AND "merchant_id" IS NULL)
    OR ("subject_type" = 'user' AND "user_id" IS NOT NULL AND "admin_user_id" IS NULL AND "merchant_account_id" IS NULL AND "merchant_id" IS NULL AND "agent_id" IS NULL)
  );

ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_validity_check";
ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_validity_check"
  CHECK ("expires_at" > "issued_at" AND ("revoked_at" IS NULL OR "revoked_at" >= "issued_at"));

ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_user_id_fkey";
ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_admin_user_id_fkey";
ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_merchant_account_id_fkey";
ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_merchant_account_id_fkey" FOREIGN KEY ("merchant_account_id") REFERENCES "merchant_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_merchant_id_fkey";
ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "auth_sessions" DROP CONSTRAINT IF EXISTS "auth_sessions_agent_id_fkey";
ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "refund_manual_confirmations" (
  "id" TEXT NOT NULL,
  "confirmation_no" TEXT NOT NULL,
  "refund_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "amount_cents" BIGINT NOT NULL,
  "voucher_url" TEXT,
  "note" TEXT,
  "confirmed_by" TEXT,
  "confirmed_at" TIMESTAMP(3) NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refund_manual_confirmations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "refund_manual_confirmations_confirmation_no_key" ON "refund_manual_confirmations"("confirmation_no");
CREATE UNIQUE INDEX IF NOT EXISTS "refund_manual_confirmations_refund_id_key" ON "refund_manual_confirmations"("refund_id");
CREATE UNIQUE INDEX IF NOT EXISTS "refund_manual_confirmations_idempotency_key_key" ON "refund_manual_confirmations"("idempotency_key");
CREATE INDEX IF NOT EXISTS "refund_manual_confirmations_order_id_idx" ON "refund_manual_confirmations"("order_id");
CREATE INDEX IF NOT EXISTS "refund_manual_confirmations_confirmed_by_created_at_idx" ON "refund_manual_confirmations"("confirmed_by", "created_at");

ALTER TABLE "refund_manual_confirmations" DROP CONSTRAINT IF EXISTS "refund_manual_confirmations_amount_check";
ALTER TABLE "refund_manual_confirmations"
  ADD CONSTRAINT "refund_manual_confirmations_amount_check" CHECK ("amount_cents" > 0);

ALTER TABLE "refund_manual_confirmations" DROP CONSTRAINT IF EXISTS "refund_manual_confirmations_refund_id_fkey";
ALTER TABLE "refund_manual_confirmations"
  ADD CONSTRAINT "refund_manual_confirmations_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_manual_confirmations" DROP CONSTRAINT IF EXISTS "refund_manual_confirmations_order_id_fkey";
ALTER TABLE "refund_manual_confirmations"
  ADD CONSTRAINT "refund_manual_confirmations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_manual_confirmations" DROP CONSTRAINT IF EXISTS "refund_manual_confirmations_confirmed_by_fkey";
ALTER TABLE "refund_manual_confirmations"
  ADD CONSTRAINT "refund_manual_confirmations_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION validate_refund_manual_confirmation_links()
RETURNS trigger AS $$
DECLARE
  refund_order_id text;
  refund_amount_cents bigint;
BEGIN
  SELECT order_id, amount_cents INTO refund_order_id, refund_amount_cents FROM refunds WHERE id = NEW.refund_id;
  IF refund_order_id IS NULL OR refund_order_id <> NEW.order_id THEN
    RAISE EXCEPTION 'refund manual confirmation must match refund order';
  END IF;
  IF refund_amount_cents IS NULL OR refund_amount_cents <> NEW.amount_cents THEN
    RAISE EXCEPTION 'refund manual confirmation amount must match refund amount';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS refund_manual_confirmations_link_check ON "refund_manual_confirmations";
CREATE TRIGGER refund_manual_confirmations_link_check
  BEFORE INSERT OR UPDATE OF refund_id, order_id, amount_cents ON "refund_manual_confirmations"
  FOR EACH ROW
  EXECUTE FUNCTION validate_refund_manual_confirmation_links();

CREATE TABLE IF NOT EXISTS "code_plaintext_access_logs" (
  "id" TEXT NOT NULL,
  "access_no" TEXT NOT NULL,
  "access_type" "CodePlaintextAccessType" NOT NULL,
  "actor_type" "ActorType" NOT NULL,
  "actor_id" TEXT NOT NULL,
  "permission_code" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "product_id" TEXT,
  "batch_id" TEXT,
  "virtual_code_id" TEXT,
  "rights_code_id" TEXT,
  "order_id" TEXT,
  "order_item_id" TEXT,
  "reason" TEXT,
  "request_id" TEXT NOT NULL,
  "ip" TEXT,
  "user_agent" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "code_plaintext_access_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "code_plaintext_access_logs_access_no_key" ON "code_plaintext_access_logs"("access_no");
CREATE UNIQUE INDEX IF NOT EXISTS "code_plaintext_access_logs_idempotency_key_key" ON "code_plaintext_access_logs"("idempotency_key");
CREATE INDEX IF NOT EXISTS "code_plaintext_access_logs_actor_type_actor_id_created_at_idx" ON "code_plaintext_access_logs"("actor_type", "actor_id", "created_at");
CREATE INDEX IF NOT EXISTS "code_plaintext_access_logs_access_type_created_at_idx" ON "code_plaintext_access_logs"("access_type", "created_at");
CREATE INDEX IF NOT EXISTS "code_plaintext_access_logs_product_id_created_at_idx" ON "code_plaintext_access_logs"("product_id", "created_at");
CREATE INDEX IF NOT EXISTS "code_plaintext_access_logs_virtual_code_id_created_at_idx" ON "code_plaintext_access_logs"("virtual_code_id", "created_at");
CREATE INDEX IF NOT EXISTS "code_plaintext_access_logs_rights_code_id_created_at_idx" ON "code_plaintext_access_logs"("rights_code_id", "created_at");
CREATE INDEX IF NOT EXISTS "code_plaintext_access_logs_order_id_created_at_idx" ON "code_plaintext_access_logs"("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "code_plaintext_access_logs_request_id_idx" ON "code_plaintext_access_logs"("request_id");

ALTER TABLE "code_plaintext_access_logs" DROP CONSTRAINT IF EXISTS "code_plaintext_access_logs_target_check";
ALTER TABLE "code_plaintext_access_logs"
  ADD CONSTRAINT "code_plaintext_access_logs_target_check"
  CHECK (
    "target_type" <> ''
    AND (
      "product_id" IS NOT NULL
      OR "batch_id" IS NOT NULL
      OR "virtual_code_id" IS NOT NULL
      OR "rights_code_id" IS NOT NULL
      OR "order_id" IS NOT NULL
      OR "order_item_id" IS NOT NULL
    )
  );

ALTER TABLE "code_plaintext_access_logs" DROP CONSTRAINT IF EXISTS "code_plaintext_access_logs_product_id_fkey";
ALTER TABLE "code_plaintext_access_logs"
  ADD CONSTRAINT "code_plaintext_access_logs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "platform_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "code_plaintext_access_logs" DROP CONSTRAINT IF EXISTS "code_plaintext_access_logs_virtual_code_id_fkey";
ALTER TABLE "code_plaintext_access_logs"
  ADD CONSTRAINT "code_plaintext_access_logs_virtual_code_id_fkey" FOREIGN KEY ("virtual_code_id") REFERENCES "virtual_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "code_plaintext_access_logs" DROP CONSTRAINT IF EXISTS "code_plaintext_access_logs_rights_code_id_fkey";
ALTER TABLE "code_plaintext_access_logs"
  ADD CONSTRAINT "code_plaintext_access_logs_rights_code_id_fkey" FOREIGN KEY ("rights_code_id") REFERENCES "rights_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "code_plaintext_access_logs" DROP CONSTRAINT IF EXISTS "code_plaintext_access_logs_order_id_fkey";
ALTER TABLE "code_plaintext_access_logs"
  ADD CONSTRAINT "code_plaintext_access_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "code_plaintext_access_logs" DROP CONSTRAINT IF EXISTS "code_plaintext_access_logs_order_item_id_fkey";
ALTER TABLE "code_plaintext_access_logs"
  ADD CONSTRAINT "code_plaintext_access_logs_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION prevent_code_plaintext_access_log_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'code_plaintext_access_logs are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS code_plaintext_access_logs_no_update ON "code_plaintext_access_logs";
CREATE TRIGGER code_plaintext_access_logs_no_update
  BEFORE UPDATE ON "code_plaintext_access_logs"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_code_plaintext_access_log_mutation();

DROP TRIGGER IF EXISTS code_plaintext_access_logs_no_delete ON "code_plaintext_access_logs";
CREATE TRIGGER code_plaintext_access_logs_no_delete
  BEFORE DELETE ON "code_plaintext_access_logs"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_code_plaintext_access_log_mutation();

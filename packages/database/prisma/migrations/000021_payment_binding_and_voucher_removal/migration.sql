DO $$ BEGIN
  CREATE TYPE "PaymentProvider" AS ENUM ('alipay_merchant', 'wechat_merchant', 'epay', 'alipay_personal');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentConfirmMode" AS ENUM ('callback_query', 'manual_confirm');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentEnvironment" AS ENUM ('sandbox', 'production');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CollectionConfigOwnerType" AS ENUM ('platform', 'agent', 'merchant');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CollectionConfigStatus" AS ENUM ('disabled', 'pending_test', 'active', 'paused');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "CredentialStatus" AS ENUM ('not_configured', 'configured', 'expired', 'rotation_required');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentConfirmSource" AS ENUM ('unconfirmed', 'callback', 'query', 'manual_confirm');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentExceptionType" AS ENUM ('signature_failed', 'amount_mismatch', 'merchant_mismatch', 'duplicate_callback', 'order_not_found', 'refunded_order_callback', 'fulfilled_dispute', 'provider_error', 'manual_review');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentExceptionStatus" AS ENUM ('open', 'investigating', 'resolved', 'ignored');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentDisputeMaterialType" AS ENUM ('payment_screenshot', 'provider_notice', 'customer_note', 'admin_note', 'other');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PaymentDisputeMaterialStatus" AS ENUM ('submitted', 'reviewed', 'ignored');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "collection_payment_config_id" TEXT,
  ADD COLUMN IF NOT EXISTS "provider" "PaymentProvider",
  ADD COLUMN IF NOT EXISTS "confirm_mode" "PaymentConfirmMode",
  ADD COLUMN IF NOT EXISTS "environment" "PaymentEnvironment",
  ADD COLUMN IF NOT EXISTS "provider_payment_no" TEXT,
  ADD COLUMN IF NOT EXISTS "provider_trade_no" TEXT,
  ADD COLUMN IF NOT EXISTS "confirm_source" "PaymentConfirmSource" NOT NULL DEFAULT 'unconfirmed',
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "callback_handled_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "exception_reason" TEXT;

CREATE TABLE IF NOT EXISTS "collection_payment_configs" (
  "id" TEXT NOT NULL,
  "config_no" TEXT NOT NULL,
  "owner_type" "CollectionConfigOwnerType" NOT NULL,
  "owner_agent_id" TEXT,
  "owner_merchant_id" TEXT,
  "shop_id" TEXT,
  "provider" "PaymentProvider" NOT NULL,
  "confirm_mode" "PaymentConfirmMode" NOT NULL,
  "environment" "PaymentEnvironment" NOT NULL DEFAULT 'production',
  "status" "CollectionConfigStatus" NOT NULL DEFAULT 'pending_test',
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "display_name" TEXT NOT NULL,
  "merchant_no_masked" TEXT,
  "app_id_masked" TEXT,
  "service_provider_masked" TEXT,
  "credential_ref" TEXT,
  "credential_ciphertext" TEXT,
  "secret_version" INTEGER NOT NULL DEFAULT 1,
  "credential_status" "CredentialStatus" NOT NULL DEFAULT 'not_configured',
  "notify_url" TEXT,
  "return_url" TEXT,
  "test_status" TEXT,
  "last_test_at" TIMESTAMP(3),
  "last_test_result_json" JSONB,
  "last_callback_at" TIMESTAMP(3),
  "qr_url" TEXT,
  "account_masked" TEXT,
  "instruction" TEXT,
  "created_by_type" "ActorType" NOT NULL DEFAULT 'system',
  "created_by_id" TEXT,
  "updated_by_type" "ActorType",
  "updated_by_id" TEXT,
  "enabled_at" TIMESTAMP(3),
  "disabled_at" TIMESTAMP(3),
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "collection_payment_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "payment_snapshots" (
  "id" TEXT NOT NULL,
  "snapshot_no" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "payment_id" TEXT,
  "collection_config_id" TEXT,
  "provider" "PaymentProvider" NOT NULL,
  "confirm_mode" "PaymentConfirmMode" NOT NULL,
  "environment" "PaymentEnvironment" NOT NULL DEFAULT 'production',
  "config_snapshot_json" JSONB NOT NULL,
  "merchant_no_masked" TEXT,
  "app_id_masked" TEXT,
  "service_provider_masked" TEXT,
  "payable_amount_cents" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "payment_no" TEXT NOT NULL,
  "provider_payment_no" TEXT,
  "provider_trade_no" TEXT,
  "status" "PaymentStatus" NOT NULL DEFAULT 'paying',
  "confirm_source" "PaymentConfirmSource" NOT NULL DEFAULT 'unconfirmed',
  "expires_at" TIMESTAMP(3),
  "paid_at" TIMESTAMP(3),
  "callback_handled_at" TIMESTAMP(3),
  "exception_reason" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "payment_callback_logs" (
  "id" TEXT NOT NULL,
  "callback_no" TEXT NOT NULL,
  "payment_id" TEXT,
  "order_id" TEXT,
  "payment_snapshot_id" TEXT,
  "collection_config_id" TEXT,
  "provider" "PaymentProvider" NOT NULL,
  "source" TEXT NOT NULL,
  "order_no" TEXT,
  "provider_payment_no" TEXT,
  "provider_trade_no" TEXT,
  "notified_at" TIMESTAMP(3),
  "signature_valid" BOOLEAN,
  "amount_matched" BOOLEAN,
  "merchant_matched" BOOLEAN,
  "processed_status" "CallbackProcessStatus" NOT NULL DEFAULT 'received',
  "provider_event_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "error_code" TEXT,
  "error_message" TEXT,
  "raw_payload_ciphertext" TEXT,
  "raw_payload_masked_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMP(3),
  CONSTRAINT "payment_callback_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "payment_exceptions" (
  "id" TEXT NOT NULL,
  "exception_no" TEXT NOT NULL,
  "order_id" TEXT,
  "payment_id" TEXT,
  "payment_snapshot_id" TEXT,
  "callback_log_id" TEXT,
  "collection_config_id" TEXT,
  "exception_type" "PaymentExceptionType" NOT NULL,
  "status" "PaymentExceptionStatus" NOT NULL DEFAULT 'open',
  "reason" TEXT,
  "action_taken" TEXT,
  "resolution_json" JSONB,
  "handled_by_type" "ActorType",
  "handled_by_id" TEXT,
  "handled_at" TIMESTAMP(3),
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_exceptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "payment_dispute_materials" (
  "id" TEXT NOT NULL,
  "material_no" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "payment_id" TEXT,
  "payment_exception_id" TEXT,
  "material_type" "PaymentDisputeMaterialType" NOT NULL,
  "status" "PaymentDisputeMaterialStatus" NOT NULL DEFAULT 'submitted',
  "file_url" TEXT,
  "file_hash" TEXT,
  "note" TEXT,
  "uploaded_by_type" "ActorType" NOT NULL,
  "uploaded_by_id" TEXT,
  "reviewed_by_type" "ActorType",
  "reviewed_by_id" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "review_note" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "payment_dispute_materials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "collection_payment_configs_config_no_key" ON "collection_payment_configs"("config_no");
CREATE UNIQUE INDEX IF NOT EXISTS "collection_payment_configs_idempotency_key_key" ON "collection_payment_configs"("idempotency_key");
CREATE INDEX IF NOT EXISTS "collection_payment_configs_owner_type_status_idx" ON "collection_payment_configs"("owner_type", "status");
CREATE INDEX IF NOT EXISTS "collection_payment_configs_owner_agent_id_status_idx" ON "collection_payment_configs"("owner_agent_id", "status");
CREATE INDEX IF NOT EXISTS "collection_payment_configs_owner_merchant_id_status_idx" ON "collection_payment_configs"("owner_merchant_id", "status");
CREATE INDEX IF NOT EXISTS "collection_payment_configs_shop_id_status_idx" ON "collection_payment_configs"("shop_id", "status");
CREATE INDEX IF NOT EXISTS "collection_payment_configs_provider_status_idx" ON "collection_payment_configs"("provider", "status");
CREATE INDEX IF NOT EXISTS "collection_payment_configs_is_default_status_idx" ON "collection_payment_configs"("is_default", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "collection_payment_configs_shop_default_active_unique"
  ON "collection_payment_configs"("shop_id")
  WHERE "is_default" = true AND "status" = 'active' AND "shop_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "payment_snapshots_snapshot_no_key" ON "payment_snapshots"("snapshot_no");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_snapshots_payment_no_key" ON "payment_snapshots"("payment_no");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_snapshots_idempotency_key_key" ON "payment_snapshots"("idempotency_key");
CREATE INDEX IF NOT EXISTS "payment_snapshots_order_id_created_at_idx" ON "payment_snapshots"("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "payment_snapshots_payment_id_idx" ON "payment_snapshots"("payment_id");
CREATE INDEX IF NOT EXISTS "payment_snapshots_collection_config_id_status_idx" ON "payment_snapshots"("collection_config_id", "status");
CREATE INDEX IF NOT EXISTS "payment_snapshots_provider_status_idx" ON "payment_snapshots"("provider", "status");
CREATE INDEX IF NOT EXISTS "payment_snapshots_provider_payment_no_idx" ON "payment_snapshots"("provider_payment_no");
CREATE INDEX IF NOT EXISTS "payment_snapshots_provider_trade_no_idx" ON "payment_snapshots"("provider_trade_no");

CREATE UNIQUE INDEX IF NOT EXISTS "payment_callback_logs_callback_no_key" ON "payment_callback_logs"("callback_no");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_callback_logs_provider_event_id_key" ON "payment_callback_logs"("provider_event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_callback_logs_idempotency_key_key" ON "payment_callback_logs"("idempotency_key");
CREATE INDEX IF NOT EXISTS "payment_callback_logs_payment_id_idx" ON "payment_callback_logs"("payment_id");
CREATE INDEX IF NOT EXISTS "payment_callback_logs_order_id_created_at_idx" ON "payment_callback_logs"("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "payment_callback_logs_payment_snapshot_id_idx" ON "payment_callback_logs"("payment_snapshot_id");
CREATE INDEX IF NOT EXISTS "payment_callback_logs_collection_config_id_created_at_idx" ON "payment_callback_logs"("collection_config_id", "created_at");
CREATE INDEX IF NOT EXISTS "payment_callback_logs_provider_processed_status_created_at_idx" ON "payment_callback_logs"("provider", "processed_status", "created_at");
CREATE INDEX IF NOT EXISTS "payment_callback_logs_order_no_idx" ON "payment_callback_logs"("order_no");
CREATE INDEX IF NOT EXISTS "payment_callback_logs_provider_trade_no_idx" ON "payment_callback_logs"("provider_trade_no");

CREATE UNIQUE INDEX IF NOT EXISTS "payment_exceptions_exception_no_key" ON "payment_exceptions"("exception_no");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_exceptions_idempotency_key_key" ON "payment_exceptions"("idempotency_key");
CREATE INDEX IF NOT EXISTS "payment_exceptions_status_created_at_idx" ON "payment_exceptions"("status", "created_at");
CREATE INDEX IF NOT EXISTS "payment_exceptions_exception_type_status_idx" ON "payment_exceptions"("exception_type", "status");
CREATE INDEX IF NOT EXISTS "payment_exceptions_order_id_status_idx" ON "payment_exceptions"("order_id", "status");
CREATE INDEX IF NOT EXISTS "payment_exceptions_payment_id_idx" ON "payment_exceptions"("payment_id");
CREATE INDEX IF NOT EXISTS "payment_exceptions_payment_snapshot_id_idx" ON "payment_exceptions"("payment_snapshot_id");
CREATE INDEX IF NOT EXISTS "payment_exceptions_callback_log_id_idx" ON "payment_exceptions"("callback_log_id");
CREATE INDEX IF NOT EXISTS "payment_exceptions_collection_config_id_status_idx" ON "payment_exceptions"("collection_config_id", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "payment_dispute_materials_material_no_key" ON "payment_dispute_materials"("material_no");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_dispute_materials_idempotency_key_key" ON "payment_dispute_materials"("idempotency_key");
CREATE INDEX IF NOT EXISTS "payment_dispute_materials_order_id_created_at_idx" ON "payment_dispute_materials"("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "payment_dispute_materials_payment_id_idx" ON "payment_dispute_materials"("payment_id");
CREATE INDEX IF NOT EXISTS "payment_dispute_materials_payment_exception_id_idx" ON "payment_dispute_materials"("payment_exception_id");
CREATE INDEX IF NOT EXISTS "payment_dispute_materials_status_created_at_idx" ON "payment_dispute_materials"("status", "created_at");
CREATE INDEX IF NOT EXISTS "payment_dispute_materials_material_type_created_at_idx" ON "payment_dispute_materials"("material_type", "created_at");
CREATE INDEX IF NOT EXISTS "payment_dispute_materials_uploaded_by_type_uploaded_by_id_created_at_idx" ON "payment_dispute_materials"("uploaded_by_type", "uploaded_by_id", "created_at");

CREATE INDEX IF NOT EXISTS "payments_collection_payment_config_id_status_idx" ON "payments"("collection_payment_config_id", "status");
CREATE INDEX IF NOT EXISTS "payments_provider_status_idx" ON "payments"("provider", "status");
CREATE INDEX IF NOT EXISTS "payments_provider_payment_no_idx" ON "payments"("provider_payment_no");
CREATE INDEX IF NOT EXISTS "payments_provider_trade_no_idx" ON "payments"("provider_trade_no");

DO $$ BEGIN
  ALTER TABLE "collection_payment_configs"
    ADD CONSTRAINT "collection_payment_configs_owner_shape_check" CHECK (
      ("owner_type" = 'platform' AND "owner_agent_id" IS NULL AND "owner_merchant_id" IS NULL)
      OR ("owner_type" = 'agent' AND "owner_agent_id" IS NOT NULL)
      OR ("owner_type" = 'merchant' AND "owner_merchant_id" IS NOT NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "collection_payment_configs"
    ADD CONSTRAINT "collection_payment_configs_confirm_mode_check" CHECK (
      ("provider" = 'alipay_personal' AND "confirm_mode" = 'manual_confirm')
      OR ("provider" IN ('alipay_merchant', 'wechat_merchant', 'epay') AND "confirm_mode" = 'callback_query')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_snapshots"
    ADD CONSTRAINT "payment_snapshots_confirm_mode_check" CHECK (
      ("provider" = 'alipay_personal' AND "confirm_mode" = 'manual_confirm')
      OR ("provider" IN ('alipay_merchant', 'wechat_merchant', 'epay') AND "confirm_mode" = 'callback_query')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_snapshots"
    ADD CONSTRAINT "payment_snapshots_non_negative_amount_check" CHECK ("payable_amount_cents" >= 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "collection_payment_configs"
    ADD CONSTRAINT "collection_payment_configs_owner_agent_id_fkey" FOREIGN KEY ("owner_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "collection_payment_configs"
    ADD CONSTRAINT "collection_payment_configs_owner_merchant_id_fkey" FOREIGN KEY ("owner_merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "collection_payment_configs"
    ADD CONSTRAINT "collection_payment_configs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payments"
    ADD CONSTRAINT "payments_collection_payment_config_id_fkey" FOREIGN KEY ("collection_payment_config_id") REFERENCES "collection_payment_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_snapshots"
    ADD CONSTRAINT "payment_snapshots_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_snapshots"
    ADD CONSTRAINT "payment_snapshots_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_snapshots"
    ADD CONSTRAINT "payment_snapshots_collection_config_id_fkey" FOREIGN KEY ("collection_config_id") REFERENCES "collection_payment_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_callback_logs"
    ADD CONSTRAINT "payment_callback_logs_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_callback_logs"
    ADD CONSTRAINT "payment_callback_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_callback_logs"
    ADD CONSTRAINT "payment_callback_logs_payment_snapshot_id_fkey" FOREIGN KEY ("payment_snapshot_id") REFERENCES "payment_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_callback_logs"
    ADD CONSTRAINT "payment_callback_logs_collection_config_id_fkey" FOREIGN KEY ("collection_config_id") REFERENCES "collection_payment_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_exceptions"
    ADD CONSTRAINT "payment_exceptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_exceptions"
    ADD CONSTRAINT "payment_exceptions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_exceptions"
    ADD CONSTRAINT "payment_exceptions_payment_snapshot_id_fkey" FOREIGN KEY ("payment_snapshot_id") REFERENCES "payment_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_exceptions"
    ADD CONSTRAINT "payment_exceptions_callback_log_id_fkey" FOREIGN KEY ("callback_log_id") REFERENCES "payment_callback_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_exceptions"
    ADD CONSTRAINT "payment_exceptions_collection_config_id_fkey" FOREIGN KEY ("collection_config_id") REFERENCES "collection_payment_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_dispute_materials"
    ADD CONSTRAINT "payment_dispute_materials_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_dispute_materials"
    ADD CONSTRAINT "payment_dispute_materials_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "payment_dispute_materials"
    ADD CONSTRAINT "payment_dispute_materials_payment_exception_id_fkey" FOREIGN KEY ("payment_exception_id") REFERENCES "payment_exceptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

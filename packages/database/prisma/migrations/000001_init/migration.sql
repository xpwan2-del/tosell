-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('draft', 'pending_review', 'rejected', 'pending_deposit', 'active', 'frozen', 'disabled', 'exit_observation', 'exited');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('pending_payment', 'paid', 'partially_deducted', 'frozen', 'refund_reviewing', 'refunded', 'insufficient');

-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('not_opened', 'configuring', 'open', 'frozen', 'disabled');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('draft', 'pending_review', 'rejected', 'approved');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('draft', 'active', 'inactive', 'risk_removed');

-- CreateEnum
CREATE TYPE "AgentProductStatus" AS ENUM ('draft', 'pending_review', 'rejected', 'approved', 'listed', 'delisted', 'risk_removed');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('platform', 'agent_owned');

-- CreateEnum
CREATE TYPE "FulfillmentType" AS ENUM ('manual', 'automatic', 'external');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending_payment', 'paid', 'fulfilling', 'fulfilled', 'fulfillment_failed', 'after_sale_pending', 'refunding', 'refunded', 'closed');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('unpaid', 'paying', 'paid', 'failed', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('not_started', 'processing', 'success', 'failed', 'resent', 'revoked');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('none', 'pending', 'refunding', 'refunded', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('pending', 'frozen', 'settleable', 'settling', 'settled', 'clawback_pending', 'clawed_back');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('normal', 'order_frozen', 'shop_frozen', 'settlement_restricted', 'product_removed', 'disabled');

-- CreateEnum
CREATE TYPE "CallbackProcessStatus" AS ENUM ('received', 'processed', 'ignored_duplicate', 'failed');

-- CreateEnum
CREATE TYPE "AfterSaleStatus" AS ENUM ('pending', 'agent_processing', 'platform_intervening', 'refund_approved', 'refunding', 'refunded', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "Responsibility" AS ENUM ('platform', 'agent', 'user', 'mixed', 'undecided');

-- CreateEnum
CREATE TYPE "ServiceFeeBearer" AS ENUM ('platform', 'agent', 'user', 'mixed', 'none');

-- CreateEnum
CREATE TYPE "SettlementSheetStatus" AS ENUM ('draft', 'confirmed', 'payout_pending', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "ManualPayoutStatus" AS ENUM ('pending', 'paid', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "DepositTransactionType" AS ENUM ('pay', 'freeze', 'unfreeze', 'deduct', 'refund', 'adjustment');

-- CreateEnum
CREATE TYPE "ClawbackStatus" AS ENUM ('pending', 'deducting', 'completed', 'insufficient', 'cancelled');

-- CreateEnum
CREATE TYPE "ClawbackDeductFrom" AS ENUM ('pending_income', 'payable_income', 'deposit', 'mixed');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('debit', 'credit');

-- CreateEnum
CREATE TYPE "LedgerSubjectType" AS ENUM ('agent', 'platform', 'user');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('agent_pending_income', 'agent_frozen_income', 'agent_payable_income', 'agent_paid_income', 'agent_clawback_receivable', 'agent_deposit_available', 'agent_deposit_frozen', 'platform_service_fee_income', 'platform_refund_cost');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('ORDER_AGENT_INCOME_PENDING', 'ORDER_SERVICE_FEE_ACCRUAL', 'REFUND_AGENT_BEAR', 'REFUND_PLATFORM_BEAR', 'SERVICE_FEE_REFUND', 'SETTLEMENT_LOCK', 'SETTLEMENT_PAYOUT', 'CLAWBACK_CREATE', 'CLAWBACK_DEDUCT_PENDING', 'CLAWBACK_DEDUCT_PAYOUT', 'CLAWBACK_DEDUCT_DEPOSIT', 'DEPOSIT_PAY', 'DEPOSIT_DEDUCT', 'DEPOSIT_REFUND', 'RISK_FREEZE', 'RISK_UNFREEZE', 'MANUAL_ADJUST');

-- CreateEnum
CREATE TYPE "RiskFreezeStatus" AS ENUM ('active', 'released', 'cancelled');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('pending', 'processing', 'resolved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('user', 'agent', 'admin', 'system');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "openid" TEXT NOT NULL,
    "unionid" TEXT,
    "phone" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agent_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact_phone" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'draft',
    "risk_status" "RiskStatus" NOT NULL DEFAULT 'normal',
    "deposit_status" "DepositStatus" NOT NULL DEFAULT 'pending_payment',
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_applications" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT,
    "user_id" TEXT NOT NULL,
    "identity_info_json" JSONB NOT NULL,
    "contact_info_json" JSONB NOT NULL,
    "customer_service_wechat" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending_review',
    "reject_reason" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "shop_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_url" TEXT,
    "announcement" TEXT,
    "share_path" TEXT NOT NULL,
    "status" "ShopStatus" NOT NULL DEFAULT 'not_opened',
    "risk_status" "RiskStatus" NOT NULL DEFAULT 'normal',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_customer_service_bindings" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "wechat_id" TEXT NOT NULL,
    "qr_code_url" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "review_status" "ReviewStatus" NOT NULL DEFAULT 'pending_review',
    "reviewed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_customer_service_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_products" (
    "id" TEXT NOT NULL,
    "product_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category_id" TEXT,
    "detail" TEXT NOT NULL,
    "rights_desc" TEXT NOT NULL,
    "supply_price_cents" BIGINT NOT NULL,
    "min_sale_price_cents" BIGINT NOT NULL,
    "suggested_sale_price_cents" BIGINT NOT NULL,
    "fulfillment_type" "FulfillmentType" NOT NULL DEFAULT 'manual',
    "fulfillment_rule_json" JSONB NOT NULL,
    "after_sale_rule_json" JSONB NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_products" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_type" "ProductType" NOT NULL,
    "platform_product_id" TEXT,
    "own_product_review_id" TEXT,
    "sale_price_cents" BIGINT NOT NULL,
    "status" "AgentProductStatus" NOT NULL DEFAULT 'draft',
    "listed_at" TIMESTAMP(3),
    "delisted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_product_reviews" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "detail_json" JSONB NOT NULL,
    "sale_price_cents" BIGINT NOT NULL,
    "after_sale_rule_json" JSONB NOT NULL,
    "fulfillment_rule_json" JSONB NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending_review',
    "reject_reason" TEXT,
    "risk_reason" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_product_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending_payment',
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'unpaid',
    "fulfillment_status" "FulfillmentStatus" NOT NULL DEFAULT 'not_started',
    "refund_status" "RefundStatus" NOT NULL DEFAULT 'none',
    "settlement_status" "SettlementStatus" NOT NULL DEFAULT 'pending',
    "risk_status" "RiskStatus" NOT NULL DEFAULT 'normal',
    "paid_amount_cents" BIGINT NOT NULL DEFAULT 0,
    "paid_at" TIMESTAMP(3),
    "fulfilled_at" TIMESTAMP(3),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "agent_product_id" TEXT NOT NULL,
    "product_type" "ProductType" NOT NULL,
    "product_id_snapshot" TEXT NOT NULL,
    "product_name_snapshot" TEXT NOT NULL,
    "sale_price_cents" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "supply_price_cents" BIGINT NOT NULL,
    "service_fee_cents" BIGINT NOT NULL,
    "agent_income_cents" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_amount_snapshots" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "service_fee_bps" INTEGER NOT NULL DEFAULT 50,
    "paid_amount_cents" BIGINT NOT NULL,
    "supply_amount_cents" BIGINT NOT NULL,
    "service_fee_cents" BIGINT NOT NULL,
    "agent_expected_income_cents" BIGINT NOT NULL,
    "product_snapshot_json" JSONB NOT NULL,
    "shop_snapshot_json" JSONB NOT NULL,
    "pricing_snapshot_json" JSONB NOT NULL,
    "fulfillment_rule_snapshot_json" JSONB NOT NULL,
    "after_sale_rule_snapshot_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_amount_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "payment_no" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "channel_trade_no" TEXT,
    "amount_cents" BIGINT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'paying',
    "idempotency_key" TEXT NOT NULL,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_callbacks" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT,
    "channel" TEXT NOT NULL,
    "channel_event_id" TEXT NOT NULL,
    "raw_payload_json" JSONB NOT NULL,
    "processed_status" "CallbackProcessStatus" NOT NULL DEFAULT 'received',
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "payment_callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_records" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "fulfillment_type" "FulfillmentType" NOT NULL,
    "status" "FulfillmentStatus" NOT NULL DEFAULT 'not_started',
    "success_at" TIMESTAMP(3),
    "fail_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fulfillment_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fulfillment_attempts" (
    "id" TEXT NOT NULL,
    "fulfillment_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "operator_id" TEXT,
    "request_json" JSONB NOT NULL,
    "result_json" JSONB,
    "status" "FulfillmentStatus" NOT NULL DEFAULT 'processing',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fulfillment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entitlements" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "rights_code" TEXT NOT NULL,
    "rights_payload_json" JSONB NOT NULL,
    "status" "FulfillmentStatus" NOT NULL DEFAULT 'success',
    "idempotency_key" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sales" (
    "id" TEXT NOT NULL,
    "after_sale_no" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "status" "AfterSaleStatus" NOT NULL DEFAULT 'pending',
    "reason_code" TEXT NOT NULL,
    "responsibility" "Responsibility" NOT NULL DEFAULT 'undecided',
    "requested_refund_cents" BIGINT NOT NULL,
    "approved_refund_cents" BIGINT NOT NULL DEFAULT 0,
    "platform_bear_cents" BIGINT NOT NULL DEFAULT 0,
    "agent_bear_cents" BIGINT NOT NULL DEFAULT 0,
    "service_fee_refund_cents" BIGINT NOT NULL DEFAULT 0,
    "service_fee_bearer" "ServiceFeeBearer" NOT NULL DEFAULT 'none',
    "evidence_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "after_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" TEXT NOT NULL,
    "refund_no" TEXT NOT NULL,
    "after_sale_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'refunding',
    "channel_refund_no" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_callbacks" (
    "id" TEXT NOT NULL,
    "refund_id" TEXT,
    "channel" TEXT NOT NULL,
    "channel_event_id" TEXT NOT NULL,
    "raw_payload_json" JSONB NOT NULL,
    "processed_status" "CallbackProcessStatus" NOT NULL DEFAULT 'received',
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "refund_callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_sheets" (
    "id" TEXT NOT NULL,
    "settlement_no" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "status" "SettlementSheetStatus" NOT NULL DEFAULT 'draft',
    "total_order_count" INTEGER NOT NULL DEFAULT 0,
    "total_paid_cents" BIGINT NOT NULL DEFAULT 0,
    "total_service_fee_cents" BIGINT NOT NULL DEFAULT 0,
    "total_agent_income_cents" BIGINT NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "created_by" TEXT,
    "confirmed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_items" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "paid_amount_cents" BIGINT NOT NULL,
    "supply_amount_cents" BIGINT NOT NULL,
    "service_fee_cents" BIGINT NOT NULL,
    "agent_income_cents" BIGINT NOT NULL,
    "deducted_cents" BIGINT NOT NULL DEFAULT 0,
    "settle_amount_cents" BIGINT NOT NULL,
    "fulfilled_at" TIMESTAMP(3) NOT NULL,
    "settleable_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_payouts" (
    "id" TEXT NOT NULL,
    "settlement_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "payee_info_snapshot_json" JSONB NOT NULL,
    "payout_method" TEXT NOT NULL,
    "payout_voucher_url" TEXT,
    "status" "ManualPayoutStatus" NOT NULL DEFAULT 'pending',
    "idempotency_key" TEXT NOT NULL,
    "paid_by" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "manual_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_accounts" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "required_amount_cents" BIGINT NOT NULL,
    "available_amount_cents" BIGINT NOT NULL DEFAULT 0,
    "frozen_amount_cents" BIGINT NOT NULL DEFAULT 0,
    "deducted_amount_cents" BIGINT NOT NULL DEFAULT 0,
    "status" "DepositStatus" NOT NULL DEFAULT 'pending_payment',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposit_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_transactions" (
    "id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "type" "DepositTransactionType" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "balance_before_cents" BIGINT NOT NULL,
    "balance_after_cents" BIGINT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "related_type" TEXT,
    "related_id" TEXT,
    "voucher_url" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "operator_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clawbacks" (
    "id" TEXT NOT NULL,
    "clawback_no" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "order_id" TEXT,
    "amount_cents" BIGINT NOT NULL,
    "status" "ClawbackStatus" NOT NULL DEFAULT 'pending',
    "deduct_from" "ClawbackDeductFrom",
    "reason_code" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clawbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "ledger_no" TEXT NOT NULL,
    "agent_id" TEXT,
    "shop_id" TEXT,
    "subject_type" "LedgerSubjectType" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "account_type" "LedgerAccountType" NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "order_id" TEXT,
    "settlement_id" TEXT,
    "refund_id" TEXT,
    "clawback_id" TEXT,
    "deposit_transaction_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "balance_before_cents" BIGINT,
    "balance_after_cents" BIGINT,
    "reversal_of_ledger_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_freezes" (
    "id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "freeze_type" TEXT NOT NULL,
    "status" "RiskFreezeStatus" NOT NULL DEFAULT 'active',
    "reason_code" TEXT NOT NULL,
    "reason_text" TEXT NOT NULL,
    "active_unique_key" TEXT,
    "created_by" TEXT,
    "released_by" TEXT,
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "risk_freezes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaints" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "agent_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'pending',
    "complaint_type" TEXT NOT NULL,
    "responsibility" "Responsibility" NOT NULL DEFAULT 'undecided',
    "resolution_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "before_json" JSONB,
    "after_json" JSONB,
    "reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "ip" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_user_roles" (
    "admin_user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_user_roles_pkey" PRIMARY KEY ("admin_user_id","role_id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_openid_key" ON "users"("openid");

-- CreateIndex
CREATE UNIQUE INDEX "users_unionid_key" ON "users"("unionid");

-- CreateIndex
CREATE UNIQUE INDEX "agents_user_id_key" ON "agents"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agents_agent_no_key" ON "agents"("agent_no");

-- CreateIndex
CREATE INDEX "agents_status_idx" ON "agents"("status");

-- CreateIndex
CREATE INDEX "agents_risk_status_idx" ON "agents"("risk_status");

-- CreateIndex
CREATE INDEX "agent_applications_status_created_at_idx" ON "agent_applications"("status", "created_at");

-- CreateIndex
CREATE INDEX "agent_applications_agent_id_idx" ON "agent_applications"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "shops_agent_id_key" ON "shops"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "shops_shop_no_key" ON "shops"("shop_no");

-- CreateIndex
CREATE UNIQUE INDEX "shops_share_path_key" ON "shops"("share_path");

-- CreateIndex
CREATE INDEX "shops_status_idx" ON "shops"("status");

-- CreateIndex
CREATE INDEX "shop_customer_service_bindings_shop_id_status_idx" ON "shop_customer_service_bindings"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_products_product_no_key" ON "platform_products"("product_no");

-- CreateIndex
CREATE INDEX "platform_products_status_idx" ON "platform_products"("status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_products_own_product_review_id_key" ON "agent_products"("own_product_review_id");

-- CreateIndex
CREATE INDEX "agent_products_agent_id_status_idx" ON "agent_products"("agent_id", "status");

-- CreateIndex
CREATE INDEX "agent_products_shop_id_status_idx" ON "agent_products"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_products_shop_id_product_type_platform_product_id_key" ON "agent_products"("shop_id", "product_type", "platform_product_id");

-- CreateIndex
CREATE INDEX "agent_product_reviews_agent_id_status_idx" ON "agent_product_reviews"("agent_id", "status");

-- CreateIndex
CREATE INDEX "agent_product_reviews_shop_id_status_idx" ON "agent_product_reviews"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_no_key" ON "orders"("order_no");

-- CreateIndex
CREATE INDEX "orders_agent_id_created_at_idx" ON "orders"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_shop_id_status_idx" ON "orders"("shop_id", "status");

-- CreateIndex
CREATE INDEX "orders_user_id_created_at_idx" ON "orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_fulfilled_at_idx" ON "orders"("fulfilled_at");

-- CreateIndex
CREATE INDEX "orders_settlement_status_risk_status_idx" ON "orders"("settlement_status", "risk_status");

-- CreateIndex
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "order_items_agent_product_id_idx" ON "order_items"("agent_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_amount_snapshots_order_id_key" ON "order_amount_snapshots"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_payment_no_key" ON "payments"("payment_no");

-- CreateIndex
CREATE UNIQUE INDEX "payments_channel_trade_no_key" ON "payments"("channel_trade_no");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_callbacks_channel_event_id_key" ON "payment_callbacks"("channel_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_callbacks_idempotency_key_key" ON "payment_callbacks"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_callbacks_payment_id_idx" ON "payment_callbacks"("payment_id");

-- CreateIndex
CREATE INDEX "fulfillment_records_agent_id_status_idx" ON "fulfillment_records"("agent_id", "status");

-- CreateIndex
CREATE INDEX "fulfillment_records_order_id_idx" ON "fulfillment_records"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_attempts_idempotency_key_key" ON "fulfillment_attempts"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_attempts_fulfillment_id_attempt_no_key" ON "fulfillment_attempts"("fulfillment_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "entitlements_idempotency_key_key" ON "entitlements"("idempotency_key");

-- CreateIndex
CREATE INDEX "entitlements_user_id_created_at_idx" ON "entitlements"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "entitlements_order_item_id_rights_code_key" ON "entitlements"("order_item_id", "rights_code");

-- CreateIndex
CREATE UNIQUE INDEX "after_sales_after_sale_no_key" ON "after_sales"("after_sale_no");

-- CreateIndex
CREATE INDEX "after_sales_agent_id_status_idx" ON "after_sales"("agent_id", "status");

-- CreateIndex
CREATE INDEX "after_sales_shop_id_status_idx" ON "after_sales"("shop_id", "status");

-- CreateIndex
CREATE INDEX "after_sales_order_id_idx" ON "after_sales"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_refund_no_key" ON "refunds"("refund_no");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_channel_refund_no_key" ON "refunds"("channel_refund_no");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "refunds_order_id_idx" ON "refunds"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_callbacks_channel_event_id_key" ON "refund_callbacks"("channel_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "refund_callbacks_idempotency_key_key" ON "refund_callbacks"("idempotency_key");

-- CreateIndex
CREATE INDEX "refund_callbacks_refund_id_idx" ON "refund_callbacks"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_sheets_settlement_no_key" ON "settlement_sheets"("settlement_no");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_sheets_idempotency_key_key" ON "settlement_sheets"("idempotency_key");

-- CreateIndex
CREATE INDEX "settlement_sheets_agent_id_status_idx" ON "settlement_sheets"("agent_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_sheets_agent_id_period_start_period_end_idempote_key" ON "settlement_sheets"("agent_id", "period_start", "period_end", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_items_order_id_key" ON "settlement_items"("order_id");

-- CreateIndex
CREATE INDEX "settlement_items_settlement_id_idx" ON "settlement_items"("settlement_id");

-- CreateIndex
CREATE INDEX "settlement_items_agent_id_created_at_idx" ON "settlement_items"("agent_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "manual_payouts_idempotency_key_key" ON "manual_payouts"("idempotency_key");

-- CreateIndex
CREATE INDEX "manual_payouts_agent_id_status_idx" ON "manual_payouts"("agent_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_accounts_agent_id_key" ON "deposit_accounts"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_transactions_idempotency_key_key" ON "deposit_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "deposit_transactions_agent_id_created_at_idx" ON "deposit_transactions"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "deposit_transactions_related_type_related_id_idx" ON "deposit_transactions"("related_type", "related_id");

-- CreateIndex
CREATE UNIQUE INDEX "clawbacks_clawback_no_key" ON "clawbacks"("clawback_no");

-- CreateIndex
CREATE UNIQUE INDEX "clawbacks_idempotency_key_key" ON "clawbacks"("idempotency_key");

-- CreateIndex
CREATE INDEX "clawbacks_agent_id_status_idx" ON "clawbacks"("agent_id", "status");

-- CreateIndex
CREATE INDEX "clawbacks_source_type_source_id_idx" ON "clawbacks"("source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_ledger_no_key" ON "ledger_entries"("ledger_no");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_idempotency_key_key" ON "ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_entries_agent_id_created_at_idx" ON "ledger_entries"("agent_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_source_type_source_id_idx" ON "ledger_entries"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "ledger_entries_order_id_idx" ON "ledger_entries"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "risk_freezes_active_unique_key_key" ON "risk_freezes"("active_unique_key");

-- CreateIndex
CREATE INDEX "risk_freezes_agent_id_status_idx" ON "risk_freezes"("agent_id", "status");

-- CreateIndex
CREATE INDEX "risk_freezes_target_type_target_id_freeze_type_status_idx" ON "risk_freezes"("target_type", "target_id", "freeze_type", "status");

-- CreateIndex
CREATE INDEX "complaints_agent_id_status_idx" ON "complaints"("agent_id", "status");

-- CreateIndex
CREATE INDEX "complaints_order_id_idx" ON "complaints"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "audit_logs_idempotency_key_key" ON "audit_logs"("idempotency_key");

-- CreateIndex
CREATE INDEX "audit_logs_actor_type_actor_id_created_at_idx" ON "audit_logs"("actor_type", "actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_created_at_idx" ON "audit_logs"("target_type", "target_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_request_id_idx" ON "audit_logs"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_username_key" ON "admin_users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_applications" ADD CONSTRAINT "agent_applications_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_applications" ADD CONSTRAINT "agent_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_customer_service_bindings" ADD CONSTRAINT "shop_customer_service_bindings_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_products" ADD CONSTRAINT "agent_products_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_products" ADD CONSTRAINT "agent_products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_products" ADD CONSTRAINT "agent_products_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_products" ADD CONSTRAINT "agent_products_own_product_review_id_fkey" FOREIGN KEY ("own_product_review_id") REFERENCES "agent_product_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_product_reviews" ADD CONSTRAINT "agent_product_reviews_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_product_reviews" ADD CONSTRAINT "agent_product_reviews_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_agent_product_id_fkey" FOREIGN KEY ("agent_product_id") REFERENCES "agent_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_amount_snapshots" ADD CONSTRAINT "order_amount_snapshots_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callbacks" ADD CONSTRAINT "payment_callbacks_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_records" ADD CONSTRAINT "fulfillment_records_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_records" ADD CONSTRAINT "fulfillment_records_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_attempts" ADD CONSTRAINT "fulfillment_attempts_fulfillment_id_fkey" FOREIGN KEY ("fulfillment_id") REFERENCES "fulfillment_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "after_sales" ADD CONSTRAINT "after_sales_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "after_sales" ADD CONSTRAINT "after_sales_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "after_sales" ADD CONSTRAINT "after_sales_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_after_sale_id_fkey" FOREIGN KEY ("after_sale_id") REFERENCES "after_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_callbacks" ADD CONSTRAINT "refund_callbacks_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_sheets" ADD CONSTRAINT "settlement_sheets_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlement_sheets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_payouts" ADD CONSTRAINT "manual_payouts_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlement_sheets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_accounts" ADD CONSTRAINT "deposit_accounts_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "deposit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlement_sheets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_clawback_id_fkey" FOREIGN KEY ("clawback_id") REFERENCES "clawbacks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_deposit_transaction_id_fkey" FOREIGN KEY ("deposit_transaction_id") REFERENCES "deposit_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_user_roles" ADD CONSTRAINT "admin_user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


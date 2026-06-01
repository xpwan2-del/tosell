-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('draft', 'pending_review', 'rejected', 'pending_deposit', 'active', 'frozen', 'disabled', 'exit_observation', 'exited');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('pending_payment', 'paid', 'partially_deducted', 'frozen', 'refund_reviewing', 'refunded', 'insufficient');

-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('not_opened', 'configuring', 'open', 'frozen', 'disabled');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('draft', 'pending_review', 'rejected', 'approved');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('draft', 'active', 'inactive', 'risk_removed');

-- CreateEnum
CREATE TYPE "ProductListingStatus" AS ENUM ('draft', 'pending_review', 'rejected', 'approved', 'listed', 'delisted', 'risk_removed');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('platform', 'merchant_owned');

-- CreateEnum
CREATE TYPE "FulfillmentType" AS ENUM ('manual', 'code_pool', 'automatic', 'external');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending_payment', 'paid', 'fulfilling', 'fulfilled', 'fulfillment_failed', 'after_sale_pending', 'refunding', 'refunded', 'closed');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('unpaid', 'paying', 'paid', 'failed', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('alipay_merchant', 'wechat_merchant', 'epay', 'alipay_personal', 'wechat_personal', 'balance');

-- CreateEnum
CREATE TYPE "PaymentConfirmMode" AS ENUM ('callback_query', 'manual_confirm', 'balance_deduct');

-- CreateEnum
CREATE TYPE "PaymentEnvironment" AS ENUM ('sandbox', 'production');

-- CreateEnum
CREATE TYPE "CollectionConfigOwnerType" AS ENUM ('platform', 'merchant');

-- CreateEnum
CREATE TYPE "CollectionConfigStatus" AS ENUM ('disabled', 'pending_test', 'active', 'paused');

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('not_configured', 'configured', 'expired', 'rotation_required');

-- CreateEnum
CREATE TYPE "PaymentConfirmSource" AS ENUM ('unconfirmed', 'callback', 'query', 'manual_confirm', 'balance');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('active', 'frozen', 'disabled');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('recharge', 'payment_hold', 'payment_capture', 'payment_release', 'refund', 'adjustment');

-- CreateEnum
CREATE TYPE "WalletRechargeStatus" AS ENUM ('pending_payment', 'paid', 'failed', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "WalletHoldStatus" AS ENUM ('active', 'captured', 'released', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "PaymentConfirmationStatus" AS ENUM ('pending', 'confirmed', 'rejected');

-- CreateEnum
CREATE TYPE "FulfillmentStatus" AS ENUM ('not_started', 'processing', 'success', 'failed', 'resent', 'revoked');

-- CreateEnum
CREATE TYPE "RightsCodeStatus" AS ENUM ('available', 'issued', 'locked', 'revoked', 'voided');

-- CreateEnum
CREATE TYPE "RightsCodeOwnerType" AS ENUM ('platform', 'merchant');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('none', 'pending', 'refunding', 'refunded', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('pending', 'frozen', 'settleable', 'settling', 'settled', 'clawback_pending', 'clawed_back');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('normal', 'order_frozen', 'shop_frozen', 'settlement_restricted', 'product_removed', 'disabled');

-- CreateEnum
CREATE TYPE "CallbackProcessStatus" AS ENUM ('received', 'processed', 'ignored_duplicate', 'failed');

-- CreateEnum
CREATE TYPE "PaymentExceptionType" AS ENUM ('signature_failed', 'amount_mismatch', 'merchant_mismatch', 'duplicate_callback', 'order_not_found', 'refunded_order_callback', 'fulfilled_dispute', 'provider_error', 'manual_review');

-- CreateEnum
CREATE TYPE "PaymentExceptionStatus" AS ENUM ('open', 'investigating', 'resolved', 'ignored');

-- CreateEnum
CREATE TYPE "PaymentDisputeMaterialType" AS ENUM ('payment_screenshot', 'provider_notice', 'customer_note', 'admin_note', 'other');

-- CreateEnum
CREATE TYPE "PaymentDisputeMaterialStatus" AS ENUM ('submitted', 'reviewed', 'ignored');

-- CreateEnum
CREATE TYPE "ServiceFeeBasisType" AS ENUM ('final_sale_price', 'paid_amount');

-- CreateEnum
CREATE TYPE "ServiceFeeConfigStatus" AS ENUM ('active', 'scheduled', 'disabled');

-- CreateEnum
CREATE TYPE "AfterSaleStatus" AS ENUM ('pending', 'merchant_processing', 'platform_intervening', 'refund_approved', 'refunding', 'refunded', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "Responsibility" AS ENUM ('platform', 'merchant', 'first_tier', 'second_tier', 'third_tier', 'user', 'mixed', 'undecided');

-- CreateEnum
CREATE TYPE "ShopOwnerType" AS ENUM ('platform', 'merchant');

-- CreateEnum
CREATE TYPE "SalesChannelType" AS ENUM ('platform_self_operated', 'single_merchant', 'two_tier', 'three_tier');

-- CreateEnum
CREATE TYPE "UserIdentityType" AS ENUM ('wechat_miniprogram', 'h5_phone', 'h5_guest', 'admin_mock');

-- CreateEnum
CREATE TYPE "MerchantTier" AS ENUM ('first_tier', 'second_tier', 'third_tier');

-- CreateEnum
CREATE TYPE "MerchantCreationSource" AS ENUM ('admin_manual', 'invite_application', 'self_application', 'migration');

-- CreateEnum
CREATE TYPE "MerchantAccountRole" AS ENUM ('owner', 'operator');

-- CreateEnum
CREATE TYPE "MerchantAccountStatus" AS ENUM ('pending_delivery', 'active', 'disabled');

-- CreateEnum
CREATE TYPE "AuthSubjectType" AS ENUM ('admin', 'merchant', 'user');

-- CreateEnum
CREATE TYPE "AuthSessionStatus" AS ENUM ('active', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "InitialAccountDeliveryStatus" AS ENUM ('pending', 'delivered', 'acknowledged');

-- CreateEnum
CREATE TYPE "SaleSourceType" AS ENUM ('merchant_product_listing', 'merchant_product', 'platform_shop_product');

-- CreateEnum
CREATE TYPE "MerchantProductListingSourceType" AS ENUM ('platform_product', 'upstream_listing');

-- CreateEnum
CREATE TYPE "VirtualCodeStatus" AS ENUM ('available', 'reserved', 'issued', 'voided', 'refunded', 'locked');

-- CreateEnum
CREATE TYPE "ExtractSecretStatus" AS ENUM ('active', 'locked', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "ExtractLogResult" AS ENUM ('success', 'failed', 'locked', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "CouponTemplateStatus" AS ENUM ('draft', 'active', 'inactive', 'voided');

-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('active', 'used', 'expired', 'voided');

-- CreateEnum
CREATE TYPE "CouponDiscountType" AS ENUM ('fixed_amount');

-- CreateEnum
CREATE TYPE "CouponScopeType" AS ENUM ('all_products', 'platform_product', 'merchant_product', 'shop');

-- CreateEnum
CREATE TYPE "PaymentChannel" AS ENUM ('wechat_miniprogram', 'wechat_h5_jsapi', 'wechat_h5', 'alipay_wap', 'epay', 'balance', 'mock');

-- CreateEnum
CREATE TYPE "SettlementRole" AS ENUM ('single_merchant', 'first_tier', 'second_tier', 'third_tier');

-- CreateEnum
CREATE TYPE "ServiceFeeBearer" AS ENUM ('platform', 'merchant', 'user', 'mixed', 'none');

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
CREATE TYPE "LedgerSubjectType" AS ENUM ('merchant', 'platform', 'user');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('merchant_pending_income', 'merchant_frozen_income', 'merchant_payable_income', 'merchant_paid_income', 'merchant_clawback_receivable', 'merchant_deposit_available', 'merchant_deposit_frozen', 'platform_service_fee_income', 'platform_refund_cost', 'platform_self_operated_revenue', 'platform_self_operated_fulfillment_cost', 'platform_payment_channel_fee', 'platform_self_operated_refund_cost', 'user_wallet_available', 'user_wallet_frozen', 'first_tier_pending_income', 'first_tier_payable_income', 'second_tier_pending_income', 'second_tier_payable_income', 'third_tier_pending_income', 'third_tier_payable_income');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('ORDER_MERCHANT_INCOME_PENDING', 'ORDER_SERVICE_FEE_ACCRUAL', 'ORDER_PLATFORM_SELF_REVENUE', 'ORDER_PLATFORM_SELF_COST', 'ORDER_PAYMENT_CHANNEL_FEE', 'ORDER_FIRST_TIER_INCOME_PENDING', 'ORDER_SECOND_TIER_INCOME_PENDING', 'ORDER_THIRD_TIER_INCOME_PENDING', 'REFUND_MERCHANT_BEAR', 'REFUND_PLATFORM_BEAR', 'REFUND_FIRST_TIER_BEAR', 'REFUND_SECOND_TIER_BEAR', 'REFUND_THIRD_TIER_BEAR', 'SERVICE_FEE_REFUND', 'SETTLEMENT_LOCK', 'SETTLEMENT_PAYOUT', 'CLAWBACK_CREATE', 'CLAWBACK_DEDUCT_PENDING', 'CLAWBACK_DEDUCT_PAYOUT', 'CLAWBACK_DEDUCT_DEPOSIT', 'DEPOSIT_PAY', 'DEPOSIT_DEDUCT', 'DEPOSIT_REFUND', 'WALLET_RECHARGE_PAID', 'WALLET_PAYMENT_HOLD', 'WALLET_PAYMENT_CAPTURE', 'WALLET_PAYMENT_RELEASE', 'WALLET_REFUND', 'WALLET_ADJUST', 'RISK_FREEZE', 'RISK_UNFREEZE', 'MANUAL_ADJUST');

-- CreateEnum
CREATE TYPE "RiskFreezeStatus" AS ENUM ('active', 'released', 'cancelled');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('pending', 'processing', 'resolved', 'rejected', 'cancelled');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('user', 'merchant', 'admin', 'system');

-- CreateEnum
CREATE TYPE "CodePlaintextAccessType" AS ENUM ('view', 'export');

-- CreateEnum
CREATE TYPE "EmailDeliveryScope" AS ENUM ('codes', 'extract_link', 'codes_and_link');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('pending', 'sent', 'provider_not_configured', 'failed', 'skipped_refunded');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "openid" TEXT,
    "unionid" TEXT,
    "phone" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "identity_type" "UserIdentityType" NOT NULL,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "session_no" TEXT NOT NULL,
    "subject_type" "AuthSubjectType" NOT NULL,
    "user_id" TEXT,
    "admin_user_id" TEXT,
    "merchant_account_id" TEXT,
    "merchant_id" TEXT,
    "token_hash" TEXT NOT NULL,
    "refresh_token_hash" TEXT,
    "status" "AuthSessionStatus" NOT NULL DEFAULT 'active',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "ip" TEXT,
    "client_info" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "merchant_id" TEXT,
    "username" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "password_hash" TEXT,
    "role" "MerchantAccountRole" NOT NULL DEFAULT 'owner',
    "status" "MerchantAccountStatus" NOT NULL DEFAULT 'pending_delivery',
    "initial_delivery_status" "InitialAccountDeliveryStatus" NOT NULL DEFAULT 'pending',
    "initial_delivered_at" TIMESTAMP(3),
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "password_changed_at" TIMESTAMP(3),
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "merchant_no" TEXT NOT NULL,
    "tier" "MerchantTier" NOT NULL DEFAULT 'first_tier',
    "name" TEXT NOT NULL,
    "contact_phone" TEXT,
    "status" "MerchantStatus" NOT NULL DEFAULT 'pending_deposit',
    "risk_status" "RiskStatus" NOT NULL DEFAULT 'normal',
    "deposit_status" "DepositStatus" NOT NULL DEFAULT 'pending_payment',
    "creation_source" "MerchantCreationSource" NOT NULL DEFAULT 'self_application',
    "created_by_admin_id" TEXT,
    "initial_account_status" "InitialAccountDeliveryStatus" NOT NULL DEFAULT 'pending',
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_applications" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "user_id" TEXT,
    "invite_code_id" TEXT,
    "tier" "MerchantTier" NOT NULL DEFAULT 'first_tier',
    "identity_info_json" JSONB NOT NULL,
    "contact_info_json" JSONB NOT NULL,
    "customer_service_wechat" TEXT,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending_review',
    "reject_reason" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_invite_codes" (
    "id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "issuer_merchant_id" TEXT,
    "tier" "MerchantTier" NOT NULL,
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "deposit_required_amount_cents" BIGINT,
    "status" "ReviewStatus" NOT NULL DEFAULT 'approved',
    "expires_at" TIMESTAMP(3),
    "created_by_admin_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_invite_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "owner_type" "ShopOwnerType" NOT NULL DEFAULT 'merchant',
    "merchant_id" TEXT,
    "shop_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logo_url" TEXT,
    "announcement" TEXT,
    "customer_service_wechat" TEXT,
    "customer_service_qr_url" TEXT,
    "customer_service_qq" TEXT,
    "customer_service_qq_qr_url" TEXT,
    "customer_service_note" TEXT,
    "collection_account_name" TEXT,
    "collection_qr_url" TEXT,
    "collection_note" TEXT,
    "theme_color" TEXT,
    "banner_url" TEXT,
    "share_title" TEXT,
    "share_path" TEXT NOT NULL,
    "status" "ShopStatus" NOT NULL DEFAULT 'not_opened',
    "risk_status" "RiskStatus" NOT NULL DEFAULT 'normal',
    "creation_source" "MerchantCreationSource",
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_product_groups" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "product_listing_ids" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_product_groups_pkey" PRIMARY KEY ("id")
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
    "category_name" TEXT,
    "tags_json" JSONB,
    "image_url" TEXT,
    "specs_json" JSONB,
    "detail_sections_json" JSONB,
    "stock_count" INTEGER NOT NULL DEFAULT 0,
    "sold_count" INTEGER NOT NULL DEFAULT 0,
    "display_badge" TEXT,
    "is_recommended" BOOLEAN NOT NULL DEFAULT false,
    "display_sort" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT NOT NULL,
    "rights_desc" TEXT NOT NULL,
    "supply_price_cents" BIGINT NOT NULL,
    "min_sale_price_cents" BIGINT NOT NULL,
    "suggested_sale_price_cents" BIGINT NOT NULL,
    "fulfillment_type" "FulfillmentType" NOT NULL DEFAULT 'manual',
    "fulfillment_rule_json" JSONB NOT NULL,
    "manual_fulfillment_instruction" TEXT,
    "manual_fulfillment_wechat_qr_url" TEXT,
    "manual_fulfillment_qq_qr_url" TEXT,
    "manual_fulfillment_wechat_id" TEXT,
    "manual_fulfillment_qq_id" TEXT,
    "after_sale_rule_json" JSONB NOT NULL,
    "extract_code_required" BOOLEAN NOT NULL DEFAULT false,
    "extract_code_ttl_minutes" INTEGER,
    "status" "ProductStatus" NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_shop_products" (
    "id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "platform_product_id" TEXT NOT NULL,
    "sale_price_cents" BIGINT NOT NULL,
    "fulfillment_cost_cents" BIGINT NOT NULL DEFAULT 0,
    "status" "ProductListingStatus" NOT NULL DEFAULT 'listed',
    "listed_at" TIMESTAMP(3),
    "delisted_at" TIMESTAMP(3),
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_shop_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rights_codes" (
    "id" TEXT NOT NULL,
    "product_id" TEXT,
    "merchant_product_listing_id" TEXT,
    "code_ciphertext" TEXT NOT NULL,
    "code_hash" TEXT,
    "secret_preview" TEXT,
    "owner_type" "RightsCodeOwnerType" NOT NULL DEFAULT 'platform',
    "owner_merchant_id" TEXT,
    "shop_id" TEXT,
    "batch_no" TEXT NOT NULL,
    "status" "RightsCodeStatus" NOT NULL DEFAULT 'available',
    "order_id" TEXT,
    "issue_key" TEXT,
    "imported_by" TEXT,
    "issued_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "import_audit_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rights_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_code_batches" (
    "id" TEXT NOT NULL,
    "batch_no" TEXT NOT NULL,
    "platform_product_id" TEXT NOT NULL,
    "imported_by" TEXT,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "available_count" INTEGER NOT NULL DEFAULT 0,
    "encrypted_payload_schema" JSONB,
    "status" "ProductStatus" NOT NULL DEFAULT 'active',
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_code_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "virtual_codes" (
    "id" TEXT NOT NULL,
    "platform_product_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "account_ciphertext" TEXT,
    "secret_ciphertext" TEXT NOT NULL,
    "secret_fingerprint" TEXT,
    "metadata_json" JSONB,
    "status" "VirtualCodeStatus" NOT NULL DEFAULT 'available',
    "reserved_order_id" TEXT,
    "reserved_order_item_id" TEXT,
    "reserved_until" TIMESTAMP(3),
    "issued_order_id" TEXT,
    "issued_order_item_id" TEXT,
    "issued_at" TIMESTAMP(3),
    "lock_idempotency_key" TEXT,
    "issue_idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "virtual_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_product_listings" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "source_type" "MerchantProductListingSourceType" NOT NULL DEFAULT 'platform_product',
    "platform_product_id" TEXT NOT NULL,
    "upstream_listing_id" TEXT,
    "sale_price_cents" BIGINT NOT NULL,
    "display_name" TEXT,
    "display_subtitle" TEXT,
    "display_description" TEXT,
    "display_usage_guide" TEXT,
    "display_image_url" TEXT,
    "display_category" TEXT,
    "display_tags_json" JSONB,
    "display_specs_json" JSONB,
    "display_detail_sections_json" JSONB,
    "status" "ProductListingStatus" NOT NULL DEFAULT 'draft',
    "listed_at" TIMESTAMP(3),
    "delisted_at" TIMESTAMP(3),
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_product_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_products" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "product_type" "ProductType" NOT NULL,
    "platform_product_id" TEXT,
    "own_product_review_id" TEXT,
    "sale_price_cents" BIGINT NOT NULL,
    "first_tier_supply_price_cents" BIGINT,
    "second_tier_supply_price_cents" BIGINT,
    "status" "ProductListingStatus" NOT NULL DEFAULT 'draft',
    "listed_at" TIMESTAMP(3),
    "delisted_at" TIMESTAMP(3),
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_product_reviews" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "platform_product_id" TEXT,
    "name" TEXT NOT NULL,
    "detail_json" JSONB NOT NULL,
    "sale_price_cents" BIGINT NOT NULL,
    "after_sale_rule_json" JSONB NOT NULL,
    "fulfillment_rule_json" JSONB NOT NULL,
    "fulfillment_type" "FulfillmentType" NOT NULL DEFAULT 'manual',
    "manual_fulfillment_instruction" TEXT,
    "manual_fulfillment_wechat_qr_url" TEXT,
    "manual_fulfillment_qq_qr_url" TEXT,
    "manual_fulfillment_wechat_id" TEXT,
    "manual_fulfillment_qq_id" TEXT,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending_review',
    "reject_reason" TEXT,
    "risk_reason" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_product_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "shop_id" TEXT NOT NULL,
    "buyer_email" TEXT,
    "buyer_phone" TEXT,
    "purchase_password_hash" TEXT,
    "sales_channel_type" "SalesChannelType" NOT NULL DEFAULT 'single_merchant',
    "platform_shop_id" TEXT,
    "client_type" TEXT,
    "first_tier_merchant_id" TEXT,
    "second_tier_merchant_id" TEXT,
    "third_tier_merchant_id" TEXT,
    "collection_snapshot_json" JSONB,
    "coupon_discount_cents" BIGINT NOT NULL DEFAULT 0,
    "coupon_snapshot_json" JSONB,
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
    "merchant_product_listing_id" TEXT,
    "merchant_product_id" TEXT,
    "platform_shop_product_id" TEXT,
    "sale_source_type" "SaleSourceType" NOT NULL DEFAULT 'merchant_product_listing',
    "product_type" "ProductType" NOT NULL,
    "product_id_snapshot" TEXT NOT NULL,
    "product_name_snapshot" TEXT NOT NULL,
    "sale_price_cents" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "supply_price_cents" BIGINT NOT NULL,
    "service_fee_cents" BIGINT NOT NULL,
    "merchant_income_cents" BIGINT NOT NULL,
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
    "merchant_expected_income_cents" BIGINT NOT NULL,
    "platform_supply_price_cents" BIGINT NOT NULL DEFAULT 0,
    "resell_supply_price_cents" BIGINT NOT NULL DEFAULT 0,
    "first_tier_supply_price_cents" BIGINT NOT NULL DEFAULT 0,
    "second_tier_supply_price_cents" BIGINT NOT NULL DEFAULT 0,
    "final_sale_price_cents" BIGINT NOT NULL DEFAULT 0,
    "first_tier_income_cents" BIGINT NOT NULL DEFAULT 0,
    "second_tier_income_cents" BIGINT NOT NULL DEFAULT 0,
    "third_tier_income_cents" BIGINT NOT NULL DEFAULT 0,
    "fulfillment_cost_cents" BIGINT NOT NULL DEFAULT 0,
    "payment_channel_fee_cents" BIGINT NOT NULL DEFAULT 0,
    "platform_gross_profit_cents" BIGINT NOT NULL DEFAULT 0,
    "payment_fee_bps" INTEGER NOT NULL DEFAULT 0,
    "payment_fee_cents" BIGINT NOT NULL DEFAULT 0,
    "balance_paid_cents" BIGINT NOT NULL DEFAULT 0,
    "external_paid_cents" BIGINT NOT NULL DEFAULT 0,
    "service_fee_enabled" BOOLEAN NOT NULL DEFAULT true,
    "service_fee_basis_amount_cents" BIGINT NOT NULL DEFAULT 0,
    "service_fee_config_snapshot_json" JSONB,
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
    "merchant_id" TEXT,
    "collection_payment_config_id" TEXT,
    "collection_snapshot_json" JSONB,
    "channel" "PaymentChannel" NOT NULL,
    "provider" "PaymentProvider",
    "confirm_mode" "PaymentConfirmMode",
    "environment" "PaymentEnvironment",
    "channel_trade_no" TEXT,
    "provider_payment_no" TEXT,
    "provider_trade_no" TEXT,
    "base_amount_cents" BIGINT NOT NULL DEFAULT 0,
    "fee_bps" INTEGER NOT NULL DEFAULT 0,
    "fee_cents" BIGINT NOT NULL DEFAULT 0,
    "amount_cents" BIGINT NOT NULL,
    "channel_fee_cents" BIGINT NOT NULL DEFAULT 0,
    "status" "PaymentStatus" NOT NULL DEFAULT 'paying',
    "confirm_source" "PaymentConfirmSource" NOT NULL DEFAULT 'unconfirmed',
    "idempotency_key" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "callback_handled_at" TIMESTAMP(3),
    "exception_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_callbacks" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT,
    "channel" "PaymentChannel" NOT NULL,
    "channel_event_id" TEXT NOT NULL,
    "raw_payload_json" JSONB NOT NULL,
    "processed_status" "CallbackProcessStatus" NOT NULL DEFAULT 'received',
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "payment_callbacks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_payment_configs" (
    "id" TEXT NOT NULL,
    "config_no" TEXT NOT NULL,
    "owner_type" "CollectionConfigOwnerType" NOT NULL,
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
    "gateway_url" TEXT,
    "api_mode" TEXT,
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

-- CreateTable
CREATE TABLE "payment_snapshots" (
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
    "base_amount_cents" BIGINT NOT NULL DEFAULT 0,
    "fee_bps" INTEGER NOT NULL DEFAULT 0,
    "fee_cents" BIGINT NOT NULL DEFAULT 0,
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

-- CreateTable
CREATE TABLE "payment_callback_logs" (
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

-- CreateTable
CREATE TABLE "payment_exceptions" (
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

-- CreateTable
CREATE TABLE "payment_dispute_materials" (
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

-- CreateTable
CREATE TABLE "payment_confirmations" (
    "id" TEXT NOT NULL,
    "confirmation_no" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "payment_id" TEXT,
    "shop_id" TEXT NOT NULL,
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

-- CreateTable
CREATE TABLE "fulfillment_records" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "shop_id" TEXT,
    "virtual_code_id" TEXT,
    "idempotency_key" TEXT,
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
CREATE TABLE "order_extract_secrets" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "virtual_code_id" TEXT,
    "refund_id" TEXT,
    "claim_code_hash" TEXT NOT NULL,
    "status" "ExtractSecretStatus" NOT NULL DEFAULT 'active',
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "first_viewed_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoke_reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_extract_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_extract_logs" (
    "id" TEXT NOT NULL,
    "extract_secret_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "result" "ExtractLogResult" NOT NULL,
    "reason_code" TEXT,
    "ip" TEXT,
    "client_info" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_extract_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_plaintext_access_logs" (
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
    "client_info" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_plaintext_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_delivery_records" (
    "id" TEXT NOT NULL,
    "delivery_no" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_item_id" TEXT,
    "email" TEXT NOT NULL,
    "scope" "EmailDeliveryScope" NOT NULL DEFAULT 'extract_link',
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'pending',
    "code_count" INTEGER NOT NULL DEFAULT 0,
    "extract_token_hash" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMP(3),
    "actor_type" "ActorType" NOT NULL DEFAULT 'system',
    "actor_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'auto_fulfillment',
    "idempotency_key" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_delivery_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "after_sales" (
    "id" TEXT NOT NULL,
    "after_sale_no" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "shop_id" TEXT NOT NULL,
    "status" "AfterSaleStatus" NOT NULL DEFAULT 'pending',
    "reason_code" TEXT NOT NULL,
    "responsibility" "Responsibility" NOT NULL DEFAULT 'undecided',
    "requested_refund_cents" BIGINT NOT NULL,
    "approved_refund_cents" BIGINT NOT NULL DEFAULT 0,
    "platform_bear_cents" BIGINT NOT NULL DEFAULT 0,
    "merchant_bear_cents" BIGINT NOT NULL DEFAULT 0,
    "first_tier_bear_cents" BIGINT NOT NULL DEFAULT 0,
    "second_tier_bear_cents" BIGINT NOT NULL DEFAULT 0,
    "third_tier_bear_cents" BIGINT NOT NULL DEFAULT 0,
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
CREATE TABLE "refund_manual_confirmations" (
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

-- CreateTable
CREATE TABLE "refund_callbacks" (
    "id" TEXT NOT NULL,
    "refund_id" TEXT,
    "channel" "PaymentChannel" NOT NULL,
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
    "merchant_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "status" "SettlementSheetStatus" NOT NULL DEFAULT 'draft',
    "total_order_count" INTEGER NOT NULL DEFAULT 0,
    "total_paid_cents" BIGINT NOT NULL DEFAULT 0,
    "total_service_fee_cents" BIGINT NOT NULL DEFAULT 0,
    "total_merchant_income_cents" BIGINT NOT NULL DEFAULT 0,
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
    "settlement_role" "SettlementRole" NOT NULL DEFAULT 'single_merchant',
    "merchant_id" TEXT NOT NULL,
    "shop_id" TEXT NOT NULL,
    "paid_amount_cents" BIGINT NOT NULL,
    "supply_amount_cents" BIGINT NOT NULL,
    "service_fee_cents" BIGINT NOT NULL,
    "merchant_income_cents" BIGINT NOT NULL,
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
    "merchant_id" TEXT NOT NULL,
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
CREATE TABLE "coupon_templates" (
    "id" TEXT NOT NULL,
    "coupon_no" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "discount_type" "CouponDiscountType" NOT NULL DEFAULT 'fixed_amount',
    "discount_amount_cents" BIGINT NOT NULL,
    "platform_subsidy_cents" BIGINT NOT NULL DEFAULT 0,
    "threshold_amount_cents" BIGINT NOT NULL DEFAULT 0,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "first_registration_only" BOOLEAN NOT NULL DEFAULT false,
    "status" "CouponTemplateStatus" NOT NULL DEFAULT 'draft',
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "total_limit" INTEGER,
    "issued_count" INTEGER NOT NULL DEFAULT 0,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupon_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_scopes" (
    "id" TEXT NOT NULL,
    "coupon_template_id" TEXT NOT NULL,
    "scope_type" "CouponScopeType" NOT NULL,
    "platform_product_id" TEXT,
    "merchant_product_id" TEXT,
    "shop_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_coupons" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "coupon_template_id" TEXT NOT NULL,
    "status" "CouponStatus" NOT NULL DEFAULT 'active',
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "valid_from" TIMESTAMP(3) NOT NULL,
    "valid_to" TIMESTAMP(3) NOT NULL,
    "void_reason" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_grant_records" (
    "id" TEXT NOT NULL,
    "user_coupon_id" TEXT NOT NULL,
    "coupon_template_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "granted_by" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_grant_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_void_records" (
    "id" TEXT NOT NULL,
    "user_coupon_id" TEXT NOT NULL,
    "coupon_template_id" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT,
    "voided_by" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_void_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_usage" (
    "id" TEXT NOT NULL,
    "user_coupon_id" TEXT NOT NULL,
    "coupon_template_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "discount_cents" BIGINT NOT NULL,
    "subsidy_cents" BIGINT NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMP(3),
    "reverse_reason" TEXT,

    CONSTRAINT "coupon_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_wallets" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "wallet_no" TEXT NOT NULL,
    "available_balance_cents" BIGINT NOT NULL DEFAULT 0,
    "frozen_balance_cents" BIGINT NOT NULL DEFAULT 0,
    "total_recharge_cents" BIGINT NOT NULL DEFAULT 0,
    "total_spend_cents" BIGINT NOT NULL DEFAULT 0,
    "status" "WalletStatus" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_recharge_orders" (
    "id" TEXT NOT NULL,
    "recharge_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "payment_id" TEXT,
    "provider" "PaymentProvider" NOT NULL,
    "confirm_mode" "PaymentConfirmMode" NOT NULL,
    "recharge_cents" BIGINT NOT NULL,
    "fee_bps" INTEGER NOT NULL DEFAULT 0,
    "fee_cents" BIGINT NOT NULL DEFAULT 0,
    "payable_cents" BIGINT NOT NULL,
    "status" "WalletRechargeStatus" NOT NULL DEFAULT 'pending_payment',
    "paid_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_recharge_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_payment_holds" (
    "id" TEXT NOT NULL,
    "hold_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "payment_id" TEXT,
    "amount_cents" BIGINT NOT NULL,
    "status" "WalletHoldStatus" NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3),
    "captured_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_payment_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" TEXT NOT NULL,
    "transaction_no" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "wallet_id" TEXT NOT NULL,
    "type" "WalletTransactionType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "balance_before_cents" BIGINT NOT NULL,
    "balance_after_cents" BIGINT NOT NULL,
    "frozen_before_cents" BIGINT NOT NULL DEFAULT 0,
    "frozen_after_cents" BIGINT NOT NULL DEFAULT 0,
    "order_id" TEXT,
    "payment_id" TEXT,
    "recharge_order_id" TEXT,
    "hold_id" TEXT,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "note" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_accounts" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT,
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
    "merchant_id" TEXT,
    "account_id" TEXT NOT NULL,
    "type" "DepositTransactionType" NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "balance_before_cents" BIGINT NOT NULL,
    "balance_after_cents" BIGINT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "related_type" TEXT,
    "related_id" TEXT,
    "voucher_url" TEXT,
    "note" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "operator_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clawbacks" (
    "id" TEXT NOT NULL,
    "clawback_no" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "order_id" TEXT,
    "settlement_role" "SettlementRole",
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
CREATE TABLE "payment_channel_configs" (
    "id" TEXT NOT NULL,
    "channel" "PaymentChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "fee_bps" INTEGER NOT NULL DEFAULT 0,
    "fixed_fee_cents" BIGINT NOT NULL DEFAULT 0,
    "config_json" JSONB,
    "status_note" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_channel_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_service_fee_configs" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "fee_bps" INTEGER NOT NULL,
    "basis_type" "ServiceFeeBasisType" NOT NULL DEFAULT 'final_sale_price',
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "status" "ServiceFeeConfigStatus" NOT NULL DEFAULT 'active',
    "created_by" TEXT,
    "updated_by" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_service_fee_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "ledger_no" TEXT NOT NULL,
    "merchant_id" TEXT,
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
CREATE TABLE "ledger_accounts" (
    "id" TEXT NOT NULL,
    "subject_type" "LedgerSubjectType" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "account_type" "LedgerAccountType" NOT NULL,
    "balance_cents" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_freezes" (
    "id" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "merchant_id" TEXT,
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
    "merchant_id" TEXT NOT NULL,
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
CREATE INDEX "user_identities_user_id_identity_type_idx" ON "user_identities"("user_id", "identity_type");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_identity_type_provider_external_id_key" ON "user_identities"("identity_type", "provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_session_no_key" ON "auth_sessions"("session_no");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_refresh_token_hash_key" ON "auth_sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_idempotency_key_key" ON "auth_sessions"("idempotency_key");

-- CreateIndex
CREATE INDEX "auth_sessions_subject_type_status_expires_at_idx" ON "auth_sessions"("subject_type", "status", "expires_at");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_status_idx" ON "auth_sessions"("user_id", "status");

-- CreateIndex
CREATE INDEX "auth_sessions_admin_user_id_status_idx" ON "auth_sessions"("admin_user_id", "status");

-- CreateIndex
CREATE INDEX "auth_sessions_merchant_account_id_status_idx" ON "auth_sessions"("merchant_account_id", "status");

-- CreateIndex
CREATE INDEX "auth_sessions_merchant_id_status_idx" ON "auth_sessions"("merchant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_accounts_username_key" ON "merchant_accounts"("username");

-- CreateIndex
CREATE INDEX "merchant_accounts_merchant_id_status_idx" ON "merchant_accounts"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "merchant_accounts_user_id_idx" ON "merchant_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_merchant_no_key" ON "merchants"("merchant_no");

-- CreateIndex
CREATE INDEX "merchants_tier_status_idx" ON "merchants"("tier", "status");

-- CreateIndex
CREATE INDEX "merchants_deposit_status_idx" ON "merchants"("deposit_status");

-- CreateIndex
CREATE INDEX "merchants_creation_source_created_at_idx" ON "merchants"("creation_source", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_applications_idempotency_key_key" ON "merchant_applications"("idempotency_key");

-- CreateIndex
CREATE INDEX "merchant_applications_tier_status_created_at_idx" ON "merchant_applications"("tier", "status", "created_at");

-- CreateIndex
CREATE INDEX "merchant_applications_merchant_id_idx" ON "merchant_applications"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_invite_codes_code_hash_key" ON "merchant_invite_codes"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_invite_codes_idempotency_key_key" ON "merchant_invite_codes"("idempotency_key");

-- CreateIndex
CREATE INDEX "merchant_invite_codes_issuer_merchant_id_status_idx" ON "merchant_invite_codes"("issuer_merchant_id", "status");

-- CreateIndex
CREATE INDEX "merchant_invite_codes_tier_status_expires_at_idx" ON "merchant_invite_codes"("tier", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "shops_merchant_id_key" ON "shops"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "shops_shop_no_key" ON "shops"("shop_no");

-- CreateIndex
CREATE UNIQUE INDEX "shops_share_path_key" ON "shops"("share_path");

-- CheckConstraint
ALTER TABLE "shops" ADD CONSTRAINT "shops_owner_type_merchant_id_check" CHECK (
    ("owner_type" = 'platform' AND "merchant_id" IS NULL)
    OR ("owner_type" = 'merchant' AND "merchant_id" IS NOT NULL)
);

-- CreateIndex
CREATE INDEX "shops_status_idx" ON "shops"("status");

-- CreateIndex
CREATE INDEX "shops_owner_type_status_idx" ON "shops"("owner_type", "status");

-- CreateIndex
CREATE INDEX "shops_merchant_id_status_idx" ON "shops"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "shop_product_groups_shop_id_sort_order_idx" ON "shop_product_groups"("shop_id", "sort_order");

-- CreateIndex
CREATE INDEX "shop_customer_service_bindings_shop_id_status_idx" ON "shop_customer_service_bindings"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_products_product_no_key" ON "platform_products"("product_no");

-- CreateIndex
CREATE INDEX "platform_products_status_idx" ON "platform_products"("status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_shop_products_idempotency_key_key" ON "platform_shop_products"("idempotency_key");

-- CreateIndex
CREATE INDEX "platform_shop_products_shop_id_status_idx" ON "platform_shop_products"("shop_id", "status");

-- CreateIndex
CREATE INDEX "platform_shop_products_platform_product_id_status_idx" ON "platform_shop_products"("platform_product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "platform_shop_products_shop_id_platform_product_id_key" ON "platform_shop_products"("shop_id", "platform_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "rights_codes_issue_key_key" ON "rights_codes"("issue_key");

-- CreateIndex
CREATE INDEX "rights_codes_product_id_status_idx" ON "rights_codes"("product_id", "status");

-- CreateIndex
CREATE INDEX "rights_codes_merchant_product_listing_id_status_idx" ON "rights_codes"("merchant_product_listing_id", "status");

-- CreateIndex
CREATE INDEX "rights_codes_owner_type_status_idx" ON "rights_codes"("owner_type", "status");

-- CreateIndex
CREATE INDEX "rights_codes_owner_merchant_id_status_idx" ON "rights_codes"("owner_merchant_id", "status");

-- CreateIndex
CREATE INDEX "rights_codes_shop_id_status_idx" ON "rights_codes"("shop_id", "status");

-- CreateIndex
CREATE INDEX "rights_codes_code_hash_idx" ON "rights_codes"("code_hash");

-- CreateIndex
CREATE INDEX "rights_codes_batch_no_idx" ON "rights_codes"("batch_no");

-- CreateIndex
CREATE UNIQUE INDEX "rights_codes_product_id_code_ciphertext_key" ON "rights_codes"("product_id", "code_ciphertext");

-- CreateIndex
CREATE UNIQUE INDEX "rights_codes_merchant_product_listing_id_code_ciphertext_key" ON "rights_codes"("merchant_product_listing_id", "code_ciphertext");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_code_batches_batch_no_key" ON "virtual_code_batches"("batch_no");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_code_batches_idempotency_key_key" ON "virtual_code_batches"("idempotency_key");

-- CreateIndex
CREATE INDEX "virtual_code_batches_platform_product_id_status_idx" ON "virtual_code_batches"("platform_product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_codes_lock_idempotency_key_key" ON "virtual_codes"("lock_idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_codes_issue_idempotency_key_key" ON "virtual_codes"("issue_idempotency_key");

-- CreateIndex
CREATE INDEX "virtual_codes_platform_product_id_status_created_at_idx" ON "virtual_codes"("platform_product_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "virtual_codes_batch_id_status_idx" ON "virtual_codes"("batch_id", "status");

-- CreateIndex
CREATE INDEX "virtual_codes_reserved_order_id_idx" ON "virtual_codes"("reserved_order_id");

-- CreateIndex
CREATE INDEX "virtual_codes_issued_order_id_idx" ON "virtual_codes"("issued_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "virtual_codes_batch_id_secret_fingerprint_key" ON "virtual_codes"("batch_id", "secret_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_product_listings_idempotency_key_key" ON "merchant_product_listings"("idempotency_key");

-- CreateIndex
CREATE INDEX "merchant_product_listings_merchant_id_status_idx" ON "merchant_product_listings"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "merchant_product_listings_shop_id_status_idx" ON "merchant_product_listings"("shop_id", "status");

-- CreateIndex
CREATE INDEX "merchant_product_listings_source_type_status_idx" ON "merchant_product_listings"("source_type", "status");

-- CreateIndex
CREATE INDEX "merchant_product_listings_platform_product_id_status_idx" ON "merchant_product_listings"("platform_product_id", "status");

-- CreateIndex
CREATE INDEX "merchant_product_listings_upstream_listing_id_status_idx" ON "merchant_product_listings"("upstream_listing_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_product_listings_shop_id_platform_product_id_key" ON "merchant_product_listings"("shop_id", "platform_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_products_own_product_review_id_key" ON "merchant_products"("own_product_review_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_products_idempotency_key_key" ON "merchant_products"("idempotency_key");

-- CreateIndex
CREATE INDEX "merchant_products_merchant_id_status_idx" ON "merchant_products"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "merchant_products_shop_id_status_idx" ON "merchant_products"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_products_shop_id_product_type_platform_product_id_key" ON "merchant_products"("shop_id", "product_type", "platform_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_product_reviews_idempotency_key_key" ON "merchant_product_reviews"("idempotency_key");

-- CreateIndex
CREATE INDEX "merchant_product_reviews_merchant_id_status_idx" ON "merchant_product_reviews"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "merchant_product_reviews_shop_id_status_idx" ON "merchant_product_reviews"("shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_no_key" ON "orders"("order_no");

-- CreateIndex
CREATE INDEX "orders_merchant_id_created_at_idx" ON "orders"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_sales_channel_type_created_at_idx" ON "orders"("sales_channel_type", "created_at");

-- CreateIndex
CREATE INDEX "orders_first_tier_merchant_id_created_at_idx" ON "orders"("first_tier_merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_second_tier_merchant_id_created_at_idx" ON "orders"("second_tier_merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_third_tier_merchant_id_created_at_idx" ON "orders"("third_tier_merchant_id", "created_at");

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
CREATE INDEX "order_items_merchant_product_listing_id_idx" ON "order_items"("merchant_product_listing_id");

-- CreateIndex
CREATE INDEX "order_items_merchant_product_id_idx" ON "order_items"("merchant_product_id");

-- CreateIndex
CREATE INDEX "order_items_platform_shop_product_id_idx" ON "order_items"("platform_shop_product_id");

-- CreateIndex
CREATE INDEX "order_items_sale_source_type_created_at_idx" ON "order_items"("sale_source_type", "created_at");

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
CREATE INDEX "payments_merchant_id_status_idx" ON "payments"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "payments_collection_payment_config_id_status_idx" ON "payments"("collection_payment_config_id", "status");

-- CreateIndex
CREATE INDEX "payments_provider_status_idx" ON "payments"("provider", "status");

-- CreateIndex
CREATE INDEX "payments_provider_payment_no_idx" ON "payments"("provider_payment_no");

-- CreateIndex
CREATE INDEX "payments_provider_trade_no_idx" ON "payments"("provider_trade_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_callbacks_channel_event_id_key" ON "payment_callbacks"("channel_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_callbacks_idempotency_key_key" ON "payment_callbacks"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_callbacks_payment_id_idx" ON "payment_callbacks"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "collection_payment_configs_config_no_key" ON "collection_payment_configs"("config_no");

-- CreateIndex
CREATE UNIQUE INDEX "collection_payment_configs_idempotency_key_key" ON "collection_payment_configs"("idempotency_key");

-- CheckConstraint
ALTER TABLE "collection_payment_configs" ADD CONSTRAINT "collection_payment_configs_owner_check" CHECK (
    ("owner_type" = 'platform' AND "owner_merchant_id" IS NULL)
    OR ("owner_type" = 'merchant' AND "owner_merchant_id" IS NOT NULL)
);

-- CreateIndex
CREATE INDEX "collection_payment_configs_owner_type_status_idx" ON "collection_payment_configs"("owner_type", "status");

-- CreateIndex
CREATE INDEX "collection_payment_configs_owner_merchant_id_status_idx" ON "collection_payment_configs"("owner_merchant_id", "status");

-- CreateIndex
CREATE INDEX "collection_payment_configs_shop_id_status_idx" ON "collection_payment_configs"("shop_id", "status");

-- CreateIndex
CREATE INDEX "collection_payment_configs_provider_status_idx" ON "collection_payment_configs"("provider", "status");

-- CreateIndex
CREATE INDEX "collection_payment_configs_is_default_status_idx" ON "collection_payment_configs"("is_default", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_snapshots_snapshot_no_key" ON "payment_snapshots"("snapshot_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_snapshots_payment_no_key" ON "payment_snapshots"("payment_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_snapshots_idempotency_key_key" ON "payment_snapshots"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_snapshots_order_id_created_at_idx" ON "payment_snapshots"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_snapshots_payment_id_idx" ON "payment_snapshots"("payment_id");

-- CreateIndex
CREATE INDEX "payment_snapshots_collection_config_id_status_idx" ON "payment_snapshots"("collection_config_id", "status");

-- CreateIndex
CREATE INDEX "payment_snapshots_provider_status_idx" ON "payment_snapshots"("provider", "status");

-- CreateIndex
CREATE INDEX "payment_snapshots_provider_payment_no_idx" ON "payment_snapshots"("provider_payment_no");

-- CreateIndex
CREATE INDEX "payment_snapshots_provider_trade_no_idx" ON "payment_snapshots"("provider_trade_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_callback_logs_callback_no_key" ON "payment_callback_logs"("callback_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_callback_logs_provider_event_id_key" ON "payment_callback_logs"("provider_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_callback_logs_idempotency_key_key" ON "payment_callback_logs"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_callback_logs_payment_id_idx" ON "payment_callback_logs"("payment_id");

-- CreateIndex
CREATE INDEX "payment_callback_logs_order_id_created_at_idx" ON "payment_callback_logs"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_callback_logs_payment_snapshot_id_idx" ON "payment_callback_logs"("payment_snapshot_id");

-- CreateIndex
CREATE INDEX "payment_callback_logs_collection_config_id_created_at_idx" ON "payment_callback_logs"("collection_config_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_callback_logs_provider_processed_status_created_at_idx" ON "payment_callback_logs"("provider", "processed_status", "created_at");

-- CreateIndex
CREATE INDEX "payment_callback_logs_order_no_idx" ON "payment_callback_logs"("order_no");

-- CreateIndex
CREATE INDEX "payment_callback_logs_provider_trade_no_idx" ON "payment_callback_logs"("provider_trade_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_exceptions_exception_no_key" ON "payment_exceptions"("exception_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_exceptions_idempotency_key_key" ON "payment_exceptions"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_exceptions_status_created_at_idx" ON "payment_exceptions"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_exceptions_exception_type_status_idx" ON "payment_exceptions"("exception_type", "status");

-- CreateIndex
CREATE INDEX "payment_exceptions_order_id_status_idx" ON "payment_exceptions"("order_id", "status");

-- CreateIndex
CREATE INDEX "payment_exceptions_payment_id_idx" ON "payment_exceptions"("payment_id");

-- CreateIndex
CREATE INDEX "payment_exceptions_payment_snapshot_id_idx" ON "payment_exceptions"("payment_snapshot_id");

-- CreateIndex
CREATE INDEX "payment_exceptions_callback_log_id_idx" ON "payment_exceptions"("callback_log_id");

-- CreateIndex
CREATE INDEX "payment_exceptions_collection_config_id_status_idx" ON "payment_exceptions"("collection_config_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_dispute_materials_material_no_key" ON "payment_dispute_materials"("material_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_dispute_materials_idempotency_key_key" ON "payment_dispute_materials"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_dispute_materials_order_id_created_at_idx" ON "payment_dispute_materials"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "payment_dispute_materials_payment_id_idx" ON "payment_dispute_materials"("payment_id");

-- CreateIndex
CREATE INDEX "payment_dispute_materials_payment_exception_id_idx" ON "payment_dispute_materials"("payment_exception_id");

-- CreateIndex
CREATE INDEX "payment_dispute_materials_status_created_at_idx" ON "payment_dispute_materials"("status", "created_at");

-- CreateIndex
CREATE INDEX "payment_dispute_materials_material_type_created_at_idx" ON "payment_dispute_materials"("material_type", "created_at");

-- CreateIndex
CREATE INDEX "payment_dispute_materials_uploaded_by_type_uploaded_by_id_c_idx" ON "payment_dispute_materials"("uploaded_by_type", "uploaded_by_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_confirmations_confirmation_no_key" ON "payment_confirmations"("confirmation_no");

-- CreateIndex
CREATE UNIQUE INDEX "payment_confirmations_idempotency_key_key" ON "payment_confirmations"("idempotency_key");

-- CreateIndex
CREATE INDEX "payment_confirmations_order_id_status_idx" ON "payment_confirmations"("order_id", "status");

-- CreateIndex
CREATE INDEX "payment_confirmations_shop_id_status_created_at_idx" ON "payment_confirmations"("shop_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "fulfillment_records_idempotency_key_key" ON "fulfillment_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "fulfillment_records_merchant_id_status_idx" ON "fulfillment_records"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "fulfillment_records_order_id_idx" ON "fulfillment_records"("order_id");

-- CreateIndex
CREATE INDEX "fulfillment_records_order_item_id_idx" ON "fulfillment_records"("order_item_id");

-- CreateIndex
CREATE INDEX "fulfillment_records_virtual_code_id_idx" ON "fulfillment_records"("virtual_code_id");

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
CREATE UNIQUE INDEX "order_extract_secrets_idempotency_key_key" ON "order_extract_secrets"("idempotency_key");

-- CreateIndex
CREATE INDEX "order_extract_secrets_order_id_claim_code_hash_idx" ON "order_extract_secrets"("order_id", "claim_code_hash");

-- CreateIndex
CREATE INDEX "order_extract_secrets_order_id_status_idx" ON "order_extract_secrets"("order_id", "status");

-- CreateIndex
CREATE INDEX "order_extract_secrets_order_item_id_idx" ON "order_extract_secrets"("order_item_id");

-- CreateIndex
CREATE INDEX "order_extract_secrets_virtual_code_id_idx" ON "order_extract_secrets"("virtual_code_id");

-- CreateIndex
CREATE INDEX "order_extract_secrets_refund_id_idx" ON "order_extract_secrets"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_extract_logs_idempotency_key_key" ON "order_extract_logs"("idempotency_key");

-- CreateIndex
CREATE INDEX "order_extract_logs_extract_secret_id_created_at_idx" ON "order_extract_logs"("extract_secret_id", "created_at");

-- CreateIndex
CREATE INDEX "order_extract_logs_order_id_created_at_idx" ON "order_extract_logs"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "code_plaintext_access_logs_access_no_key" ON "code_plaintext_access_logs"("access_no");

-- CreateIndex
CREATE UNIQUE INDEX "code_plaintext_access_logs_idempotency_key_key" ON "code_plaintext_access_logs"("idempotency_key");

-- CreateIndex
CREATE INDEX "code_plaintext_access_logs_actor_type_actor_id_created_at_idx" ON "code_plaintext_access_logs"("actor_type", "actor_id", "created_at");

-- CreateIndex
CREATE INDEX "code_plaintext_access_logs_access_type_created_at_idx" ON "code_plaintext_access_logs"("access_type", "created_at");

-- CreateIndex
CREATE INDEX "code_plaintext_access_logs_product_id_created_at_idx" ON "code_plaintext_access_logs"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "code_plaintext_access_logs_virtual_code_id_created_at_idx" ON "code_plaintext_access_logs"("virtual_code_id", "created_at");

-- CreateIndex
CREATE INDEX "code_plaintext_access_logs_rights_code_id_created_at_idx" ON "code_plaintext_access_logs"("rights_code_id", "created_at");

-- CreateIndex
CREATE INDEX "code_plaintext_access_logs_order_id_created_at_idx" ON "code_plaintext_access_logs"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "code_plaintext_access_logs_request_id_idx" ON "code_plaintext_access_logs"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_delivery_records_delivery_no_key" ON "email_delivery_records"("delivery_no");

-- CreateIndex
CREATE UNIQUE INDEX "email_delivery_records_idempotency_key_key" ON "email_delivery_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "email_delivery_records_order_id_status_idx" ON "email_delivery_records"("order_id", "status");

-- CreateIndex
CREATE INDEX "email_delivery_records_email_created_at_idx" ON "email_delivery_records"("email", "created_at");

-- CreateIndex
CREATE INDEX "email_delivery_records_status_next_retry_at_idx" ON "email_delivery_records"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "email_delivery_records_actor_type_actor_id_created_at_idx" ON "email_delivery_records"("actor_type", "actor_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "after_sales_after_sale_no_key" ON "after_sales"("after_sale_no");

-- CreateIndex
CREATE INDEX "after_sales_merchant_id_status_idx" ON "after_sales"("merchant_id", "status");

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
CREATE UNIQUE INDEX "refund_manual_confirmations_confirmation_no_key" ON "refund_manual_confirmations"("confirmation_no");

-- CreateIndex
CREATE UNIQUE INDEX "refund_manual_confirmations_idempotency_key_key" ON "refund_manual_confirmations"("idempotency_key");

-- CreateIndex
CREATE INDEX "refund_manual_confirmations_refund_id_idx" ON "refund_manual_confirmations"("refund_id");

-- CreateIndex
CREATE INDEX "refund_manual_confirmations_order_id_idx" ON "refund_manual_confirmations"("order_id");

-- CreateIndex
CREATE INDEX "refund_manual_confirmations_confirmed_by_created_at_idx" ON "refund_manual_confirmations"("confirmed_by", "created_at");

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
CREATE INDEX "settlement_sheets_merchant_id_status_idx" ON "settlement_sheets"("merchant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_sheets_merchant_id_period_start_period_end_idemp_key" ON "settlement_sheets"("merchant_id", "period_start", "period_end", "idempotency_key");

-- CreateIndex
CREATE INDEX "settlement_items_settlement_id_idx" ON "settlement_items"("settlement_id");

-- CreateIndex
CREATE INDEX "settlement_items_merchant_id_created_at_idx" ON "settlement_items"("merchant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_items_order_id_settlement_role_key" ON "settlement_items"("order_id", "settlement_role");

-- CreateIndex
CREATE UNIQUE INDEX "manual_payouts_idempotency_key_key" ON "manual_payouts"("idempotency_key");

-- CreateIndex
CREATE INDEX "manual_payouts_merchant_id_status_idx" ON "manual_payouts"("merchant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_templates_coupon_no_key" ON "coupon_templates"("coupon_no");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_templates_idempotency_key_key" ON "coupon_templates"("idempotency_key");

-- CreateIndex
CREATE INDEX "coupon_templates_status_valid_from_valid_to_idx" ON "coupon_templates"("status", "valid_from", "valid_to");

-- CreateIndex
CREATE INDEX "coupon_scopes_coupon_template_id_idx" ON "coupon_scopes"("coupon_template_id");

-- CreateIndex
CREATE INDEX "coupon_scopes_scope_type_platform_product_id_idx" ON "coupon_scopes"("scope_type", "platform_product_id");

-- CreateIndex
CREATE INDEX "coupon_scopes_scope_type_merchant_product_id_idx" ON "coupon_scopes"("scope_type", "merchant_product_id");

-- CreateIndex
CREATE INDEX "coupon_scopes_scope_type_shop_id_idx" ON "coupon_scopes"("scope_type", "shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_coupons_idempotency_key_key" ON "user_coupons"("idempotency_key");

-- CreateIndex
CREATE INDEX "user_coupons_user_id_status_valid_to_idx" ON "user_coupons"("user_id", "status", "valid_to");

-- CreateIndex
CREATE INDEX "user_coupons_coupon_template_id_status_idx" ON "user_coupons"("coupon_template_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_grant_records_idempotency_key_key" ON "coupon_grant_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "coupon_grant_records_user_id_created_at_idx" ON "coupon_grant_records"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "coupon_grant_records_coupon_template_id_created_at_idx" ON "coupon_grant_records"("coupon_template_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_void_records_idempotency_key_key" ON "coupon_void_records"("idempotency_key");

-- CreateIndex
CREATE INDEX "coupon_void_records_user_coupon_id_created_at_idx" ON "coupon_void_records"("user_coupon_id", "created_at");

-- CreateIndex
CREATE INDEX "coupon_void_records_coupon_template_id_created_at_idx" ON "coupon_void_records"("coupon_template_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_usage_idempotency_key_key" ON "coupon_usage"("idempotency_key");

-- CreateIndex
CREATE INDEX "coupon_usage_coupon_template_id_created_at_idx" ON "coupon_usage"("coupon_template_id", "created_at");

-- CreateIndex
CREATE INDEX "coupon_usage_order_id_idx" ON "coupon_usage"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_usage_user_coupon_id_order_id_key" ON "coupon_usage"("user_coupon_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_wallets_user_id_key" ON "user_wallets"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_wallets_wallet_no_key" ON "user_wallets"("wallet_no");

-- CreateIndex
CREATE INDEX "user_wallets_status_updated_at_idx" ON "user_wallets"("status", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_recharge_orders_recharge_no_key" ON "wallet_recharge_orders"("recharge_no");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_recharge_orders_payment_id_key" ON "wallet_recharge_orders"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_recharge_orders_idempotency_key_key" ON "wallet_recharge_orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_recharge_orders_user_id_status_created_at_idx" ON "wallet_recharge_orders"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "wallet_recharge_orders_wallet_id_status_created_at_idx" ON "wallet_recharge_orders"("wallet_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "wallet_recharge_orders_provider_status_idx" ON "wallet_recharge_orders"("provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_payment_holds_hold_no_key" ON "wallet_payment_holds"("hold_no");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_payment_holds_payment_id_key" ON "wallet_payment_holds"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_payment_holds_idempotency_key_key" ON "wallet_payment_holds"("idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_payment_holds_user_id_status_created_at_idx" ON "wallet_payment_holds"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "wallet_payment_holds_wallet_id_status_created_at_idx" ON "wallet_payment_holds"("wallet_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "wallet_payment_holds_order_id_status_idx" ON "wallet_payment_holds"("order_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_transaction_no_key" ON "wallet_transactions"("transaction_no");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_idempotency_key_key" ON "wallet_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "wallet_transactions_user_id_created_at_idx" ON "wallet_transactions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_wallet_id_created_at_idx" ON "wallet_transactions"("wallet_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_order_id_idx" ON "wallet_transactions"("order_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_payment_id_idx" ON "wallet_transactions"("payment_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_recharge_order_id_idx" ON "wallet_transactions"("recharge_order_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_hold_id_idx" ON "wallet_transactions"("hold_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_source_type_source_id_idx" ON "wallet_transactions"("source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_accounts_merchant_id_key" ON "deposit_accounts"("merchant_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposit_transactions_idempotency_key_key" ON "deposit_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "deposit_transactions_merchant_id_created_at_idx" ON "deposit_transactions"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "deposit_transactions_related_type_related_id_idx" ON "deposit_transactions"("related_type", "related_id");

-- CreateIndex
CREATE UNIQUE INDEX "clawbacks_clawback_no_key" ON "clawbacks"("clawback_no");

-- CreateIndex
CREATE UNIQUE INDEX "clawbacks_idempotency_key_key" ON "clawbacks"("idempotency_key");

-- CreateIndex
CREATE INDEX "clawbacks_merchant_id_status_idx" ON "clawbacks"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "clawbacks_source_type_source_id_idx" ON "clawbacks"("source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_channel_configs_channel_key" ON "payment_channel_configs"("channel");

-- CreateIndex
CREATE UNIQUE INDEX "platform_service_fee_configs_idempotency_key_key" ON "platform_service_fee_configs"("idempotency_key");

-- CreateIndex
CREATE INDEX "platform_service_fee_configs_status_effective_from_idx" ON "platform_service_fee_configs"("status", "effective_from");

-- CreateIndex
CREATE INDEX "platform_service_fee_configs_effective_to_idx" ON "platform_service_fee_configs"("effective_to");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_ledger_no_key" ON "ledger_entries"("ledger_no");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_idempotency_key_key" ON "ledger_entries"("idempotency_key");

-- CreateIndex
CREATE INDEX "ledger_entries_merchant_id_created_at_idx" ON "ledger_entries"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "ledger_entries_source_type_source_id_idx" ON "ledger_entries"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "ledger_entries_order_id_idx" ON "ledger_entries"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_subject_type_subject_id_account_type_key" ON "ledger_accounts"("subject_type", "subject_id", "account_type");

-- CreateIndex
CREATE UNIQUE INDEX "risk_freezes_active_unique_key_key" ON "risk_freezes"("active_unique_key");

-- CreateIndex
CREATE INDEX "risk_freezes_merchant_id_status_idx" ON "risk_freezes"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "risk_freezes_target_type_target_id_freeze_type_status_idx" ON "risk_freezes"("target_type", "target_id", "freeze_type", "status");

-- CreateIndex
CREATE INDEX "complaints_merchant_id_status_idx" ON "complaints"("merchant_id", "status");

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
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_merchant_account_id_fkey" FOREIGN KEY ("merchant_account_id") REFERENCES "merchant_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_accounts" ADD CONSTRAINT "merchant_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_accounts" ADD CONSTRAINT "merchant_accounts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_accounts" ADD CONSTRAINT "merchant_accounts_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_applications" ADD CONSTRAINT "merchant_applications_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_applications" ADD CONSTRAINT "merchant_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_applications" ADD CONSTRAINT "merchant_applications_invite_code_id_fkey" FOREIGN KEY ("invite_code_id") REFERENCES "merchant_invite_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_invite_codes" ADD CONSTRAINT "merchant_invite_codes_issuer_merchant_id_fkey" FOREIGN KEY ("issuer_merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_invite_codes" ADD CONSTRAINT "merchant_invite_codes_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_product_groups" ADD CONSTRAINT "shop_product_groups_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_customer_service_bindings" ADD CONSTRAINT "shop_customer_service_bindings_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_shop_products" ADD CONSTRAINT "platform_shop_products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_shop_products" ADD CONSTRAINT "platform_shop_products_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rights_codes" ADD CONSTRAINT "rights_codes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "platform_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rights_codes" ADD CONSTRAINT "rights_codes_merchant_product_listing_id_fkey" FOREIGN KEY ("merchant_product_listing_id") REFERENCES "merchant_product_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rights_codes" ADD CONSTRAINT "rights_codes_owner_merchant_id_fkey" FOREIGN KEY ("owner_merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rights_codes" ADD CONSTRAINT "rights_codes_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rights_codes" ADD CONSTRAINT "rights_codes_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_code_batches" ADD CONSTRAINT "virtual_code_batches_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_codes" ADD CONSTRAINT "virtual_codes_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_codes" ADD CONSTRAINT "virtual_codes_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "virtual_code_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_codes" ADD CONSTRAINT "virtual_codes_reserved_order_id_fkey" FOREIGN KEY ("reserved_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_codes" ADD CONSTRAINT "virtual_codes_issued_order_id_fkey" FOREIGN KEY ("issued_order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_codes" ADD CONSTRAINT "virtual_codes_reserved_order_item_id_fkey" FOREIGN KEY ("reserved_order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "virtual_codes" ADD CONSTRAINT "virtual_codes_issued_order_item_id_fkey" FOREIGN KEY ("issued_order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_product_listings" ADD CONSTRAINT "merchant_product_listings_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_product_listings" ADD CONSTRAINT "merchant_product_listings_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_product_listings" ADD CONSTRAINT "merchant_product_listings_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_product_listings" ADD CONSTRAINT "merchant_product_listings_upstream_listing_id_fkey" FOREIGN KEY ("upstream_listing_id") REFERENCES "merchant_product_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_products" ADD CONSTRAINT "merchant_products_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_products" ADD CONSTRAINT "merchant_products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_products" ADD CONSTRAINT "merchant_products_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_products" ADD CONSTRAINT "merchant_products_own_product_review_id_fkey" FOREIGN KEY ("own_product_review_id") REFERENCES "merchant_product_reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_product_reviews" ADD CONSTRAINT "merchant_product_reviews_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_product_reviews" ADD CONSTRAINT "merchant_product_reviews_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_product_reviews" ADD CONSTRAINT "merchant_product_reviews_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_merchant_product_listing_id_fkey" FOREIGN KEY ("merchant_product_listing_id") REFERENCES "merchant_product_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_merchant_product_id_fkey" FOREIGN KEY ("merchant_product_id") REFERENCES "merchant_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_platform_shop_product_id_fkey" FOREIGN KEY ("platform_shop_product_id") REFERENCES "platform_shop_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_amount_snapshots" ADD CONSTRAINT "order_amount_snapshots_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_collection_payment_config_id_fkey" FOREIGN KEY ("collection_payment_config_id") REFERENCES "collection_payment_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callbacks" ADD CONSTRAINT "payment_callbacks_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_payment_configs" ADD CONSTRAINT "collection_payment_configs_owner_merchant_id_fkey" FOREIGN KEY ("owner_merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_payment_configs" ADD CONSTRAINT "collection_payment_configs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_snapshots" ADD CONSTRAINT "payment_snapshots_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_snapshots" ADD CONSTRAINT "payment_snapshots_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_snapshots" ADD CONSTRAINT "payment_snapshots_collection_config_id_fkey" FOREIGN KEY ("collection_config_id") REFERENCES "collection_payment_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callback_logs" ADD CONSTRAINT "payment_callback_logs_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callback_logs" ADD CONSTRAINT "payment_callback_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callback_logs" ADD CONSTRAINT "payment_callback_logs_payment_snapshot_id_fkey" FOREIGN KEY ("payment_snapshot_id") REFERENCES "payment_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_callback_logs" ADD CONSTRAINT "payment_callback_logs_collection_config_id_fkey" FOREIGN KEY ("collection_config_id") REFERENCES "collection_payment_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_payment_snapshot_id_fkey" FOREIGN KEY ("payment_snapshot_id") REFERENCES "payment_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_callback_log_id_fkey" FOREIGN KEY ("callback_log_id") REFERENCES "payment_callback_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_exceptions" ADD CONSTRAINT "payment_exceptions_collection_config_id_fkey" FOREIGN KEY ("collection_config_id") REFERENCES "collection_payment_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_dispute_materials" ADD CONSTRAINT "payment_dispute_materials_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_dispute_materials" ADD CONSTRAINT "payment_dispute_materials_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_dispute_materials" ADD CONSTRAINT "payment_dispute_materials_payment_exception_id_fkey" FOREIGN KEY ("payment_exception_id") REFERENCES "payment_exceptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_confirmations" ADD CONSTRAINT "payment_confirmations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_confirmations" ADD CONSTRAINT "payment_confirmations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_confirmations" ADD CONSTRAINT "payment_confirmations_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_records" ADD CONSTRAINT "fulfillment_records_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_records" ADD CONSTRAINT "fulfillment_records_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_records" ADD CONSTRAINT "fulfillment_records_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_records" ADD CONSTRAINT "fulfillment_records_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_records" ADD CONSTRAINT "fulfillment_records_virtual_code_id_fkey" FOREIGN KEY ("virtual_code_id") REFERENCES "virtual_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fulfillment_attempts" ADD CONSTRAINT "fulfillment_attempts_fulfillment_id_fkey" FOREIGN KEY ("fulfillment_id") REFERENCES "fulfillment_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_extract_secrets" ADD CONSTRAINT "order_extract_secrets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_extract_secrets" ADD CONSTRAINT "order_extract_secrets_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_extract_secrets" ADD CONSTRAINT "order_extract_secrets_virtual_code_id_fkey" FOREIGN KEY ("virtual_code_id") REFERENCES "virtual_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_extract_secrets" ADD CONSTRAINT "order_extract_secrets_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_extract_logs" ADD CONSTRAINT "order_extract_logs_extract_secret_id_fkey" FOREIGN KEY ("extract_secret_id") REFERENCES "order_extract_secrets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_plaintext_access_logs" ADD CONSTRAINT "code_plaintext_access_logs_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "platform_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_plaintext_access_logs" ADD CONSTRAINT "code_plaintext_access_logs_virtual_code_id_fkey" FOREIGN KEY ("virtual_code_id") REFERENCES "virtual_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_plaintext_access_logs" ADD CONSTRAINT "code_plaintext_access_logs_rights_code_id_fkey" FOREIGN KEY ("rights_code_id") REFERENCES "rights_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_plaintext_access_logs" ADD CONSTRAINT "code_plaintext_access_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_plaintext_access_logs" ADD CONSTRAINT "code_plaintext_access_logs_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_delivery_records" ADD CONSTRAINT "email_delivery_records_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_delivery_records" ADD CONSTRAINT "email_delivery_records_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "after_sales" ADD CONSTRAINT "after_sales_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "after_sales" ADD CONSTRAINT "after_sales_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "after_sales" ADD CONSTRAINT "after_sales_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_after_sale_id_fkey" FOREIGN KEY ("after_sale_id") REFERENCES "after_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_manual_confirmations" ADD CONSTRAINT "refund_manual_confirmations_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_manual_confirmations" ADD CONSTRAINT "refund_manual_confirmations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_manual_confirmations" ADD CONSTRAINT "refund_manual_confirmations_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_callbacks" ADD CONSTRAINT "refund_callbacks_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_sheets" ADD CONSTRAINT "settlement_sheets_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlement_sheets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_items" ADD CONSTRAINT "settlement_items_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_payouts" ADD CONSTRAINT "manual_payouts_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlement_sheets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_templates" ADD CONSTRAINT "coupon_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_scopes" ADD CONSTRAINT "coupon_scopes_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_scopes" ADD CONSTRAINT "coupon_scopes_platform_product_id_fkey" FOREIGN KEY ("platform_product_id") REFERENCES "platform_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_scopes" ADD CONSTRAINT "coupon_scopes_merchant_product_id_fkey" FOREIGN KEY ("merchant_product_id") REFERENCES "merchant_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_scopes" ADD CONSTRAINT "coupon_scopes_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_coupons" ADD CONSTRAINT "user_coupons_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_grant_records" ADD CONSTRAINT "coupon_grant_records_user_coupon_id_fkey" FOREIGN KEY ("user_coupon_id") REFERENCES "user_coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_grant_records" ADD CONSTRAINT "coupon_grant_records_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_void_records" ADD CONSTRAINT "coupon_void_records_user_coupon_id_fkey" FOREIGN KEY ("user_coupon_id") REFERENCES "user_coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_void_records" ADD CONSTRAINT "coupon_void_records_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_usage" ADD CONSTRAINT "coupon_usage_user_coupon_id_fkey" FOREIGN KEY ("user_coupon_id") REFERENCES "user_coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_usage" ADD CONSTRAINT "coupon_usage_coupon_template_id_fkey" FOREIGN KEY ("coupon_template_id") REFERENCES "coupon_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_usage" ADD CONSTRAINT "coupon_usage_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_recharge_orders" ADD CONSTRAINT "wallet_recharge_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_recharge_orders" ADD CONSTRAINT "wallet_recharge_orders_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "user_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_recharge_orders" ADD CONSTRAINT "wallet_recharge_orders_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_payment_holds" ADD CONSTRAINT "wallet_payment_holds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_payment_holds" ADD CONSTRAINT "wallet_payment_holds_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "user_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_payment_holds" ADD CONSTRAINT "wallet_payment_holds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_payment_holds" ADD CONSTRAINT "wallet_payment_holds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "user_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_recharge_order_id_fkey" FOREIGN KEY ("recharge_order_id") REFERENCES "wallet_recharge_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "wallet_payment_holds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_accounts" ADD CONSTRAINT "deposit_accounts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "deposit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

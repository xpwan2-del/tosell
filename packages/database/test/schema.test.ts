import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const schemaPath = resolve(testDir, "../prisma/schema.prisma");
const schema = readFileSync(schemaPath, "utf8");
const initMigrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000001_init/migration.sql"),
  "utf8"
);
const constraintsMigrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000002_constraints/migration.sql"),
  "utf8"
);
const v2MigrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000003_v2_operations/migration.sql"),
  "utf8"
);
const platformSelfOperatedMigrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000004_platform_self_operated/migration.sql"),
  "utf8"
);
const productionChannelMigrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000005_production_channel_foundation/migration.sql"),
  "utf8"
);
const threeTierChannelMigrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000008_three_tier_channel_foundation/migration.sql"),
  "utf8"
);
const productMediaInventoryMigrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000013_product_media_inventory/migration.sql"),
  "utf8"
);
const storefrontDisplayMigrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000014_product_storefront_display/migration.sql"),
  "utf8"
);
const productionAuthRefundCodeAuditMigrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000016_production_auth_refund_code_audit/migration.sql"),
  "utf8"
);
const paymentBindingMigrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000021_payment_binding_and_voucher_removal/migration.sql"),
  "utf8"
);
const backendServicesSource = readFileSync(
  resolve(testDir, "../../../apps/api/src/services.ts"),
  "utf8"
);

function modelBlock(modelName: string) {
  const match = schema.match(new RegExp(`model\\s+${modelName}\\s+\\{([\\s\\S]*?)\\n\\}`));
  if (!match) {
    throw new Error(`Missing model ${modelName}`);
  }
  return match[1];
}

describe("Prisma database contract", () => {
  it("does not define prohibited distribution fields", () => {
    const snake = (...parts: string[]) => parts.join("_");
    const camel = (...parts: string[]) => parts.join("");
    const forbiddenFields = [
      snake("parent", "agent", "id"),
      camel("parent", "Agent", "Id"),
      snake("inviter", "agent", "id"),
      camel("inviter", "Agent", "Id"),
      snake("agent", "level"),
      camel("agent", "Level"),
      snake("team", "id"),
      camel("team", "Id"),
      snake("commission", "rate"),
      camel("commission", "Rate"),
      snake("downline", "order"),
      camel("downline", "Order"),
      snake("team", "performance"),
      camel("team", "Performance")
    ];

    for (const field of forbiddenFields) {
      expect(schema).not.toContain(field);
    }
  });

  it("defines all V1 core models", () => {
    const requiredModels = [
      "User",
      "Agent",
      "AgentApplication",
      "AuthSession",
      "Shop",
      "ShopCustomerServiceBinding",
      "PlatformProduct",
      "AgentProduct",
      "AgentProductReview",
      "Order",
      "OrderItem",
      "OrderAmountSnapshot",
      "Payment",
      "PaymentCallback",
      "FulfillmentRecord",
      "FulfillmentAttempt",
      "Entitlement",
      "AfterSale",
      "Refund",
      "RefundCallback",
      "RefundManualConfirmation",
      "SettlementSheet",
      "SettlementItem",
      "ManualPayout",
      "DepositAccount",
      "DepositTransaction",
      "Clawback",
      "LedgerEntry",
      "RiskFreeze",
      "Complaint",
      "AuditLog",
      "AdminUser",
      "Role",
      "Permission",
      "AdminUserRole",
      "RolePermission",
      "CodePlaintextAccessLog",
      "ShopProductGroup",
      "RightsCode",
      "AgentNotification"
    ];

    for (const model of requiredModels) {
      expect(schema).toMatch(new RegExp(`model\\s+${model}\\s+\\{`));
    }
  });

  it("uses BigInt for authoritative cent amount fields and avoids Float", () => {
    expect(schema).not.toMatch(/\bFloat\b/);

    const amountLines = schema
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => /(?:Cents|amount_cents|price_cents|fee_cents|income_cents)/.test(line));

    expect(amountLines.length).toBeGreaterThan(30);
    for (const line of amountLines) {
      if (line.startsWith("//") || line.includes("serviceFeeBps")) {
        continue;
      }
      expect(line).toMatch(/\bBigInt\b/);
    }
  });

  it("uses order and settlement role uniqueness for controlled two-tier settlement", () => {
    const settlementItem = modelBlock("SettlementItem");
    expect(settlementItem).toMatch(/orderId\s+String\s+@map\("order_id"\)/);
    expect(settlementItem).toMatch(/settlementRole\s+SettlementRole\s+@default\(single_agent\)\s+@map\("settlement_role"\)/);
    expect(settlementItem).toMatch(/@@unique\(\[orderId,\s*settlementRole\]\)/);
  });

  it("requires unique idempotency keys for ledger and key external-event records", () => {
    for (const model of [
      "LedgerEntry",
      "Payment",
      "PaymentCallback",
      "Refund",
      "RefundCallback",
      "FulfillmentAttempt",
      "SettlementSheet",
      "ManualPayout",
      "DepositTransaction",
      "Clawback",
      "AuditLog",
      "AuthSession",
      "RefundManualConfirmation",
      "CodePlaintextAccessLog"
    ]) {
      expect(modelBlock(model)).toMatch(/idempotencyKey\s+String\s+@unique\s+@map\("idempotency_key"\)/);
    }
  });

  it("models active risk freeze uniqueness through a nullable active key", () => {
    const riskFreeze = modelBlock("RiskFreeze");
    expect(riskFreeze).toMatch(/activeUniqueKey\s+String\?\s+@unique\s+@map\("active_unique_key"\)/);
    expect(riskFreeze).toMatch(/@@index\(\[targetType,\s*targetId,\s*freezeType,\s*status\]\)/);
  });

  it("adds PostgreSQL constraints for cross-field financial invariants", () => {
    expect(initMigrationSql).toContain('CREATE TABLE "orders"');
    expect(initMigrationSql).toContain('CREATE TABLE "ledger_entries"');
    expect(constraintsMigrationSql).toContain("agent_products_type_reference_check");
    expect(constraintsMigrationSql).toContain("agent_products_business_rules_check");
    expect(constraintsMigrationSql).toContain("order_amount_snapshots_totals_check");
    expect(constraintsMigrationSql).toContain("order_items_totals_check");
    expect(constraintsMigrationSql).toContain("risk_freezes_active_target_unique");
    expect(constraintsMigrationSql).toContain("manual_payouts_paid_settlement_unique");
    expect(constraintsMigrationSql).toContain("ledger_entries_no_update");
    expect(constraintsMigrationSql).toContain("ledger_entries_no_delete");
  });

  it("uses a generic product snapshot for platform and agent-owned products", () => {
    const snapshot = modelBlock("OrderAmountSnapshot");
    expect(snapshot).toMatch(/productSnapshotJson\s+Json\s+@map\("product_snapshot_json"\)/);
    expect(snapshot).not.toContain("platformProductSnapshotJson");
  });

  it("adds non-negative money checks for V1 financial tables", () => {
    for (const constraint of [
      "platform_products_amounts_check",
      "order_items_amounts_check",
      "order_amount_snapshots_amounts_check",
      "after_sales_amounts_check",
      "settlement_items_amounts_check",
      "deposit_accounts_amounts_check",
      "ledger_entries_amounts_check"
    ]) {
      expect(constraintsMigrationSql).toContain(constraint);
    }
  });

  it("adds ownership and refund-total triggers that Prisma cannot express", () => {
    for (const trigger of [
      "agent_products_owner_check",
      "agent_products_business_rules_check",
      "order_amount_snapshots_totals_check",
      "order_items_owner_check",
      "after_sales_owner_check",
      "refunds_link_check",
      "refunds_total_check",
      "settlement_items_owner_check",
      "manual_payouts_owner_check",
      "deposit_transactions_owner_check"
    ]) {
      expect(constraintsMigrationSql).toContain(trigger);
    }
    expect(constraintsMigrationSql).toContain("refund total cannot exceed order paid amount");
  });

  it("adds V2 non-payment operations tables and constraints", () => {
    expect(schema).toContain("enum RightsCodeStatus");
    expect(modelBlock("Shop")).toContain("themeColor");
    expect(modelBlock("PlatformProduct")).toContain("tagsJson");
    expect(modelBlock("RightsCode")).toMatch(/@@unique\(\[productId,\s*codeCiphertext\]\)/);
    expect(modelBlock("RightsCode")).toMatch(/issueKey\s+String\?\s+@unique\s+@map\("issue_key"\)/);
    expect(v2MigrationSql).toContain('CREATE TABLE "rights_codes"');
    expect(v2MigrationSql).toContain('CREATE TABLE "shop_product_groups"');
    expect(v2MigrationSql).toContain('CREATE TABLE "agent_notifications"');
    expect(v2MigrationSql).toContain("shops_theme_color_check");
    expect(v2MigrationSql).toContain("rights_codes_issue_key_key");
  });

  it("models platform self-operated shops and sales channels", () => {
    const shop = modelBlock("Shop");
    const order = modelBlock("Order");

    expect(schema).toContain("enum ShopOwnerType");
    expect(schema).toContain("enum SalesChannelType");
    expect(schema).toContain("platform_self_operated");
    expect(schema).toContain("single_agent");
    expect(schema).toContain("two_tier");
    expect(schema).toContain("three_tier");
    expect(schema).toContain("first_tier");
    expect(schema).toContain("second_tier");
    expect(schema).toContain("third_tier");
    expect(shop).toMatch(/ownerType\s+ShopOwnerType\s+@default\(agent\)\s+@map\("owner_type"\)/);
    expect(shop).toMatch(/agentId\s+String\?\s+@unique\s+@map\("agent_id"\)/);
    expect(shop).toMatch(/customerServiceQrUrl\s+String\?\s+@map\("customer_service_qr_url"\)/);
    expect(order).toMatch(/salesChannelType\s+SalesChannelType\s+@default\(single_agent\)\s+@map\("sales_channel_type"\)/);
    expect(order).toMatch(/platformShopId\s+String\?\s+@map\("platform_shop_id"\)/);
    expect(platformSelfOperatedMigrationSql).toContain("CREATE TYPE \"ShopOwnerType\"");
    expect(platformSelfOperatedMigrationSql).toContain("sales_channel_type");
    expect(platformSelfOperatedMigrationSql).toContain('DROP INDEX IF EXISTS "settlement_items_order_id_key"');
    expect(platformSelfOperatedMigrationSql).toContain("settlement_items_order_id_settlement_role_key");
  });

  it("adds production foundation for H5 identities and controlled three-tier supply", () => {
    expect(modelBlock("User")).toContain("identities");
    expect(modelBlock("UserIdentity")).toMatch(/@@unique\(\[identityType,\s*provider,\s*externalId\]\)/);
    expect(modelBlock("PlatformShopProduct")).toMatch(/fulfillmentCostCents\s+BigInt\s+@default\(0\)\s+@map\("fulfillment_cost_cents"\)/);
    expect(modelBlock("ChannelAuthorization")).toMatch(/firstTierAgentId\s+String\s+@unique\s+@map\("first_tier_agent_id"\)/);
    expect(modelBlock("ChannelRelation")).toMatch(/activeUniqueKey\s+String\?\s+@unique\s+@map\("active_unique_key"\)/);
    expect(modelBlock("ChannelProductOffer")).toMatch(/resellSupplyPriceCents\s+BigInt\s+@map\("resell_supply_price_cents"\)/);
    expect(modelBlock("Order")).toMatch(/firstTierAgentId\s+String\?\s+@map\("first_tier_agent_id"\)/);
    expect(modelBlock("Order")).toMatch(/secondTierAgentId\s+String\?\s+@map\("second_tier_agent_id"\)/);
    expect(modelBlock("Order")).toMatch(/thirdTierAgentId\s+String\?\s+@map\("third_tier_agent_id"\)/);
    expect(modelBlock("ChannelRelation")).toMatch(/thirdTierAgentId\s+String\?\s+@map\("third_tier_agent_id"\)/);
    expect(modelBlock("OrderAmountSnapshot")).toContain("platformSupplyPriceCents");
    expect(modelBlock("OrderAmountSnapshot")).toContain("firstTierIncomeCents");
    expect(modelBlock("OrderAmountSnapshot")).toContain("secondTierSupplyPriceCents");
    expect(modelBlock("OrderAmountSnapshot")).toContain("thirdTierIncomeCents");
    expect(modelBlock("AfterSale")).toContain("thirdTierBearCents");
    expect(modelBlock("Payment")).toMatch(/channel\s+PaymentChannel/);
    expect(modelBlock("PaymentChannelConfig")).toMatch(/channel\s+PaymentChannel\s+@unique/);
    expect(productionChannelMigrationSql).toContain('CREATE TABLE "user_identities"');
    expect(productionChannelMigrationSql).toContain('CREATE TABLE "channel_relations"');
    expect(productionChannelMigrationSql).toContain('CREATE TABLE "channel_product_offers"');
    expect(productionChannelMigrationSql).toContain("WHEN 'wechat' THEN 'wechat_miniprogram'");
    expect(productionChannelMigrationSql).toContain("shops_owner_agent_scope_check");
    expect(productionChannelMigrationSql).toContain("channel_relations_active_unique_key_required_check");
    expect(productionChannelMigrationSql).toContain("channel_relations_active_unique_key_set");
    expect(productionChannelMigrationSql).toContain("channel_product_offers_supply_price_check");
    expect(productionChannelMigrationSql).toContain("resell supply price cannot be below platform supply price");
    expect(threeTierChannelMigrationSql).toContain("third_tier_agent_id");
    expect(threeTierChannelMigrationSql).toContain("third_tier_pending_income");
    expect(threeTierChannelMigrationSql).toContain("third_tier_bear_cents");
  });

  it("persists product media, detail sections, and display inventory in the product table", () => {
    const product = modelBlock("PlatformProduct");

    expect(product).toMatch(/imageUrl\s+String\?\s+@map\("image_url"\)/);
    expect(product).toMatch(/specsJson\s+Json\?\s+@map\("specs_json"\)/);
    expect(product).toMatch(/detailSectionsJson\s+Json\?\s+@map\("detail_sections_json"\)/);
    expect(product).toMatch(/stockCount\s+Int\s+@default\(0\)\s+@map\("stock_count"\)/);
    expect(product).toMatch(/soldCount\s+Int\s+@default\(0\)\s+@map\("sold_count"\)/);
    expect(productMediaInventoryMigrationSql).toContain('"image_url" TEXT');
    expect(productMediaInventoryMigrationSql).toContain('"detail_sections_json" JSONB');
    expect(productMediaInventoryMigrationSql).toContain("platform_products_stock_count_check");
  });

  it("persists storefront product badge and recommendation order", () => {
    const product = modelBlock("PlatformProduct");

    expect(product).toMatch(/displayBadge\s+String\?\s+@map\("display_badge"\)/);
    expect(product).toMatch(/isRecommended\s+Boolean\s+@default\(false\)\s+@map\("is_recommended"\)/);
    expect(product).toMatch(/displaySort\s+Int\s+@default\(0\)\s+@map\("display_sort"\)/);
    expect(storefrontDisplayMigrationSql).toContain('"display_badge" TEXT');
    expect(storefrontDisplayMigrationSql).toContain('"is_recommended" BOOLEAN NOT NULL DEFAULT false');
    expect(storefrontDisplayMigrationSql).toContain("platform_products_recommended_sort_idx");
  });

  it("adds production auth sessions, manual refund confirmation, and plaintext code access audit", () => {
    expect(schema).toContain("enum AuthSubjectType");
    expect(schema).toContain("enum AuthSessionStatus");
    expect(schema).toContain("enum CodePlaintextAccessType");
    expect(schema).toMatch(/enum ActorType\s+\{[\s\S]*merchant[\s\S]*\}/);

    const authSession = modelBlock("AuthSession");
    expect(authSession).toMatch(/tokenHash\s+String\s+@unique\s+@map\("token_hash"\)/);
    expect(authSession).toMatch(/merchantAccountId\s+String\?\s+@map\("merchant_account_id"\)/);
    expect(authSession).toMatch(/@@index\(\[merchantAccountId,\s*status\]\)/);

    const refundManualConfirmation = modelBlock("RefundManualConfirmation");
    expect(refundManualConfirmation).toMatch(/voucherUrl\s+String\?\s+@map\("voucher_url"\)/);
    expect(refundManualConfirmation).toMatch(/confirmedById\s+String\?\s+@map\("confirmed_by"\)/);
    expect(refundManualConfirmation).toMatch(/idempotencyKey\s+String\s+@unique\s+@map\("idempotency_key"\)/);

    const codeAccess = modelBlock("CodePlaintextAccessLog");
    expect(codeAccess).toMatch(/accessType\s+CodePlaintextAccessType\s+@map\("access_type"\)/);
    expect(codeAccess).toMatch(/permissionCode\s+String\s+@map\("permission_code"\)/);
    expect(codeAccess).toMatch(/idempotencyKey\s+String\s+@unique\s+@map\("idempotency_key"\)/);

    expect(productionAuthRefundCodeAuditMigrationSql).toContain('CREATE TABLE IF NOT EXISTS "auth_sessions"');
    expect(productionAuthRefundCodeAuditMigrationSql).toContain("auth_sessions_subject_shape_check");
    expect(productionAuthRefundCodeAuditMigrationSql).toContain('CREATE TABLE IF NOT EXISTS "refund_manual_confirmations"');
    expect(productionAuthRefundCodeAuditMigrationSql).toContain("refund_manual_confirmations_link_check");
    expect(productionAuthRefundCodeAuditMigrationSql).toContain('CREATE TABLE IF NOT EXISTS "code_plaintext_access_logs"');
    expect(productionAuthRefundCodeAuditMigrationSql).toContain("code_plaintext_access_logs_no_update");
    expect(productionAuthRefundCodeAuditMigrationSql).toContain("code_plaintext_access_logs_no_delete");
  });

  it("models payment binding, callback verification, and dispute-only materials", () => {
    expect(schema).toContain("enum PaymentProvider");
    expect(schema).toContain("alipay_merchant");
    expect(schema).toContain("wechat_merchant");
    expect(schema).toContain("epay");
    expect(schema).toContain("alipay_personal");

    const config = modelBlock("CollectionPaymentConfig");
    expect(config).toMatch(/ownerType\s+CollectionConfigOwnerType\s+@map\("owner_type"\)/);
    expect(config).toMatch(/provider\s+PaymentProvider/);
    expect(config).toMatch(/confirmMode\s+PaymentConfirmMode\s+@map\("confirm_mode"\)/);
    expect(config).toMatch(/credentialRef\s+String\?\s+@map\("credential_ref"\)/);
    expect(config).toMatch(/credentialCiphertext\s+String\?\s+@map\("credential_ciphertext"\)/);
    expect(config).toMatch(/secretVersion\s+Int\s+@default\(1\)\s+@map\("secret_version"\)/);
    expect(config).toMatch(/idempotencyKey\s+String\s+@unique\s+@map\("idempotency_key"\)/);

    const snapshot = modelBlock("PaymentSnapshot");
    expect(snapshot).toMatch(/payableAmountCents\s+BigInt\s+@map\("payable_amount_cents"\)/);
    expect(snapshot).toMatch(/providerTradeNo\s+String\?\s+@map\("provider_trade_no"\)/);
    expect(snapshot).toMatch(/confirmSource\s+PaymentConfirmSource\s+@default\(unconfirmed\)\s+@map\("confirm_source"\)/);
    expect(snapshot).toMatch(/configSnapshotJson\s+Json\s+@map\("config_snapshot_json"\)/);

    const callback = modelBlock("PaymentCallbackLog");
    expect(callback).toMatch(/signatureValid\s+Boolean\?\s+@map\("signature_valid"\)/);
    expect(callback).toMatch(/amountMatched\s+Boolean\?\s+@map\("amount_matched"\)/);
    expect(callback).toMatch(/merchantMatched\s+Boolean\?\s+@map\("merchant_matched"\)/);
    expect(callback).toMatch(/rawPayloadCiphertext\s+String\?\s+@map\("raw_payload_ciphertext"\)/);
    expect(callback).toMatch(/idempotencyKey\s+String\s+@unique\s+@map\("idempotency_key"\)/);

    const exception = modelBlock("PaymentException");
    expect(exception).toMatch(/exceptionType\s+PaymentExceptionType\s+@map\("exception_type"\)/);
    expect(exception).toMatch(/actionTaken\s+String\?\s+@map\("action_taken"\)/);

    const material = modelBlock("PaymentDisputeMaterial");
    expect(material).toMatch(/materialType\s+PaymentDisputeMaterialType\s+@map\("material_type"\)/);
    expect(material).toMatch(/status\s+PaymentDisputeMaterialStatus\s+@default\(submitted\)/);
    expect(material).toMatch(/reviewedById\s+String\?\s+@map\("reviewed_by_id"\)/);
    expect(material).toMatch(/reviewedAt\s+DateTime\?\s+@map\("reviewed_at"\)/);
    expect(schema).toContain("payment_screenshot");

    expect(paymentBindingMigrationSql).toContain('CREATE TABLE IF NOT EXISTS "collection_payment_configs"');
    expect(paymentBindingMigrationSql).toContain('CREATE TABLE IF NOT EXISTS "payment_snapshots"');
    expect(paymentBindingMigrationSql).toContain('CREATE TABLE IF NOT EXISTS "payment_callback_logs"');
    expect(paymentBindingMigrationSql).toContain('CREATE TABLE IF NOT EXISTS "payment_exceptions"');
    expect(paymentBindingMigrationSql).toContain('CREATE TABLE IF NOT EXISTS "payment_dispute_materials"');
    expect(paymentBindingMigrationSql).toContain("collection_payment_configs_confirm_mode_check");
    expect(paymentBindingMigrationSql).toContain("payment_snapshots_confirm_mode_check");
    expect(paymentBindingMigrationSql).toContain("collection_payment_configs_shop_default_active_unique");
    expect(paymentBindingMigrationSql).toContain('CREATE TYPE "PaymentDisputeMaterialStatus"');
    expect(paymentBindingMigrationSql).toContain("payment_dispute_materials_status_created_at_idx");
  });

  it("routes payment binding runtime persistence through the production Prisma tables", () => {
    expect(backendServicesSource).toContain("INSERT INTO collection_payment_configs");
    expect(backendServicesSource).toContain("FROM collection_payment_configs");
    expect(backendServicesSource).toContain("INSERT INTO payments");
    expect(backendServicesSource).toContain("INSERT INTO payment_snapshots");
    expect(backendServicesSource).toContain("FROM payment_snapshots");
    expect(backendServicesSource).toContain("INSERT INTO payment_callback_logs");
    expect(backendServicesSource).toContain("FROM payment_callback_logs");
    expect(backendServicesSource).toContain("INSERT INTO payment_exceptions");
    expect(backendServicesSource).toContain("FROM payment_exceptions");
    expect(backendServicesSource).toContain("INSERT INTO payment_dispute_materials");
    expect(backendServicesSource).toContain("FROM payment_dispute_materials");
    expect(backendServicesSource).toContain("mapPaymentProviderToDb");
    expect(backendServicesSource).toContain("mapPaymentProviderFromDb");
  });
});

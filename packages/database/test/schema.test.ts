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
      "AuditLog"
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
    expect(schema).toContain("first_tier");
    expect(schema).toContain("second_tier");
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

  it("adds production foundation for H5 identities and controlled two-tier supply", () => {
    expect(modelBlock("User")).toContain("identities");
    expect(modelBlock("UserIdentity")).toMatch(/@@unique\(\[identityType,\s*provider,\s*externalId\]\)/);
    expect(modelBlock("PlatformShopProduct")).toMatch(/fulfillmentCostCents\s+BigInt\s+@default\(0\)\s+@map\("fulfillment_cost_cents"\)/);
    expect(modelBlock("ChannelAuthorization")).toMatch(/firstTierAgentId\s+String\s+@unique\s+@map\("first_tier_agent_id"\)/);
    expect(modelBlock("ChannelRelation")).toMatch(/activeUniqueKey\s+String\?\s+@unique\s+@map\("active_unique_key"\)/);
    expect(modelBlock("ChannelProductOffer")).toMatch(/resellSupplyPriceCents\s+BigInt\s+@map\("resell_supply_price_cents"\)/);
    expect(modelBlock("Order")).toMatch(/firstTierAgentId\s+String\?\s+@map\("first_tier_agent_id"\)/);
    expect(modelBlock("Order")).toMatch(/secondTierAgentId\s+String\?\s+@map\("second_tier_agent_id"\)/);
    expect(modelBlock("OrderAmountSnapshot")).toContain("platformSupplyPriceCents");
    expect(modelBlock("OrderAmountSnapshot")).toContain("firstTierIncomeCents");
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
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const schemaPath = resolve(testDir, "../prisma/schema.prisma");
const schema = readFileSync(schemaPath, "utf8");
const migrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000001_constraints/migration.sql"),
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
      "RolePermission"
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

  it("keeps settlement_items.order_id unique for V1 duplicate-settlement protection", () => {
    const settlementItem = modelBlock("SettlementItem");
    expect(settlementItem).toMatch(/orderId\s+String\s+@unique\s+@map\("order_id"\)/);
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
    expect(migrationSql).toContain("agent_products_type_reference_check");
    expect(migrationSql).toContain("risk_freezes_active_target_unique");
    expect(migrationSql).toContain("manual_payouts_paid_settlement_unique");
    expect(migrationSql).toContain("ledger_entries_no_update");
    expect(migrationSql).toContain("ledger_entries_no_delete");
  });

  it("uses a generic product snapshot for platform and agent-owned products", () => {
    const snapshot = modelBlock("OrderAmountSnapshot");
    expect(snapshot).toMatch(/productSnapshotJson\s+Json\s+@map\("product_snapshot_json"\)/);
    expect(snapshot).not.toContain("platformProductSnapshotJson");
  });
});

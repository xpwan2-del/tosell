import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const schema = readFileSync(resolve(testDir, "../prisma/schema.prisma"), "utf8");
const cleanMigrationSql = readFileSync(
  resolve(testDir, "../prisma/migrations/000001_clean_merchants_only/migration.sql"),
  "utf8"
);
const appSource = readFileSync(resolve(testDir, "../../../apps/api/src/app.ts"), "utf8");
const servicesSource = readFileSync(resolve(testDir, "../../../apps/api/src/services.ts"), "utf8");
const productionSmokeSource = readFileSync(resolve(testDir, "../../../apps/api/src/production-p0-smoke.ts"), "utf8");
const legacyActor = ["ag", "ent"].join("");
const legacyApiPrefix = ["/api", legacyActor].join("/");
const legacyAuthPrefix = ["/api/auth", legacyActor].join("/");
const legacyProductTable = [legacyActor, "products"].join("_");
const legacyConfigTable = ["shop", "collection", "channels"].join("_");
const legacyConfigColumn = ["collection", "channel", "id"].join("_");
const legacyOwnerColumn = ["owner", legacyActor, "id"].join("_");
const legacyProductColumn = [legacyActor, "product", "id"].join("_");
const legacyTables = [
  `${legacyActor}s`,
  [legacyActor, "products"].join("_"),
  [legacyActor, "applications"].join("_"),
  [legacyActor, "notifications"].join("_"),
  [legacyActor, "product", "reviews"].join("_"),
  ["shop", "collection", "channels"].join("_")
] as const;
const legacyColumns = [
  [legacyActor, "id"].join("_"),
  ["first", "tier", legacyActor, "id"].join("_"),
  ["second", "tier", legacyActor, "id"].join("_"),
  ["third", "tier", legacyActor, "id"].join("_"),
  ["collection", "channel", "id"].join("_")
] as const;
const legacyCollectionChannelField = ["collection", "Channel", "Id"].join("");
const legacyModelPrefix = ["A", "gent"].join("");
const legacyCollectionChannelModel = ["Shop", "Collection", "Channel"].join("");

function modelBlock(modelName: string) {
  const match = schema.match(new RegExp(`model\\s+${modelName}\\s+\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`Missing model ${modelName}`);
  return match[1];
}

describe("canonical merchants-only database contract", () => {
  it("uses merchants and merchant-scoped product models instead of legacy agents", () => {
    expect(schema).toMatch(/model\s+Merchant\s+\{/);
    expect(schema).toMatch(/model\s+MerchantAccount\s+\{/);
    expect(schema).toMatch(/model\s+MerchantProductListing\s+\{/);
    expect(schema).toMatch(/model\s+MerchantProduct\s+\{/);
    expect(schema).toMatch(/model\s+MerchantProductReview\s+\{/);
    expect(schema).not.toMatch(new RegExp(`model\\s+${legacyModelPrefix}\\s+\\{`));
    expect(schema).not.toMatch(new RegExp(`model\\s+${legacyModelPrefix}(Product|Application|Notification|ProductReview)?\\s+\\{`));
    expect(schema).not.toMatch(new RegExp(`model\\s+${legacyCollectionChannelModel}\\s+\\{`));
    for (const table of legacyTables) {
      expect(schema).not.toContain(`@@map("${table}")`);
      expect(cleanMigrationSql).not.toContain(`CREATE TABLE "${table}"`);
    }
    for (const column of legacyColumns) {
      expect(schema).not.toContain(`@map("${column}")`);
      expect(cleanMigrationSql).not.toContain(`"${column}"`);
    }
    expect(cleanMigrationSql).toContain('CREATE TABLE "merchants"');
    expect(cleanMigrationSql).toContain('CREATE TABLE "merchant_accounts"');
    expect(cleanMigrationSql).toContain('CREATE TABLE "merchant_product_listings"');
    expect(cleanMigrationSql).toContain('CREATE TABLE "merchant_products"');
    expect(cleanMigrationSql).toContain('CREATE TABLE "merchant_product_reviews"');
    expect(cleanMigrationSql).not.toContain(`CREATE TABLE "${legacyProductTable}"`);
  });

  it("uses collection_payment_configs as the payment configuration authority", () => {
    expect(modelBlock("CollectionPaymentConfig")).toContain('@@map("collection_payment_configs")');
    expect(modelBlock("Payment")).toContain('collectionPaymentConfigId String?');
    expect(modelBlock("Payment")).toContain('merchantId');
    expect(modelBlock("Payment")).not.toContain(legacyCollectionChannelField);
    expect(modelBlock("Order")).not.toContain(legacyCollectionChannelField);
    expect(modelBlock("PaymentConfirmation")).not.toContain(legacyCollectionChannelField);
    expect(cleanMigrationSql).toContain('CREATE TABLE "collection_payment_configs"');
    expect(cleanMigrationSql).toContain('CREATE TABLE "payment_snapshots"');
    expect(cleanMigrationSql).not.toContain(legacyConfigTable);
    expect(cleanMigrationSql).not.toContain(legacyConfigColumn);
  });

  it("keeps public merchant APIs on canonical merchant paths and production smoke off legacy paths", () => {
    expect(appSource).toContain('"/api/merchant/shop"');
    expect(appSource).toContain('"/api/auth/merchant/login"');
    expect(appSource).not.toContain(legacyApiPrefix);
    expect(productionSmokeSource).not.toContain(`${legacyApiPrefix}/`);
    expect(productionSmokeSource).not.toContain(`${legacyAuthPrefix}/`);
    expect(productionSmokeSource).toContain("/api/merchant/shop");
  });

  it("persists payment and code ownership through merchant canonical columns", () => {
    expect(servicesSource).toContain("collection_payment_config_id");
    expect(servicesSource).toContain("owner_merchant_id");
    expect(servicesSource).toContain("merchant_product_listing_id");
    expect(servicesSource).toContain("merchant_product_id");
    expect(modelBlock("RightsCode")).toContain("merchantProductId");
    expect(servicesSource).not.toContain(legacyConfigTable);
    expect(servicesSource).not.toContain(legacyConfigColumn);
    expect(servicesSource).not.toContain(legacyOwnerColumn);
    expect(servicesSource).not.toContain(legacyProductColumn);
  });

  it("models wallet fees, service fees, fulfillment, refund lockout, and audit persistence", () => {
    expect(modelBlock("MerchantProductListing")).toContain('sourceType');
    expect(modelBlock("MerchantProductListing")).toContain('upstreamListingId');
    expect(modelBlock("Order")).toContain('purchasePasswordHash');
    expect(modelBlock("OrderAmountSnapshot")).toContain('paymentFeeBps');
    expect(modelBlock("OrderAmountSnapshot")).toContain('balancePaidCents');
    expect(modelBlock("OrderAmountSnapshot")).toContain('externalPaidCents');
    expect(modelBlock("PlatformServiceFeeConfig")).toContain('feeBps');
    expect(modelBlock("UserWallet")).toContain('availableBalanceCents');
    expect(modelBlock("WalletTransaction")).toContain('@@map("wallet_transactions")');
    expect(modelBlock("RightsCode")).toContain('ownerMerchantId');
    expect(modelBlock("OrderExtractSecret")).toContain('refund');
    expect(modelBlock("AuditLog")).toContain('@@map("audit_logs")');
  });
});

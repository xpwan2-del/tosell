import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

const permissions = [
  "agent.review",
  "product.manage",
  "after_sale.arbitrate",
  "settlement.generate",
  "settlement.confirm",
  "payout.confirm",
  "deposit.manage",
  "payment_config.manage",
  "risk.freeze",
  "audit.read",
  "rbac.manage",
  "merchant.manage",
  "shop.manage",
  "collection_channel.review",
  "order.read",
  "payment.confirm",
  "fulfillment.manage",
  "after_sale.manage",
  "coupon.manage",
  "clearing.manage",
  "ledger.read",
  "risk.manage",
  "rights_code.secret.read"
];

const paymentChannels = [
  "wechat_miniprogram",
  "wechat_h5_jsapi",
  "wechat_h5",
  "alipay_wap",
  "mock"
] as const;

const DB_RETRY_ATTEMPTS = Number(process.env.E2E_SETUP_DB_RETRY_ATTEMPTS ?? 5);
const DB_RETRY_BASE_DELAY_MS = Number(process.env.E2E_SETUP_DB_RETRY_BASE_DELAY_MS ?? 750);

async function main() {
  assertEnvironment();

  await withFreshPrismaRetry("db:e2e-setup", setup);
}

async function setup(prisma: PrismaClient) {
  const username = process.env.ADMIN_USERNAME!;
  const passwordHash = adminPasswordHash();
  const now = new Date();

  const admin = await prisma.adminUser.upsert({
    where: { username },
    update: {
      passwordHash,
      displayName: process.env.ADMIN_DISPLAY_NAME ?? "Production E2E Admin",
      status: "active"
    },
    create: {
      username,
      passwordHash,
      displayName: process.env.ADMIN_DISPLAY_NAME ?? "Production E2E Admin",
      status: "active"
    }
  });

  const role = await prisma.role.upsert({
    where: { code: "admin" },
    update: { name: "Administrator" },
    create: { code: "admin", name: "Administrator" }
  });

  await prisma.permission.createMany({
    data: permissions.map((code) => ({ code, name: code })),
    skipDuplicates: true
  });

  const permissionRows = await prisma.permission.findMany({
    where: { code: { in: permissions } },
    select: { id: true }
  });

  await prisma.adminUserRole.createMany({
    data: [{ adminUserId: admin.id, roleId: role.id }],
    skipDuplicates: true
  });

  await prisma.rolePermission.createMany({
    data: permissionRows.map((permission) => ({
      roleId: role.id,
      permissionId: permission.id
    })),
    skipDuplicates: true
  });

  for (const channel of paymentChannels) {
    await prisma.paymentChannelConfig.upsert({
      where: { channel },
      update: {
        enabled: false,
        feeBps: 0,
        fixedFeeCents: 0n,
        statusNote: channel === "mock" ? "disabled_in_production_e2e" : "pending_merchant_configuration",
        updatedAt: now
      },
      create: {
        channel,
        enabled: false,
        feeBps: 0,
        fixedFeeCents: 0n,
        configJson: Prisma.JsonNull,
        statusNote: channel === "mock" ? "disabled_in_production_e2e" : "pending_merchant_configuration",
        updatedAt: now
      }
    });
  }

  await prisma.auditLog.upsert({
    where: { idempotencyKey: "e2e-setup:admin-rbac-payment-config" },
    update: {
      afterJson: {
        adminUsernameConfigured: true,
        permissions: permissionRows.length,
        paymentChannels: paymentChannels.length,
        businessFixturesCreated: false
      }
    },
    create: {
      actorType: "system",
      actorId: "e2e-setup",
      action: "database.e2e_setup",
      targetType: "system_config",
      targetId: "admin-rbac-payment-config",
      afterJson: {
        adminUsernameConfigured: true,
        permissions: permissionRows.length,
        paymentChannels: paymentChannels.length,
        businessFixturesCreated: false
      },
      idempotencyKey: "e2e-setup:admin-rbac-payment-config",
      requestId: "e2e-setup"
    }
  });
}

async function withFreshPrismaRetry<T>(label: string, action: (client: PrismaClient) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt += 1) {
    const client = new PrismaClient();
    try {
      const result = await action(client);
      if (attempt > 1) {
        console.error(`${label} recovered after transient database error on attempt ${attempt}`);
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!isTransientDatabaseError(error) || attempt >= DB_RETRY_ATTEMPTS) throw error;
      console.error(`${label} transient database error on attempt ${attempt}; retrying`);
      await sleep(DB_RETRY_BASE_DELAY_MS * attempt);
    } finally {
      await client.$disconnect().catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

function isTransientDatabaseError(error: unknown) {
  const candidate = error as { code?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code : undefined;
  const message = typeof candidate?.message === "string" ? candidate.message : "";
  return Boolean(code && ["P1001", "P1002", "P1017", "P2024", "P2028"].includes(code))
    || [
      "Transaction API error",
      "Transaction not found",
      "Can't reach database server",
      "Timed out fetching a new connection",
      "Timed out trying to acquire",
      "Connection terminated",
      "connection closed",
      "closed the connection",
      "server closed the connection",
      "ECONNRESET",
      "ETIMEDOUT",
      "pooler",
      "pool timeout"
    ].some((fragment) => message.includes(fragment));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertEnvironment() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for controlled E2E setup");
  }
  if (!process.env.ADMIN_USERNAME) {
    throw new Error("ADMIN_USERNAME is required for controlled E2E setup");
  }
  if (!process.env.ADMIN_PASSWORD_HASH && !process.env.ADMIN_PASSWORD) {
    throw new Error("ADMIN_PASSWORD_HASH or ADMIN_PASSWORD is required for controlled E2E setup");
  }
  if (process.env.ADMIN_PASSWORD_HASH && !process.env.ADMIN_PASSWORD_HASH.startsWith("sha256:")) {
    throw new Error("ADMIN_PASSWORD_HASH must use sha256:<hex>");
  }
}

function adminPasswordHash() {
  if (process.env.ADMIN_PASSWORD_HASH) return process.env.ADMIN_PASSWORD_HASH;
  return `sha256:${createHash("sha256").update(process.env.ADMIN_PASSWORD!).digest("hex")}`;
}

main()
  .then(() => undefined)
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : "E2E setup failed");
    process.exit(1);
  });

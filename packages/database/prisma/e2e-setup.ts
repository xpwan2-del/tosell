import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

async function main() {
  assertEnvironment();

  const username = process.env.ADMIN_USERNAME!;
  const passwordHash = adminPasswordHash();
  const now = new Date();

  const [admin, role] = await Promise.all([
    prisma.adminUser.upsert({
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
    }),
    prisma.role.upsert({
      where: { code: "admin" },
      update: { name: "Administrator" },
      create: { code: "admin", name: "Administrator" }
    })
  ]);

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

  await Promise.all(paymentChannels.map((channel) => (
    prisma.paymentChannelConfig.upsert({
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
    })
  )));

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
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : "E2E setup failed");
    await prisma.$disconnect();
    process.exit(1);
  });

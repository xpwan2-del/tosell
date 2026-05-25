import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.upsert({
    where: { openid: "dev_openid_user_001" },
    update: {},
    create: {
      openid: "dev_openid_user_001",
      unionid: "dev_unionid_user_001",
      phone: "13800000000"
    }
  });

  const agent = await prisma.agent.upsert({
    where: { agentNo: "AGT000001" },
    update: {
      status: "active",
      depositStatus: "paid"
    },
    create: {
      userId: user.id,
      agentNo: "AGT000001",
      name: "测试代理",
      contactPhone: "13800000000",
      status: "active",
      depositStatus: "paid",
      approvedAt: new Date()
    }
  });

  const shop = await prisma.shop.upsert({
    where: { shopNo: "SHOP000001" },
    update: {
      status: "open"
    },
    create: {
      agentId: agent.id,
      shopNo: "SHOP000001",
      name: "测试代理小店",
      announcement: "测试商品仅用于开发环境",
      sharePath: "/pages/shop/index?shopNo=SHOP000001",
      status: "open"
    }
  });

  await prisma.shopCustomerServiceBinding.create({
    data: {
      shopId: shop.id,
      wechatId: "dev_service_wechat",
      status: "active",
      reviewStatus: "approved"
    }
  });

  const product = await prisma.platformProduct.upsert({
    where: { productNo: "P000001" },
    update: {
      status: "active"
    },
    create: {
      productNo: "P000001",
      name: "测试虚拟权益",
      detail: "开发环境测试平台商品",
      rightsDesc: "测试权益说明",
      supplyPriceCents: 10_000n,
      minSalePriceCents: 12_000n,
      suggestedSalePriceCents: 15_000n,
      fulfillmentType: "manual",
      fulfillmentRuleJson: { mode: "manual", evidenceRequired: true },
      afterSaleRuleJson: { refundBeforeFulfillment: true },
      status: "active"
    }
  });

  await prisma.agentProduct.upsert({
    where: {
      shopId_productType_platformProductId: {
        shopId: shop.id,
        productType: "platform",
        platformProductId: product.id
      }
    },
    update: {
      salePriceCents: 15_000n,
      status: "listed"
    },
    create: {
      agentId: agent.id,
      shopId: shop.id,
      productType: "platform",
      platformProductId: product.id,
      salePriceCents: 15_000n,
      status: "listed",
      listedAt: new Date()
    }
  });

  await prisma.depositAccount.upsert({
    where: { agentId: agent.id },
    update: {
      requiredAmountCents: 50_000n,
      availableAmountCents: 50_000n,
      status: "paid"
    },
    create: {
      agentId: agent.id,
      requiredAmountCents: 50_000n,
      availableAmountCents: 50_000n,
      status: "paid"
    }
  });

  const permissions = [
    ["agent.review", "代理审核"],
    ["product.manage", "商品管理"],
    ["after_sale.arbitrate", "售后仲裁"],
    ["settlement.confirm", "结算确认"],
    ["payout.confirm", "人工打款回填"],
    ["deposit.manage", "保证金管理"],
    ["risk.freeze", "风控冻结"],
    ["audit.read", "审计查询"],
    ["rbac.manage", "权限管理"]
  ] as const;

  for (const [code, name] of permissions) {
    await prisma.permission.upsert({
      where: { code },
      update: { name },
      create: { code, name }
    });
  }

  const roles = [
    ["admin", "管理员", permissions.map(([code]) => code)],
    ["operator", "运营", ["agent.review", "product.manage", "after_sale.arbitrate", "risk.freeze", "audit.read"]],
    ["finance", "财务", ["settlement.confirm", "payout.confirm", "deposit.manage", "audit.read"]]
  ] as const;

  for (const [code, name, permissionCodes] of roles) {
    const role = await prisma.role.upsert({
      where: { code },
      update: { name },
      create: { code, name }
    });

    for (const permissionCode of permissionCodes) {
      const permission = await prisma.permission.findUniqueOrThrow({
        where: { code: permissionCode }
      });

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: permission.id
          }
        },
        update: {},
        create: {
          roleId: role.id,
          permissionId: permission.id
        }
      });
    }
  }

  const admin = await prisma.adminUser.upsert({
    where: { username: "admin" },
    update: {},
    create: {
      username: "admin",
      displayName: "开发管理员",
      passwordHash: "replace-with-local-dev-hash"
    }
  });

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: "admin" } });
  await prisma.adminUserRole.upsert({
    where: {
      adminUserId_roleId: {
        adminUserId: admin.id,
        roleId: adminRole.id
      }
    },
    update: {},
    create: {
      adminUserId: admin.id,
      roleId: adminRole.id
    }
  });
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

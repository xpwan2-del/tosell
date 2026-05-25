import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const fulfilledAt = new Date("2026-05-24T00:00:00.000Z");
  const settleableAt = new Date("2026-05-25T00:00:00.000Z");
  const paidAt = new Date("2026-05-24T00:10:00.000Z");

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

  await ensureAgentApplication(agent.id, user.id);

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

  const existingService = await prisma.shopCustomerServiceBinding.findFirst({
    where: { shopId: shop.id, status: "active" }
  });
  if (!existingService) {
    await prisma.shopCustomerServiceBinding.create({
      data: {
      shopId: shop.id,
      wechatId: "dev_service_wechat",
      status: "active",
      reviewStatus: "approved"
      }
    });
  }

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

  const agentProduct = await prisma.agentProduct.upsert({
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

  const depositAccount = await prisma.depositAccount.upsert({
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

  const depositPay = await prisma.depositTransaction.upsert({
    where: { idempotencyKey: "deposit:pay:manual:AGT000001" },
    update: {},
    create: {
      agentId: agent.id,
      accountId: depositAccount.id,
      type: "pay",
      amountCents: 50_000n,
      balanceBeforeCents: 0n,
      balanceAfterCents: 50_000n,
      reasonCode: "initial_deposit",
      relatedType: "manual_receipt",
      relatedId: "DEV-DEPOSIT-001",
      voucherUrl: "dev://voucher/deposit-001",
      idempotencyKey: "deposit:pay:manual:AGT000001",
      operatorId: "seed"
    }
  });

  const order = await prisma.order.upsert({
    where: { orderNo: "ORD000001" },
    update: {
      status: "fulfilled",
      paymentStatus: "paid",
      fulfillmentStatus: "success",
      refundStatus: "pending",
      settlementStatus: "clawback_pending",
      riskStatus: "normal",
      paidAmountCents: 15_000n,
      paidAt
    },
    create: {
      orderNo: "ORD000001",
      userId: user.id,
      agentId: agent.id,
      shopId: shop.id,
      status: "fulfilled",
      paymentStatus: "paid",
      fulfillmentStatus: "success",
      refundStatus: "pending",
      settlementStatus: "clawback_pending",
      riskStatus: "normal",
      paidAmountCents: 15_000n,
      paidAt
    }
  });

  const orderItem = await ensureOrderItem(order.id, agentProduct.id);

  await prisma.orderAmountSnapshot.upsert({
    where: { orderId: order.id },
    update: {},
    create: {
      orderId: order.id,
      serviceFeeBps: 50,
      paidAmountCents: 15_000n,
      supplyAmountCents: 10_000n,
      serviceFeeCents: 75n,
      agentExpectedIncomeCents: 4_925n,
      productSnapshotJson: {
        productType: "platform",
        platformProductId: product.id,
        productNo: product.productNo,
        productName: product.name,
        supplyPriceCents: "10000",
        minSalePriceCents: "12000",
        suggestedSalePriceCents: "15000"
      },
      shopSnapshotJson: {
        agentId: agent.id,
        shopId: shop.id,
        shopName: shop.name,
        customerServiceWechat: "dev_service_wechat",
        agentStatus: "active",
        shopStatus: "open"
      },
      pricingSnapshotJson: {
        salePriceCents: "15000",
        serviceFeeBps: 50,
        serviceFeeCents: "75",
        agentExpectedIncomeCents: "4925"
      },
      fulfillmentRuleSnapshotJson: product.fulfillmentRuleJson as Prisma.InputJsonValue,
      afterSaleRuleSnapshotJson: product.afterSaleRuleJson as Prisma.InputJsonValue
    }
  });

  const payment = await prisma.payment.upsert({
    where: { paymentNo: "PAY000001" },
    update: {
      status: "paid",
      paidAt
    },
    create: {
      paymentNo: "PAY000001",
      orderId: order.id,
      userId: user.id,
      channel: "wechat",
      channelTradeNo: "WXTRADE000001",
      amountCents: 15_000n,
      status: "paid",
      idempotencyKey: "pay:wechat:WXTRADE000001",
      paidAt
    }
  });

  await prisma.paymentCallback.upsert({
    where: { channelEventId: "WXEVENT_PAY_000001" },
    update: {},
    create: {
      paymentId: payment.id,
      channel: "wechat",
      channelEventId: "WXEVENT_PAY_000001",
      rawPayloadJson: { transactionId: "WXTRADE000001", amountCents: "15000" },
      processedStatus: "processed",
      idempotencyKey: "pay:wechat:WXTRADE000001",
      processedAt: paidAt
    }
  });

  const fulfillment = await ensureFulfillment(order.id, orderItem.id, agent.id, fulfilledAt);

  await prisma.fulfillmentAttempt.upsert({
    where: { idempotencyKey: `fulfill:${orderItem.id}:1` },
    update: {},
    create: {
      fulfillmentId: fulfillment.id,
      attemptNo: 1,
      idempotencyKey: `fulfill:${orderItem.id}:1`,
      operatorId: "seed",
      requestJson: { mode: "manual" },
      resultJson: { voucher: "DEV-RIGHT-001" },
      status: "success"
    }
  });

  await prisma.entitlement.upsert({
    where: { idempotencyKey: `entitlement:${orderItem.id}:DEV-RIGHT-001` },
    update: {},
    create: {
      orderId: order.id,
      orderItemId: orderItem.id,
      userId: user.id,
      rightsCode: "DEV-RIGHT-001",
      rightsPayloadJson: { code: "DEV-RIGHT-001", note: "seed entitlement" },
      status: "success",
      idempotencyKey: `entitlement:${orderItem.id}:DEV-RIGHT-001`,
      issuedAt: fulfilledAt
    }
  });

  const settlement = await prisma.settlementSheet.upsert({
    where: { settlementNo: "SETTLE000001" },
    update: {},
    create: {
      settlementNo: "SETTLE000001",
      agentId: agent.id,
      periodStart: new Date("2026-05-25T00:00:00.000Z"),
      periodEnd: new Date("2026-05-25T23:59:59.000Z"),
      status: "paid",
      totalOrderCount: 1,
      totalPaidCents: 15_000n,
      totalServiceFeeCents: 75n,
      totalAgentIncomeCents: 4_925n,
      idempotencyKey: "settlement:AGT000001:2026-05-25:2026-05-25:batch-001",
      createdById: "seed",
      confirmedById: "seed"
    }
  });

  await prisma.settlementItem.upsert({
    where: { orderId: order.id },
    update: {},
    create: {
      settlementId: settlement.id,
      orderId: order.id,
      agentId: agent.id,
      shopId: shop.id,
      paidAmountCents: 15_000n,
      supplyAmountCents: 10_000n,
      serviceFeeCents: 75n,
      agentIncomeCents: 4_925n,
      deductedCents: 0n,
      settleAmountCents: 4_925n,
      fulfilledAt,
      settleableAt
    }
  });

  await prisma.manualPayout.upsert({
    where: { idempotencyKey: "payout:SETTLE000001:paid" },
    update: {},
    create: {
      settlementId: settlement.id,
      agentId: agent.id,
      amountCents: 4_925n,
      payeeInfoSnapshotJson: { name: "测试代理", method: "manual" },
      payoutMethod: "manual_bank_transfer",
      payoutVoucherUrl: "dev://voucher/payout-001",
      status: "paid",
      idempotencyKey: "payout:SETTLE000001:paid",
      paidById: "seed",
      paidAt: new Date("2026-05-25T12:00:00.000Z")
    }
  });

  const afterSale = await prisma.afterSale.upsert({
    where: { afterSaleNo: "AS000001" },
    update: {},
    create: {
      afterSaleNo: "AS000001",
      orderId: order.id,
      userId: user.id,
      agentId: agent.id,
      shopId: shop.id,
      status: "refunded",
      reasonCode: "agent_service_issue",
      responsibility: "agent",
      requestedRefundCents: 3_000n,
      approvedRefundCents: 3_000n,
      platformBearCents: 0n,
      agentBearCents: 3_000n,
      serviceFeeRefundCents: 0n,
      serviceFeeBearer: "agent",
      evidenceJson: { note: "seed partial refund after settlement" }
    }
  });

  const refund = await prisma.refund.upsert({
    where: { refundNo: "REF000001" },
    update: {},
    create: {
      refundNo: "REF000001",
      afterSaleId: afterSale.id,
      orderId: order.id,
      paymentId: payment.id,
      amountCents: 3_000n,
      status: "refunded",
      channelRefundNo: "WXREFUND000001",
      idempotencyKey: "refund:wechat:WXREFUND000001"
    }
  });

  await prisma.refundCallback.upsert({
    where: { channelEventId: "WXEVENT_REFUND_000001" },
    update: {},
    create: {
      refundId: refund.id,
      channel: "wechat",
      channelEventId: "WXEVENT_REFUND_000001",
      rawPayloadJson: { refundId: "WXREFUND000001", amountCents: "3000" },
      processedStatus: "processed",
      idempotencyKey: "refund:wechat:WXREFUND000001",
      processedAt: new Date("2026-05-26T01:00:00.000Z")
    }
  });

  const clawback = await prisma.clawback.upsert({
    where: { clawbackNo: "CLAW000001" },
    update: {},
    create: {
      clawbackNo: "CLAW000001",
      agentId: agent.id,
      sourceType: "refund",
      sourceId: refund.id,
      orderId: order.id,
      amountCents: 3_000n,
      status: "completed",
      deductFrom: "deposit",
      reasonCode: "post_settlement_refund",
      idempotencyKey: `clawback:refund:${refund.id}:${agent.id}`
    }
  });

  await prisma.riskFreeze.upsert({
    where: { activeUniqueKey: `shop:${shop.id}:settlement_restricted` },
    update: {},
    create: {
      targetType: "shop",
      targetId: shop.id,
      agentId: agent.id,
      freezeType: "settlement_restricted",
      status: "active",
      reasonCode: "seed_risk_review",
      reasonText: "Seed active risk freeze for review flow",
      activeUniqueKey: `shop:${shop.id}:settlement_restricted`,
      createdById: "seed"
    }
  });

  await ensureComplaint(order.id, agent.id, user.id);

  await seedLedgers(agent.id, shop.id, order.id, settlement.id, refund.id, clawback.id, depositPay.id);

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

  await prisma.auditLog.upsert({
    where: { idempotencyKey: "audit:seed:v1-closed-loop" },
    update: {},
    create: {
      actorType: "system",
      actorId: "seed",
      action: "seed.v1_closed_loop",
      targetType: "order",
      targetId: order.id,
      beforeJson: {},
      afterJson: { orderNo: order.orderNo, settlementNo: settlement.settlementNo, refundNo: refund.refundNo },
      reason: "development seed data",
      idempotencyKey: "audit:seed:v1-closed-loop",
      requestId: "seed-v1-closed-loop",
      ip: "127.0.0.1"
    }
  });
}

async function ensureAgentApplication(agentId: string, userId: string) {
  const existing = await prisma.agentApplication.findFirst({ where: { agentId, userId } });
  if (existing) return existing;
  return prisma.agentApplication.create({
    data: {
      agentId,
      userId,
      identityInfoJson: { type: "individual", name: "测试代理" },
      contactInfoJson: { phone: "13800000000" },
      customerServiceWechat: "dev_service_wechat",
      status: "approved",
      reviewedById: "seed",
      reviewedAt: new Date()
    }
  });
}

async function ensureOrderItem(orderId: string, agentProductId: string) {
  const existing = await prisma.orderItem.findFirst({ where: { orderId, agentProductId } });
  if (existing) return existing;
  return prisma.orderItem.create({
    data: {
      orderId,
      agentProductId,
      productType: "platform",
      productIdSnapshot: "P000001",
      productNameSnapshot: "测试虚拟权益",
      salePriceCents: 15_000n,
      quantity: 1,
      supplyPriceCents: 10_000n,
      serviceFeeCents: 75n,
      agentIncomeCents: 4_925n
    }
  });
}

async function ensureFulfillment(orderId: string, orderItemId: string, agentId: string, successAt: Date) {
  const existing = await prisma.fulfillmentRecord.findFirst({ where: { orderId, orderItemId } });
  if (existing) return existing;
  return prisma.fulfillmentRecord.create({
    data: {
      orderId,
      orderItemId,
      agentId,
      fulfillmentType: "manual",
      status: "success",
      successAt
    }
  });
}

async function ensureComplaint(orderId: string, agentId: string, userId: string) {
  const existing = await prisma.complaint.findFirst({
    where: { orderId, complaintType: "after_sale_service" }
  });
  if (existing) return existing;
  return prisma.complaint.create({
    data: {
      orderId,
      agentId,
      userId,
      status: "resolved",
      complaintType: "after_sale_service",
      responsibility: "agent",
      resolutionJson: { result: "partial refund and clawback" }
    }
  });
}

async function seedLedgers(
  agentId: string,
  shopId: string,
  orderId: string,
  settlementId: string,
  refundId: string,
  clawbackId: string,
  depositTransactionId: string
) {
  const entries = [
    {
      ledgerNo: "LEDGER000001",
      accountType: "agent_deposit_available",
      entryType: "DEPOSIT_PAY",
      direction: "credit",
      amountCents: 50_000n,
      sourceType: "deposit_transaction",
      sourceId: depositTransactionId,
      depositTransactionId,
      idempotencyKey: "ledger:deposit:pay:AGT000001"
    },
    {
      ledgerNo: "LEDGER000002",
      accountType: "agent_pending_income",
      entryType: "ORDER_AGENT_INCOME_PENDING",
      direction: "credit",
      amountCents: 4_925n,
      sourceType: "order",
      sourceId: orderId,
      orderId,
      idempotencyKey: "ledger:order:income:ORD000001"
    },
    {
      ledgerNo: "LEDGER000003",
      accountType: "platform_service_fee_income",
      entryType: "ORDER_SERVICE_FEE_ACCRUAL",
      direction: "credit",
      amountCents: 75n,
      sourceType: "order",
      sourceId: orderId,
      orderId,
      idempotencyKey: "ledger:order:service_fee:ORD000001"
    },
    {
      ledgerNo: "LEDGER000004",
      accountType: "agent_paid_income",
      entryType: "SETTLEMENT_PAYOUT",
      direction: "debit",
      amountCents: 4_925n,
      sourceType: "settlement",
      sourceId: settlementId,
      settlementId,
      idempotencyKey: "ledger:settlement:payout:SETTLE000001"
    },
    {
      ledgerNo: "LEDGER000005",
      accountType: "agent_clawback_receivable",
      entryType: "CLAWBACK_CREATE",
      direction: "debit",
      amountCents: 3_000n,
      sourceType: "refund",
      sourceId: refundId,
      orderId,
      refundId,
      clawbackId,
      idempotencyKey: "ledger:clawback:create:CLAW000001"
    }
  ] as const;

  for (const entry of entries) {
    await prisma.ledgerEntry.upsert({
      where: { ledgerNo: entry.ledgerNo },
      update: {},
      create: {
        ledgerNo: entry.ledgerNo,
        agentId,
        shopId,
        subjectType: "agent",
        subjectId: agentId,
        accountType: entry.accountType,
        entryType: entry.entryType,
        direction: entry.direction,
        amountCents: entry.amountCents,
        currency: "CNY",
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        orderId: "orderId" in entry ? entry.orderId : undefined,
        settlementId: "settlementId" in entry ? entry.settlementId : undefined,
        refundId: "refundId" in entry ? entry.refundId : undefined,
        clawbackId: "clawbackId" in entry ? entry.clawbackId : undefined,
        depositTransactionId: "depositTransactionId" in entry ? entry.depositTransactionId : undefined,
        idempotencyKey: entry.idempotencyKey,
        balanceBeforeCents: 0n,
        balanceAfterCents: entry.amountCents
      }
    });
  }
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

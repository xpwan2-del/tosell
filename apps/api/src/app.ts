import cors from "@fastify/cors";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  IdempotencyRegistry,
  MockPaymentProvider,
  allocateRefund,
  applyClawback,
  applyFulfillmentAttempt,
  assertAdminPermission,
  assertAgentScope,
  assertUserScope,
  buildOrderSnapshot,
  buildSettlementItems,
  canEnterSettlementAfterFulfillment,
  deductDeposit,
  isSettlementCandidate,
  paymentCallbackKey,
  processPaymentCallback,
  quotePlatformProduct,
  refundCallbackKey
} from "@tosell/core";

const bigintString = z.union([z.string(), z.number(), z.bigint()]).transform((value) => BigInt(value));
const adminRole = z.enum(["operator", "finance", "admin"]);

export function buildApp() {
  const app = Fastify({ logger: false });
  const store = createDemoStore();
  const registry = new IdempotencyRegistry();
  const paymentProvider = new MockPaymentProvider();

  app.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof AuthError) {
      return reply.status(401).send({ code: "AUTH_REQUIRED", message: error.message });
    }
    return reply.status(500).send({ code: "INTERNAL_ERROR", message: error.message });
  });
  app.register(cors, { origin: true });

  app.get("/health", async () => ({ ok: true, service: "tosell-api" }));

  app.get("/api/user/shops/:shopId", async (request, reply) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    const shop = store.shops.get(shopId);
    if (!shop) return reply.status(404).send({ code: "RESOURCE_NOT_FOUND", message: "shop not found" });
    return shop;
  });

  app.get("/api/user/shops/:shopId/products", async (request, reply) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    const shop = store.shops.get(shopId);
    if (!shop) return reply.status(404).send({ code: "RESOURCE_NOT_FOUND", message: "shop not found" });
    return [...store.agentProducts.values()]
      .filter((agentProduct) => agentProduct.shopId === shopId && agentProduct.status === "listed")
      .map((agentProduct) => serializeAgentProduct(store, agentProduct));
  });

  app.get("/api/user/products/:agentProductId", async (request, reply) => {
    const { agentProductId } = z.object({ agentProductId: z.string() }).parse(request.params);
    const agentProduct = store.agentProducts.get(agentProductId);
    if (!agentProduct) return reply.status(404).send({ code: "RESOURCE_NOT_FOUND", message: "product not found" });
    return serializeAgentProduct(store, agentProduct);
  });

  app.post("/api/user/orders/quote", async (request, reply) => {
    const body = z.object({
      shopId: z.string(),
      agentProductId: z.string(),
      quantity: z.number().int().positive().optional(),
    }).parse(request.body);

    try {
      const snapshot = buildSnapshotFromStore(store, {
        orderNo: "quote-only",
        userId: getUserActor(request).userId,
        shopId: body.shopId,
        agentProductId: body.agentProductId,
        quantity: body.quantity
      });
      return serializeBigInt(snapshot.amountSnapshot);
    } catch (error) {
      return reply.status(400).send({ code: "PRICE_RULE_FAILED", message: getErrorMessage(error) });
    }
  });

  app.post("/api/user/orders", async (request, reply) => {
    const actor = getUserActor(request);
    const body = z.object({
      shopId: z.string(),
      agentProductId: z.string(),
      quantity: z.number().int().positive().optional(),
      clientPaidAmountCents: bigintString.optional()
    }).parse(request.body);

    try {
      const orderNo = nextId(store, "order");
      const snapshot = buildSnapshotFromStore(store, {
        orderNo,
        userId: actor.userId,
        shopId: body.shopId,
        agentProductId: body.agentProductId,
        quantity: body.quantity,
        entrySource: "user_api"
      });
      if (body.clientPaidAmountCents !== undefined && body.clientPaidAmountCents !== snapshot.amountSnapshot.paidAmountCents) {
        return reply.status(400).send({ code: "AMOUNT_MISMATCH", message: "client amount does not match backend quote" });
      }

      const order: DemoOrder = {
        orderNo,
        userId: actor.userId,
        agentId: snapshot.agentId,
        shopId: snapshot.shopId,
        agentProductId: snapshot.agentProductId,
        status: "pending_payment",
        paymentStatus: "unpaid",
        fulfillmentStatus: "not_started",
        refundStatus: "none",
        settlementStatus: "pending",
        riskStatus: "normal",
        complaintStatus: "none",
        fulfilledAt: null,
        paidAt: null,
        refundedAmountCents: 0n,
        snapshot
      };
      store.orders.set(order.orderNo, order);
      audit(store, "system", "order.create", "order", order.orderNo, { agentId: order.agentId, shopId: order.shopId });
      return serializeBigInt(order);
    } catch (error) {
      return reply.status(400).send({ code: "ORDER_CREATE_FAILED", message: getErrorMessage(error) });
    }
  });

  app.get("/api/user/orders/:orderNo", async (request, reply) => {
    const actor = getUserActor(request);
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const order = store.orders.get(orderNo);
    if (!order) return reply.status(404).send({ code: "RESOURCE_NOT_FOUND", message: "order not found" });
    try {
      assertUserScope(actor, order);
      return serializeBigInt(order);
    } catch (error) {
      return reply.status(403).send({ code: "FORBIDDEN_USER_SCOPE", message: getErrorMessage(error) });
    }
  });

  app.post("/api/user/after-sales", async (request, reply) => {
    const actor = getUserActor(request);
    const body = z.object({
      orderNo: z.string(),
      reasonCode: z.string(),
      requestedRefundCents: bigintString,
      description: z.string().optional()
    }).parse(request.body);
    const order = store.orders.get(body.orderNo);
    if (!order) return reply.status(404).send({ code: "RESOURCE_NOT_FOUND", message: "order not found" });
    try {
      assertUserScope(actor, order);
      const afterSaleNo = nextId(store, "as");
      const afterSale: DemoAfterSale = {
        afterSaleNo,
        orderNo: order.orderNo,
        userId: actor.userId,
        agentId: order.agentId,
        shopId: order.shopId,
        status: "pending",
        reasonCode: body.reasonCode,
        requestedRefundCents: body.requestedRefundCents
      };
      store.afterSales.set(afterSaleNo, afterSale);
      order.status = "after_sale_pending";
      order.refundStatus = "pending";
      order.settlementStatus = "frozen";
      audit(store, "user", "after_sale.create", "after_sale", afterSaleNo, { orderNo: order.orderNo });
      return serializeBigInt(afterSale);
    } catch (error) {
      return reply.status(403).send({ code: "FORBIDDEN_USER_SCOPE", message: getErrorMessage(error) });
    }
  });

  app.post("/api/agent/applications", async (request) => {
    const actor = getAgentActor(request);
    const body = z.object({
      contactPhone: z.string(),
      customerServiceWechat: z.string()
    }).parse(request.body);
    const agent = store.agents.get(actor.agentId);
    if (agent) {
      agent.status = "pending_review";
      agent.contactPhone = body.contactPhone;
    }
    return { status: "pending_review", agentId: actor.agentId, customerServiceWechat: body.customerServiceWechat };
  });

  app.get("/api/agent/shop", async (request, reply) => {
    const actor = getAgentActor(request);
    const shop = store.shops.get(actor.shopId);
    if (!shop) return reply.status(404).send({ code: "RESOURCE_NOT_FOUND", message: "shop not found" });
    try {
      assertAgentScope(actor, shop);
      return shop;
    } catch (error) {
      return reply.status(403).send({ code: "FORBIDDEN_AGENT_SCOPE", message: getErrorMessage(error) });
    }
  });

  app.patch("/api/agent/shop", async (request, reply) => {
    const actor = getAgentActor(request);
    const body = z.object({ name: z.string().optional(), announcement: z.string().optional() }).parse(request.body);
    const shop = store.shops.get(actor.shopId);
    if (!shop) return reply.status(404).send({ code: "RESOURCE_NOT_FOUND", message: "shop not found" });
    assertAgentScope(actor, shop);
    Object.assign(shop, body);
    return shop;
  });

  app.get("/api/agent/products/platform", async () => serializeBigInt([...store.platformProducts.values()]));

  app.patch("/api/agent/products/:agentProductId/price", async (request, reply) => {
    const actor = getAgentActor(request);
    const { agentProductId } = z.object({ agentProductId: z.string() }).parse(request.params);
    const body = z.object({ salePriceCents: bigintString }).parse(request.body);
    const agentProduct = store.agentProducts.get(agentProductId);
    if (!agentProduct) return reply.status(404).send({ code: "RESOURCE_NOT_FOUND", message: "agent product not found" });
    try {
      assertAgentScope(actor, agentProduct);
      const product = store.platformProducts.get(requireValue(agentProduct.platformProductId, "platformProductId"));
      if (!product) throw new Error("platform product not found");
      quotePlatformProduct({
        salePriceCents: body.salePriceCents,
        supplyPriceCents: product.supplyPriceCents,
        minSalePriceCents: product.minSalePriceCents
      });
      agentProduct.salePriceCents = body.salePriceCents;
      audit(store, "agent", "agent_product.price_update", "agent_product", agentProduct.id, { salePriceCents: body.salePriceCents });
      return serializeBigInt(agentProduct);
    } catch (error) {
      return reply.status(400).send({ code: "PRICE_RULE_FAILED", message: getErrorMessage(error) });
    }
  });

  app.get("/api/agent/orders", async (request) => {
    const actor = getAgentActor(request);
    return serializeBigInt([...store.orders.values()].filter((order) => order.agentId === actor.agentId && order.shopId === actor.shopId));
  });

  app.get("/api/agent/settlements", async (request) => {
    const actor = getAgentActor(request);
    return serializeBigInt(store.settlementSheets.filter((sheet) => sheet.agentId === actor.agentId));
  });

  app.get("/api/agent/clawbacks", async (request) => {
    const actor = getAgentActor(request);
    return serializeBigInt(store.clawbacks.filter((clawback) => clawback.agentId === actor.agentId));
  });

  app.post("/api/agent/scope-check", async (request, reply) => {
    const actor = getAgentActor(request);
    const body = z.object({
      resourceAgentId: z.string(),
      resourceShopId: z.string().optional()
    }).parse(request.body);

    try {
      assertAgentScope(actor, { agentId: body.resourceAgentId, shopId: body.resourceShopId });
      return { ok: true };
    } catch (error) {
      return reply.status(403).send({ code: "FORBIDDEN_AGENT_SCOPE", message: getErrorMessage(error) });
    }
  });

  app.post("/api/admin/agents/:agentId/review", async (request, reply) => {
    const actor = getAdminActor(request);
    const { agentId } = z.object({ agentId: z.string() }).parse(request.params);
    const body = z.object({ approved: z.boolean(), reason: z.string().optional() }).parse(request.body);
    try {
      assertAdminPermission(actor, "agent.review");
      const agent = requireEntity(store.agents.get(agentId), "agent not found");
      agent.status = body.approved ? "pending_deposit" : "rejected";
      audit(store, actor.role, "agent.review", "agent", agentId, body);
      return agent;
    } catch (error) {
      return reply.status(403).send({ code: "FORBIDDEN_ADMIN_PERMISSION", message: getErrorMessage(error) });
    }
  });

  app.post("/api/admin/products", async (request, reply) => {
    const actor = getAdminActor(request);
    const body = z.object({
      name: z.string(),
      supplyPriceCents: bigintString,
      minSalePriceCents: bigintString,
      suggestedSalePriceCents: bigintString
    }).parse(request.body);
    try {
      assertAdminPermission(actor, "product.manage");
      const id = nextId(store, "prod");
      const product: DemoPlatformProduct = {
        id,
        name: body.name,
        supplyPriceCents: body.supplyPriceCents,
        minSalePriceCents: body.minSalePriceCents,
        suggestedSalePriceCents: body.suggestedSalePriceCents,
        fulfillmentRule: { mode: "manual" },
        afterSaleRule: { refundBeforeFulfillment: true },
        status: "active"
      };
      store.platformProducts.set(id, product);
      audit(store, actor.role, "product.create", "platform_product", id, body);
      return serializeBigInt(product);
    } catch (error) {
      return reply.status(403).send({ code: "FORBIDDEN_ADMIN_PERMISSION", message: getErrorMessage(error) });
    }
  });

  app.get("/api/admin/orders", async (request) => {
    assertAdminPermission(getAdminActor(request), "audit.read");
    return serializeBigInt([...store.orders.values()]);
  });

  app.post("/api/admin/fulfillment/:orderNo", async (request, reply) => {
    const actor = getAdminActor(request);
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = z.object({
      status: z.enum(["success", "failed"]),
      attemptNo: z.number().int().positive().default(1),
      evidence: z.string().optional(),
      failReason: z.string().optional()
    }).parse(request.body);
    try {
      assertAdminPermission(actor, "after_sale.arbitrate");
      const order = requireEntity(store.orders.get(orderNo), "order not found");
      const record = store.fulfillmentRecords.get(orderNo) ?? {
        fulfillmentId: `fulfillment-${orderNo}`,
        orderItemId: `${orderNo}-item-1`,
        status: "not_started" as const,
        attemptCount: 0
      };
      const result = applyFulfillmentAttempt({ registry, record, attemptNo: body.attemptNo, result: body });
      store.fulfillmentRecords.set(orderNo, record);
      order.fulfillmentStatus = record.status;
      order.status = result.orderStatus;
      if (record.status === "success") {
        order.fulfilledAt = new Date();
      }
      audit(store, actor.role, "fulfillment.update", "order", orderNo, body);
      return serializeBigInt({ ...result, order });
    } catch (error) {
      return reply.status(400).send({ code: "FULFILLMENT_FAILED", message: getErrorMessage(error) });
    }
  });

  app.post("/api/admin/refunds/allocate", async (request, reply) => {
    assertAdminPermission(getAdminActor(request), "after_sale.arbitrate");
    const body = refundAllocationSchema().parse(request.body);
    try {
      return serializeBigInt(allocateRefund(body));
    } catch (error) {
      return reply.status(400).send({ code: "REFUND_ALLOCATION_FAILED", message: getErrorMessage(error) });
    }
  });

  app.post("/api/admin/after-sales/:afterSaleNo/refunds", async (request, reply) => {
    const actor = getAdminActor(request);
    const { afterSaleNo } = z.object({ afterSaleNo: z.string() }).parse(request.params);
    const body = refundAllocationSchema().pick({
      refundAmountCents: true,
      responsibility: true,
      platformBearCents: true,
      agentBearCents: true
    }).parse(request.body);
    try {
      assertAdminPermission(actor, "after_sale.arbitrate");
      const afterSale = requireEntity(store.afterSales.get(afterSaleNo), "after sale not found");
      const order = requireEntity(store.orders.get(afterSale.orderNo), "order not found");
      const allocation = allocateRefund({
        paidAmountCents: order.snapshot.amountSnapshot.paidAmountCents,
        supplyAmountCents: order.snapshot.amountSnapshot.supplyAmountCents,
        agentIncomeCents: order.snapshot.amountSnapshot.agentExpectedIncomeCents,
        alreadyRefundedCents: order.refundedAmountCents,
        refundAmountCents: body.refundAmountCents,
        responsibility: body.responsibility,
        platformBearCents: body.platformBearCents,
        agentBearCents: body.agentBearCents
      });
      afterSale.status = "refunding";
      afterSale.allocation = allocation;
      order.status = "refunding";
      order.refundStatus = "refunding";
      order.settlementStatus = "frozen";
      const refundNo = nextId(store, "refund");
      const refund: DemoRefund = {
        refundNo,
        afterSaleNo,
        orderNo: order.orderNo,
        amountCents: allocation.refundAmountCents,
        agentClawbackCents: allocation.agentTotalCostCents,
        status: "pending"
      };
      store.refunds.set(refundNo, refund);
      audit(store, actor.role, "refund.approve", "after_sale", afterSaleNo, allocation);
      return serializeBigInt({ refund, allocation });
    } catch (error) {
      return reply.status(400).send({ code: "REFUND_CREATE_FAILED", message: getErrorMessage(error) });
    }
  });

  app.post("/api/admin/settlements/candidate", async (request) => {
    assertAdminPermission(getAdminActor(request), "settlement.generate");
    const body = z.object({
      orderId: z.string(),
      paymentStatus: z.string(),
      fulfillmentStatus: z.string(),
      settlementStatus: z.string(),
      refundStatus: z.string(),
      riskStatus: z.string(),
      fulfilledAt: z.string().nullable(),
      now: z.string()
    }).parse(request.body);

    return {
      settleable: isSettlementCandidate({
        ...body,
        fulfilledAt: body.fulfilledAt ? new Date(body.fulfilledAt) : null,
        now: new Date(body.now)
      })
    };
  });

  app.post("/api/admin/settlements/generate", async (request, reply) => {
    const actor = getAdminActor(request);
    const body = z.object({
      agentId: z.string(),
      now: z.string().optional(),
      batchNo: z.string().default("default")
    }).parse(request.body);
    try {
      assertAdminPermission(actor, "settlement.generate");
      const now = body.now ? new Date(body.now) : new Date();
      const orders = [...store.orders.values()]
        .filter((order) => order.agentId === body.agentId)
        .map((order) => ({
          orderId: order.orderNo,
          agentId: order.agentId,
          shopId: order.shopId,
          paymentStatus: order.paymentStatus,
          fulfillmentStatus: order.fulfillmentStatus,
          settlementStatus: order.settlementStatus,
          refundStatus: order.refundStatus,
          riskStatus: order.riskStatus,
          complaintStatus: order.complaintStatus,
          fulfilledAt: order.fulfilledAt,
          now,
          paidAmountCents: order.snapshot.amountSnapshot.paidAmountCents,
          supplyAmountCents: order.snapshot.amountSnapshot.supplyAmountCents,
          serviceFeeCents: order.snapshot.amountSnapshot.serviceFeeCents,
          agentIncomeCents: order.snapshot.amountSnapshot.agentExpectedIncomeCents
        }));
      const items = buildSettlementItems(orders, store.settlementItemOrderIds, body.agentId);
      for (const item of items) {
        store.settlementItemOrderIds.add(item.orderId);
        const order = store.orders.get(item.orderId);
        if (order) order.settlementStatus = "settling";
      }
      const sheet = {
        settlementNo: nextId(store, "settlement"),
        agentId: body.agentId,
        status: "confirmed",
        items,
        totalOrderCount: items.length,
        totalPaidCents: sum(items.map((item) => item.paidAmountCents)),
        totalServiceFeeCents: sum(items.map((item) => item.serviceFeeCents)),
        totalAgentIncomeCents: sum(items.map((item) => item.agentIncomeCents))
      };
      store.settlementSheets.push(sheet);
      audit(store, actor.role, "settlement.generate", "settlement", sheet.settlementNo, { count: items.length });
      return serializeBigInt(sheet);
    } catch (error) {
      return reply.status(400).send({ code: "SETTLEMENT_GENERATE_FAILED", message: getErrorMessage(error) });
    }
  });

  app.post("/api/admin/deposits/:agentId/deduct", async (request, reply) => {
    const actor = getAdminActor(request);
    const { agentId } = z.object({ agentId: z.string() }).parse(request.params);
    const body = z.object({
      amountCents: bigintString,
      sourceType: z.string(),
      sourceId: z.string(),
      reasonCode: z.string()
    }).parse(request.body);
    try {
      assertAdminPermission(actor, "deposit.manage");
      const account = requireEntity(store.depositAccounts.get(agentId), "deposit account not found");
      const result = deductDeposit({ registry, account, ...body });
      audit(store, actor.role, "deposit.deduct", "agent", agentId, result);
      return serializeBigInt(result);
    } catch (error) {
      return reply.status(400).send({ code: "DEPOSIT_DEDUCT_FAILED", message: getErrorMessage(error) });
    }
  });

  app.post("/api/admin/risk-freezes", async (request, reply) => {
    const actor = getAdminActor(request);
    const body = z.object({
      targetType: z.enum(["order", "shop", "agent", "product", "settlement"]),
      targetId: z.string(),
      freezeType: z.enum(["order_frozen", "shop_frozen", "settlement_restricted", "product_removed", "disabled"]),
      reasonCode: z.string()
    }).parse(request.body);
    try {
      assertAdminPermission(actor, "risk.freeze");
      const key = `${body.targetType}:${body.targetId}:${body.freezeType}`;
      if (store.activeRiskFreezeKeys.has(key)) {
        return { status: "duplicate", key };
      }
      store.activeRiskFreezeKeys.add(key);
      store.riskFreezes.push({ ...body, status: "active" });
      if (body.targetType === "order") {
        const order = requireEntity(store.orders.get(body.targetId), "order not found");
        order.riskStatus = body.freezeType;
        order.settlementStatus = "frozen";
      }
      if (body.targetType === "shop") {
        const shop = requireEntity(store.shops.get(body.targetId), "shop not found");
        shop.riskStatus = body.freezeType;
        if (body.freezeType === "shop_frozen") shop.status = "frozen";
        if (body.freezeType === "disabled") shop.status = "disabled";
      }
      audit(store, actor.role, "risk.freeze", body.targetType, body.targetId, body);
      return { status: "processed", key };
    } catch (error) {
      return reply.status(400).send({ code: "RISK_FREEZE_FAILED", message: getErrorMessage(error) });
    }
  });

  app.get("/api/admin/audit-logs", async (request) => {
    assertAdminPermission(getAdminActor(request), "audit.read");
    return serializeBigInt(store.auditLogs);
  });

  app.post("/api/callbacks/payments/mock", async (request, reply) => {
    const body = z.object({
      channel: z.string().default("mock"),
      channelTradeNo: z.string(),
      orderNo: z.string(),
      amountCents: bigintString
    }).parse(request.body);
    const order = store.orders.get(body.orderNo);

    if (!order) {
      return reply.status(404).send({ code: "RESOURCE_NOT_FOUND", message: "order not found" });
    }

    try {
      const result = processPaymentCallback({
        provider: paymentProvider,
        registry,
        payload: body,
        order: {
          orderNo: order.orderNo,
          paidAmountCents: order.snapshot.amountSnapshot.paidAmountCents,
          paymentStatus: order.paymentStatus
        },
        onProcessed: () => {
          order.paymentStatus = "paid";
          order.status = "fulfilling";
          order.fulfillmentStatus = "processing";
          order.paidAt = new Date();
          store.pendingIncomeByAgent.set(order.agentId, (store.pendingIncomeByAgent.get(order.agentId) ?? 0n) + order.snapshot.amountSnapshot.agentExpectedIncomeCents);
        }
      });
      audit(store, "system", "payment.callback", "order", order.orderNo, result);
      return serializeBigInt(result);
    } catch (error) {
      return reply.status(400).send({ code: "PAYMENT_CALLBACK_FAILED", message: getErrorMessage(error) });
    }
  });

  app.post("/api/callbacks/refunds/mock", async (request, reply) => {
    const body = z.object({
      channel: z.string().default("mock"),
      channelRefundNo: z.string(),
      refundNo: z.string()
    }).parse(request.body);
    const refund = store.refunds.get(body.refundNo);
    if (!refund) return reply.status(404).send({ code: "RESOURCE_NOT_FOUND", message: "refund not found" });

    const key = refundCallbackKey(body.channel, body.channelRefundNo);
    const result = registry.runOnce(key, () => {
      const order = requireEntity(store.orders.get(refund.orderNo), "order not found");
      refund.status = "success";
      order.refundedAmountCents += refund.amountCents;
      order.refundStatus = order.refundedAmountCents === order.snapshot.amountSnapshot.paidAmountCents ? "refunded" : "none";
      order.status = order.refundStatus === "refunded" ? "refunded" : "fulfilled";

      if (order.settlementStatus === "settled") {
        const balances = {
          pendingIncomeCents: store.pendingIncomeByAgent.get(order.agentId) ?? 0n,
          payableIncomeCents: store.payableIncomeByAgent.get(order.agentId) ?? 0n,
          depositAvailableCents: store.depositAccounts.get(order.agentId)?.availableAmountCents ?? 0n
        };
        const clawback = applyClawback(refund.agentClawbackCents, balances);
        store.pendingIncomeByAgent.set(order.agentId, clawback.balances.pendingIncomeCents);
        store.payableIncomeByAgent.set(order.agentId, clawback.balances.payableIncomeCents);
        const deposit = store.depositAccounts.get(order.agentId);
        if (deposit) deposit.availableAmountCents = clawback.balances.depositAvailableCents;
        store.clawbacks.push({ clawbackNo: nextId(store, "clawback"), agentId: order.agentId, orderNo: order.orderNo, ...clawback });
      }

      return { status: "processed" as const, idempotencyKey: key, refund };
    });

    return serializeBigInt(result ?? { status: "duplicate", idempotencyKey: key });
  });

  app.get("/api/exports/reconciliation-summary", async (request) => {
    assertAdminPermission(getAdminActor(request), "audit.read");
    const orders = [...store.orders.values()];
    return serializeBigInt({
      totalPaidCents: sum(orders.filter((order) => order.paymentStatus === "paid").map((order) => order.snapshot.amountSnapshot.paidAmountCents)),
      totalRefundedCents: sum(orders.map((order) => order.refundedAmountCents)),
      totalServiceFeeCents: sum(orders.filter((order) => order.paymentStatus === "paid").map((order) => order.snapshot.amountSnapshot.serviceFeeCents)),
      totalAgentIncomeCents: sum(orders.filter((order) => order.paymentStatus === "paid").map((order) => order.snapshot.amountSnapshot.agentExpectedIncomeCents)),
      settlementCount: store.settlementSheets.length,
      clawbackCount: store.clawbacks.length,
      depositAvailableCents: sum([...store.depositAccounts.values()].map((account) => account.availableAmountCents))
    });
  });

  return app;
}

function refundAllocationSchema() {
  return z.object({
    paidAmountCents: bigintString,
    supplyAmountCents: bigintString,
    agentIncomeCents: bigintString,
    alreadyRefundedCents: bigintString.optional(),
    refundAmountCents: bigintString,
    responsibility: z.enum(["platform", "agent", "user", "mixed"]),
    platformBearCents: bigintString.optional(),
    agentBearCents: bigintString.optional()
  });
}

function getUserActor(request: FastifyRequest) {
  return { role: "user" as const, userId: requiredHeader(request, "x-user-id") };
}

function getAgentActor(request: FastifyRequest) {
  const agentId = requiredHeader(request, "x-agent-id");
  const shopId = requiredHeader(request, "x-shop-id");
  return {
    role: "agent" as const,
    agentId,
    shopId
  };
}

function getAdminActor(request: FastifyRequest) {
  const role = adminRole.parse(requiredHeader(request, "x-admin-role"));
  return { role, adminId: requiredHeader(request, "x-admin-id") };
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new AuthError(`missing ${name} header`);
  }
  return value;
}

function buildSnapshotFromStore(
  store: DemoStore,
  input: { orderNo: string; userId: string; shopId: string; agentProductId: string; quantity?: number; entrySource?: string }
) {
  const shop = requireEntity(store.shops.get(input.shopId), "shop not found");
  const agent = requireEntity(store.agents.get(shop.agentId), "agent not found");
  const agentProduct = requireEntity(store.agentProducts.get(input.agentProductId), "agent product not found");
  if (agentProduct.shopId !== shop.id) throw new Error("agent product does not belong to shop");
  const platformProduct = agentProduct.platformProductId ? store.platformProducts.get(agentProduct.platformProductId) : undefined;
  const ownProduct = agentProduct.ownProductReviewId ? store.ownProducts.get(agentProduct.ownProductReviewId) : undefined;

  return buildOrderSnapshot({
    orderNo: input.orderNo,
    userId: input.userId,
    agent,
    shop,
    agentProduct,
    platformProduct,
    ownProduct,
    quantity: input.quantity,
    entrySource: input.entrySource
  });
}

function serializeAgentProduct(store: DemoStore, agentProduct: DemoAgentProduct) {
  const product = agentProduct.platformProductId
    ? store.platformProducts.get(agentProduct.platformProductId)
    : store.ownProducts.get(requireValue(agentProduct.ownProductReviewId, "ownProductReviewId"));
  return serializeBigInt({ ...agentProduct, product });
}

function serializeBigInt(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (
    typeof nested === "bigint" ? nested.toString() : nested
  )));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function requireValue<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) throw new Error(`${name} is required`);
  return value;
}

function requireEntity<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

class AuthError extends Error {}

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function nextId(store: DemoStore, prefix: string): string {
  store.sequence += 1;
  return `${prefix}-${store.sequence}`;
}

function audit(store: DemoStore, actor: string, action: string, targetType: string, targetId: string, after: unknown): void {
  store.auditLogs.push({
    id: nextId(store, "audit"),
    actor,
    action,
    targetType,
    targetId,
    after,
    createdAt: new Date()
  });
}

function createDemoStore(): DemoStore {
  const store: DemoStore = {
    sequence: 0,
    agents: new Map(),
    shops: new Map(),
    platformProducts: new Map(),
    ownProducts: new Map(),
    agentProducts: new Map(),
    depositAccounts: new Map(),
    orders: new Map(),
    afterSales: new Map(),
    refunds: new Map(),
    fulfillmentRecords: new Map(),
    settlementSheets: [],
    settlementItemOrderIds: new Set(),
    clawbacks: [],
    riskFreezes: [],
    activeRiskFreezeKeys: new Set(),
    auditLogs: [],
    pendingIncomeByAgent: new Map(),
    payableIncomeByAgent: new Map()
  };

  store.agents.set("agent-1", {
    id: "agent-1",
    name: "测试代理 A",
    status: "active",
    riskStatus: "normal",
    depositStatus: "paid",
    contactPhone: "13800000000"
  });
  store.agents.set("agent-2", {
    id: "agent-2",
    name: "测试代理 B",
    status: "active",
    riskStatus: "normal",
    depositStatus: "paid",
    contactPhone: "13900000000"
  });
  store.shops.set("shop-1", {
    id: "shop-1",
    agentId: "agent-1",
    name: "测试代理 A 小店",
    status: "open",
    riskStatus: "normal",
    customerServiceWechat: "agent_a_service"
  });
  store.shops.set("shop-2", {
    id: "shop-2",
    agentId: "agent-2",
    name: "测试代理 B 小店",
    status: "open",
    riskStatus: "normal",
    customerServiceWechat: "agent_b_service"
  });
  store.platformProducts.set("prod-1", {
    id: "prod-1",
    name: "测试虚拟权益",
    supplyPriceCents: 10_000n,
    minSalePriceCents: 12_000n,
    suggestedSalePriceCents: 15_000n,
    fulfillmentRule: { mode: "manual" },
    afterSaleRule: { refundBeforeFulfillment: true },
    status: "active"
  });
  store.agentProducts.set("ap-1", {
    id: "ap-1",
    agentId: "agent-1",
    shopId: "shop-1",
    productType: "platform",
    platformProductId: "prod-1",
    ownProductReviewId: null,
    salePriceCents: 15_000n,
    status: "listed"
  });
  store.agentProducts.set("ap-2", {
    id: "ap-2",
    agentId: "agent-2",
    shopId: "shop-2",
    productType: "platform",
    platformProductId: "prod-1",
    ownProductReviewId: null,
    salePriceCents: 16_000n,
    status: "listed"
  });
  store.depositAccounts.set("agent-1", {
    agentId: "agent-1",
    requiredAmountCents: 50_000n,
    availableAmountCents: 50_000n,
    frozenAmountCents: 0n,
    deductedAmountCents: 0n,
    status: "paid"
  });
  store.depositAccounts.set("agent-2", {
    agentId: "agent-2",
    requiredAmountCents: 50_000n,
    availableAmountCents: 50_000n,
    frozenAmountCents: 0n,
    deductedAmountCents: 0n,
    status: "paid"
  });

  return store;
}

type DemoAgent = {
  id: string;
  name: string;
  contactPhone?: string;
  status: string;
  riskStatus: string;
  depositStatus: string;
};

type DemoShop = {
  id: string;
  agentId: string;
  name: string;
  status: string;
  riskStatus: string;
  customerServiceWechat?: string;
};

type DemoPlatformProduct = {
  id: string;
  name: string;
  supplyPriceCents: bigint;
  minSalePriceCents: bigint;
  suggestedSalePriceCents: bigint;
  fulfillmentRule: unknown;
  afterSaleRule: unknown;
  status: string;
};

type DemoOwnProduct = {
  id: string;
  name: string;
  minSalePriceCents?: bigint;
  fulfillmentRule: unknown;
  afterSaleRule: unknown;
  reviewStatus: string;
};

type DemoAgentProduct = {
  id: string;
  agentId: string;
  shopId: string;
  productType: "platform" | "agent_owned";
  platformProductId?: string | null;
  ownProductReviewId?: string | null;
  salePriceCents: bigint;
  status: string;
};

type DemoOrder = {
  orderNo: string;
  userId: string;
  agentId: string;
  shopId: string;
  agentProductId: string;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  refundStatus: string;
  settlementStatus: string;
  riskStatus: string;
  complaintStatus: string;
  fulfilledAt: Date | null;
  paidAt: Date | null;
  refundedAmountCents: bigint;
  snapshot: ReturnType<typeof buildOrderSnapshot>;
};

type DemoAfterSale = {
  afterSaleNo: string;
  orderNo: string;
  userId: string;
  agentId: string;
  shopId: string;
  status: string;
  reasonCode: string;
  requestedRefundCents: bigint;
  allocation?: ReturnType<typeof allocateRefund>;
};

type DemoRefund = {
  refundNo: string;
  afterSaleNo: string;
  orderNo: string;
  amountCents: bigint;
  agentClawbackCents: bigint;
  status: string;
};

type DemoStore = {
  sequence: number;
  agents: Map<string, DemoAgent>;
  shops: Map<string, DemoShop>;
  platformProducts: Map<string, DemoPlatformProduct>;
  ownProducts: Map<string, DemoOwnProduct>;
  agentProducts: Map<string, DemoAgentProduct>;
  depositAccounts: Map<string, Parameters<typeof deductDeposit>[0]["account"]>;
  orders: Map<string, DemoOrder>;
  afterSales: Map<string, DemoAfterSale>;
  refunds: Map<string, DemoRefund>;
  fulfillmentRecords: Map<string, Parameters<typeof applyFulfillmentAttempt>[0]["record"]>;
  settlementSheets: Array<Record<string, unknown>>;
  settlementItemOrderIds: Set<string>;
  clawbacks: Array<Record<string, unknown>>;
  riskFreezes: Array<Record<string, unknown>>;
  activeRiskFreezeKeys: Set<string>;
  auditLogs: Array<Record<string, unknown>>;
  pendingIncomeByAgent: Map<string, bigint>;
  payableIncomeByAgent: Map<string, bigint>;
};

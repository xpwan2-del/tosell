import cors from "@fastify/cors";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import { isSettlementCandidate } from "@tosell/core";
import {
  ApiError,
  type AdminActor,
  type AgentActor,
  type UserActor,
  createBackendServices
} from "./services.js";

const bigintString = z.union([z.string(), z.number(), z.bigint()]).transform((value) => BigInt(value));
const adminRole = z.enum(["operator", "finance", "admin"]);

export function buildApp() {
  const app = Fastify({ logger: false });
  const services = createBackendServices();

  app.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message });
    }
    return reply.status(500).send({ code: "INTERNAL_ERROR", message: error.message });
  });
  app.register(cors, { origin: true });

  app.get("/health", async () => services.health());

  app.get("/api/user/shops/:shopId", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    return services.getPublicShop(shopId);
  });

  app.get("/api/user/shops/:shopId/products", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    return serializeBigInt(services.listShopProducts(shopId));
  });

  app.get("/api/user/products/:agentProductId", async (request) => {
    const { agentProductId } = z.object({ agentProductId: z.string() }).parse(request.params);
    return serializeBigInt(services.getAgentProduct(agentProductId));
  });

  app.post("/api/user/orders/quote", async (request) => {
    const body = z.object({
      shopId: z.string(),
      agentProductId: z.string(),
      quantity: z.number().int().positive().optional()
    }).parse(request.body);
    try {
      return serializeBigInt(services.quoteOrder(getUserActor(request), body));
    } catch (error) {
      if (error instanceof ApiError) {
        throw new ApiError(400, "PRICE_RULE_FAILED", error.message);
      }
      throw error;
    }
  });

  app.post("/api/user/orders", async (request) => {
    const body = z.object({
      shopId: z.string(),
      agentProductId: z.string(),
      quantity: z.number().int().positive().optional(),
      clientPaidAmountCents: bigintString.optional()
    }).parse(request.body);
    try {
      return serializeBigInt(services.createOrder(getUserActor(request), body));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "ORDER_CREATE_FAILED", error instanceof Error ? error.message : "order create failed");
    }
  });

  app.get("/api/user/orders", async (request) => {
    return serializeBigInt(services.listUserOrders(getUserActor(request)));
  });

  app.get("/api/user/orders/:orderNo", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    return serializeBigInt(services.getUserOrder(getUserActor(request), orderNo));
  });

  app.post("/api/user/after-sales", async (request) => {
    const body = z.object({
      orderNo: z.string(),
      reasonCode: z.string(),
      requestedRefundCents: bigintString,
      description: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.createAfterSale(getUserActor(request), body));
  });

  app.post("/api/agent/applications", async (request) => {
    const body = z.object({
      contactPhone: z.string(),
      customerServiceWechat: z.string()
    }).parse(request.body);
    return services.submitAgentApplication(getAgentActor(request), body);
  });

  app.get("/api/agent/shop", async (request) => services.getAgentShop(getAgentActor(request)));

  app.get("/api/agent/dashboard", async (request) => serializeBigInt(services.agentDashboard(getAgentActor(request))));

  app.patch("/api/agent/shop", async (request) => {
    const body = z.object({
      name: z.string().optional(),
      announcement: z.string().optional(),
      customerServiceWechat: z.string().optional(),
      customerServiceQrUrl: z.string().optional()
    }).parse(request.body);
    return services.updateAgentShop(getAgentActor(request), body);
  });

  app.patch("/api/agent/shop/decor", async (request) => {
    const body = z.object({
      themeColor: z.string().optional(),
      bannerUrl: z.string().optional(),
      shareTitle: z.string().optional(),
      productGroups: z.array(z.object({
        name: z.string(),
        agentProductIds: z.array(z.string())
      })).optional()
    }).parse(request.body);
    return serializeBigInt(services.updateShopDecor(getAgentActor(request), body));
  });

  app.get("/api/agent/products/platform", async (request) => serializeBigInt(services.listPlatformProducts(getAgentActor(request))));
  app.get("/api/agent/products", async (request) => serializeBigInt(services.listAgentProducts(getAgentActor(request))));
  app.get("/api/agent/products/own", async (request) => serializeBigInt(services.listOwnProductReviews(getAgentActor(request))));

  app.post("/api/agent/products/own", async (request) => {
    const body = z.object({
      name: z.string(),
      salePriceCents: bigintString,
      minSalePriceCents: bigintString.optional(),
      fulfillmentMode: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.submitOwnProduct(getAgentActor(request), {
      ...body,
      fulfillmentRule: { mode: body.fulfillmentMode ?? "manual" }
    }));
  });

  app.post("/api/agent/products/platform", async (request) => {
    const body = z.object({ platformProductId: z.string(), salePriceCents: bigintString }).parse(request.body);
    return serializeBigInt(services.selectPlatformProduct(getAgentActor(request), body));
  });

  app.post("/api/agent/products/platform/batch", async (request) => {
    const body = z.object({
      items: z.array(z.object({ platformProductId: z.string(), salePriceCents: bigintString }))
    }).parse(request.body);
    return serializeBigInt(services.batchSelectPlatformProducts(getAgentActor(request), body));
  });

  app.patch("/api/agent/products/:agentProductId/price", async (request) => {
    const { agentProductId } = z.object({ agentProductId: z.string() }).parse(request.params);
    const body = z.object({ salePriceCents: bigintString }).parse(request.body);
    return serializeBigInt(services.setAgentProductPrice(getAgentActor(request), agentProductId, body.salePriceCents));
  });

  app.get("/api/agent/orders", async (request) => serializeBigInt(services.listAgentOrders(getAgentActor(request))));
  app.get("/api/agent/settlements", async (request) => serializeBigInt(services.listAgentSettlements(getAgentActor(request))));
  app.get("/api/agent/clawbacks", async (request) => serializeBigInt(services.listAgentClawbacks(getAgentActor(request))));
  app.get("/api/agent/deposit-transactions", async (request) => serializeBigInt(services.listAgentDepositTransactions(getAgentActor(request))));
  app.get("/api/agent/notifications", async (request) => serializeBigInt(services.listNotifications(getAgentActor(request))));

  app.post("/api/agent/notifications/:notificationId/read", async (request) => {
    const { notificationId } = z.object({ notificationId: z.string() }).parse(request.params);
    return serializeBigInt(services.markNotificationRead(getAgentActor(request), notificationId));
  });

  app.post("/api/agent/scope-check", async (request) => {
    const body = z.object({ resourceAgentId: z.string(), resourceShopId: z.string().optional() }).parse(request.body);
    const actor = getAgentActor(request);
    if (actor.agentId !== body.resourceAgentId || (body.resourceShopId && actor.shopId !== body.resourceShopId)) {
      throw new ApiError(403, "FORBIDDEN_AGENT_SCOPE", "agent cannot access another agent resource");
    }
    return { ok: true };
  });

  app.post("/api/admin/agents/:agentId/review", async (request) => {
    const { agentId } = z.object({ agentId: z.string() }).parse(request.params);
    const body = z.object({ approved: z.boolean(), reason: z.string().optional() }).parse(request.body);
    return services.reviewAgent(getAdminActor(request), agentId, body);
  });

  app.post("/api/admin/deposits/:agentId/confirm", async (request) => {
    const { agentId } = z.object({ agentId: z.string() }).parse(request.params);
    const body = z.object({ amountCents: bigintString, requiredAmountCents: bigintString.optional(), voucherUrl: z.string().optional() }).parse(request.body);
    return serializeBigInt(services.confirmDeposit(getAdminActor(request), agentId, body));
  });

  app.post("/api/admin/deposits/:agentId/deduct", async (request) => {
    const { agentId } = z.object({ agentId: z.string() }).parse(request.params);
    const body = z.object({
      amountCents: bigintString,
      sourceType: z.string(),
      sourceId: z.string(),
      reasonCode: z.string()
    }).parse(request.body);
    return serializeBigInt(services.deductDeposit(getAdminActor(request), agentId, body));
  });

  app.post("/api/admin/products", async (request) => {
    const body = z.object({
      name: z.string(),
      supplyPriceCents: bigintString,
      minSalePriceCents: bigintString,
      suggestedSalePriceCents: bigintString
    }).parse(request.body);
    return serializeBigInt(services.createPlatformProduct(getAdminActor(request), body));
  });

  app.get("/api/admin/rights-codes", async (request) => {
    const query = z.object({ productId: z.string().optional() }).parse(request.query);
    return serializeBigInt(services.listRightsCodes(getAdminActor(request), query.productId));
  });

  app.post("/api/admin/rights-codes/import", async (request) => {
    const body = z.object({
      productId: z.string(),
      codes: z.array(z.string()),
      batchNo: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.addRightsCodes(getAdminActor(request), body));
  });

  app.post("/api/admin/agent-products/reviews/:ownProductId/review", async (request) => {
    const { ownProductId } = z.object({ ownProductId: z.string() }).parse(request.params);
    const body = z.object({ approved: z.boolean(), reason: z.string().optional() }).parse(request.body);
    return serializeBigInt(services.reviewOwnProduct(getAdminActor(request), ownProductId, body));
  });

  app.get("/api/admin/orders", async (request) => serializeBigInt(services.listAdminOrders(getAdminActor(request))));

  app.post("/api/admin/fulfillment/:orderNo", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = z.object({
      status: z.enum(["success", "failed"]),
      attemptNo: z.number().int().positive().default(1),
      evidence: z.string().optional(),
      failReason: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.fulfillOrder(getAdminActor(request), orderNo, body));
  });

  app.post("/api/admin/refunds/allocate", async (request) => {
    try {
      const actor = getAdminActor(request);
      return serializeBigInt(services.allocateRefundForAdmin(actor, refundAllocationSchema().parse(request.body)));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "REFUND_ALLOCATION_FAILED", error instanceof Error ? error.message : "refund allocation failed");
    }
  });

  app.post("/api/admin/after-sales/:afterSaleNo/refunds", async (request) => {
    const { afterSaleNo } = z.object({ afterSaleNo: z.string() }).parse(request.params);
    const body = refundAllocationSchema().pick({
      refundAmountCents: true,
      responsibility: true,
      platformBearCents: true,
      agentBearCents: true,
      serviceFeeBearer: true
    }).parse(request.body);
    return serializeBigInt(services.approveRefund(getAdminActor(request), afterSaleNo, body));
  });

  app.post("/api/admin/settlements/candidate", async (request) => {
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

  app.post("/api/admin/settlements/generate", async (request) => {
    const body = z.object({ agentId: z.string(), now: z.string().optional(), batchNo: z.string().default("default") }).parse(request.body);
    const result = services.generateSettlement(getAdminActor(request), {
      ...body,
      now: body.now ? new Date(body.now) : undefined
    });
    return serializeBigInt(result.status === "processed" ? result.sheet : { ...result.sheet, status: result.status });
  });

  app.post("/api/admin/settlements/:settlementNo/payouts", async (request) => {
    const { settlementNo } = z.object({ settlementNo: z.string() }).parse(request.params);
    const body = z.object({ payoutMethod: z.string().optional(), voucherUrl: z.string().optional() }).parse(request.body);
    return serializeBigInt(services.confirmManualPayout(getAdminActor(request), settlementNo, {
      voucherUrl: body.voucherUrl ?? "manual-voucher",
      payoutMethod: body.payoutMethod
    }));
  });

  app.post("/api/admin/risk-freezes", async (request) => {
    const body = z.object({
      targetType: z.enum(["order", "shop", "agent", "product", "settlement"]),
      targetId: z.string(),
      freezeType: z.enum(["order_frozen", "shop_frozen", "settlement_restricted", "product_removed", "disabled"]),
      reasonCode: z.string()
    }).parse(request.body);
    return services.createRiskFreeze(getAdminActor(request), body);
  });

  app.get("/api/admin/audit-logs", async (request) => serializeBigInt(services.listAuditLogs(getAdminActor(request))));
  app.get("/api/admin/risk-dashboard", async (request) => serializeBigInt(services.adminRiskDashboard(getAdminActor(request))));
  app.get("/api/admin/payment-onboarding-guide", async (request) => {
    getAdminActor(request);
    return services.paymentOnboardingGuide();
  });

  app.post("/api/callbacks/payments/mock", async (request) => {
    const body = z.object({ channel: z.string().default("mock"), channelTradeNo: z.string(), orderNo: z.string(), amountCents: bigintString }).parse(request.body);
    return serializeBigInt(services.paymentCallback(body));
  });

  app.post("/api/callbacks/refunds/mock", async (request) => {
    const body = z.object({ channel: z.string().default("mock"), channelRefundNo: z.string(), refundNo: z.string() }).parse(request.body);
    return serializeBigInt(services.refundCallback(body));
  });

  app.get("/api/exports/reconciliation-summary", async (request) => serializeBigInt(services.reconciliationSummary(getAdminActor(request))));

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
    agentBearCents: bigintString.optional(),
    serviceFeeBearer: z.enum(["platform", "agent", "mixed", "none"]).optional()
  });
}

function getUserActor(request: FastifyRequest): UserActor {
  return { role: "user", userId: requiredHeader(request, "x-user-id") };
}

function getAgentActor(request: FastifyRequest): AgentActor {
  return {
    role: "agent",
    agentId: requiredHeader(request, "x-agent-id"),
    shopId: requiredHeader(request, "x-shop-id")
  };
}

function getAdminActor(request: FastifyRequest): AdminActor {
  return {
    role: adminRole.parse(requiredHeader(request, "x-admin-role")),
    adminId: requiredHeader(request, "x-admin-id")
  } as AdminActor;
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(401, "AUTH_REQUIRED", `missing ${name} header`);
  }
  return value;
}

function serializeBigInt(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (
    typeof nested === "bigint" ? nested.toString() : nested
  )));
}

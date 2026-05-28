import cors from "@fastify/cors";
import Fastify, { type FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isSettlementCandidate } from "../../../packages/core/src/index.js";
import {
  ApiError,
  type AdminActor,
  type AgentActor,
  type UserActor,
  createBackendServices
} from "./services.js";

const bigintString = z.union([z.string(), z.number(), z.bigint()]).transform((value) => BigInt(value));
const adminRole = z.enum(["operator", "finance", "admin"]);
const paymentChannel = z.enum(["wechat_miniprogram", "wechat_h5_jsapi", "wechat_h5", "alipay_wap", "mock"]);
const collectionChannelType = z.enum([
  "alipay_personal_qr",
  "alipay_merchant_qr",
  "alipay_merchant_link",
  "wechat_personal_qr",
  "wechat_merchant_qr",
  "wechat_merchant_link"
]);
const emailSchema = z.string().email().max(160);
const extractionCodeSchema = z.string().regex(/^\d{4,12}$/).max(12);
const agentTierSchema = z.enum(["first_tier", "second_tier", "third_tier"]);
const productDetailSectionSchema = z.object({
  title: z.string().min(1).max(60),
  items: z.array(z.string().min(1).max(240)).max(12)
});

export function buildApp() {
  const app = Fastify({ logger: false });
  const services = createBackendServices();

  app.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message });
    }
    if (error.message.startsWith("missing admin permission")) {
      return reply.status(403).send({ code: "FORBIDDEN_ADMIN_PERMISSION", message: error.message });
    }
    if (error.message.includes("agent cannot access another") || error.message === "actor is not an agent") {
      return reply.status(403).send({ code: "FORBIDDEN_AGENT_SCOPE", message: error.message });
    }
    return reply.status(500).send({ code: "INTERNAL_ERROR", message: error.message });
  });
  app.register(cors, { origin: true });

  app.get("/health", async () => services.health());
  app.get("/api/health", async () => services.health());

  app.post("/api/auth/h5/guest", async () => {
    const userId = `h5-guest-${cryptoRandomId()}`;
    return createAuthSession({ userId, identityType: "h5_guest", displayName: "游客用户" });
  });

  app.post("/api/auth/h5/register", async (request) => {
    const body = z.object({
      phone: z.string().min(6).max(30),
      displayName: z.string().min(1).max(40).optional()
    }).parse(request.body);
    const normalizedPhone = body.phone.replace(/[^\d+]/g, "");
    const userId = `h5-phone-${normalizedPhone}`;
    const session = createAuthSession({
      userId,
      identityType: "h5_phone",
      displayName: body.displayName ?? `用户${normalizedPhone.slice(-4)}`,
      phone: normalizedPhone
    });
    const grantedCoupon = await services.grantRegistrationCoupon(userId);
    return serializeBigInt({
      ...session,
      grantedCoupon
    });
  });

  app.get("/api/auth/me", async (request) => {
    const actor = getUserActor(request);
    return { user: { userId: actor.userId } };
  });

  app.post("/api/auth/admin/login", async (request) => {
    const body = z.object({
      username: z.string().min(1).max(80),
      password: z.string().min(1).max(200)
    }).parse(request.body);
    return createAdminAuthSession(await services.loginAdmin(body));
  });

  app.post("/api/auth/agent/login", async (request) => {
    const body = z.object({
      account: z.string().min(1).max(120),
      password: z.string().min(1).max(200)
    }).parse(request.body);
    return createAgentAuthSession(await services.loginAgent(body));
  });

  app.get("/api/auth/agent/session", async (request) => {
    const actor = getAgentActor(request);
    const shop = await services.getAgentShop(actor);
    return {
      agent: {
        agentId: actor.agentId
      },
      shop: {
        shopId: actor.shopId,
        name: shop.name,
        status: shop.status
      }
    };
  });

  app.get("/api/auth/admin/session", async (request) => {
    const actor = getAdminActor(request);
    return {
      admin: {
        adminId: actor.adminId,
        adminRole: actor.role
      }
    };
  });

  const wechatMiniProgramLogin = async (request: FastifyRequest) => {
    if (isProductionRuntime()) {
      throw new ApiError(410, "MINIPROGRAM_LOGIN_DISABLED", "WeChat mini-program login is not a P0 production entry");
    }
    const body = z.object({
      code: z.string().min(1),
      nickname: z.string().max(40).optional()
    }).parse(request.body);
    const userId = `wx-mini-${body.code.slice(0, 16)}`;
    return createAuthSession({
      userId,
      identityType: "wechat_miniprogram",
      displayName: body.nickname ?? "微信用户"
    });
  };

  app.post("/api/auth/wechat-miniprogram/login", wechatMiniProgramLogin);
  app.post("/api/auth/wechat/miniprogram/login", wechatMiniProgramLogin);

  app.get("/api/user/shops/:shopId", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    return services.getPublicShop(shopId);
  });
  app.get("/api/h5/shops/:shopId", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    return services.getPublicShop(shopId);
  });

  app.get("/api/user/shops/:shopId/products", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    return serializeBigInt(services.listShopProducts(shopId));
  });
  app.get("/api/h5/shops/:shopId/products", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    return serializeBigInt(services.listShopProducts(shopId));
  });

  app.get("/api/user/shops/:shopId/collection-channels", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    return serializeBigInt(services.listPublicCollectionChannels(shopId));
  });
  app.get("/api/h5/shops/:shopId/collection-channels", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    return serializeBigInt(services.listPublicCollectionChannels(shopId));
  });

  app.get("/api/user/products/:agentProductId", async (request) => {
    const { agentProductId } = z.object({ agentProductId: z.string() }).parse(request.params);
    return serializeBigInt(services.getAgentProduct(agentProductId));
  });

  app.get("/api/user/coupons", async (request) => {
    const query = z.object({
      shopId: z.string().optional(),
      agentProductId: z.string().optional()
    }).parse(request.query);
    return serializeBigInt(services.listUserCoupons(getUserActor(request), query));
  });

  app.post("/api/user/orders/quote", async (request) => {
    const body = z.object({
      shopId: z.string(),
      agentProductId: z.string(),
      quantity: z.number().int().positive().optional(),
      couponId: z.string().optional()
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
      buyerEmail: emailSchema.optional(),
      extractionCode: extractionCodeSchema.optional(),
      couponId: z.string().optional(),
      collectionChannelId: z.string().optional(),
      clientPaidAmountCents: bigintString.optional()
    }).parse(request.body);
    try {
      return serializeBigInt(services.createOrder(getUserActor(request), body));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "ORDER_CREATE_FAILED", error instanceof Error ? error.message : "order create failed");
    }
  });

  app.post("/api/user/orders/:orderNo/payments", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = z.object({ channel: paymentChannel }).parse(request.body);
    return serializeBigInt(services.createPaymentIntent(getUserActor(request), orderNo, body));
  });

  app.post("/api/user/orders/:orderNo/payment-vouchers", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = z.object({
      channel: paymentChannel.optional(),
      payerName: z.string().optional(),
      voucherUrl: z.string().optional(),
      note: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.createPaymentVoucher(getUserActor(request), orderNo, body));
  });

  app.get("/api/user/orders", async (request) => {
    return serializeBigInt(services.listUserOrders(getUserActor(request)));
  });

  app.get("/api/user/orders/:orderNo", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    return serializeBigInt(services.getUserOrder(getUserActor(request), orderNo));
  });

  app.post("/api/user/orders/:orderNo/extract", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = z.object({ extractionCode: extractionCodeSchema }).parse(request.body);
    return serializeBigInt(services.extractOrderCodes(getUserActor(request), orderNo, body.extractionCode));
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
      customerServiceWechat: z.string(),
      inviteCode: z.string().optional()
    }).parse(request.body);
    return services.submitAgentApplication(getAgentActor(request), body);
  });

  app.post("/api/agent/register-by-invite", async (request) => {
    const body = z.object({
      inviteCode: z.string().min(1).max(80),
      name: z.string().min(1).max(80),
      contactPhone: z.string().max(40).optional(),
      customerServiceWechat: z.string().max(80).optional(),
      shopName: z.string().max(80).optional()
    }).parse(request.body);
    return serializeBigInt(services.registerAgentByInvite(body));
  });

  app.get("/api/agent/invite-codes", async (request) => serializeBigInt(services.listInviteCodes(getAgentActor(request))));
  app.post("/api/agent/invite-codes", async (request) => {
    const body = z.object({
      code: z.string().min(1).max(80).optional(),
      maxUses: z.number().int().positive().optional(),
      expiresAt: z.string().datetime().optional(),
      depositRequiredAmountCents: bigintString.optional()
    }).parse(request.body);
    return serializeBigInt(services.createAgentInviteCode(getAgentActor(request), body));
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

  app.patch("/api/agent/shop/collection", async (request) => {
    const body = z.object({
      collectionAccountName: z.string().optional(),
      collectionQrUrl: z.string().optional(),
      collectionNote: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.updateAgentShopCollection(getAgentActor(request), body));
  });

  app.get("/api/agent/collection-channels", async (request) => serializeBigInt(services.listAgentCollectionChannels(getAgentActor(request))));
  app.post("/api/agent/collection-channels", async (request) => {
    const body = z.object({
      channelType: collectionChannelType,
      displayName: z.string().min(1).max(80),
      accountName: z.string().max(120).optional(),
      qrUrl: z.string().url().optional(),
      paymentUrl: z.string().url().optional(),
      isDefault: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      dailyLimitCents: bigintString.optional(),
      singleOrderLimitCents: bigintString.optional()
    }).parse(request.body);
    return serializeBigInt(services.submitAgentCollectionChannel(getAgentActor(request), body));
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
      name: z.string().trim().min(1),
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

  app.post("/api/agent/channels/offers", async (request) => {
    const body = z.object({
      downstreamAgentId: z.string(),
      platformProductId: z.string(),
      resellSupplyPriceCents: bigintString,
      status: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.upsertAgentChannelProductOffer(getAgentActor(request), body));
  });

  app.get("/api/agent/orders", async (request) => serializeBigInt(services.listAgentOrders(getAgentActor(request))));
  app.get("/api/agent/orders/:orderNo", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    return serializeBigInt(services.getAgentOrder(getAgentActor(request), orderNo));
  });
  app.post("/api/agent/orders/:orderNo/confirm-payment", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = z.object({
      amountCents: bigintString,
      voucherUrl: z.string().optional(),
      note: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.confirmAgentOfflinePayment(getAgentActor(request), orderNo, body));
  });
  app.post("/api/agent/orders/:orderNo/fulfillment", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = z.object({
      status: z.enum(["success", "failed"]),
      attemptNo: z.number().int().positive().default(1),
      evidence: z.string().optional(),
      failReason: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.fulfillAgentOrder(getAgentActor(request), orderNo, body));
  });
  app.get("/api/agent/after-sales", async (request) => serializeBigInt(services.listAgentAfterSales(getAgentActor(request))));
  app.post("/api/agent/after-sales/:afterSaleNo/assist", async (request) => {
    const { afterSaleNo } = z.object({ afterSaleNo: z.string() }).parse(request.params);
    const body = z.object({
      note: z.string().min(1).max(500),
      evidenceUrl: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.updateAgentAfterSaleAssist(getAgentActor(request), afterSaleNo, body));
  });
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
  app.get("/api/admin/agent-applications", async (request) => serializeBigInt(services.listAgentApplications(getAdminActor(request))));
  app.post("/api/admin/agents/manual", async (request) => {
    const body = z.object({
      name: z.string().min(1),
      targetTier: agentTierSchema.optional(),
      contactPhone: z.string().optional(),
      shopName: z.string().optional(),
      customerServiceWechat: z.string().optional(),
      initialPassword: z.string().optional(),
      depositRequiredAmountCents: bigintString.optional(),
      depositPaid: z.boolean().optional(),
      depositAmountCents: bigintString.optional()
    }).parse(request.body);
    return serializeBigInt(services.createAgentByAdmin(getAdminActor(request), body));
  });

  app.get("/api/admin/invite-codes", async (request) => serializeBigInt(services.listInviteCodes(getAdminActor(request))));
  app.post("/api/admin/invite-codes", async (request) => {
    const body = z.object({
      code: z.string().min(1).max(80).optional(),
      targetTier: agentTierSchema.optional(),
      maxUses: z.number().int().positive().optional(),
      expiresAt: z.string().datetime().optional(),
      depositRequiredAmountCents: bigintString.optional()
    }).parse(request.body);
    return serializeBigInt(services.createPlatformInviteCode(getAdminActor(request), body));
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
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
      subtitle: z.string().optional(),
      description: z.string().optional(),
      usageGuide: z.string().optional(),
      imageUrl: z.string().optional(),
      specs: z.array(z.string().min(1).max(60)).max(12).optional(),
      detailSections: z.array(productDetailSectionSchema).max(8).optional(),
      stockCount: z.number().int().nonnegative().optional(),
      soldCount: z.number().int().nonnegative().optional(),
      supplyPriceCents: bigintString,
      minSalePriceCents: bigintString,
      suggestedSalePriceCents: bigintString,
      fulfillmentMode: z.enum(["manual", "code_pool"]).optional()
    }).parse(request.body);
    return serializeBigInt(services.createPlatformProduct(getAdminActor(request), {
      ...body,
      fulfillmentRule: { mode: body.fulfillmentMode ?? "manual" }
    }));
  });
  app.get("/api/admin/products", async (request) => serializeBigInt(services.listAdminPlatformProducts(getAdminActor(request))));
  app.patch("/api/admin/products/:productId", async (request) => {
    const { productId } = z.object({ productId: z.string() }).parse(request.params);
    const body = z.object({
      name: z.string().optional(),
      supplyPriceCents: bigintString.optional(),
      minSalePriceCents: bigintString.optional(),
      suggestedSalePriceCents: bigintString.optional(),
      status: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.updatePlatformProduct(getAdminActor(request), productId, body));
  });
  app.get("/api/admin/platform-shop-products", async (request) => serializeBigInt(services.listAdminPlatformShopProducts(getAdminActor(request))));
  app.post("/api/admin/platform-shop-products", async (request) => {
    const body = z.object({
      shopId: z.string(),
      platformProductId: z.string(),
      salePriceCents: bigintString,
      fulfillmentCostCents: bigintString.optional(),
      status: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.upsertPlatformShopProduct(getAdminActor(request), body));
  });

  app.get("/api/admin/coupons", async (request) => serializeBigInt(services.listAdminCoupons(getAdminActor(request))));
  app.post("/api/admin/coupons", async (request) => {
    const body = z.object({
      name: z.string().min(1).max(80),
      discountCents: bigintString,
      productIds: z.array(z.string()).optional(),
      validDays: z.number().int().positive().optional(),
      grantOnFirstRegister: z.boolean().optional(),
      status: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.createCouponTemplate(getAdminActor(request), body));
  });
  app.patch("/api/admin/coupons/:couponId/status", async (request) => {
    const { couponId } = z.object({ couponId: z.string() }).parse(request.params);
    const body = z.object({ status: z.string() }).parse(request.body);
    return serializeBigInt(services.updateCouponTemplateStatus(getAdminActor(request), couponId, body));
  });

  app.get("/api/admin/rights-codes", async (request) => {
    const query = z.object({
      productId: z.string().optional(),
      orderNo: z.string().optional(),
      shopId: z.string().optional(),
      status: z.enum(["available", "issued", "voided"]).optional()
    }).parse(request.query);
    return serializeBigInt(services.listRightsCodes(getAdminActor(request), query));
  });

  app.get("/api/admin/rights-codes/plaintext", async (request) => {
    const query = z.object({
      productId: z.string().optional(),
      orderNo: z.string().optional(),
      shopId: z.string().optional(),
      status: z.enum(["available", "issued", "voided"]).optional()
    }).parse(request.query);
    return serializeBigInt(services.revealRightsCodesPlaintext(getAdminActor(request), query));
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
  app.post("/api/admin/orders/:orderNo/offline-payment", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = z.object({
      amountCents: bigintString,
      voucherUrl: z.string().optional(),
      note: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.confirmOfflinePayment(getAdminActor(request), orderNo, body));
  });
  app.get("/api/admin/after-sales", async (request) => serializeBigInt(services.listAdminAfterSales(getAdminActor(request))));
  app.get("/api/admin/refunds", async (request) => serializeBigInt(services.listAdminRefunds(getAdminActor(request))));
  app.get("/api/admin/settlements", async (request) => serializeBigInt(services.listAdminSettlements(getAdminActor(request))));
  app.get("/api/admin/deposits", async (request) => serializeBigInt(services.listAdminDeposits(getAdminActor(request))));
  app.get("/api/admin/channels", async (request) => serializeBigInt(services.listAdminChannels(getAdminActor(request))));
  app.post("/api/admin/channels/:agentId/review", async (request) => {
    const { agentId } = z.object({ agentId: z.string() }).parse(request.params);
    const body = z.object({ approved: z.boolean(), reason: z.string().optional() }).parse(request.body);
    return serializeBigInt(services.reviewChannelAuthorization(getAdminActor(request), agentId, body));
  });
  app.post("/api/admin/channels/relations", async (request) => {
    const body = z.object({
      firstTierAgentId: z.string(),
      secondTierAgentId: z.string(),
      thirdTierAgentId: z.string().optional(),
      reason: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.createChannelRelation(getAdminActor(request), body));
  });
  app.post("/api/admin/channels/offers", async (request) => {
    const body = z.object({
      channelRelationId: z.string(),
      platformProductId: z.string(),
      resellSupplyPriceCents: bigintString,
      status: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.upsertChannelProductOffer(getAdminActor(request), body));
  });

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

  app.post("/api/admin/refunds/:refundNo/manual-confirm", async (request) => {
    const { refundNo } = z.object({ refundNo: z.string() }).parse(request.params);
    const body = z.object({
      channelRefundNo: z.string().optional(),
      voucherUrl: z.string().optional(),
      note: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.confirmManualRefund(getAdminActor(request), refundNo, body));
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
  app.get("/api/admin/risk-freezes", async (request) => serializeBigInt(services.listRiskFreezes(getAdminActor(request))));
  app.post("/api/admin/risk-freezes/:freezeId/release", async (request) => {
    const { freezeId } = z.object({ freezeId: z.string() }).parse(request.params);
    return serializeBigInt(services.releaseRiskFreeze(getAdminActor(request), freezeId));
  });

  app.get("/api/admin/audit-logs", async (request) => serializeBigInt(services.listAuditLogs(getAdminActor(request))));
  app.get("/api/admin/ledger-entries", async (request) => serializeBigInt(services.listLedgerEntries(getAdminActor(request))));
  app.get("/api/admin/sales-dashboard", async (request) => serializeBigInt(services.adminSalesDashboard(getAdminActor(request))));
  app.get("/api/admin/risk-dashboard", async (request) => serializeBigInt(services.adminRiskDashboard(getAdminActor(request))));
  app.get("/api/admin/service-qrcodes", async (request) => serializeBigInt(services.listServiceQrCodes(getAdminActor(request))));
  app.get("/api/admin/collection-channels", async (request) => serializeBigInt(services.listCollectionChannels(getAdminActor(request))));
  app.post("/api/admin/collection-channels/:channelId/review", async (request) => {
    const { channelId } = z.object({ channelId: z.string() }).parse(request.params);
    const body = z.object({ approved: z.boolean(), reason: z.string().optional() }).parse(request.body);
    return serializeBigInt(services.reviewCollectionChannel(getAdminActor(request), channelId, body));
  });
  app.patch("/api/admin/shops/:shopId/collection", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    const body = z.object({
      collectionAccountName: z.string().optional(),
      collectionQrUrl: z.string().optional(),
      collectionNote: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.updateShopCollection(getAdminActor(request), shopId, body));
  });
  app.patch("/api/admin/shops/:shopId/service-qrcode", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    const body = z.object({
      customerServiceWechat: z.string().optional(),
      customerServiceQrUrl: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.updateShopServiceQrCode(getAdminActor(request), shopId, body));
  });
  app.get("/api/admin/payment-config/status", async (request) => serializeBigInt(services.paymentConfigStatus(getAdminActor(request))));
  app.patch("/api/admin/payment-config/metadata", async (request) => {
    const body = z.object({
      channel: paymentChannel,
      enabled: z.boolean().optional(),
      feeBps: z.number().int().nonnegative().optional(),
      fixedFeeCents: bigintString.optional(),
      statusNote: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.updatePaymentConfigMetadata(getAdminActor(request), body));
  });
  app.post("/api/admin/payment-config/check", async (request) => serializeBigInt(services.checkPaymentConfig(getAdminActor(request))));
  app.get("/api/admin/payment-onboarding-guide", async (request) => {
    getAdminActor(request);
    return services.paymentOnboardingGuide();
  });

  app.get("/api/admin/payment-vouchers", async (request) => serializeBigInt(services.listPaymentVouchers(getAdminActor(request))));
  app.post("/api/admin/payment-vouchers/:voucherId/review", async (request) => {
    const { voucherId } = z.object({ voucherId: z.string() }).parse(request.params);
    const body = z.object({ approved: z.boolean(), reason: z.string().optional() }).parse(request.body);
    return serializeBigInt(services.confirmPaymentVoucher(getAdminActor(request), voucherId, body));
  });

  app.get("/api/admin/order-extract-logs", async (request) => serializeBigInt(services.listExtractLogs(getAdminActor(request))));

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
  if (hasBearerToken(request)) return parseSignedActor(request, "user");
  if (!allowDemoAuth()) return parseSignedActor(request, "user");
  return { role: "user", userId: requiredHeader(request, "x-user-id") };
}

function getAgentActor(request: FastifyRequest): AgentActor {
  if (hasBearerToken(request)) return parseSignedActor(request, "agent");
  if (!allowDemoAuth()) return parseSignedActor(request, "agent");
  return {
    role: "agent",
    agentId: requiredHeader(request, "x-agent-id"),
    shopId: requiredHeader(request, "x-shop-id")
  };
}

function getAdminActor(request: FastifyRequest): AdminActor {
  if (hasBearerToken(request)) return parseSignedActor(request, "admin");
  if (!allowDemoAuth()) return parseSignedActor(request, "admin");
  return {
    role: adminRole.parse(requiredHeader(request, "x-admin-role")),
    adminId: requiredHeader(request, "x-admin-id")
  } as AdminActor;
}

function createAuthSession(input: {
  userId: string;
  identityType: "h5_guest" | "h5_phone" | "wechat_miniprogram";
  displayName: string;
  phone?: string;
}) {
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  const token = signToken({
    role: "user",
    userId: input.userId,
    identityType: input.identityType,
    exp: expiresAt
  });
  return {
    token,
    expiresAt,
    user: {
      userId: input.userId,
      identityType: input.identityType,
      displayName: input.displayName,
      phone: input.phone
    }
  };
}

function createAdminAuthSession(input: {
  adminId: string;
  username: string;
  role: "operator" | "finance" | "admin";
  displayName: string;
}) {
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 12;
  const token = signToken({
    role: "admin",
    adminId: input.adminId,
    adminRole: input.role,
    exp: expiresAt
  });
  return {
    token,
    expiresAt,
    admin: {
      adminId: input.adminId,
      username: input.username,
      adminRole: input.role,
      displayName: input.displayName
    }
  };
}

function createAgentAuthSession(input: {
  agentId: string;
  shopId: string;
  username: string;
  displayName: string;
  tier?: string;
  status: string;
  depositStatus: string;
  shopName: string;
  shopStatus: string;
  mustChangePassword: boolean;
}) {
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 12;
  const token = signToken({
    role: "agent",
    agentId: input.agentId,
    shopId: input.shopId,
    exp: expiresAt
  });
  return {
    token,
    expiresAt,
    agent: {
      agentId: input.agentId,
      username: input.username,
      displayName: input.displayName,
      tier: input.tier,
      status: input.status,
      depositStatus: input.depositStatus,
      mustChangePassword: input.mustChangePassword
    },
    shop: {
      shopId: input.shopId,
      name: input.shopName,
      status: input.shopStatus
    }
  };
}

function signToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", authTokenSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function hasBearerToken(request: FastifyRequest): boolean {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ");
}

function allowDemoAuth(): boolean {
  if (isProductionRuntime()) return false;
  const configured = process.env.ALLOW_DEMO_AUTH ?? process.env.DEMO_AUTH_ENABLED;
  if (configured !== undefined) return configured === "true";
  return true;
}

function isProductionRuntime(): boolean {
  return process.env.APP_ENV === "production"
    || process.env.NODE_ENV === "production"
    || process.env.VERCEL_ENV === "production";
}

function parseSignedActor<T extends UserActor | AgentActor | AdminActor>(
  request: FastifyRequest,
  expectedRole: T["role"]
): T {
  const secret = authTokenSecret();
  const authorization = request.headers.authorization;
  const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (!token) throw new ApiError(401, "AUTH_REQUIRED", "missing bearer token");
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) throw new ApiError(401, "AUTH_INVALID", "invalid bearer token");
  const expected = createHmac("sha256", secret).update(payloadPart).digest("base64url");
  if (!safeEqual(expected, signaturePart)) throw new ApiError(401, "AUTH_INVALID", "invalid bearer token signature");
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
  if (payload.role !== expectedRole) throw new ApiError(403, "AUTH_ROLE_MISMATCH", "token role does not match route");
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new ApiError(401, "AUTH_EXPIRED", "bearer token expired");
  }
  if (expectedRole === "user" && typeof payload.userId === "string") return { role: "user", userId: payload.userId } as T;
  if (expectedRole === "agent" && typeof payload.agentId === "string" && typeof payload.shopId === "string") {
    return { role: "agent", agentId: payload.agentId, shopId: payload.shopId } as T;
  }
  if (expectedRole === "admin" && typeof payload.adminId === "string") {
    return {
      role: adminRole.parse(payload.adminRole ?? payload.roleCode ?? "operator"),
      adminId: payload.adminId
    } as T;
  }
  throw new ApiError(401, "AUTH_INVALID", "token is missing required actor fields");
}

function authTokenSecret(): string {
  const secret = process.env.AUTH_TOKEN_SECRET;
  if (secret) return secret;
  if (isProductionRuntime()) {
    throw new ApiError(503, "AUTH_NOT_CONFIGURED", "AUTH_TOKEN_SECRET is required in production");
  }
  return "tosell-dev-auth-secret";
}

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requiredHeader(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(401, "AUTH_REQUIRED", `missing ${name} header`);
  }
  return value;
}

function serializeBigInt(value: unknown): unknown {
  if (value && typeof (value as PromiseLike<unknown>).then === "function") {
    return Promise.resolve(value).then((resolved) => serializeBigInt(resolved));
  }
  return JSON.parse(JSON.stringify(value, (_key, nested) => (
    typeof nested === "bigint" ? nested.toString() : nested
  )));
}

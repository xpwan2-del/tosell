import cors from "@fastify/cors";
import Fastify, { type FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { z } from "zod";
import { assertAdminPermission, isSettlementCandidate } from "../../../packages/core/src/index.js";
import {
  ApiError,
  type AdminActor,
  type MerchantActor,
  type UserActor,
  createBackendServices
} from "./services.js";

const bigintString = z.union([z.string(), z.number(), z.bigint()]).transform((value) => BigInt(value));
const adminRole = z.enum(["operator", "finance", "admin"]);
const paymentChannel = z.enum(["wechat_miniprogram", "wechat_h5_jsapi", "wechat_h5", "alipay_wap", "epay", "balance", "mock"]);
const paymentProvider = z.enum(["alipay_merchant", "wechat_merchant", "epay", "personal_alipay", "wechat_personal", "balance"]);
const paymentMethodBodySchema = z.object({
  id: z.string().optional(),
  provider: paymentProvider,
  displayName: z.string().min(1).max(80),
  productType: z.string().optional(),
  merchantNo: z.string().optional(),
  appId: z.string().optional(),
  serviceProviderId: z.string().optional(),
  gatewayUrl: z.string().url().optional(),
  apiMode: z.enum(["mapi_first", "submit", "hupijiao_direct"]).optional(),
  accountName: z.string().optional(),
  qrUrl: z.string().min(1).max(900_000).refine((value) => /^https?:\/\//.test(value) || /^data:image\/(png|jpeg|webp);base64,/.test(value), "qrUrl must be an image upload or http url").optional(),
  paymentUrl: z.string().url().optional(),
  note: z.string().optional(),
  returnUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
  status: z.enum(["pending_test", "enabled", "disabled", "paused"]).optional(),
  isDefault: z.boolean().optional(),
  signingSecret: z.string().optional(),
  privateKey: z.string().optional(),
  publicKey: z.string().optional(),
  certificate: z.string().optional()
});
const paymentResultBodySchema = z.object({
  orderNo: z.string().optional(),
  providerTradeNo: z.string(),
  amountCents: bigintString,
  merchantNo: z.string().optional(),
  appId: z.string().optional(),
  serviceProviderId: z.string().optional(),
  tradeStatus: z.string(),
  signature: z.string(),
  rawPayload: z.unknown().optional()
});
const emailSchema = z.string().email().max(160);
const extractionCodeSchema = z.string().regex(/^\d{4,12}$/).max(12);
const purchasePasswordSchema = z.string().trim().min(4).max(32);
const mainlandPhoneSchema = z.string().regex(/^1[3-9]\d{9}$/);
const merchantTierSchema = z.enum(["first_tier", "second_tier", "third_tier"]);
const fulfillmentModeSchema = z.enum(["manual", "code_pool"]);
const credentialTypeSchema = z.enum(["code", "account_password"]);
const productImageUploadSchema = z.object({
  filename: z.string().min(1).max(180).optional(),
  contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  dataBase64: z.string().min(1).max(1_700_000)
});
const productDetailSectionSchema = z.object({
  title: z.string().min(1).max(60),
  items: z.array(z.string().min(1).max(240)).max(12)
});
const productDetailUpdateSchema = z.object({
  name: z.string().trim().min(1).optional(),
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
  fulfillmentMode: fulfillmentModeSchema.optional(),
  credentialType: credentialTypeSchema.optional(),
  manualFulfillmentInstruction: z.string().max(1000).optional(),
  afterSaleRule: z.unknown().optional(),
  status: z.string().optional()
});
const merchantProductListingDisplayOverrideSchema = z.object({
  displayName: z.string().trim().max(120).optional(),
  displaySubtitle: z.string().max(240).optional(),
  displayDescription: z.string().max(4000).optional(),
  displayUsageGuide: z.string().max(4000).optional(),
  displayImageUrl: z.string().max(8000).optional(),
  displayCategory: z.string().max(80).optional(),
  displayTags: z.array(z.string().min(1).max(40)).max(12).optional(),
  displaySpecs: z.array(z.string().min(1).max(60)).max(12).optional(),
  displayDetailSections: z.array(productDetailSectionSchema).max(8).optional()
});

export function buildApp() {
  const app = Fastify({ logger: false, bodyLimit: 2_500_000 });
  const services = createBackendServices();
  const productImageDir = resolve(process.cwd(), "apps/api/uploads/product-images");

  app.setErrorHandler((error: Error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ code: error.code, message: error.message });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        code: "VALIDATION_FAILED",
        message: "request validation failed",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
    }
    if (error.message.startsWith("missing admin permission")) {
      return reply.status(403).send({ code: "FORBIDDEN_ADMIN_PERMISSION", message: error.message });
    }
    if (error.message.includes("merchant cannot access another") || error.message === "actor is not a merchant") {
      return reply.status(403).send({ code: "FORBIDDEN_MERCHANT_SCOPE", message: error.message });
    }
    if (error.message.includes("Can't reach database server") || error.message.includes("ECONNREFUSED") || error.message.includes("Connection refused")) {
      return reply.status(503).send({ code: "DATABASE_UNAVAILABLE", message: "configured PostgreSQL database is unavailable" });
    }
    return reply.status(500).send({ code: "INTERNAL_ERROR", message: error.message });
  });
  app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"]
  });
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    const params = new URLSearchParams(String(body));
    done(null, Object.fromEntries(params.entries()));
  });

  app.get("/health", async () => services.health());
  app.get("/api/health", async () => services.health());
  app.get("/uploads/product-images/:filename", async (request, reply) => {
    const { filename } = z.object({ filename: z.string().regex(/^[a-zA-Z0-9._-]+$/) }).parse(request.params);
    const contentType = productImageContentType(filename);
    if (!contentType) throw new ApiError(404, "PRODUCT_IMAGE_NOT_FOUND", "product image not found");
    try {
      const bytes = await readFile(join(productImageDir, filename));
      return reply.type(contentType).send(bytes);
    } catch {
      throw new ApiError(404, "PRODUCT_IMAGE_NOT_FOUND", "product image not found");
    }
  });

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

  app.post("/api/auth/merchant/login", async (request) => {
    const body = z.object({
      account: z.string().min(1).max(120),
      password: z.string().min(1).max(200)
    }).parse(request.body);
    return createMerchantAuthSession(await services.loginMerchant(body));
  });

  app.get("/api/auth/merchant/session", async (request) => {
    const actor = getMerchantActor(request);
    const shop = await services.getMerchantShop(actor);
    return {
      merchant: {
        merchantId: actorMerchantId(actor)
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

  const wechatMiniProgramLogin = async () => {
    throw new ApiError(410, "MINIPROGRAM_LOGIN_DISABLED", "微信小程序登录已不作为 P0 交付入口，请使用 H5 注册/登录。");
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

  app.get("/api/user/shops/:shopId/payment-methods", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    return serializeBigInt(services.listPublicPaymentMethods(shopId));
  });
  app.get("/api/h5/shops/:shopId/payment-methods", async (request) => {
    const { shopId } = z.object({ shopId: z.string() }).parse(request.params);
    return serializeBigInt(services.listPublicPaymentMethods(shopId));
  });

  app.get("/api/user/products/:merchantProductListingId", async (request) => {
    const { merchantProductListingId } = z.object({ merchantProductListingId: z.string() }).parse(request.params);
    return serializeBigInt(services.getMerchantProduct(merchantProductListingId));
  });

  app.get("/api/user/coupons", async (request) => {
    const query = z.object({
      shopId: z.string().optional(),
      merchantProductListingId: z.string().optional()
    }).parse(request.query);
    return serializeBigInt(services.listUserCoupons(getUserActor(request), {
      shopId: query.shopId,
      ...internalProductRef(query.merchantProductListingId)
    } as Parameters<typeof services.listUserCoupons>[1]));
  });

  app.post("/api/user/orders/quote", async (request) => {
    const body = z.object({
      shopId: z.string(),
      merchantProductListingId: z.string().optional(),
      quantity: z.number().int().positive().optional(),
      couponId: z.string().optional()
    }).parse(request.body);
    const listingId = body.merchantProductListingId;
    if (!listingId) throw new ApiError(400, "PRODUCT_REQUIRED", "product required");
    try {
      return serializeBigInt(services.quoteOrder(getUserActor(request), {
        shopId: body.shopId,
        ...internalProductRef(listingId),
        quantity: body.quantity,
        couponId: body.couponId
      } as Parameters<typeof services.quoteOrder>[1]));
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
      merchantProductListingId: z.string().optional(),
      quantity: z.number().int().positive().optional(),
      buyerEmail: emailSchema.optional(),
      buyerPhone: mainlandPhoneSchema.optional(),
      extractionCode: extractionCodeSchema.optional(),
      purchasePassword: purchasePasswordSchema.optional(),
      couponId: z.string().optional(),
      paymentMethodId: z.string().optional(),
      clientPaidAmountCents: bigintString.optional()
    }).parse(request.body);
    const listingId = body.merchantProductListingId;
    if (!listingId) throw new ApiError(400, "PRODUCT_REQUIRED", "product required");
    try {
      return serializeBigInt(services.createOrder(getUserActor(request), {
        ...body,
        ...internalProductRef(listingId),
        paymentMethodId: body.paymentMethodId,
        extractionCode: body.purchasePassword ?? body.extractionCode
      } as Parameters<typeof services.createOrder>[1]));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "ORDER_CREATE_FAILED", error instanceof Error ? error.message : "order create failed");
    }
  });

  app.post("/api/user/orders/:orderNo/payments", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = z.object({ channel: paymentChannel.optional(), paymentMethodId: z.string().optional() }).parse(request.body);
    if (body.paymentMethodId) return serializeBigInt(await services.createPaymentOrder(getUserActor(request), orderNo, { paymentMethodId: body.paymentMethodId }));
    if (!body.channel) return serializeBigInt(await services.createPaymentOrder(getUserActor(request), orderNo, {}));
    return serializeBigInt(services.createPaymentIntent(getUserActor(request), orderNo, { channel: body.channel ?? "alipay_wap" }));
  });
  app.get("/api/user/wallet", async (request) => serializeBigInt(services.getUserWallet(getUserActor(request))));
  app.post("/api/user/wallet/recharges", async (request) => {
    const body = z.object({
      amountCents: bigintString,
      paymentMethodId: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.createWalletRecharge(getUserActor(request), body));
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
    const body = z.object({
      extractionCode: extractionCodeSchema.optional(),
      purchasePassword: purchasePasswordSchema.optional()
    }).parse(request.body);
    return serializeBigInt(services.extractOrderCodes(getUserActor(request), orderNo, body.purchasePassword ?? body.extractionCode ?? ""));
  });

  app.post("/api/user/extractions/:token", async (request) => {
    const { token } = z.object({ token: z.string().min(20) }).parse(request.params);
    const body = z.object({
      extractionCode: extractionCodeSchema.optional(),
      purchasePassword: purchasePasswordSchema.optional()
    }).parse(request.body);
    return serializeBigInt(services.extractOrderCodesByToken(getUserActor(request), token, body.purchasePassword ?? body.extractionCode ?? ""));
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

  app.post("/api/merchant/applications", async (request) => {
    const body = z.object({
      contactPhone: z.string(),
      customerServiceWechat: z.string(),
      inviteCode: z.string().optional()
    }).parse(request.body);
    return services.submitMerchantApplication(getMerchantActor(request), body);
  });

  app.post("/api/merchant/register-by-invite", async (request) => {
    const body = z.object({
      inviteCode: z.string().min(1).max(80),
      name: z.string().min(1).max(80),
      contactPhone: z.string().max(40).optional(),
      customerServiceWechat: z.string().max(80).optional(),
      shopName: z.string().max(80).optional()
    }).parse(request.body);
    return serializeBigInt(services.registerMerchantByInvite(body));
  });

  app.get("/api/merchant/invite-codes", async (request) => serializeBigInt(services.listInviteCodes(getMerchantActor(request))));
  app.post("/api/merchant/invite-codes", async (request) => {
    const body = z.object({
      code: z.string().min(1).max(80).optional(),
      maxUses: z.number().int().positive().optional(),
      expiresAt: z.string().datetime().optional(),
      depositRequiredAmountCents: bigintString.optional()
    }).parse(request.body);
    return serializeBigInt(services.createMerchantInviteCode(getMerchantActor(request), body));
  });

  app.get("/api/merchant/shop", async (request) => services.getMerchantShop(getMerchantActor(request)));

  app.get("/api/merchant/dashboard", async (request) => serializeBigInt(services.merchantDashboard(getMerchantActor(request))));

  app.patch("/api/merchant/shop", async (request) => {
    const body = z.object({
      name: z.string().optional(),
      announcement: z.string().optional(),
      customerServiceWechat: z.string().optional(),
      customerServiceQrUrl: z.string().optional(),
      customerServiceQq: z.string().optional(),
      customerServiceQqQrUrl: z.string().optional(),
      customerServiceNote: z.string().optional()
    }).parse(request.body);
    return services.updateMerchantShop(getMerchantActor(request), body);
  });

  app.patch("/api/merchant/shop/collection", async (request) => {
    const body = z.object({
      collectionAccountName: z.string().optional(),
      collectionQrUrl: z.string().optional(),
      collectionNote: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.updateMerchantShopCollection(getMerchantActor(request), body));
  });

  app.patch("/api/merchant/shop/decor", async (request) => {
    const body = z.object({
      themeColor: z.string().optional(),
      bannerUrl: z.string().optional(),
      shareTitle: z.string().optional(),
      productGroups: z.array(z.object({
        name: z.string(),
        merchantProductListingIds: z.array(z.string()).optional()
      })).optional()
    }).parse(request.body);
    return serializeBigInt(services.updateShopDecor(getMerchantActor(request), {
      ...body,
      productGroups: body.productGroups?.map((group) => ({
        name: group.name,
        ...internalProductGroupRef(group.merchantProductListingIds ?? [])
      }))
    } as Parameters<typeof services.updateShopDecor>[1]));
  });

  app.get("/api/merchant/products/platform", async (request) => serializeBigInt(services.listPlatformProducts(getMerchantActor(request))));
  app.get("/api/merchant/products", async (request) => serializeBigInt(services.listMerchantProducts(getMerchantActor(request))));
  app.get("/api/merchant/products/own", async (request) => serializeBigInt(services.listOwnProductReviews(getMerchantActor(request))));
  app.get("/api/merchant/products/own/:ownProductId", async (request) => {
    const { ownProductId } = z.object({ ownProductId: z.string() }).parse(request.params);
    return serializeBigInt(services.getOwnProductDetail(getMerchantActor(request), ownProductId));
  });

  app.post("/api/merchant/products/own", async (request) => {
    const body = z.object({
      name: z.string().trim().min(1),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
      subtitle: z.string().optional(),
      description: z.string().optional(),
      usageGuide: z.string().optional(),
      imageUrl: z.string().optional(),
      specs: z.array(z.string().min(1).max(60)).max(12).optional(),
      detailSections: z.array(productDetailSectionSchema).max(8).optional(),
      salePriceCents: bigintString,
      minSalePriceCents: bigintString.optional(),
      fulfillmentMode: fulfillmentModeSchema.optional(),
      credentialType: credentialTypeSchema.optional(),
      manualFulfillmentInstruction: z.string().max(1000).optional()
    }).parse(request.body);
    return serializeBigInt(services.submitOwnProduct(getMerchantActor(request), {
      ...body,
      fulfillmentRule: {
        mode: body.fulfillmentMode ?? "manual",
        ...(body.fulfillmentMode === "code_pool" ? { extractCodeRequired: true, credentialType: body.credentialType ?? "code" } : {}),
        ...(body.manualFulfillmentInstruction ? { manualFulfillmentInstruction: body.manualFulfillmentInstruction } : {})
      }
    }));
  });
  app.patch("/api/merchant/products/own/:ownProductId", async (request) => {
    const { ownProductId } = z.object({ ownProductId: z.string() }).parse(request.params);
    const body = productDetailUpdateSchema.extend({
      salePriceCents: bigintString.optional(),
      minSalePriceCents: bigintString.optional()
    }).parse(request.body);
    const { fulfillmentMode, credentialType, manualFulfillmentInstruction, ...rest } = body;
    return serializeBigInt(services.updateOwnProductDetail(getMerchantActor(request), ownProductId, {
      ...rest,
      fulfillmentRule: fulfillmentMode || manualFulfillmentInstruction
        ? {
            mode: fulfillmentMode ?? "manual",
            ...(fulfillmentMode === "code_pool" ? { extractCodeRequired: true, credentialType: credentialType ?? "code" } : {}),
            ...(manualFulfillmentInstruction ? { manualFulfillmentInstruction } : {})
          }
        : undefined
    }));
  });

  app.get("/api/merchant/rights-codes", async (request) => {
    const query = z.object({
      merchantProductListingId: z.string().optional(),
      status: z.enum(["available", "locked", "issued", "voided"]).optional()
    }).parse(request.query);
    return serializeBigInt(services.listMerchantRightsCodes(getMerchantActor(request), {
      ...internalProductRef(query.merchantProductListingId),
      status: query.status
    } as Parameters<typeof services.listMerchantRightsCodes>[1]));
  });

  app.post("/api/merchant/rights-codes/import", async (request) => {
    const body = z.object({
      merchantProductListingId: z.string().optional(),
      codes: z.array(z.string()),
      batchNo: z.string().optional(),
      credentialType: credentialTypeSchema.optional()
    }).parse(request.body);
    const listingId = body.merchantProductListingId;
    if (!listingId) throw new ApiError(400, "PRODUCT_REQUIRED", "product required");
    return serializeBigInt(services.addMerchantRightsCodes(getMerchantActor(request), {
      ...internalProductRef(listingId),
      codes: body.codes,
      batchNo: body.batchNo,
      credentialType: body.credentialType
    } as Parameters<typeof services.addMerchantRightsCodes>[1]));
  });
  app.post("/api/merchant/rights-codes/precheck", async (request) => {
    const body = z.object({
      merchantProductListingId: z.string().optional(),
      codes: z.array(z.string()),
      credentialType: credentialTypeSchema.optional()
    }).parse(request.body);
    const listingId = body.merchantProductListingId;
    if (!listingId) throw new ApiError(400, "PRODUCT_REQUIRED", "product required");
    return serializeBigInt(services.precheckMerchantRightsCodes(getMerchantActor(request), {
      ...internalProductRef(listingId),
      codes: body.codes,
      credentialType: body.credentialType
    } as Parameters<typeof services.precheckMerchantRightsCodes>[1]));
  });

  app.post("/api/merchant/products/platform", async (request) => {
    const body = merchantProductListingDisplayOverrideSchema.extend({ platformProductId: z.string(), salePriceCents: bigintString }).parse(request.body);
    return serializeBigInt(services.selectPlatformProduct(getMerchantActor(request), body));
  });
  app.get("/api/merchant/products/:merchantProductListingId", async (request) => {
    const { merchantProductListingId } = z.object({ merchantProductListingId: z.string() }).parse(request.params);
    return serializeBigInt(services.getMerchantProductDetail(getMerchantActor(request), merchantProductListingId));
  });
  app.patch("/api/merchant/products/:merchantProductListingId", async (request) => {
    const { merchantProductListingId } = z.object({ merchantProductListingId: z.string() }).parse(request.params);
    const body = merchantProductListingDisplayOverrideSchema.extend({
      salePriceCents: bigintString.optional(),
      status: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.updateMerchantProductDetail(getMerchantActor(request), merchantProductListingId, body));
  });

  app.post("/api/merchant/products/platform/batch", async (request) => {
    const body = z.object({
      items: z.array(merchantProductListingDisplayOverrideSchema.extend({ platformProductId: z.string(), salePriceCents: bigintString }))
    }).parse(request.body);
    return serializeBigInt(services.batchSelectPlatformProducts(getMerchantActor(request), body));
  });

  app.patch("/api/merchant/products/:merchantProductListingId/price", async (request) => {
    const { merchantProductListingId } = z.object({ merchantProductListingId: z.string() }).parse(request.params);
    const body = z.object({ salePriceCents: bigintString }).parse(request.body);
    return serializeBigInt(services.setMerchantProductPrice(getMerchantActor(request), merchantProductListingId, body.salePriceCents));
  });

  app.post("/api/merchant/supply/offers", async (request) => {
    const body = z.object({
      downstreamMerchantId: z.string(),
      platformProductId: z.string(),
      resellSupplyPriceCents: bigintString,
      status: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.upsertMerchantChannelProductOffer(getMerchantActor(request), body));
  });

  app.get("/api/merchant/orders", async (request) => serializeBigInt(services.listMerchantOrders(getMerchantActor(request))));
  app.get("/api/merchant/payment-vouchers", async (request) => serializeBigInt(services.listMerchantPaymentVouchers(getMerchantActor(request))));
  app.get("/api/merchant/payment-methods", async (request) => serializeBigInt(services.listMerchantPaymentMethods(getMerchantActor(request))));
  app.post("/api/merchant/payment-methods", async (request) => {
    const body = paymentMethodBodySchema.parse(request.body);
    return serializeBigInt(services.upsertMerchantPaymentMethod(getMerchantActor(request), body));
  });
  app.patch("/api/merchant/payment-methods/:methodId", async (request) => {
    const { methodId } = z.object({ methodId: z.string() }).parse(request.params);
    const body = paymentMethodBodySchema.partial().parse(request.body);
    return serializeBigInt(services.upsertMerchantPaymentMethod(getMerchantActor(request), { ...body, id: methodId }));
  });
  app.delete("/api/merchant/payment-methods/:methodId", async (request) => {
    const { methodId } = z.object({ methodId: z.string() }).parse(request.params);
    return serializeBigInt(services.deleteMerchantPaymentMethod(getMerchantActor(request), methodId));
  });
  app.post("/api/merchant/payment-methods/:methodId/default", async (request) => {
    const { methodId } = z.object({ methodId: z.string() }).parse(request.params);
    return serializeBigInt(services.setMerchantPaymentMethodDefault(getMerchantActor(request), methodId));
  });
  app.post("/api/merchant/payment-methods/:methodId/test", async (request) => {
    const { methodId } = z.object({ methodId: z.string() }).parse(request.params);
    return serializeBigInt(services.testMerchantPaymentMethod(getMerchantActor(request), methodId));
  });
  app.get("/api/merchant/orders/:orderNo", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    return serializeBigInt(services.getMerchantOrder(getMerchantActor(request), orderNo));
  });
  app.post("/api/merchant/orders/:orderNo/confirm-payment", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = z.object({
      amountCents: bigintString,
      voucherUrl: z.string().optional(),
      note: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.confirmMerchantOfflinePayment(getMerchantActor(request), orderNo, body));
  });
  app.post("/api/merchant/orders/:orderNo/fulfillment", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = z.object({
      status: z.enum(["success", "failed"]),
      attemptNo: z.number().int().positive().default(1),
      evidence: z.string().optional(),
      failReason: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.fulfillMerchantOrder(getMerchantActor(request), orderNo, body));
  });
  app.get("/api/merchant/after-sales", async (request) => serializeBigInt(services.listMerchantAfterSales(getMerchantActor(request))));
  app.post("/api/merchant/after-sales/:afterSaleNo/assist", async (request) => {
    const { afterSaleNo } = z.object({ afterSaleNo: z.string() }).parse(request.params);
    const body = z.object({
      note: z.string().min(1).max(500),
      evidenceUrl: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.updateMerchantAfterSaleAssist(getMerchantActor(request), afterSaleNo, body));
  });
  app.get("/api/merchant/settlements", async (request) => serializeBigInt(services.listMerchantSettlements(getMerchantActor(request))));
  app.get("/api/merchant/clawbacks", async (request) => serializeBigInt(services.listMerchantClawbacks(getMerchantActor(request))));
  app.get("/api/merchant/deposit-transactions", async (request) => serializeBigInt(services.listMerchantDepositTransactions(getMerchantActor(request))));
  app.get("/api/merchant/notifications", async (request) => serializeBigInt(services.listNotifications(getMerchantActor(request))));

  app.post("/api/merchant/notifications/:notificationId/read", async (request) => {
    const { notificationId } = z.object({ notificationId: z.string() }).parse(request.params);
    return serializeBigInt(services.markNotificationRead(getMerchantActor(request), notificationId));
  });

  app.post("/api/merchant/scope-check", async (request) => {
    const body = z.object({ resourceMerchantId: z.string(), resourceShopId: z.string().optional() }).parse(request.body);
    const actor = getMerchantActor(request);
    if (actorMerchantId(actor) !== body.resourceMerchantId || (body.resourceShopId && actor.shopId !== body.resourceShopId)) {
      throw new ApiError(403, "FORBIDDEN_MERCHANT_SCOPE", "merchant cannot access another merchant resource");
    }
    return { ok: true };
  });

  app.post("/api/admin/merchants/:merchantId/review", async (request) => {
    const { merchantId } = z.object({ merchantId: z.string() }).parse(request.params);
    const body = z.object({ approved: z.boolean(), reason: z.string().optional() }).parse(request.body);
    return services.reviewMerchant(getAdminActor(request), merchantId, body);
  });
  app.get("/api/admin/merchant-applications", async (request) => serializeBigInt(services.listMerchantApplications(getAdminActor(request))));
  app.post("/api/admin/merchants/manual", async (request) => {
    const body = z.object({
      name: z.string().min(1),
      targetTier: merchantTierSchema.optional(),
      contactPhone: z.string().optional(),
      shopName: z.string().optional(),
      customerServiceWechat: z.string().optional(),
      initialPassword: z.string().optional(),
      depositRequiredAmountCents: bigintString.optional(),
      depositPaid: z.boolean().optional(),
      depositAmountCents: bigintString.optional()
    }).parse(request.body);
    return serializeBigInt(services.createMerchantByAdmin(getAdminActor(request), body));
  });

  app.get("/api/admin/invite-codes", async (request) => serializeBigInt(services.listInviteCodes(getAdminActor(request))));
  app.post("/api/admin/invite-codes", async (request) => {
    const body = z.object({
      code: z.string().min(1).max(80).optional(),
      targetTier: merchantTierSchema.optional(),
      maxUses: z.number().int().positive().optional(),
      expiresAt: z.string().datetime().optional(),
      depositRequiredAmountCents: bigintString.optional()
    }).parse(request.body);
    return serializeBigInt(services.createPlatformInviteCode(getAdminActor(request), body));
  });

  app.post("/api/admin/deposits/:merchantId/confirm", async (request) => {
    const { merchantId } = z.object({ merchantId: z.string() }).parse(request.params);
    const body = z.object({ amountCents: bigintString, requiredAmountCents: bigintString.optional(), voucherUrl: z.string().optional() }).parse(request.body);
    return serializeBigInt(services.confirmDeposit(getAdminActor(request), merchantId, body));
  });

  app.post("/api/admin/deposits/:merchantId/deduct", async (request) => {
    const { merchantId } = z.object({ merchantId: z.string() }).parse(request.params);
    const body = z.object({
      amountCents: bigintString,
      sourceType: z.string(),
      sourceId: z.string(),
      reasonCode: z.string()
    }).parse(request.body);
    return serializeBigInt(services.deductDeposit(getAdminActor(request), merchantId, body));
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
      fulfillmentMode: fulfillmentModeSchema.optional(),
      credentialType: credentialTypeSchema.optional(),
      manualFulfillmentInstruction: z.string().max(1000).optional()
    }).parse(request.body);
    return serializeBigInt(services.createPlatformProduct(getAdminActor(request), {
      ...body,
      fulfillmentRule: {
        mode: body.fulfillmentMode ?? "manual",
        ...(body.fulfillmentMode === "code_pool" ? { extractCodeRequired: true, credentialType: body.credentialType ?? "code" } : {}),
        ...(body.fulfillmentMode === "manual" && body.manualFulfillmentInstruction ? { manualFulfillmentInstruction: body.manualFulfillmentInstruction } : {})
      }
    }));
  });
  app.get("/api/admin/products", async (request) => serializeBigInt(services.listAdminPlatformProducts(getAdminActor(request))));
  app.get("/api/admin/products/:productId", async (request) => {
    const { productId } = z.object({ productId: z.string() }).parse(request.params);
    return serializeBigInt(services.getAdminPlatformProductDetail(getAdminActor(request), productId));
  });
  app.post("/api/admin/product-images", async (request) => {
    assertAdminPermission(getAdminActor(request), "product.manage");
    const body = productImageUploadSchema.parse(request.body);
    const bytes = Buffer.from(body.dataBase64, "base64");
    if (!bytes.length || bytes.length > 1_200_000) {
      throw new ApiError(400, "PRODUCT_IMAGE_TOO_LARGE", "product image must be 1.2MB or smaller");
    }
    const extension = productImageExtension(body.contentType);
    const stem = (body.filename ?? "product-image")
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "product-image";
    const filename = `${stem}-${cryptoRandomId()}.${extension}`;
    await mkdir(productImageDir, { recursive: true });
    await writeFile(join(productImageDir, filename), bytes);
    return {
      imageUrl: `/uploads/product-images/${filename}`,
      contentType: body.contentType,
      byteLength: bytes.length
    };
  });
  app.patch("/api/admin/products/:productId", async (request) => {
    const { productId } = z.object({ productId: z.string() }).parse(request.params);
    const body = productDetailUpdateSchema.extend({
      supplyPriceCents: bigintString.optional(),
      minSalePriceCents: bigintString.optional(),
      suggestedSalePriceCents: bigintString.optional()
    }).parse(request.body);
    const { fulfillmentMode, credentialType, manualFulfillmentInstruction, ...rest } = body;
    return serializeBigInt(services.updatePlatformProduct(getAdminActor(request), productId, {
      ...rest,
      fulfillmentRule: fulfillmentMode || manualFulfillmentInstruction
        ? {
            mode: fulfillmentMode ?? "manual",
            ...(fulfillmentMode === "code_pool" ? { extractCodeRequired: true, credentialType: credentialType ?? "code" } : {}),
            ...(manualFulfillmentInstruction ? { manualFulfillmentInstruction } : {})
          }
        : undefined
    }));
  });
  app.get("/api/admin/platform-shop-products", async (request) => serializeBigInt(services.listAdminPlatformShopProducts(getAdminActor(request))));
  app.get("/api/admin/platform-shop-products/:shopProductId", async (request) => {
    const { shopProductId } = z.object({ shopProductId: z.string() }).parse(request.params);
    return serializeBigInt(services.getAdminPlatformShopProductDetail(getAdminActor(request), shopProductId));
  });
  app.patch("/api/admin/platform-shop-products/:shopProductId", async (request) => {
    const { shopProductId } = z.object({ shopProductId: z.string() }).parse(request.params);
    const body = z.object({
      salePriceCents: bigintString.optional(),
      fulfillmentCostCents: bigintString.optional(),
      status: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.updatePlatformShopProductDetail(getAdminActor(request), shopProductId, body));
  });
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
  app.post("/api/admin/coupons/:couponId/grants", async (request) => {
    const { couponId } = z.object({ couponId: z.string() }).parse(request.params);
    const body = z.object({
      target: z.enum(["all_users", "single_user"]),
      userId: z.string().optional(),
      phone: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.grantCouponTemplate(getAdminActor(request), couponId, body));
  });

  app.get("/api/admin/rights-codes", async (request) => {
    const query = z.object({
      productId: z.string().optional(),
      orderNo: z.string().optional(),
      shopId: z.string().optional(),
      status: z.enum(["available", "locked", "issued", "voided"]).optional()
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

  app.get("/api/admin/email-deliveries", async (request) => {
    return serializeBigInt(services.listEmailDeliveries(getAdminActor(request)));
  });
  app.post("/api/admin/orders/:orderNo/email-deliveries", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    return serializeBigInt(services.resendOrderEmailDelivery(getAdminActor(request), orderNo));
  });

  app.post("/api/admin/rights-codes/import", async (request) => {
    const body = z.object({
      productId: z.string(),
      codes: z.array(z.string()),
      batchNo: z.string().optional(),
      credentialType: credentialTypeSchema.optional()
    }).parse(request.body);
    return serializeBigInt(services.addRightsCodes(getAdminActor(request), body));
  });
  app.post("/api/admin/rights-codes/precheck", async (request) => {
    const body = z.object({
      productId: z.string(),
      codes: z.array(z.string()),
      credentialType: credentialTypeSchema.optional()
    }).parse(request.body);
    return serializeBigInt(services.precheckRightsCodes(getAdminActor(request), body));
  });

  app.get("/api/admin/merchant-products/reviews", async (request) => {
    const query = z.object({
      reviewStatus: z.string().optional(),
      status: z.string().optional(),
      merchantId: z.string().optional(),
      shopId: z.string().optional(),
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().max(100).optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
      offset: z.coerce.number().int().nonnegative().optional()
    }).parse(request.query);
    return serializeBigInt(services.listAdminOwnProductReviews(getAdminActor(request), query));
  });
  app.get("/api/admin/merchant-products/reviews/:ownProductId", async (request) => {
    const { ownProductId } = z.object({ ownProductId: z.string() }).parse(request.params);
    return serializeBigInt(services.getAdminOwnProductReviewDetail(getAdminActor(request), ownProductId));
  });

  app.post("/api/admin/merchant-products/reviews/:ownProductId/review", async (request) => {
    const { ownProductId } = z.object({ ownProductId: z.string() }).parse(request.params);
    const body = z.object({ approved: z.boolean(), reason: z.string().optional() }).parse(request.body);
    return serializeBigInt(services.reviewOwnProduct(getAdminActor(request), ownProductId, body));
  });

  app.get("/api/admin/orders", async (request) => {
    const query = z.object({
      page: z.coerce.number().int().positive().optional(),
      pageSize: z.coerce.number().int().positive().max(100).optional(),
      status: z.string().optional(),
      shopId: z.string().optional(),
      orderNo: z.string().optional()
    }).parse(request.query);
    return serializeBigInt(services.listAdminOrders(getAdminActor(request), query));
  });
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
  app.get("/api/admin/merchant-supply", async (request) => serializeBigInt(services.listAdminChannels(getAdminActor(request))));
  app.post("/api/admin/merchant-supply/:merchantId/review", async (request) => {
    const { merchantId } = z.object({ merchantId: z.string() }).parse(request.params);
    const body = z.object({ approved: z.boolean(), reason: z.string().optional() }).parse(request.body);
    return serializeBigInt(services.reviewChannelAuthorization(getAdminActor(request), merchantId, body));
  });
  app.post("/api/admin/merchant-supply/relations", async (request) => {
    const body = z.object({
      firstTierMerchantId: z.string(),
      secondTierMerchantId: z.string(),
      thirdTierMerchantId: z.string().optional(),
      reason: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.createChannelRelation(getAdminActor(request), {
      firstTierMerchantId: body.firstTierMerchantId,
      secondTierMerchantId: body.secondTierMerchantId,
      thirdTierMerchantId: body.thirdTierMerchantId,
      reason: body.reason
    }));
  });
  app.post("/api/admin/merchant-supply/offers", async (request) => {
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
      return serializeBigInt(services.allocateRefundForAdmin(actor, mapRefundAllocation(refundAllocationSchema().parse(normalizeRefundRequest(request.body))) as never));
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
      merchantBearCents: true,
      serviceFeeBearer: true
    }).parse(normalizeRefundRequest(request.body));
    return serializeBigInt(services.approveRefund(getAdminActor(request), afterSaleNo, mapRefundAllocation(body) as never));
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
    const body = z.object({ merchantId: z.string(), now: z.string().optional(), batchNo: z.string().default("default") }).parse(request.body);
    const result = await services.generateSettlement(getAdminActor(request), {
      ...internalMerchantRef(body.merchantId),
      batchNo: body.batchNo,
      now: body.now ? new Date(body.now) : undefined
    } as Parameters<typeof services.generateSettlement>[1]);
    return serializeBigInt(result.status === "processed" ? result.sheet : { ...result.sheet, status: result.status });
  });

  app.post("/api/admin/settlements/:settlementNo/payouts", async (request) => {
    const { settlementNo } = z.object({ settlementNo: z.string() }).parse(request.params);
    const body = z.object({ payoutMethod: z.string().optional(), voucherUrl: z.string().optional() }).parse(request.body);
    return serializeBigInt(await services.confirmManualPayout(getAdminActor(request), settlementNo, {
      voucherUrl: body.voucherUrl ?? "manual-voucher",
      payoutMethod: body.payoutMethod
    }));
  });

  app.post("/api/admin/risk-freezes", async (request) => {
    const body = z.object({
      targetType: z.enum(["order", "shop", "merchant", "product", "settlement"]),
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
      customerServiceQrUrl: z.string().optional(),
      customerServiceQq: z.string().optional(),
      customerServiceQqQrUrl: z.string().optional(),
      customerServiceNote: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.updateShopServiceQrCode(getAdminActor(request), shopId, body));
  });
  app.get("/api/admin/payment-config/status", async (request) => serializeBigInt(services.paymentConfigStatus(getAdminActor(request))));
  app.get("/api/admin/payment-methods", async (request) => serializeBigInt(services.listAdminPaymentMethods(getAdminActor(request))));
  app.post("/api/admin/payment-methods", async (request) => {
    const body = paymentMethodBodySchema.extend({
      merchantId: z.string().optional(),
      shopId: z.string().optional()
    }).parse(request.body);
    return serializeBigInt(services.upsertAdminPaymentMethod(getAdminActor(request), body));
  });
  app.patch("/api/admin/payment-methods/:methodId", async (request) => {
    const { methodId } = z.object({ methodId: z.string() }).parse(request.params);
    const body = paymentMethodBodySchema.partial().parse(request.body);
    return serializeBigInt(services.upsertAdminPaymentMethod(getAdminActor(request), { ...body, id: methodId }));
  });
  app.delete("/api/admin/payment-methods/:methodId", async (request) => {
    const { methodId } = z.object({ methodId: z.string() }).parse(request.params);
    return serializeBigInt(services.deleteAdminPaymentMethod(getAdminActor(request), methodId));
  });
  app.post("/api/admin/payment-methods/:methodId/default", async (request) => {
    const { methodId } = z.object({ methodId: z.string() }).parse(request.params);
    return serializeBigInt(services.setAdminPaymentMethodDefault(getAdminActor(request), methodId));
  });
  app.post("/api/admin/payment-methods/:methodId/test", async (request) => {
    const { methodId } = z.object({ methodId: z.string() }).parse(request.params);
    return serializeBigInt(services.testAdminPaymentMethod(getAdminActor(request), methodId));
  });
  app.get("/api/admin/payment-callbacks", async (request) => serializeBigInt(services.listPaymentCallbackLogs(getAdminActor(request))));
  app.get("/api/admin/payment-exceptions", async (request) => serializeBigInt(services.listPaymentExceptions(getAdminActor(request))));
  app.post("/api/admin/payment-exceptions/:exceptionId/handle", async (request) => {
    const { exceptionId } = z.object({ exceptionId: z.string() }).parse(request.params);
    const body = z.object({ action: z.enum(["mark_handled", "keep_exception"]), note: z.string().optional() }).parse(request.body);
    return serializeBigInt(services.handlePaymentException(getAdminActor(request), exceptionId, body));
  });
  app.post("/api/admin/orders/:orderNo/payment-query", async (request) => {
    const { orderNo } = z.object({ orderNo: z.string() }).parse(request.params);
    const body = paymentResultBodySchema.omit({ orderNo: true, rawPayload: true }).parse(request.body);
    return serializeBigInt(services.queryPaymentOrder(getAdminActor(request), orderNo, body));
  });
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
  app.get("/api/admin/platform-service-fee", async (request) => serializeBigInt(services.getPlatformServiceFeeConfig(getAdminActor(request))));
  app.patch("/api/admin/platform-service-fee", async (request) => {
    const body = z.object({
      enabled: z.boolean().optional(),
      feeBps: z.number().int().nonnegative().max(10_000).optional()
    }).parse(request.body);
    return serializeBigInt(services.updatePlatformServiceFeeConfig(getAdminActor(request), body));
  });
  app.get("/api/admin/wallets", async (request) => serializeBigInt(services.listWallets(getAdminActor(request))));
  app.get("/api/admin/wallet-transactions", async (request) => serializeBigInt(services.listWalletTransactions(getAdminActor(request))));
  app.get("/api/admin/wallet-recharges", async (request) => serializeBigInt(services.listWalletRecharges(getAdminActor(request))));
  app.post("/api/admin/wallet-recharges/:rechargeNo/confirm", async (request) => {
    const { rechargeNo } = z.object({ rechargeNo: z.string() }).parse(request.params);
    const body = z.object({ voucherUrl: z.string().optional(), note: z.string().optional() }).parse(request.body);
    return serializeBigInt(services.confirmWalletRecharge(getAdminActor(request), rechargeNo, body));
  });
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
  app.get("/api/callbacks/payments/epay", async (request) => {
    const result = await services.epayProviderCallback(recordPayload(request.query));
    return result.status === "processed" || result.status === "duplicate" ? "success" : serializeBigInt(result);
  });
  app.post("/api/callbacks/payments/:provider", async (request) => {
    const { provider } = z.object({ provider: paymentProvider }).parse(request.params);
    if (provider === "epay") {
      const result = await services.epayProviderCallback(recordPayload(request.body));
      return result.status === "processed" || result.status === "duplicate" ? "success" : serializeBigInt(result);
    }
    const body = paymentResultBodySchema.parse(request.body);
    return serializeBigInt(services.paymentProviderCallback(provider, body));
  });

  app.post("/api/callbacks/refunds/mock", async (request) => {
    const body = z.object({ channel: z.string().default("mock"), channelRefundNo: z.string(), refundNo: z.string() }).parse(request.body);
    return serializeBigInt(services.refundCallback(body));
  });

  app.get("/api/exports/reconciliation-summary", async (request) => serializeBigInt(services.exportReconciliationSummary(getAdminActor(request))));

  return app;
}

function refundAllocationSchema() {
  return z.object({
    paidAmountCents: bigintString,
    supplyAmountCents: bigintString,
    merchantIncomeCents: bigintString,
    alreadyRefundedCents: bigintString.optional(),
    refundAmountCents: bigintString,
    responsibility: z.enum(["platform", "merchant", "user", "mixed"]),
    platformBearCents: bigintString.optional(),
    merchantBearCents: bigintString.optional(),
    serviceFeeBearer: z.enum(["platform", "merchant", "mixed", "none"]).optional()
  });
}

function normalizeRefundRequest(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  return {
    ...record,
    merchantIncomeCents: record.merchantIncomeCents ?? record.merchantIncomeCents,
    merchantBearCents: record.merchantBearCents ?? record.merchantBearCents,
    responsibility: record.responsibility === "merchant" ? "merchant" : record.responsibility,
    serviceFeeBearer: record.serviceFeeBearer === "merchant" ? "merchant" : record.serviceFeeBearer
  };
}

function mapRefundAllocation<T extends {
  merchantIncomeCents?: bigint;
  merchantBearCents?: bigint;
  responsibility: "platform" | "merchant" | "user" | "mixed";
  serviceFeeBearer?: "platform" | "merchant" | "mixed" | "none";
}>(body: T) {
  return {
    ...body,
    merchantIncomeCents: body.merchantIncomeCents,
    responsibility: body.responsibility === "merchant" ? "merchant" as const : body.responsibility,
    merchantBearCents: body.merchantBearCents,
    serviceFeeBearer: body.serviceFeeBearer === "merchant" ? "merchant" as const : body.serviceFeeBearer
  };
}

function internalMerchantRef(merchantId: string) {
  return { merchantId };
}

function internalProductRef(merchantProductListingId: string | undefined) {
  return merchantProductListingId ? { merchantProductListingId } : {};
}

function internalProductGroupRef(merchantProductListingIds: string[]) {
  return { merchantProductListingIds };
}

function merchantActorFromMerchant(merchantId: string, shopId: string): MerchantActor {
  return { role: "merchant", ...internalMerchantRef(merchantId), shopId } as MerchantActor;
}

function actorMerchantId(actor: MerchantActor): string {
  return merchantIdFromRecord(actor);
}

function merchantIdFromRecord(input: object): string {
  const record = input as Record<string, unknown>;
  const merchantId = record.merchantId;
  if (typeof merchantId !== "string" || !merchantId) {
    throw new ApiError(401, "AUTH_INVALID", "merchant actor is missing required id");
  }
  return merchantId;
}

function getUserActor(request: FastifyRequest): UserActor {
  if (hasBearerToken(request)) return parseSignedActor(request, "user");
  if (!allowDemoAuth()) return parseSignedActor(request, "user");
  return { role: "user", userId: requiredHeader(request, "x-user-id") };
}

function getMerchantActor(request: FastifyRequest): MerchantActor {
  if (hasBearerToken(request)) return parseSignedActor(request, "merchant");
  if (!allowDemoAuth()) return parseSignedActor(request, "merchant");
  return merchantActorFromMerchant(requiredHeader(request, "x-merchant-id"), requiredHeader(request, "x-shop-id"));
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

function createMerchantAuthSession(input: {
  merchantId?: string;
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
  const merchantId = merchantIdFromRecord(input);
  const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60 * 12;
  const token = signToken({
    role: "merchant",
    merchantId,
    shopId: input.shopId,
    exp: expiresAt
  });
  return {
    token,
    expiresAt,
    merchant: {
      merchantId,
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

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

function parseSignedActor<T extends UserActor | MerchantActor | AdminActor>(
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
  if (expectedRole === "merchant" && typeof payload.merchantId === "string" && typeof payload.shopId === "string") {
    return merchantActorFromMerchant(payload.merchantId, payload.shopId) as unknown as T;
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

function productImageExtension(contentType: "image/jpeg" | "image/png" | "image/webp"): "jpg" | "png" | "webp" {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

function productImageContentType(filename: string): "image/jpeg" | "image/png" | "image/webp" | undefined {
  const extension = extname(filename).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return undefined;
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

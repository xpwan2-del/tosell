import {
  IdempotencyRegistry,
  MockPaymentProvider,
  type Actor,
  type RefundResponsibility,
  allocateRefund,
  applyClawback,
  applyFulfillmentAttempt,
  assertAdminPermission,
  assertAgentScope,
  buildOrderSnapshot,
  buildSettlementItems,
  calculateServiceFeeCents,
  deductDeposit,
  hasAdminPermission,
  processPaymentCallback,
  quoteAgentOwnedProduct,
  quotePlatformProduct,
  refundCallbackKey,
  shouldRestrictForDeposit
} from "../../../packages/core/src/index.js";
import {
  virtualCatalogProducts,
  virtualShopSeed
} from "../../../packages/database/src/virtual-catalog.js";
import {
  PrismaClient,
  createPrismaRepositories,
  type PrismaRepositoryRegistry,
  type PrismaTx
} from "../../../packages/database/src/index.js";
import { createHash, createHmac, randomUUID } from "node:crypto";

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export type UserActor = Extract<Actor, { role: "user" }>;
export type AgentActor = Extract<Actor, { role: "agent" }>;
export type AdminActor = Extract<Actor, { role: "operator" | "finance" | "admin" }>;

export function createBackendServices() {
  if (isProductionRuntime()) {
    if (!process.env.DATABASE_URL) {
      return createPersistenceDisabledServices("DATABASE_URL is required in production") as unknown as BackendServices;
    }
    return createPrismaProductionServices() as unknown as BackendServices;
  }
  if (process.env.PERSISTENCE_PROVIDER === "prisma") {
    if (!process.env.DATABASE_URL) {
      return createPersistenceDisabledServices("DATABASE_URL is required for Prisma persistence") as unknown as BackendServices;
    }
    return createPrismaProductionServices() as unknown as BackendServices;
  }
  if (process.env.ALLOW_MEMORY_STORE === "false") {
    return createPersistenceDisabledServices("memory store is disabled and Prisma persistence is not configured") as unknown as BackendServices;
  }
  return new BackendServices(createMemoryStore(), { persistenceMode: "memory" });
}

let productionPrisma: PrismaClient | undefined;

function prismaClient() {
  if (!process.env.DATABASE_URL) {
    throw new ApiError(503, "DATABASE_NOT_CONFIGURED", "DATABASE_URL is required in production");
  }
  productionPrisma ??= new PrismaClient();
  return productionPrisma;
}

function toPrismaApiError(error: unknown): Error {
  if (error instanceof ApiError) return error;
  if (isPrismaConnectionError(error)) {
    return new ApiError(503, "DATABASE_UNAVAILABLE", "configured PostgreSQL database is unavailable");
  }
  return error instanceof Error ? error : new Error("unknown persistence error");
}

function isPrismaConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "P1001"
    || (typeof candidate.message === "string" && candidate.message.includes("Can't reach database server"));
}

function createPrismaProductionServices() {
  const prisma = prismaClient();
  const repositories = createPrismaRepositories(prisma);
  const repository = new PrismaStateRepository(prisma, repositories);
  const service = new BackendServices(createEmptyMemoryStore(), {
    persistenceMode: "prisma",
    adminAuth: (input) => repository.verifyAdmin(input),
    agentAuth: (input) => repository.verifyAgent(input)
  });
  let hydrated = false;
  async function hydrate() {
    if (hydrated) return;
    try {
      service.store = await repository.load();
      service.store.sequence = Math.max(service.store.sequence, Date.now());
      hydrated = true;
    } catch (error) {
      throw toPrismaApiError(error);
    }
  }
  return new Proxy(service, {
    get(target, property) {
      if (property === "health") {
        return async () => ({
          ok: true,
          service: "tosell-api",
          runtime: runtimeMode(),
          persistenceMode: "prisma",
          databaseConfigured: Boolean(process.env.DATABASE_URL),
          repositories: Object.keys(repositories).filter((key) => key !== "tx"),
          demoAuthEnabled: allowDemoAuth(),
          mockPaymentEnabled: mockPaymentEnabled()
        });
      }
      const value = target[property as keyof typeof target];
      if (typeof value !== "function") return value;
      if (property === "loginAdmin") {
        return async (...args: unknown[]) => target.loginAdmin(...(args as Parameters<BackendServices["loginAdmin"]>));
      }
      if (property === "loginAgent") {
        return async (...args: unknown[]) => target.loginAgent(...(args as Parameters<BackendServices["loginAgent"]>));
      }
      if (property === "createOrder") {
        return async (...args: unknown[]) => {
          await hydrate();
          const result = target.createOrder(...(args as Parameters<BackendServices["createOrder"]>));
          try {
            await repository.saveForMethod("createOrder", service.store);
          } catch (error) {
            throw toPrismaApiError(error);
          }
          return result;
        };
      }
      return async (...args: unknown[]) => {
        await hydrate();
        let result: unknown;
        try {
          result = (value as (...methodArgs: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          if (property === "paymentProviderCallback" || property === "queryPaymentOrder") {
            try {
              await repository.saveForMethod(String(property), service.store);
            } catch (persistError) {
              throw toPrismaApiError(persistError);
            }
          }
          throw error;
        }
        if (isMutatingServiceMethod(String(property))) {
          try {
            await repository.saveForMethod(String(property), service.store);
          } catch (error) {
            throw toPrismaApiError(error);
          }
        }
        return result;
      };
    }
  });
}

function createPersistenceDisabledServices(message: string) {
  const disabled = () => {
    throw new ApiError(503, "PERSISTENCE_NOT_CONFIGURED", message);
  };
  return new Proxy({
    health: () => ({
      ok: false,
      service: "tosell-api",
      runtime: runtimeMode(),
      persistenceMode: "disabled",
      code: "PERSISTENCE_NOT_CONFIGURED"
    })
  }, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      return disabled;
    }
  });
}

function isMutatingServiceMethod(name: string) {
  return /^(add|approve|batchSelect|confirm|create|deduct|delete|export|fulfill|generate|grant|handle|mark|paymentCallback|paymentProviderCallback|queryPaymentOrder|refundCallback|register|release|reveal|review|select|set|submit|test|update|upsert)/.test(name);
}

type BackendServicesOptions = {
  persistenceMode: "memory" | "prisma";
  adminAuth?: (input: { username: string; password: string }) => Promise<AdminLoginResult>;
  agentAuth?: (input: { account: string; password: string }) => Promise<AgentLoginResult>;
};

export type AdminLoginResult = {
  adminId: string;
  username: string;
  displayName: string;
  role: "operator" | "finance" | "admin";
};

export type AgentLoginResult = {
  agentId: string;
  shopId: string;
  username: string;
  displayName: string;
  tier?: AgentTier;
  status: string;
  depositStatus: string;
  shopName: string;
  shopStatus: string;
  mustChangePassword: boolean;
};

class BackendServices {
  private readonly registry = new IdempotencyRegistry();
  private readonly paymentProvider = new MockPaymentProvider();

  constructor(public store: MemoryStore, private readonly options: BackendServicesOptions = { persistenceMode: "memory" }) {}

  health() {
    return {
      ok: true,
      service: "tosell-api",
      runtime: runtimeMode(),
      persistenceMode: this.options.persistenceMode,
      demoAuthEnabled: allowDemoAuth(),
      mockPaymentEnabled: mockPaymentEnabled()
    };
  }

  async loginAdmin(input: { username: string; password: string }): Promise<AdminLoginResult> {
    if (this.options.adminAuth) return this.options.adminAuth(input);
    const username = process.env.ADMIN_USERNAME ?? "admin";
    const password = process.env.ADMIN_PASSWORD ?? "admin";
    if (input.username !== username || input.password !== password) {
      throw new ApiError(401, "AUTH_INVALID", "invalid admin credentials");
    }
    return {
      adminId: process.env.ADMIN_ID ?? "admin-dev",
      username,
      displayName: process.env.ADMIN_DISPLAY_NAME ?? "开发管理员",
      role: (process.env.ADMIN_ROLE as AdminLoginResult["role"] | undefined) ?? "admin"
    };
  }

  async loginAgent(input: { account: string; password: string }): Promise<AgentLoginResult> {
    if (this.options.agentAuth) return this.options.agentAuth(input);
    const account = input.account.trim();
    const agent = requireEntity(
      [...this.store.agents.values()].find((candidate) =>
        candidate.merchantUsername === account || candidate.id === account || candidate.contactPhone === account
      ),
      "AUTH_INVALID",
      "invalid merchant credentials"
    );
    if (!agent.passwordHash || !verifyPassword(input.password, agent.passwordHash)) {
      throw new ApiError(401, "AUTH_INVALID", "invalid merchant credentials");
    }
    if (agent.status !== "active" && agent.status !== "pending_deposit") {
      throw new ApiError(403, "AUTH_DISABLED", "merchant account is not active");
    }
    const shop = requireEntity([...this.store.shops.values()].find((candidate) => candidate.agentId === agent.id), "AUTH_INVALID", "merchant shop not found");
    return {
      agentId: agent.id,
      shopId: shop.id,
      username: agent.merchantUsername ?? agent.id,
      displayName: agent.name,
      tier: agent.tier,
      status: agent.status,
      depositStatus: agent.depositStatus,
      shopName: shop.name,
      shopStatus: shop.status,
      mustChangePassword: true
    };
  }

  listInviteCodes(actor: AdminActor | AgentActor) {
    if (actor.role === "agent") {
      return [...this.store.inviteCodes.values()]
        .filter((code) => code.issuerAgentId === actor.agentId)
        .map((code) => this.serializeInviteCode(code, actor));
    }
    assertAdminPermission(actor, "agent.review");
    return [...this.store.inviteCodes.values()].map((code) => this.serializeInviteCode(code));
  }

  createPlatformInviteCode(actor: AdminActor, input: { code?: string; targetTier?: AgentTier; maxUses?: number; expiresAt?: string; depositRequiredAmountCents?: bigint }) {
    assertAdminPermission(actor, "agent.review");
    if (input.targetTier && input.targetTier !== "first_tier") {
      throw new ApiError(400, "PLATFORM_INVITE_FIRST_TIER_ONLY", "platform invite codes can only create first-tier merchants");
    }
    const invite = this.createInviteCode({
      code: input.code,
      issuerType: "platform",
      targetTier: "first_tier",
      maxUses: input.maxUses,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdBy: actor.adminId,
      depositRequiredAmountCents: input.depositRequiredAmountCents
    });
    this.audit(actor.role, "invite_code.create.platform", "invite_code", invite.id, invite);
    return this.serializeInviteCode(invite);
  }

  createAgentInviteCode(actor: AgentActor, input: { code?: string; maxUses?: number; expiresAt?: string; depositRequiredAmountCents?: bigint } = {}) {
    const agent = requireEntity(this.store.agents.get(actor.agentId), "RESOURCE_NOT_FOUND", "agent not found");
    const tier = this.agentTier(agent.id);
    if (tier === "third_tier") {
      this.audit("agent", "invite_code.create.rejected_fourth_tier", "agent", agent.id, { tier });
      throw new ApiError(400, "FOURTH_TIER_FORBIDDEN", "third-tier merchants cannot create fourth-tier invite codes");
    }
    this.assertAgentDepositConfirmed(agent.id, "create invite code");
    const invite = this.createInviteCode({
      code: input.code,
      issuerType: "agent",
      issuerAgentId: agent.id,
      targetTier: tier === "first_tier" ? "second_tier" : "third_tier",
      maxUses: input.maxUses,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdBy: agent.id,
      depositRequiredAmountCents: input.depositRequiredAmountCents ?? this.depositRequirementForAgentInvite(agent.id)
    });
    this.audit("agent", "invite_code.create.agent", "invite_code", invite.id, invite);
    return this.serializeInviteCode(invite, actor);
  }

  registerAgentByInvite(input: {
    inviteCode: string;
    name: string;
    contactPhone?: string;
    customerServiceWechat?: string;
    shopName?: string;
  }) {
    const invite = requireEntity(
      this.findInviteByCode(input.inviteCode),
      "INVITE_CODE_INVALID",
      "invite code not found"
    );
    this.assertInviteUsable(invite);
    if (invite.targetTier === "second_tier" || invite.targetTier === "third_tier") {
      requireEntity(invite.issuerAgentId ? this.store.agents.get(invite.issuerAgentId) : undefined, "INVITE_CODE_INVALID", "upstream merchant not found");
    }
    const agentId = nextId(this.store, "agent");
    const shopId = nextId(this.store, "shop");
    const userId = nextId(this.store, "agent-user");
    const initialPassword = `TS${Date.now().toString().slice(-6)}`;
    const agent: DemoAgent = {
      id: agentId,
      userId,
      name: input.name,
      contactPhone: input.contactPhone,
      tier: invite.targetTier,
      parentAgentId: invite.issuerAgentId,
      status: "pending_review",
      riskStatus: "normal",
      depositStatus: "pending_payment",
      initialPasswordSet: true,
      merchantUsername: agentId,
      passwordHash: `sha256:${hashSecret(initialPassword)}`
    };
    const shop: DemoShop = {
      id: shopId,
      agentId,
      ownerType: "agent",
      name: input.shopName ?? `${input.name} 小店`,
      status: "not_opened",
      riskStatus: "normal",
      customerServiceWechat: input.customerServiceWechat
    };
    const application: AgentApplication = {
      applicationNo: nextId(this.store, "agent-app"),
      agentId,
      userId,
      status: "pending_review",
      contactPhone: input.contactPhone ?? "",
      customerServiceWechat: input.customerServiceWechat ?? "",
      inviteCodeId: invite.id,
      targetTier: invite.targetTier,
      parentAgentId: invite.issuerAgentId
    };
    this.store.agents.set(agentId, agent);
    this.store.shops.set(shopId, shop);
    this.store.agentApplications.set(application.applicationNo, application);
    const requiredAmount = invite.depositRequiredAmountCents;
    if (requiredAmount === undefined || requiredAmount <= 0n) {
      throw new ApiError(400, "DEPOSIT_REQUIREMENT_MISSING", "invite code is missing deposit requirement");
    }
    this.store.depositAccounts.set(agentId, {
      agentId,
      requiredAmountCents: requiredAmount,
      availableAmountCents: 0n,
      frozenAmountCents: 0n,
      deductedAmountCents: 0n,
      status: "pending_payment"
    });
    this.createPendingRelationForInvite(invite, agentId);
    invite.usedCount += 1;
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) invite.status = "used_up";
    this.audit("system", "agent.register_by_invite", "agent", agentId, { inviteCodeId: invite.id, targetTier: invite.targetTier });
    return {
      agent,
      shop,
      application,
      inviteCode: this.serializeInviteCode(invite),
      credential: {
        account: agent.merchantUsername,
        initialPassword,
        mustResetPassword: true
      }
    };
  }

  grantRegistrationCoupon(userId: string) {
    const existing = [...this.store.userCoupons.values()]
      .find((coupon) => coupon.userId === userId && coupon.grantReason === "first_register");
    if (existing) return existing.status === "available" ? existing : undefined;
    const template = [...this.store.couponTemplates.values()]
      .find((item) => item.status === "active" && item.grantOnFirstRegister);
    if (!template) return undefined;
    const coupon: UserCoupon = {
      id: nextId(this.store, "coupon-user"),
      templateId: template.id,
      userId,
      status: "available",
      grantReason: "first_register",
      grantedAt: new Date(),
      usedAt: null,
      orderNo: null
    };
    this.store.userCoupons.set(coupon.id, coupon);
    this.audit("system", "coupon.grant.first_register", "user", userId, coupon);
    return coupon;
  }

  listUserCoupons(actor: UserActor, input: { shopId?: string; agentProductId?: string } = {}) {
    return [...this.store.userCoupons.values()]
      .filter((coupon) => coupon.userId === actor.userId)
      .map((coupon) => this.serializeUserCoupon(coupon, input))
      .filter((coupon) => coupon.visible);
  }

  getShop(shopId: string) {
    return requireEntity(this.store.shops.get(shopId), "RESOURCE_NOT_FOUND", "shop not found");
  }

  getPublicShop(shopId: string) {
    const shop = this.getShop(shopId);
    return {
      id: shop.id,
      agentId: shop.agentId,
      ownerType: shop.ownerType ?? "agent",
      name: shop.name,
      status: shop.status,
      announcement: shop.announcement,
      customerServiceWechat: shop.customerServiceWechat,
      customerServiceQrUrl: shop.customerServiceQrUrl,
      customerServiceQq: shop.customerServiceQq,
      customerServiceQqQrUrl: shop.customerServiceQqQrUrl,
      customerServiceNote: shop.customerServiceNote,
      themeColor: shop.themeColor,
      bannerUrl: shop.bannerUrl,
      shareTitle: shop.shareTitle,
      collectionAccountName: shop.collectionAccountName,
      collectionQrUrl: shop.collectionQrUrl,
      collectionNote: shop.collectionNote,
      productGroups: shop.productGroups ?? []
    };
  }

  listShopProducts(shopId: string) {
    const shop = this.getShop(shopId);
    if ((shop.ownerType ?? "agent") === "platform") {
      return [...this.store.platformShopProducts.values()]
        .filter((shopProduct) => shopProduct.shopId === shopId && shopProduct.status === "listed")
        .map((shopProduct) => this.serializePublicShopProduct(shopProduct));
    }
    return [...this.store.agentProducts.values()]
      .filter((agentProduct) => agentProduct.shopId === shopId && agentProduct.status === "listed")
      .map((agentProduct) => this.serializePublicAgentProduct(agentProduct));
  }

  getAgentProduct(agentProductId: string) {
    const platformShopProduct = this.store.platformShopProducts.get(agentProductId);
    if (platformShopProduct) return this.serializePublicShopProduct(platformShopProduct);
    return this.serializePublicAgentProduct(
      requireEntity(this.store.agentProducts.get(agentProductId), "RESOURCE_NOT_FOUND", "product not found")
    );
  }

  quoteOrder(actor: UserActor, input: { shopId: string; agentProductId: string; quantity?: number; couponId?: string }) {
    try {
      const snapshot = this.buildSnapshot({
        orderNo: "quote-only",
        userId: actor.userId,
        shopId: input.shopId,
        agentProductId: input.agentProductId,
        quantity: input.quantity
      });
      return this.serializePublicQuote(snapshot, this.resolveCouponDiscount(actor, snapshot, input.couponId));
    } catch (error) {
      if (error instanceof ApiError) throw error.statusCode === 404
        ? new ApiError(400, "PRICE_RULE_FAILED", error.message)
        : error;
      throw new ApiError(400, "PRICE_RULE_FAILED", getErrorMessage(error));
    }
  }

  createOrder(actor: UserActor, input: {
    shopId: string;
    agentProductId: string;
    quantity?: number;
    buyerEmail?: string;
    extractionCode?: string;
    couponId?: string;
    collectionChannelId?: string;
    clientPaidAmountCents?: bigint;
  }) {
    try {
      const orderNo = nextId(this.store, "order");
      const snapshot = this.buildSnapshot({
        orderNo,
        userId: actor.userId,
        shopId: input.shopId,
        agentProductId: input.agentProductId,
        quantity: input.quantity,
        entrySource: "user_api"
      });
      if (input.clientPaidAmountCents !== undefined && input.clientPaidAmountCents !== snapshot.amountSnapshot.paidAmountCents) {
        const quoteDiscount = this.resolveCouponDiscount(actor, snapshot, input.couponId);
        if (input.clientPaidAmountCents !== quoteDiscount.buyerPaidAmountCents) {
          throw new ApiError(400, "AMOUNT_MISMATCH", "client amount does not match backend quote");
        }
      }
      const coupon = this.resolveCouponDiscount(actor, snapshot, input.couponId);
      if (requiresExtractionCode(snapshot) && !input.extractionCode) {
        throw new ApiError(400, "PURCHASE_PASSWORD_REQUIRED", "this product requires a purchase password");
      }
      const collectionChannel = this.resolvePublicCollectionChannel(snapshot.shopId, input.collectionChannelId);
      const order: DemoOrder = {
        orderNo,
        userId: actor.userId,
        agentId: snapshot.agentId,
        shopId: snapshot.shopId,
        agentProductId: snapshot.agentProductId,
        salesChannelType: "salesChannelType" in snapshot ? snapshot.salesChannelType : "single_agent",
        status: "pending_payment_confirmation",
        paymentStatus: "unpaid",
        fulfillmentStatus: "not_started",
        refundStatus: "none",
        settlementStatus: "pending",
        riskStatus: "normal",
        complaintStatus: "none",
        fulfilledAt: null,
        paidAt: null,
        buyerEmail: input.buyerEmail,
        extractionCodeSet: Boolean(input.extractionCode),
        extractionCodeHash: input.extractionCode ? hashSecret(input.extractionCode) : undefined,
        extractionAttemptCount: 0,
        extractionLockedUntil: null,
        couponId: coupon.userCoupon?.id,
        couponDiscountCents: coupon.discountCents,
        buyerPaidAmountCents: coupon.buyerPaidAmountCents,
        collectionChannelId: collectionChannel.id,
        collectionChannelSnapshot: this.serializePublicCollectionChannel(collectionChannel),
        refundedAmountCents: 0n,
        snapshot
      };
      this.store.orders.set(orderNo, order);
      if (coupon.userCoupon) {
        coupon.userCoupon.status = "used";
        coupon.userCoupon.orderNo = orderNo;
        coupon.userCoupon.usedAt = new Date();
      }
      this.audit("system", "order.create", "order", orderNo, { agentId: order.agentId, shopId: order.shopId });
      this.ledger("ORDER_CREATED", { orderNo: order.orderNo, agentId: order.agentId }, order.snapshot.amountSnapshot.paidAmountCents, {
        salesChannelType: order.salesChannelType,
        channel: getChannelSnapshot(order.snapshot)
      });
      return this.serializePublicOrder(order, { includeDeliveryCodes: false, includeBuyerContact: false });
    } catch (error) {
      if (error instanceof ApiError && error.code !== "RESOURCE_NOT_FOUND") throw error;
      throw new ApiError(400, "ORDER_CREATE_FAILED", getErrorMessage(error));
    }
  }

  createPaymentIntent(actor: UserActor, orderNo: string, input: { channel: PaymentChannel }) {
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertUserOrderScope(actor, order);
    if (order.paymentStatus === "paid") {
      return { status: "already_paid" as const, orderNo, channel: input.channel };
    }
    if (input.channel === "mock") {
      if (!mockPaymentEnabled()) {
        throw new ApiError(403, "MOCK_PAYMENT_DISABLED", "mock payment is disabled in this runtime");
      }
      return {
        status: "ready" as const,
        orderNo,
        channel: "mock" as const,
        amountCents: payableAmount(order),
        devOnly: true
      };
    }
    const configured = this.paymentConfigStatus({ role: "admin", adminId: "system" })
      .find((item) => item.channel === input.channel && item.enabled);
    if (!configured) {
      return {
        status: "not_configured" as const,
        orderNo,
        channel: input.channel,
        amountCents: payableAmount(order),
        message: "支付账号尚未配置，不能伪造支付成功；请在后台完成支付渠道配置后再启用在线支付。"
      };
    }
    return {
      status: "not_implemented" as const,
      orderNo,
      channel: input.channel,
      amountCents: payableAmount(order),
      message: "支付渠道已启用元数据，但真实签名下单需要接入商户证书后开放。"
    };
  }

  createPaymentOrder(actor: UserActor, orderNo: string, input: { paymentMethodId?: string }) {
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertUserOrderScope(actor, order);
    if (order.paymentStatus === "paid") {
      return { status: "already_paid" as const, orderNo, order: this.serializePublicOrder(order, { includeDeliveryCodes: false }) };
    }
    if (order.refundStatus !== "none" || order.status === "refunded") {
      throw new ApiError(400, "PAYMENT_ORDER_NOT_ALLOWED", "refunded orders cannot create payment");
    }
    const method = this.resolvePaymentMethodForOrder(order, input.paymentMethodId);
    const amountCents = payableAmount(order);
    const paymentNo = `payment:${order.orderNo}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const maskedIdentity = this.paymentMethodMaskedIdentity(method);
    order.paymentSnapshot = {
      paymentNo,
      paymentMethodId: method.id,
      provider: method.provider,
      confirmationMode: method.confirmationMode,
      merchantNoMasked: maskedIdentity.merchantNoMasked,
      appIdMasked: maskedIdentity.appIdMasked,
      serviceProviderMasked: maskedIdentity.serviceProviderMasked,
      amountCents,
      currency: "CNY",
      orderNo: order.orderNo,
      status: method.provider === "personal_alipay" ? "pending_manual_confirmation" : "created",
      expiresAt,
      createdAt: new Date()
    };
    if (method.provider === "personal_alipay") {
      order.status = "pending_payment_confirmation";
      order.paymentStatus = "unpaid";
      this.audit("user", "payment.manual.create", "order", order.orderNo, {
        paymentMethodId: method.id,
        provider: method.provider,
        amountCents
      });
      return {
        status: "pending_manual_confirmation" as const,
        orderNo,
        provider: method.provider,
        amountCents,
        paymentMethod: this.serializePaymentMethod(method),
        paymentSnapshot: order.paymentSnapshot,
        message: "请使用个人支付宝收款信息付款，付款后等待商户人工确认收款。"
      };
    }
    order.paymentStatus = "paying";
    const providerTradeNo = `tp_${order.orderNo}_${Date.now()}`;
    order.paymentSnapshot.providerPaymentNo = providerTradeNo;
    order.paymentSnapshot.status = "paying";
    const signaturePayload = this.paymentSignaturePayload(method.provider, order.orderNo, amountCents, providerTradeNo, method.merchantNo);
    this.audit("user", "payment.order.create", "order", order.orderNo, {
      paymentMethodId: method.id,
      provider: method.provider,
      amountCents,
      providerTradeNo
    });
    return {
      status: "created" as const,
      orderNo,
      provider: method.provider,
      amountCents,
      paymentNo,
      providerTradeNo,
      expiresAt,
      paymentSnapshot: order.paymentSnapshot,
      paymentParams: {
        qrCodeUrl: `tosell-pay://${method.provider}/${encodeURIComponent(providerTradeNo)}`,
        returnUrl: method.returnUrl,
        notifyUrl: this.providerCallbackUrl(method.provider),
        signaturePayload
      },
      message: "支付状态只以服务端回调或后台查单结果为准，前端返回页不能确认支付成功。"
    };
  }

  getUserOrder(actor: UserActor, orderNo: string) {
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertUserOrderScope(actor, order);
    return this.serializePublicOrder(order, { includeDeliveryCodes: false, includeBuyerContact: true });
  }

  extractOrderCodes(actor: UserActor, orderNo: string, extractionCode: string) {
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertUserOrderScope(actor, order);
    if (fulfillmentMode(order.snapshot) !== "code_pool") {
      throw new ApiError(400, "EXTRACTION_NOT_REQUIRED", "this order is manually delivered");
    }
    if (order.paymentStatus !== "paid" || order.fulfillmentStatus !== "success") {
      throw new ApiError(400, "EXTRACTION_NOT_READY", "delivery codes are not ready");
    }
    if (order.refundStatus !== "none" || order.status === "refunded") {
      this.recordExtractLog(order, actor.userId, "refunded_blocked", "refunded_order");
      throw new ApiError(403, "EXTRACTION_FORBIDDEN_AFTER_REFUND", "refunded orders cannot view delivery codes");
    }
    const now = new Date();
    if (order.extractionLockedUntil && order.extractionLockedUntil > now) {
      this.recordExtractLog(order, actor.userId, "locked", "too_many_attempts");
      throw new ApiError(423, "EXTRACTION_LOCKED", "too many wrong attempts, try again later");
    }
    if (order.extractionCodeHash && hashSecret(extractionCode) !== order.extractionCodeHash) {
      order.extractionAttemptCount = (order.extractionAttemptCount ?? 0) + 1;
      if (order.extractionAttemptCount >= 3) {
        order.extractionLockedUntil = new Date(now.getTime() + 30 * 60 * 1000);
        order.extractionAttemptCount = 0;
      }
      this.recordExtractLog(order, actor.userId, order.extractionLockedUntil ? "locked" : "failed", "invalid_code");
      this.audit("user", "order.extract.failed", "order", orderNo, {
        attemptCount: order.extractionAttemptCount,
        lockedUntil: order.extractionLockedUntil
      });
      throw new ApiError(403, "PURCHASE_PASSWORD_INVALID", "purchase password is incorrect");
    }
    order.extractionAttemptCount = 0;
    order.extractionLockedUntil = null;
    const codes = this.store.rightsCodes
      .filter((code) => code.orderNo === order.orderNo && code.status === "issued")
      .map((code) => ({ codeId: code.codeId, code: code.code, issuedAt: code.issuedAt }));
    this.recordExtractLog(order, actor.userId, "success", undefined);
    this.audit("user", "order.extract.success", "order", orderNo, { codeCount: codes.length });
    return {
      orderNo,
      status: "success",
      codes,
      message: "卡密已提取，请妥善保存。"
    };
  }

  extractOrderCodesByToken(actor: UserActor, token: string, extractionCode: string) {
    const parsed = parseExtractionToken(token);
    if (!parsed || parsed.expiresAt <= Date.now()) {
      this.audit("user", parsed ? "order.extract.token_expired" : "order.extract.token_invalid", "extraction", "token", {
        userId: actor.userId
      });
      throw new ApiError(parsed ? 410 : 404, parsed ? "EXTRACTION_TOKEN_EXPIRED" : "EXTRACTION_TOKEN_NOT_FOUND", "extraction link is invalid or expired");
    }
    const order = [...this.store.orders.values()]
      .find((candidate) => this.extractionTokenSignature(candidate, parsed.expiresAt) === parsed.signature);
    if (!order) {
      this.audit("user", "order.extract.token_invalid", "extraction", "token", { userId: actor.userId });
      throw new ApiError(404, "EXTRACTION_TOKEN_NOT_FOUND", "extraction link is invalid or expired");
    }
    return this.extractOrderCodes(actor, order.orderNo, extractionCode);
  }

  listUserOrders(actor: UserActor) {
    return [...this.store.orders.values()]
      .filter((order) => order.userId === actor.userId)
      .map((order) => this.serializePublicOrder(order, { includeDeliveryCodes: false, includeBuyerContact: false }));
  }

  createAfterSale(actor: UserActor, input: {
    orderNo: string;
    reasonCode: string;
    requestedRefundCents: bigint;
    description?: string;
  }) {
    const order = requireEntity(this.store.orders.get(input.orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertUserOrderScope(actor, order);
    if (order.paymentStatus !== "paid") throw new ApiError(400, "AFTER_SALE_NOT_ALLOWED", "only paid orders can apply after sale");
    if (order.refundStatus === "refunded") throw new ApiError(400, "AFTER_SALE_NOT_ALLOWED", "order already refunded");
    if (order.refundStatus === "pending" || order.refundStatus === "refunding") {
      throw new ApiError(400, "AFTER_SALE_NOT_ALLOWED", "order already has active after sale");
    }
    if ([...this.store.afterSales.values()].some((item) => item.orderNo === order.orderNo && ["pending", "refunding"].includes(item.status))) {
      throw new ApiError(400, "AFTER_SALE_NOT_ALLOWED", "order already has active after sale");
    }
    if (input.requestedRefundCents <= 0n) throw new ApiError(400, "REFUND_AMOUNT_INVALID", "refund amount must be positive");
    if (order.refundedAmountCents + input.requestedRefundCents > order.snapshot.amountSnapshot.paidAmountCents) {
      throw new ApiError(400, "REFUND_AMOUNT_INVALID", "requested refund exceeds remaining paid amount");
    }
    const afterSaleNo = nextId(this.store, "as");
    const afterSale: DemoAfterSale = {
      afterSaleNo,
      orderNo: order.orderNo,
      userId: actor.userId,
      agentId: order.agentId,
      shopId: order.shopId,
      status: "pending",
      reasonCode: input.reasonCode,
      requestedRefundCents: input.requestedRefundCents,
      description: input.description
    };
    this.store.afterSales.set(afterSaleNo, afterSale);
    order.status = "after_sale_pending";
    order.refundStatus = "pending";
    if (order.settlementStatus !== "settled" && order.settlementStatus !== "settling") order.settlementStatus = "frozen";
    this.audit("user", "after_sale.create", "after_sale", afterSaleNo, { orderNo: order.orderNo });
    return afterSale;
  }

  submitAgentApplication(actor: AgentActor, input: { contactPhone: string; customerServiceWechat: string; inviteCode?: string }) {
    const agent = requireEntity(this.store.agents.get(actor.agentId), "RESOURCE_NOT_FOUND", "agent not found");
    agent.status = "pending_review";
    agent.contactPhone = input.contactPhone;
    const application: AgentApplication = {
      applicationNo: nextId(this.store, "agent-app"),
      agentId: agent.id,
      userId: agent.userId,
      status: "pending_review",
      contactPhone: input.contactPhone,
      customerServiceWechat: input.customerServiceWechat,
      inviteCode: input.inviteCode
    };
    this.store.agentApplications.set(application.applicationNo, application);
    this.audit("agent", "agent.application.submit", "agent", agent.id, application);
    return application;
  }

  getAgentShop(actor: AgentActor) {
    const shop = requireEntity(this.store.shops.get(actor.shopId), "RESOURCE_NOT_FOUND", "shop not found");
    assertAgentScope(actor, { agentId: required(shop.agentId, "agentId"), shopId: shop.id });
    return shop;
  }

  updateAgentShop(actor: AgentActor, input: {
    name?: string;
    announcement?: string;
    customerServiceWechat?: string;
    customerServiceQrUrl?: string;
    customerServiceQq?: string;
    customerServiceQqQrUrl?: string;
    customerServiceNote?: string;
  }) {
    const shop = this.getAgentShop(actor);
    Object.assign(shop, input);
    this.audit("agent", "shop.update", "shop", shop.id, input);
    return shop;
  }

  updateAgentShopCollection(actor: AgentActor, input: { collectionAccountName?: string; collectionQrUrl?: string; collectionNote?: string }) {
    const shop = this.getAgentShop(actor);
    shop.collectionAccountName = input.collectionAccountName ?? shop.collectionAccountName;
    shop.collectionQrUrl = input.collectionQrUrl ?? shop.collectionQrUrl;
    shop.collectionNote = input.collectionNote ?? shop.collectionNote;
    this.audit("agent", "shop.collection.update", "shop", shop.id, input);
    return shop;
  }

  updateShopDecor(actor: AgentActor, input: {
    themeColor?: string;
    bannerUrl?: string;
    shareTitle?: string;
    productGroups?: Array<{ name: string; agentProductIds: string[] }>;
  }) {
    const shop = this.getAgentShop(actor);
    if (input.themeColor && !/^#[0-9a-fA-F]{6}$/.test(input.themeColor)) {
      throw new ApiError(400, "SHOP_DECOR_INVALID", "themeColor must be a hex color");
    }
    if (input.productGroups) {
      for (const group of input.productGroups) {
        for (const agentProductId of group.agentProductIds) {
          const agentProduct = requireEntity(this.store.agentProducts.get(agentProductId), "RESOURCE_NOT_FOUND", "agent product not found");
          assertAgentScope(actor, agentProduct);
        }
      }
    }
    Object.assign(shop, input);
    this.notify(actor.agentId, "shop.decor.updated", "店铺装修已更新", "新的店铺主题、分享标题或商品分组已经保存。");
    this.audit("agent", "shop.decor.update", "shop", shop.id, input);
    return shop;
  }

  listPlatformProducts(actor?: AgentActor) {
    if (actor) {
      this.getAgentShop(actor);
      this.assertAgentDepositConfirmed(actor.agentId, "select platform products");
      if (this.findActiveChannelRelationForSellingAgent(actor.agentId) || this.isSecondTierSupplier(actor.agentId)) {
        return this.listVisibleUpstreamProducts(actor);
      }
    }
    return [...this.store.platformProducts.values()];
  }

  listAdminPlatformProducts(actor: AdminActor) {
    assertAdminPermission(actor, "product.manage");
    return [...this.store.platformProducts.values()];
  }

  getAdminPlatformProductDetail(actor: AdminActor, productId: string) {
    assertAdminPermission(actor, "product.manage");
    const product = requireEntity(this.store.platformProducts.get(productId), "RESOURCE_NOT_FOUND", "platform product not found");
    return this.serializePlatformProductDetail(product, "admin", actor);
  }

  updatePlatformProduct(actor: AdminActor, productId: string, input: {
    name?: string;
    category?: string;
    tags?: string[];
    subtitle?: string;
    description?: string;
    usageGuide?: string;
    imageUrl?: string;
    specs?: string[];
    detailSections?: ProductDetailSection[];
    stockCount?: number;
    soldCount?: number;
    supplyPriceCents?: bigint;
    minSalePriceCents?: bigint;
    suggestedSalePriceCents?: bigint;
    fulfillmentRule?: unknown;
    afterSaleRule?: unknown;
    status?: string;
  }) {
    assertAdminPermission(actor, "product.manage");
    const product = requireEntity(this.store.platformProducts.get(productId), "RESOURCE_NOT_FOUND", "platform product not found");
    const nextFulfillmentMode = input.fulfillmentRule === undefined ? undefined : fulfillmentRuleMode(input.fulfillmentRule);
    if (nextFulfillmentMode && nextFulfillmentMode !== fulfillmentRuleMode(product.fulfillmentRule)) {
      this.assertSafePlatformFulfillmentModeChange(product.id, nextFulfillmentMode);
    }
    assignDefined(product, input);
    if (product.stockCount !== undefined && (!Number.isInteger(product.stockCount) || product.stockCount < 0)) {
      throw new ApiError(400, "PRODUCT_INPUT_INVALID", "stock count must be a non-negative integer");
    }
    if (product.soldCount !== undefined && (!Number.isInteger(product.soldCount) || product.soldCount < 0)) {
      throw new ApiError(400, "PRODUCT_INPUT_INVALID", "sold count must be a non-negative integer");
    }
    if (product.supplyPriceCents <= 0n || product.minSalePriceCents <= 0n || product.suggestedSalePriceCents <= 0n) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "product prices must be positive");
    }
    if (product.minSalePriceCents < product.supplyPriceCents) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "minimum sale price cannot be below supply price");
    }
    if (product.suggestedSalePriceCents < product.minSalePriceCents) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "suggested sale price cannot be below minimum sale price");
    }
    this.audit(actor.role, "platform_product.update", "platform_product", product.id, input);
    return this.serializePlatformProductDetail(product, "admin", actor);
  }

  listAdminPlatformShopProducts(actor: AdminActor) {
    assertAdminPermission(actor, "product.manage");
    return [...this.store.platformShopProducts.values()].map((item) => ({
      ...item,
      product: this.store.platformProducts.get(item.platformProductId)
    }));
  }

  getAdminPlatformShopProductDetail(actor: AdminActor, shopProductId: string) {
    assertAdminPermission(actor, "product.manage");
    const shopProduct = requireEntity(this.store.platformShopProducts.get(shopProductId), "RESOURCE_NOT_FOUND", "platform shop product not found");
    return this.serializePlatformShopProductDetail(shopProduct, actor);
  }

  updatePlatformShopProductDetail(actor: AdminActor, shopProductId: string, input: { salePriceCents?: bigint; fulfillmentCostCents?: bigint; status?: string }) {
    assertAdminPermission(actor, "product.manage");
    const shopProduct = requireEntity(this.store.platformShopProducts.get(shopProductId), "RESOURCE_NOT_FOUND", "platform shop product not found");
    const product = requireEntity(this.store.platformProducts.get(shopProduct.platformProductId), "RESOURCE_NOT_FOUND", "platform product not found");
    const nextSalePrice = input.salePriceCents ?? shopProduct.salePriceCents;
    if (nextSalePrice < product.minSalePriceCents) throw new ApiError(400, "PRICE_RULE_FAILED", "sale price is below minimum sale price");
    if (input.fulfillmentCostCents !== undefined && input.fulfillmentCostCents < 0n) throw new ApiError(400, "PRICE_RULE_FAILED", "fulfillment cost must be non-negative");
    assignDefined(shopProduct, input);
    this.audit(actor.role, "platform_shop_product.update", "platform_shop_product", shopProduct.id, input);
    return this.serializePlatformShopProductDetail(shopProduct, actor);
  }

  upsertPlatformShopProduct(actor: AdminActor, input: {
    shopId: string;
    platformProductId: string;
    salePriceCents: bigint;
    fulfillmentCostCents?: bigint;
    status?: string;
  }) {
    assertAdminPermission(actor, "product.manage");
    const shop = this.getShop(input.shopId);
    if ((shop.ownerType ?? "agent") !== "platform") throw new ApiError(400, "SHOP_SCOPE_INVALID", "shop is not platform-owned");
    const product = requireEntity(this.store.platformProducts.get(input.platformProductId), "RESOURCE_NOT_FOUND", "platform product not found");
    if (input.salePriceCents < product.minSalePriceCents) throw new ApiError(400, "PRICE_RULE_FAILED", "sale price is below minimum sale price");
    const existing = [...this.store.platformShopProducts.values()]
      .find((item) => item.shopId === input.shopId && item.platformProductId === input.platformProductId);
    const shopProduct = existing ?? {
      id: nextId(this.store, "psp"),
      shopId: input.shopId,
      platformProductId: input.platformProductId,
      salePriceCents: input.salePriceCents,
      fulfillmentCostCents: input.fulfillmentCostCents ?? product.supplyPriceCents,
      status: input.status ?? "listed"
    };
    shopProduct.salePriceCents = input.salePriceCents;
    shopProduct.fulfillmentCostCents = input.fulfillmentCostCents ?? shopProduct.fulfillmentCostCents;
    shopProduct.status = input.status ?? shopProduct.status;
    this.store.platformShopProducts.set(shopProduct.id, shopProduct);
    this.audit(actor.role, "platform_shop_product.upsert", "platform_shop_product", shopProduct.id, shopProduct);
    return shopProduct;
  }

  agentDashboard(actor: AgentActor) {
    const orders = this.listAgentScopedOrders(actor);
    const paidOrders = orders.filter((order) => order.paymentStatus === "paid");
    const fulfilledOrders = orders.filter((order) => order.fulfillmentStatus === "success");
    const refundedOrders = orders.filter((order) => order.refundStatus === "refunded");
    const account = this.store.depositAccounts.get(actor.agentId);
    return {
      orderCount: orders.length,
      paidOrderCount: paidOrders.length,
      fulfilledOrderCount: fulfilledOrders.length,
      refundOrderCount: refundedOrders.length,
      gmvCents: sum(paidOrders.map((order) => order.snapshot.amountSnapshot.paidAmountCents)),
      expectedIncomeCents: sum(paidOrders.map((order) => order.snapshot.amountSnapshot.agentExpectedIncomeCents)),
      pendingIncomeCents: this.store.pendingIncomeByAgent.get(actor.agentId) ?? 0n,
      payableIncomeCents: this.store.payableIncomeByAgent.get(actor.agentId) ?? 0n,
      paidIncomeCents: this.store.paidIncomeByAgent.get(actor.agentId) ?? 0n,
      refundRateBps: paidOrders.length === 0 ? 0 : Math.round((refundedOrders.length / paidOrders.length) * 10_000),
      depositAvailableCents: account?.availableAmountCents ?? 0n,
      activeProductCount: this.listAgentProducts(actor).filter((item) => item.status === "listed").length,
      noticeCount: this.listNotifications(actor).filter((item) => !item.readAt).length
    };
  }

  listAgentProducts(actor: AgentActor) {
    return [...this.store.agentProducts.values()]
      .filter((agentProduct) => agentProduct.agentId === actor.agentId && agentProduct.shopId === actor.shopId)
      .map((agentProduct) => this.serializeAgentProductForActor(actor, agentProduct));
  }

  getAgentProductDetail(actor: AgentActor, agentProductId: string) {
    const agentProduct = requireEntity(this.store.agentProducts.get(agentProductId), "RESOURCE_NOT_FOUND", "agent product not found");
    assertAgentScope(actor, agentProduct);
    return this.serializeAgentProductDetailForActor(actor, agentProduct);
  }

  updateAgentProductDetail(actor: AgentActor, agentProductId: string, input: { salePriceCents?: bigint; status?: string }) {
    const agentProduct = requireEntity(this.store.agentProducts.get(agentProductId), "RESOURCE_NOT_FOUND", "agent product not found");
    assertAgentScope(actor, agentProduct);
    if (input.salePriceCents !== undefined) this.setAgentProductPrice(actor, agentProductId, input.salePriceCents);
    if (input.status !== undefined) agentProduct.status = input.status;
    this.audit("agent", "agent_product.detail_update", "agent_product", agentProduct.id, input);
    return this.serializeAgentProductDetailForActor(actor, agentProduct);
  }

  listAgentOrders(actor: AgentActor) {
    return this.listAgentScopedOrders(actor).map((order) => this.serializeAgentOrderForActor(actor, order));
  }

  getAgentOrder(actor: AgentActor, orderNo: string) {
    const order = this.listAgentScopedOrders(actor).find((item) => item.orderNo === orderNo);
    if (!order) throw new ApiError(404, "RESOURCE_NOT_FOUND", "order not found");
    return this.serializeAgentOrderForActor(actor, order);
  }

  private listAgentScopedOrders(actor: AgentActor) {
    return [...this.store.orders.values()].filter((order) => {
      if (order.agentId === actor.agentId && order.shopId === actor.shopId) return true;
      const channel = getChannelSnapshot(order.snapshot);
      return (channel?.firstTierAgentId === actor.agentId && channel.firstTierShopId === actor.shopId)
        || (channel?.secondTierAgentId === actor.agentId && channel.secondTierShopId === actor.shopId);
    });
  }

  listAgentSettlements(actor: AgentActor) {
    return this.store.settlementSheets.filter((sheet) => sheet.agentId === actor.agentId);
  }

  listAgentClawbacks(actor: AgentActor) {
    return this.store.clawbacks.filter((clawback) => clawback.agentId === actor.agentId);
  }

  listAgentDepositTransactions(actor: AgentActor) {
    return this.store.depositTransactions.filter((transaction) => transaction.agentId === actor.agentId);
  }

  setAgentProductPrice(actor: AgentActor, agentProductId: string, salePriceCents: bigint) {
    this.assertAgentDepositConfirmed(actor.agentId, "change product price");
    const agentProduct = requireEntity(this.store.agentProducts.get(agentProductId), "RESOURCE_NOT_FOUND", "agent product not found");
    assertAgentScope(actor, agentProduct);
    try {
      if (agentProduct.productType === "platform") {
        const pricing = this.platformSelectionPricingForActor(actor, required(agentProduct.platformProductId, "platformProductId"));
        quotePlatformProduct({
          salePriceCents,
          supplyPriceCents: pricing.supplyPriceCents,
          minSalePriceCents: pricing.minSalePriceCents
        });
      } else {
        const ownProduct = requireEntity(this.store.ownProducts.get(required(agentProduct.ownProductReviewId, "ownProductReviewId")), "RESOURCE_NOT_FOUND", "own product not found");
        quoteAgentOwnedProduct({ salePriceCents, minSalePriceCents: ownProduct.minSalePriceCents });
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "PRICE_RULE_FAILED", getErrorMessage(error));
    }
    agentProduct.salePriceCents = salePriceCents;
    this.audit("agent", "agent_product.price_update", "agent_product", agentProduct.id, { salePriceCents });
    return agentProduct;
  }

  listOwnProductReviews(actor: AgentActor) {
    return [...this.store.ownProducts.values()].filter((product) => product.agentId === actor.agentId && product.shopId === actor.shopId);
  }

  getOwnProductDetail(actor: AgentActor, ownProductId: string) {
    const product = requireEntity(this.store.ownProducts.get(ownProductId), "RESOURCE_NOT_FOUND", "own product not found");
    assertAgentScope(actor, product);
    return this.serializeOwnProductDetail(product, "merchant");
  }

  updateOwnProductDetail(actor: AgentActor, ownProductId: string, input: {
    name?: string;
    category?: string;
    tags?: string[];
    subtitle?: string;
    description?: string;
    usageGuide?: string;
    imageUrl?: string;
    specs?: string[];
    detailSections?: ProductDetailSection[];
    stockCount?: number;
    soldCount?: number;
    salePriceCents?: bigint;
    minSalePriceCents?: bigint;
    fulfillmentRule?: unknown;
    afterSaleRule?: unknown;
    status?: string;
  }) {
    const product = requireEntity(this.store.ownProducts.get(ownProductId), "RESOURCE_NOT_FOUND", "own product not found");
    assertAgentScope(actor, product);
    if (product.reviewStatus !== "pending_review" && (input.name || input.category || input.fulfillmentRule)) {
      throw new ApiError(400, "OWN_PRODUCT_EDIT_LOCKED", "approved or rejected own product core fields cannot be changed");
    }
    const nextFulfillmentMode = input.fulfillmentRule === undefined ? undefined : fulfillmentRuleMode(input.fulfillmentRule);
    if (nextFulfillmentMode && nextFulfillmentMode !== fulfillmentRuleMode(product.fulfillmentRule)) {
      this.assertSafeOwnFulfillmentModeChange(product.id, nextFulfillmentMode);
    }
    const nextSalePrice = input.salePriceCents ?? product.salePriceCents;
    const nextMinSalePrice = input.minSalePriceCents ?? product.minSalePriceCents;
    quoteAgentOwnedProduct({ salePriceCents: nextSalePrice, minSalePriceCents: nextMinSalePrice });
    assignDefined(product, input);
    product.updatedAt = new Date();
    this.audit("agent", "own_product.update", "own_product", product.id, input);
    return this.serializeOwnProductDetail(product, "merchant");
  }

  submitOwnProduct(actor: AgentActor, input: {
    name: string;
    category?: string;
    tags?: string[];
    subtitle?: string;
    description?: string;
    usageGuide?: string;
    imageUrl?: string;
    specs?: string[];
    detailSections?: ProductDetailSection[];
    salePriceCents: bigint;
    minSalePriceCents?: bigint;
    fulfillmentRule?: unknown;
    afterSaleRule?: unknown;
  }) {
    this.assertAgentDepositConfirmed(actor.agentId, "submit own product");
    const shop = this.getAgentShop(actor);
    try {
      quoteAgentOwnedProduct({ salePriceCents: input.salePriceCents, minSalePriceCents: input.minSalePriceCents });
    } catch (error) {
      throw new ApiError(400, "PRICE_RULE_FAILED", getErrorMessage(error));
    }
    const now = new Date();
    const review: DemoOwnProduct = {
      id: nextId(this.store, "own"),
      agentId: actor.agentId,
      shopId: shop.id,
      name: input.name,
      category: input.category,
      tags: input.tags,
      subtitle: input.subtitle,
      description: input.description,
      usageGuide: input.usageGuide,
      imageUrl: input.imageUrl,
      specs: input.specs,
      detailSections: input.detailSections,
      salePriceCents: input.salePriceCents,
      minSalePriceCents: input.minSalePriceCents,
      fulfillmentRule: input.fulfillmentRule ?? { mode: "manual" },
      afterSaleRule: input.afterSaleRule ?? { platformReviewRequired: true },
      reviewStatus: "pending_review",
      status: "pending_review",
      createdAt: now,
      updatedAt: now
    };
    this.store.ownProducts.set(review.id, review);
    this.audit("agent", "own_product.submit", "own_product", review.id, review);
    return review;
  }

  selectPlatformProduct(actor: AgentActor, input: { platformProductId: string; salePriceCents: bigint }) {
    this.getAgentShop(actor);
    this.assertAgentDepositConfirmed(actor.agentId, "select platform product");
    const pricing = this.platformSelectionPricingForActor(actor, input.platformProductId);
    try {
      quotePlatformProduct({
        salePriceCents: input.salePriceCents,
        supplyPriceCents: pricing.supplyPriceCents,
        minSalePriceCents: pricing.minSalePriceCents
      });
    } catch (error) {
      throw new ApiError(400, "PRICE_RULE_FAILED", getErrorMessage(error));
    }
    const existing = [...this.store.agentProducts.values()]
      .find((agentProduct) => agentProduct.shopId === actor.shopId && agentProduct.platformProductId === pricing.product.id);
    const agentProduct: DemoAgentProduct = existing ?? {
      id: nextId(this.store, "ap"),
      agentId: actor.agentId,
      shopId: actor.shopId,
      productType: "platform",
      platformProductId: pricing.product.id,
      ownProductReviewId: null,
      salePriceCents: input.salePriceCents,
      status: "listed"
    };
    agentProduct.salePriceCents = input.salePriceCents;
    agentProduct.status = "listed";
    this.store.agentProducts.set(agentProduct.id, agentProduct);
    this.audit("agent", "agent_product.select_platform", "agent_product", agentProduct.id, agentProduct);
    return agentProduct;
  }

  upsertAgentChannelProductOffer(actor: AgentActor, input: { downstreamAgentId: string; platformProductId: string; resellSupplyPriceCents: bigint; status?: string }) {
    this.assertAgentDepositConfirmed(actor.agentId, "configure transfer price");
    const relation = this.findDirectDownstreamRelation(actor.agentId, input.downstreamAgentId);
    if (!relation) {
      if (this.agentTier(actor.agentId) === "third_tier") {
        throw new ApiError(403, "FOURTH_TIER_FORBIDDEN", "third-tier merchants cannot configure downstream transfer price");
      }
      throw new ApiError(403, "FORBIDDEN_AGENT_SCOPE", "downstream merchant is not directly related to current merchant");
    }
    if (relation.status !== "active") throw new ApiError(400, "CHANNEL_RULE_FAILED", "channel relation is not active");
    return this.upsertChannelOfferForRelation("agent", relation, input);
  }

  batchSelectPlatformProducts(actor: AgentActor, input: { items: Array<{ platformProductId: string; salePriceCents: bigint }> }) {
    if (input.items.length === 0) throw new ApiError(400, "BATCH_EMPTY", "items are required");
    if (input.items.length > 50) throw new ApiError(400, "BATCH_TOO_LARGE", "batch size cannot exceed 50");
    this.assertAgentDepositConfirmed(actor.agentId, "batch select platform products");
    for (const item of input.items) {
      const pricing = this.platformSelectionPricingForActor(actor, item.platformProductId);
      try {
        quotePlatformProduct({
          salePriceCents: item.salePriceCents,
          supplyPriceCents: pricing.supplyPriceCents,
          minSalePriceCents: pricing.minSalePriceCents
        });
      } catch (error) {
        throw new ApiError(400, "PRICE_RULE_FAILED", `${pricing.product.id}: ${getErrorMessage(error)}`);
      }
    }
    const results = input.items.map((item) => this.selectPlatformProduct(actor, item));
    this.notify(actor.agentId, "product.batch_listed", "批量选品已完成", `已处理 ${results.length} 个商品。`);
    this.audit("agent", "agent_product.batch_select_platform", "agent_product", actor.shopId, { count: results.length });
    return { count: results.length, items: results };
  }

  reviewAgent(actor: AdminActor, agentId: string, input: { approved: boolean; reason?: string }) {
    assertAdminPermission(actor, "agent.review");
    const agent = requireEntity(this.store.agents.get(agentId), "RESOURCE_NOT_FOUND", "agent not found");
    agent.status = input.approved ? "pending_deposit" : "rejected";
    let credential: { account: string; initialPassword: string; mustResetPassword: boolean } | undefined;
    if (input.approved && !agent.initialPasswordSet) {
      const initialPassword = `TS${Date.now().toString().slice(-6)}`;
      agent.initialPasswordSet = true;
      agent.merchantUsername = agent.id;
      agent.passwordHash = `sha256:${hashSecret(initialPassword)}`;
      credential = {
        account: agent.merchantUsername,
        initialPassword,
        mustResetPassword: true
      };
    }
    for (const relation of this.store.channelRelations) {
      if (relation.status === "pending_review" && (relation.secondTierAgentId === agentId || relation.thirdTierAgentId === agentId)) {
        relation.status = input.approved ? "pending_deposit" : "closed";
        relation.reason = input.reason ?? relation.reason;
      }
    }
    this.audit(actor.role, "agent.review", "agent", agentId, input);
    return credential ? { ...agent, credential } : agent;
  }

  listAgentApplications(actor: AdminActor) {
    assertAdminPermission(actor, "agent.review");
    return [...this.store.agentApplications.values()];
  }

  createAgentByAdmin(actor: AdminActor, input: {
    name: string;
    targetTier?: "first_tier" | "second_tier" | "third_tier";
    contactPhone?: string;
    shopName?: string;
    customerServiceWechat?: string;
    initialPassword?: string;
    depositRequiredAmountCents?: bigint;
    depositPaid?: boolean;
    depositAmountCents?: bigint;
  }) {
    assertAdminPermission(actor, "agent.review");
    if (input.targetTier && input.targetTier !== "first_tier") {
      this.audit(actor.role, "agent.admin_create_rejected_non_first_tier", "agent", input.targetTier, {
        targetTier: input.targetTier,
        operatorId: actor.adminId
      });
      throw new ApiError(400, "ADMIN_CREATE_FIRST_TIER_ONLY", "admin manual creation can only create first-tier merchants");
    }
    const agentId = nextId(this.store, "agent");
    const shopId = nextId(this.store, "shop");
    const userId = nextId(this.store, "agent-user");
    const initialPassword = input.initialPassword ?? `TS${Date.now().toString().slice(-6)}`;
    const requiredAmount = input.depositRequiredAmountCents ?? input.depositAmountCents;
    if (requiredAmount === undefined || requiredAmount <= 0n) {
      throw new ApiError(400, "DEPOSIT_REQUIREMENT_MISSING", "deposit required amount is required");
    }
    const paidAmount = input.depositPaid ? (input.depositAmountCents ?? requiredAmount) : 0n;
    const paid = paidAmount >= requiredAmount;
    const agent: DemoAgent = {
      id: agentId,
      userId,
      name: input.name,
      contactPhone: input.contactPhone,
      tier: "first_tier",
      status: paid ? "active" : "pending_deposit",
      riskStatus: "normal",
      depositStatus: paid ? "paid" : "pending_payment",
      createdByAdminId: actor.adminId,
      initialPasswordSet: true,
      merchantUsername: agentId,
      passwordHash: `sha256:${hashSecret(initialPassword)}`
    };
    const shop: DemoShop = {
      id: shopId,
      agentId,
      ownerType: "agent",
      name: input.shopName ?? `${input.name} 小店`,
      status: paid ? "open" : "not_opened",
      riskStatus: "normal",
      announcement: "精选虚拟权益，付款后按商品规则发放。",
      customerServiceWechat: input.customerServiceWechat,
      themeColor: "#ff9900",
      shareTitle: `${input.name} 官方小店`,
      createdByAdminId: actor.adminId
    };
    this.store.agents.set(agentId, agent);
    this.store.shops.set(shopId, shop);
    this.store.depositAccounts.set(agentId, {
      agentId,
      requiredAmountCents: requiredAmount,
      availableAmountCents: paidAmount,
      frozenAmountCents: 0n,
      deductedAmountCents: 0n,
      status: paid ? "paid" : "pending_payment"
    });
    if (paidAmount > 0n) {
      this.addDepositTransaction(agentId, {
        type: "pay",
        amountCents: paidAmount,
        balanceBeforeCents: 0n,
        balanceAfterCents: paidAmount,
        reasonCode: "admin_manual_create",
        relatedType: "agent",
        relatedId: agentId,
        idempotencyKey: `admin-create-agent:${agentId}:deposit`,
        proofUrl: "admin://manual-first-tier",
        operatorId: actor.adminId,
        remark: "后台手工开一级商户并确认保证金"
      });
    }
    this.audit(actor.role, "agent.admin_create_first_tier", "agent", agentId, {
      agentId,
      shopId,
      depositPaid: paid,
      operatorId: actor.adminId
    });
    return {
      agent,
      shop,
      credential: {
        account: agentId,
        initialPassword,
        mustResetPassword: true
      }
    };
  }

  confirmDeposit(actor: AdminActor, agentId: string, input: { amountCents: bigint; requiredAmountCents?: bigint; voucherUrl?: string; remark?: string }) {
    assertAdminPermission(actor, "deposit.manage");
    const agent = requireEntity(this.store.agents.get(agentId), "RESOURCE_NOT_FOUND", "agent not found");
    const account = requireEntity(this.store.depositAccounts.get(agentId), "RESOURCE_NOT_FOUND", "deposit account not found");
    const idempotencyKey = `deposit:pay:manual:${agentId}:${input.voucherUrl ?? input.amountCents.toString()}`;
    const result = this.registry.runOnce(idempotencyKey, () => {
      account.requiredAmountCents = input.requiredAmountCents ?? account.requiredAmountCents;
      const before = account.availableAmountCents;
      account.availableAmountCents += input.amountCents;
      account.status = account.availableAmountCents < account.requiredAmountCents ? "insufficient" : "paid";
      agent.depositStatus = account.status;
      if (agent.status === "pending_deposit" && account.status === "paid") {
        agent.status = "active";
        const shop = [...this.store.shops.values()].find((candidate) => candidate.agentId === agent.id);
        if (shop) shop.status = "open";
        this.activateEligibleInviteRelations(agent.id);
      }
      const transaction = this.addDepositTransaction(agentId, {
        type: "pay",
        amountCents: input.amountCents,
        balanceBeforeCents: before,
        balanceAfterCents: account.availableAmountCents,
        reasonCode: "manual_confirm",
        relatedType: "deposit",
        relatedId: agentId,
        idempotencyKey,
        proofUrl: input.voucherUrl,
        operatorId: actor.adminId,
        remark: input.remark
      });
      this.ledger("DEPOSIT_CONFIRMED", { agentId }, input.amountCents, { transactionNo: transaction.transactionNo });
      this.audit(actor.role, "deposit.confirm", "agent", agentId, transaction);
      return { status: "processed" as const, idempotencyKey, account, transaction };
    });
    return result ?? { status: "duplicate" as const, idempotencyKey, account };
  }

  createPlatformProduct(actor: AdminActor, input: {
    name: string;
    category?: string;
    tags?: string[];
    subtitle?: string;
    description?: string;
    usageGuide?: string;
    imageUrl?: string;
    specs?: string[];
    detailSections?: ProductDetailSection[];
    stockCount?: number;
    soldCount?: number;
    supplyPriceCents: bigint;
    minSalePriceCents: bigint;
    suggestedSalePriceCents: bigint;
    fulfillmentRule?: unknown;
    afterSaleRule?: unknown;
  }) {
    assertAdminPermission(actor, "product.manage");
    if (!input.name.trim()) {
      throw new ApiError(400, "PRODUCT_INPUT_INVALID", "product name is required");
    }
    if (input.stockCount !== undefined && (!Number.isInteger(input.stockCount) || input.stockCount < 0)) {
      throw new ApiError(400, "PRODUCT_INPUT_INVALID", "stock count must be a non-negative integer");
    }
    if (input.soldCount !== undefined && (!Number.isInteger(input.soldCount) || input.soldCount < 0)) {
      throw new ApiError(400, "PRODUCT_INPUT_INVALID", "sold count must be a non-negative integer");
    }
    if (input.supplyPriceCents <= 0n || input.minSalePriceCents <= 0n || input.suggestedSalePriceCents <= 0n) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "product prices must be positive");
    }
    if (input.minSalePriceCents < input.supplyPriceCents) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "minimum sale price cannot be below supply price");
    }
    if (input.suggestedSalePriceCents < input.minSalePriceCents) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "suggested sale price cannot be below minimum sale price");
    }
    const product: DemoPlatformProduct = {
      id: nextId(this.store, "prod"),
      name: input.name,
      category: input.category,
      tags: input.tags,
      subtitle: input.subtitle,
      description: input.description,
      usageGuide: input.usageGuide,
      imageUrl: input.imageUrl,
      specs: input.specs,
      detailSections: input.detailSections,
      stockCount: input.stockCount,
      soldCount: input.soldCount ?? 0,
      supplyPriceCents: input.supplyPriceCents,
      minSalePriceCents: input.minSalePriceCents,
      suggestedSalePriceCents: input.suggestedSalePriceCents,
      fulfillmentRule: input.fulfillmentRule ?? { mode: "manual" },
      afterSaleRule: input.afterSaleRule ?? { refundBeforeFulfillment: true },
      status: "active"
    };
    this.store.platformProducts.set(product.id, product);
    this.audit(actor.role, "product.create", "platform_product", product.id, input);
    return product;
  }

  listAdminOwnProductReviews(actor: AdminActor, filters: {
    reviewStatus?: string;
    status?: string;
    agentId?: string;
    shopId?: string;
    page?: number;
    pageSize?: number;
    limit?: number;
    offset?: number;
  } = {}) {
    assertAdminPermission(actor, "product.manage");
    const rows = [...this.store.ownProducts.values()]
      .filter((product) => !filters.reviewStatus || product.reviewStatus === filters.reviewStatus)
      .filter((product) => !filters.status || product.status === filters.status || product.reviewStatus === filters.status)
      .filter((product) => !filters.agentId || product.agentId === filters.agentId)
      .filter((product) => !filters.shopId || product.shopId === filters.shopId)
      .sort((left, right) => {
        if (left.reviewStatus === right.reviewStatus) return left.id.localeCompare(right.id);
        if (left.reviewStatus === "pending_review") return -1;
        if (right.reviewStatus === "pending_review") return 1;
        return left.reviewStatus.localeCompare(right.reviewStatus);
      })
      .map((product) => {
        const agent = this.store.agents.get(product.agentId);
        const shop = this.store.shops.get(product.shopId);
        return {
          id: product.id,
          ownProductId: product.id,
          agentId: product.agentId,
          shopId: product.shopId,
          name: product.name,
          salePriceCents: product.salePriceCents,
          minSalePriceCents: product.minSalePriceCents,
          fulfillmentRule: product.fulfillmentRule,
          fulfillmentMode: isRecord(product.fulfillmentRule) ? product.fulfillmentRule.mode : undefined,
          afterSaleRule: product.afterSaleRule,
          reviewStatus: product.reviewStatus,
          status: product.status,
          createdAt: product.createdAt,
          updatedAt: product.updatedAt,
          agent: agent ? { id: agent.id, name: agent.name, tier: agent.tier, status: agent.status } : undefined,
          shop: shop ? { id: shop.id, name: shop.name, status: shop.status } : undefined
        };
      });
    if (!filters.page && !filters.pageSize && !filters.limit && filters.offset === undefined) return rows;
    const pageSize = filters.pageSize ?? filters.limit ?? 20;
    const offset = filters.offset ?? ((filters.page ?? 1) - 1) * pageSize;
    const page = filters.page ?? Math.floor(offset / pageSize) + 1;
    return {
      items: rows.slice(offset, offset + pageSize),
      total: rows.length,
      page,
      pageSize,
      offset
    };
  }

  getAdminOwnProductReviewDetail(actor: AdminActor, ownProductId: string) {
    assertAdminPermission(actor, "product.manage");
    const product = requireEntity(this.store.ownProducts.get(ownProductId), "RESOURCE_NOT_FOUND", "own product not found");
    return this.serializeOwnProductDetail(product, "admin");
  }

  reviewOwnProduct(actor: AdminActor, ownProductId: string, input: { approved: boolean; reason?: string }) {
    assertAdminPermission(actor, "product.manage");
    const ownProduct = requireEntity(this.store.ownProducts.get(ownProductId), "RESOURCE_NOT_FOUND", "own product not found");
    ownProduct.reviewStatus = input.approved ? "approved" : "rejected";
    ownProduct.status = ownProduct.reviewStatus;
    ownProduct.updatedAt = new Date();
    let agentProduct: DemoAgentProduct | undefined;
    if (input.approved) {
      agentProduct = {
        id: nextId(this.store, "ap"),
        agentId: ownProduct.agentId,
        shopId: ownProduct.shopId,
        productType: "agent_owned",
        platformProductId: null,
        ownProductReviewId: ownProduct.id,
        salePriceCents: ownProduct.salePriceCents,
        status: "listed"
      };
      ownProduct.status = "listed";
      this.store.agentProducts.set(agentProduct.id, agentProduct);
    }
    this.audit(actor.role, "own_product.review", "own_product", ownProduct.id, input);
    return { ownProduct, agentProduct };
  }

  listAdminOrders(actor: AdminActor, filters: { page?: number; pageSize?: number; status?: string; shopId?: string; orderNo?: string } = {}) {
    assertAdminPermission(actor, "audit.read");
    const rows = [...this.store.orders.values()]
      .filter((order) => !filters.status || order.status === filters.status || order.paymentStatus === filters.status || order.fulfillmentStatus === filters.status || order.refundStatus === filters.status)
      .filter((order) => !filters.shopId || order.shopId === filters.shopId)
      .filter((order) => !filters.orderNo || order.orderNo.includes(filters.orderNo));
    if (!filters.page && !filters.pageSize) return rows;
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    return {
      items: rows.slice(start, start + pageSize),
      total: rows.length,
      page,
      pageSize
    };
  }

  listAdminAfterSales(actor: AdminActor) {
    assertAdminPermission(actor, "after_sale.arbitrate");
    return [...this.store.afterSales.values()];
  }

  listAdminRefunds(actor: AdminActor) {
    assertAdminPermission(actor, "after_sale.arbitrate");
    return [...this.store.refunds.values()];
  }

  listAdminSettlements(actor: AdminActor) {
    assertAdminPermission(actor, "settlement.generate");
    return this.store.settlementSheets;
  }

  listAdminDeposits(actor: AdminActor) {
    assertAdminPermission(actor, "deposit.manage");
    return [...this.store.depositAccounts.values()].map((account) => ({
      ...account,
      transactions: this.store.depositTransactions.filter((transaction) => transaction.agentId === account.agentId)
    }));
  }

  listAdminChannels(actor: AdminActor) {
    assertAdminPermission(actor, "agent.review");
    return {
      authorizations: this.store.channelAuthorizations,
      relations: this.store.channelRelations,
      offers: this.store.channelProductOffers
    };
  }

  reviewChannelAuthorization(actor: AdminActor, agentId: string, input: { approved: boolean; reason?: string }) {
    assertAdminPermission(actor, "agent.review");
    const agent = requireEntity(this.store.agents.get(agentId), "RESOURCE_NOT_FOUND", "agent not found");
    const existing = this.store.channelAuthorizations.find((item) => item.firstTierAgentId === agent.id);
    const authorization = existing ?? {
      id: nextId(this.store, "channel-auth"),
      firstTierAgentId: agent.id,
      status: "pending_review",
      reason: null,
      reviewedAt: null
    };
    authorization.status = input.approved ? "active" : "rejected";
    authorization.reason = input.reason ?? null;
    authorization.reviewedAt = new Date();
    if (!existing) this.store.channelAuthorizations.push(authorization);
    this.audit(actor.role, "channel.authorization.review", "agent", agent.id, authorization);
    return authorization;
  }

  createChannelRelation(actor: AdminActor, input: { firstTierAgentId: string; secondTierAgentId: string; thirdTierAgentId?: string; reason?: string }) {
    assertAdminPermission(actor, "agent.review");
    if (input.firstTierAgentId === input.secondTierAgentId || input.thirdTierAgentId === input.firstTierAgentId || input.thirdTierAgentId === input.secondTierAgentId) {
      throw new ApiError(400, "CHANNEL_RULE_FAILED", "channel agents cannot be same agent");
    }
    const firstTier = requireEntity(this.store.agents.get(input.firstTierAgentId), "RESOURCE_NOT_FOUND", "first tier agent not found");
    const secondTier = requireEntity(this.store.agents.get(input.secondTierAgentId), "RESOURCE_NOT_FOUND", "second tier agent not found");
    const thirdTier = input.thirdTierAgentId ? requireEntity(this.store.agents.get(input.thirdTierAgentId), "RESOURCE_NOT_FOUND", "third tier agent not found") : undefined;
    const authorization = this.store.channelAuthorizations.find((item) => item.firstTierAgentId === firstTier.id && item.status === "active");
    if (!authorization) throw new ApiError(400, "CHANNEL_RULE_FAILED", "first tier agent is not authorized");
    if (this.store.channelRelations.some((item) => item.status === "active" && (item.secondTierAgentId === firstTier.id || item.thirdTierAgentId === firstTier.id))) {
      throw new ApiError(400, "CHANNEL_RULE_FAILED", "fourth-tier channel creation is forbidden");
    }
    if (firstTier.status !== "active" || secondTier.status !== "active" || (thirdTier && thirdTier.status !== "active")) {
      throw new ApiError(400, "CHANNEL_RULE_FAILED", "channel agents must be active");
    }
    this.assertAgentDepositConfirmed(firstTier.id, "create channel relation");
    this.assertAgentDepositConfirmed(secondTier.id, "create channel relation");
    if (thirdTier) this.assertAgentDepositConfirmed(thirdTier.id, "create channel relation");
    const activeUniqueKey = thirdTier ? `third-tier:${thirdTier.id}` : `second-tier:${secondTier.id}`;
    const existing = this.store.channelRelations.find((item) => item.activeUniqueKey === activeUniqueKey && item.status === "active");
    if (existing) {
      this.audit(actor.role, "channel.relation.create", "channel_relation", existing.id, existing);
      return existing;
    }
    const relation = {
      id: nextId(this.store, "channel-rel"),
      firstTierAgentId: firstTier.id,
      secondTierAgentId: secondTier.id,
      thirdTierAgentId: thirdTier?.id,
      status: "active",
      reason: input.reason ?? null,
      reviewedAt: new Date(),
      activeUniqueKey
    };
    this.store.channelRelations.push(relation);
    this.audit(actor.role, "channel.relation.create", "channel_relation", relation.id, relation);
    return relation;
  }

  upsertChannelProductOffer(actor: AdminActor, input: { channelRelationId: string; platformProductId: string; resellSupplyPriceCents: bigint; status?: string }) {
    assertAdminPermission(actor, "product.manage");
    const relation = requireEntity(this.store.channelRelations.find((item) => item.id === input.channelRelationId), "RESOURCE_NOT_FOUND", "channel relation not found");
    if (relation.status !== "active") throw new ApiError(400, "CHANNEL_RULE_FAILED", "channel relation is not active");
    return this.upsertChannelOfferForRelation(actor.role, relation, input);
  }

  private upsertChannelOfferForRelation(
    auditRole: string,
    relation: ChannelRelation,
    input: { platformProductId: string; resellSupplyPriceCents: bigint; status?: string }
  ) {
    this.assertAgentDepositConfirmed(relation.firstTierAgentId, "configure channel offer");
    this.assertAgentDepositConfirmed(relation.secondTierAgentId, "configure channel offer");
    if (relation.thirdTierAgentId) this.assertAgentDepositConfirmed(relation.thirdTierAgentId, "configure channel offer");
    const product = requireEntity(this.store.platformProducts.get(input.platformProductId), "RESOURCE_NOT_FOUND", "platform product not found");
    const upstreamSupplyPriceCents = this.upstreamSupplyPriceForRelation(relation, product.id);
    if (input.resellSupplyPriceCents < upstreamSupplyPriceCents) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "resell supply price cannot be below upstream supply price");
    }
    const existing = this.store.channelProductOffers.find((item) => item.channelRelationId === relation.id && item.platformProductId === product.id);
    const offer = existing ?? {
      id: nextId(this.store, "channel-offer"),
      channelRelationId: relation.id,
      platformProductId: product.id,
      resellSupplyPriceCents: input.resellSupplyPriceCents,
      status: input.status ?? "listed"
    };
    offer.resellSupplyPriceCents = input.resellSupplyPriceCents;
    offer.status = input.status ?? offer.status;
    if (!existing) this.store.channelProductOffers.push(offer);
    this.audit(auditRole, "channel.offer.upsert", "channel_product_offer", offer.id, offer);
    return offer;
  }

  listRightsCodes(actor: AdminActor, filters: { productId?: string; orderNo?: string; status?: RightsCode["status"]; shopId?: string } = {}) {
    assertAdminPermission(actor, "product.manage");
    return this.filterRightsCodes(filters).map((code) => this.redactRightsCode(code));
  }

  revealRightsCodesPlaintext(actor: AdminActor, filters: { productId?: string; orderNo?: string; status?: RightsCode["status"]; shopId?: string } = {}) {
    assertAdminPermission(actor, "rights_code.secret.read");
    const codes = this.filterRightsCodes(filters);
    this.audit(actor.role, "rights_code.secret.read", "rights_code", filters.orderNo ?? filters.productId ?? "filtered", {
      ...filters,
      count: codes.length
    });
    return codes;
  }

  precheckRightsCodes(actor: AdminActor, input: { productId: string; codes: string[] }) {
    assertAdminPermission(actor, "product.manage");
    const product = requireEntity(this.store.platformProducts.get(input.productId), "RESOURCE_NOT_FOUND", "platform product not found");
    if (fulfillmentRuleMode(product.fulfillmentRule) !== "code_pool") {
      throw new ApiError(400, "RIGHTS_CODE_PRODUCT_MODE_INVALID", "card-code pool is only available for code_pool products");
    }
    const precheck = this.analyzeRightsCodeImport(input.codes, (code) =>
      this.store.rightsCodes.some((item) => item.productId === product.id && item.code === code)
    );
    return this.redactRightsCodeImportPrecheck(precheck);
  }

  listEmailDeliveries(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return this.store.emailDeliveries;
  }

  resendOrderEmailDelivery(actor: AdminActor, orderNo: string) {
    assertAdminPermission(actor, "after_sale.arbitrate");
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    if (!order.buyerEmail) throw new ApiError(400, "EMAIL_DELIVERY_NOT_CONFIGURED", "buyer email is not set for this order");
    if (order.refundStatus !== "none" || order.status === "refunded") {
      throw new ApiError(403, "EMAIL_DELIVERY_FORBIDDEN_AFTER_REFUND", "refunded orders cannot resend delivery codes");
    }
    if (order.paymentStatus !== "paid" || order.fulfillmentStatus !== "success") {
      throw new ApiError(400, "EMAIL_DELIVERY_NOT_READY", "delivery is not ready for this order");
    }
    const codes = this.store.rightsCodes.filter((code) => code.orderNo === order.orderNo && code.status === "issued");
    if (fulfillmentMode(order.snapshot) === "code_pool" && codes.length === 0) {
      throw new ApiError(400, "EMAIL_DELIVERY_CODE_NOT_ISSUED", "no issued codes are bound to this order");
    }
    const delivery = this.recordEmailDelivery(order, codes, "manual_resend");
    this.audit(actor.role, "email.delivery.resend", "order", order.orderNo, {
      email: order.buyerEmail,
      codeCount: codes.length,
      deliveryId: delivery?.id
    });
    return delivery;
  }

  private filterRightsCodes(filters: { productId?: string; orderNo?: string; status?: RightsCode["status"]; shopId?: string } = {}) {
    return this.store.rightsCodes.filter((code) => {
      if (filters.productId && code.productId !== filters.productId) return false;
      if (filters.orderNo && code.orderNo !== filters.orderNo) return false;
      if (filters.status && code.status !== filters.status) return false;
      if (filters.shopId) {
        if (!code.orderNo) return false;
        const order = this.store.orders.get(code.orderNo);
        if (order?.shopId !== filters.shopId) return false;
      }
      return true;
    });
  }

  private redactRightsCode(code: RightsCode) {
    const preview = code.code.length <= 6 ? "***" : `${code.code.slice(0, 2)}***${code.code.slice(-2)}`;
    return {
      ...code,
      code: undefined,
      codePreview: preview
    };
  }

  private analyzeRightsCodeImport(codes: string[], exists: (code: string) => boolean): RightsCodeImportPrecheck {
    const seen = new Set<string>();
    const details = codes.map((rawCode, index): RightsCodeImportDetail => {
      const normalizedCode = rawCode.trim();
      const base = {
        line: index + 1,
        codePreview: normalizedCode ? previewSecret(normalizedCode) : undefined,
        normalizedCode: normalizedCode || undefined
      };
      if (!normalizedCode) {
        return { ...base, action: "fail", reasonCode: "EMPTY_LINE", reason: "empty line" };
      }
      if (normalizedCode.length > 256 || /[\u0000-\u001f\u007f]/.test(normalizedCode)) {
        return { ...base, action: "fail", reasonCode: "INVALID_FORMAT", reason: "card code contains invalid characters or is too long" };
      }
      if (seen.has(normalizedCode)) {
        return { ...base, action: "skip", reasonCode: "DUPLICATE_IN_REQUEST", reason: "duplicate in current import" };
      }
      seen.add(normalizedCode);
      if (exists(normalizedCode)) {
        return { ...base, action: "skip", reasonCode: "DUPLICATE_EXISTING", reason: "card code already exists" };
      }
      return { ...base, action: "create", reasonCode: null, reason: null };
    });
    const created = details.filter((item) => item.action === "create").length;
    const skipped = details.filter((item) => item.action === "skip").length;
    const failed = details.filter((item) => item.action === "fail").length;
    return {
      summary: {
        total: details.length,
        create: created,
        created,
        skipped,
        failed,
        importable: created
      },
      details
    };
  }

  private redactRightsCodeImportPrecheck(precheck: RightsCodeImportPrecheck) {
    return {
      ...precheck,
      details: precheck.details.map(({ normalizedCode: _normalizedCode, ...item }) => item)
    };
  }

  addRightsCodes(actor: AdminActor, input: { productId: string; codes: string[]; batchNo?: string }) {
    assertAdminPermission(actor, "product.manage");
    const product = requireEntity(this.store.platformProducts.get(input.productId), "RESOURCE_NOT_FOUND", "platform product not found");
    if (fulfillmentRuleMode(product.fulfillmentRule) !== "code_pool") {
      throw new ApiError(400, "RIGHTS_CODE_PRODUCT_MODE_INVALID", "card-code pool is only available for code_pool products");
    }
    const precheck = this.analyzeRightsCodeImport(input.codes, (code) =>
      this.store.rightsCodes.some((item) => item.productId === product.id && item.code === code)
    );
    const importableCodes = precheck.details
      .filter((item) => item.action === "create")
      .map((item) => item.normalizedCode)
      .filter((code): code is string => Boolean(code));
    if (importableCodes.length === 0) throw new ApiError(400, "RIGHTS_CODE_EMPTY", "no importable card codes");
    const created: RightsCode[] = [];
    for (const code of importableCodes) {
      const item: RightsCode = {
        codeId: nextId(this.store, "code"),
        productId: product.id,
        platformProductId: product.id,
        code,
        batchNo: input.batchNo ?? "manual",
        status: "available",
        createdAt: new Date()
      };
      this.store.rightsCodes.push(item);
      created.push(item);
    }
    this.audit(actor.role, "rights_code.import", "platform_product", product.id, {
      count: created.length,
      batchNo: input.batchNo ?? "manual",
      codeIds: created.map((code) => code.codeId)
    });
    return {
      count: created.length,
      createdCount: created.length,
      skippedCount: precheck.summary.skipped,
      failedCount: precheck.summary.failed,
      product,
      codes: created.map((code) => this.redactRightsCode(code)),
      details: this.redactRightsCodeImportPrecheck({
        ...precheck,
        details: precheck.details.map((item) =>
          item.action === "create"
            ? { ...item, codeId: created.find((code) => code.code === item.normalizedCode)?.codeId }
            : item
        )
      }).details,
      summary: precheck.summary
    };
  }

  listAgentRightsCodes(actor: AgentActor, filters: { agentProductId?: string; status?: RightsCode["status"] } = {}) {
    const products = [...this.store.agentProducts.values()]
      .filter((product) => product.agentId === actor.agentId && product.shopId === actor.shopId && product.productType === "agent_owned");
    const allowedIds = new Set(products.map((product) => product.id));
    return this.store.rightsCodes
      .filter((code) => allowedIds.has(code.agentProductId ?? code.productId))
      .filter((code) => !filters.agentProductId || code.productId === filters.agentProductId || code.agentProductId === filters.agentProductId)
      .filter((code) => !filters.status || code.status === filters.status)
      .map((code) => this.redactRightsCode(code));
  }

  precheckAgentRightsCodes(actor: AgentActor, input: { agentProductId: string; codes: string[] }) {
    this.assertAgentDepositConfirmed(actor.agentId, "import own rights codes");
    const agentProduct = requireEntity(this.store.agentProducts.get(input.agentProductId), "RESOURCE_NOT_FOUND", "agent product not found");
    assertAgentScope(actor, agentProduct);
    if (agentProduct.productType !== "agent_owned") {
      throw new ApiError(400, "RIGHTS_CODE_PRODUCT_SCOPE_INVALID", "merchant can only import card codes for own reviewed products");
    }
    const ownProduct = requireEntity(this.store.ownProducts.get(required(agentProduct.ownProductReviewId, "ownProductReviewId")), "RESOURCE_NOT_FOUND", "own product not found");
    if (fulfillmentRuleMode(ownProduct.fulfillmentRule) !== "code_pool") {
      throw new ApiError(400, "RIGHTS_CODE_PRODUCT_MODE_INVALID", "own product must use automatic card-code fulfillment");
    }
    const precheck = this.analyzeRightsCodeImport(input.codes, (code) =>
      this.store.rightsCodes.some((item) => (item.agentProductId ?? item.productId) === agentProduct.id && item.code === code)
    );
    return this.redactRightsCodeImportPrecheck(precheck);
  }

  addAgentRightsCodes(actor: AgentActor, input: { agentProductId: string; codes: string[]; batchNo?: string }) {
    this.assertAgentDepositConfirmed(actor.agentId, "import own rights codes");
    const agentProduct = requireEntity(this.store.agentProducts.get(input.agentProductId), "RESOURCE_NOT_FOUND", "agent product not found");
    assertAgentScope(actor, agentProduct);
    if (agentProduct.productType !== "agent_owned") {
      throw new ApiError(400, "RIGHTS_CODE_PRODUCT_SCOPE_INVALID", "merchant can only import card codes for own reviewed products");
    }
    const ownProduct = requireEntity(this.store.ownProducts.get(required(agentProduct.ownProductReviewId, "ownProductReviewId")), "RESOURCE_NOT_FOUND", "own product not found");
    const rule = ownProduct.fulfillmentRule;
    if (!isRecord(rule) || rule.mode !== "code_pool") {
      throw new ApiError(400, "RIGHTS_CODE_PRODUCT_MODE_INVALID", "own product must use automatic card-code fulfillment");
    }
    ownProduct.fulfillmentRule = { ...rule, mode: "code_pool", extractCodeRequired: true };
    const precheck = this.analyzeRightsCodeImport(input.codes, (code) =>
      this.store.rightsCodes.some((item) => (item.agentProductId ?? item.productId) === agentProduct.id && item.code === code)
    );
    const importableCodes = precheck.details
      .filter((item) => item.action === "create")
      .map((item) => item.normalizedCode)
      .filter((code): code is string => Boolean(code));
    if (importableCodes.length === 0) throw new ApiError(400, "RIGHTS_CODE_EMPTY", "no importable card codes");
    const created: RightsCode[] = [];
    for (const code of importableCodes) {
      const item: RightsCode = {
        codeId: nextId(this.store, "code"),
        productId: agentProduct.id,
        agentProductId: agentProduct.id,
        code,
        batchNo: input.batchNo ?? "merchant",
        status: "available",
        createdAt: new Date()
      };
      this.store.rightsCodes.push(item);
      created.push(item);
    }
    this.audit("agent", "rights_code.agent_import", "agent_product", agentProduct.id, {
      count: created.length,
      batchNo: input.batchNo ?? "merchant",
      codeIds: created.map((code) => code.codeId)
    });
    return {
      count: created.length,
      createdCount: created.length,
      skippedCount: precheck.summary.skipped,
      failedCount: precheck.summary.failed,
      agentProduct,
      codes: created.map((code) => this.redactRightsCode(code)),
      details: this.redactRightsCodeImportPrecheck({
        ...precheck,
        details: precheck.details.map((item) =>
          item.action === "create"
            ? { ...item, codeId: created.find((code) => code.code === item.normalizedCode)?.codeId }
            : item
        )
      }).details,
      summary: precheck.summary
    };
  }

  fulfillOrder(actor: AdminActor, orderNo: string, input: { status: "success" | "failed"; attemptNo: number; evidence?: string; failReason?: string }) {
    assertAdminPermission(actor, "after_sale.arbitrate");
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    if (order.paymentStatus !== "paid") throw new ApiError(400, "STATE_NOT_ALLOWED", "only paid orders can be fulfilled");
    const record = this.store.fulfillmentRecords.get(orderNo) ?? {
      fulfillmentId: `fulfillment-${orderNo}`,
      orderItemId: `${orderNo}-item-1`,
      status: "not_started" as const,
      attemptCount: 0
    };
    const result = applyFulfillmentAttempt({ registry: this.registry, record, attemptNo: input.attemptNo, result: input });
    this.store.fulfillmentRecords.set(orderNo, record);
    order.fulfillmentStatus = record.status;
    order.status = result.orderStatus;
    if (record.status === "success" && !order.fulfilledAt) order.fulfilledAt = new Date();
    this.audit(actor.role, "fulfillment.update", "order", orderNo, input);
    return { ...result, order };
  }

  fulfillAgentOrder(actor: AgentActor, orderNo: string, input: { status: "success" | "failed"; attemptNo: number; evidence?: string; failReason?: string }) {
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertAgentScope(actor, { agentId: order.agentId, shopId: order.shopId });
    if (order.paymentStatus !== "paid") throw new ApiError(400, "STATE_NOT_ALLOWED", "only paid orders can be fulfilled");
    const record = this.store.fulfillmentRecords.get(orderNo) ?? {
      fulfillmentId: `fulfillment-${orderNo}`,
      orderItemId: `${orderNo}-item-1`,
      status: "not_started" as const,
      attemptCount: 0
    };
    const result = applyFulfillmentAttempt({ registry: this.registry, record, attemptNo: input.attemptNo, result: input });
    this.store.fulfillmentRecords.set(orderNo, record);
    order.fulfillmentStatus = record.status;
    order.status = result.orderStatus;
    if (record.status === "success" && !order.fulfilledAt) order.fulfilledAt = new Date();
    this.audit("agent", "fulfillment.update", "order", orderNo, input);
    return { ...result, order };
  }

  listAgentAfterSales(actor: AgentActor) {
    return [...this.store.afterSales.values()].filter((afterSale) => {
      const order = this.store.orders.get(afterSale.orderNo);
      return order?.agentId === actor.agentId && order.shopId === actor.shopId;
    });
  }

  updateAgentAfterSaleAssist(actor: AgentActor, afterSaleNo: string, input: { note: string; evidenceUrl?: string }) {
    const afterSale = requireEntity(this.store.afterSales.get(afterSaleNo), "RESOURCE_NOT_FOUND", "after sale not found");
    const order = requireEntity(this.store.orders.get(afterSale.orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertAgentScope(actor, { agentId: order.agentId, shopId: order.shopId });
    this.audit("agent", "after_sale.agent_assist", "after_sale", afterSale.afterSaleNo, input);
    return { status: "recorded" as const, afterSale };
  }

  allocateRefundForAdmin(actor: AdminActor, input: RefundAllocationRequest) {
    assertAdminPermission(actor, "after_sale.arbitrate");
    try {
      return allocateRefund(input);
    } catch (error) {
      throw new ApiError(400, "REFUND_ALLOCATION_FAILED", getErrorMessage(error));
    }
  }

  approveRefund(actor: AdminActor, afterSaleNo: string, input: {
    refundAmountCents: bigint;
    responsibility: RefundResponsibility;
    platformBearCents?: bigint;
    agentBearCents?: bigint;
    serviceFeeBearer?: "platform" | "agent" | "mixed" | "none";
  }) {
    assertAdminPermission(actor, "after_sale.arbitrate");
    const afterSale = requireEntity(this.store.afterSales.get(afterSaleNo), "RESOURCE_NOT_FOUND", "after sale not found");
    const order = requireEntity(this.store.orders.get(afterSale.orderNo), "RESOURCE_NOT_FOUND", "order not found");
    let allocation: ReturnType<typeof allocateRefund>;
    try {
      allocation = allocateRefund({
        paidAmountCents: order.snapshot.amountSnapshot.paidAmountCents,
        supplyAmountCents: order.snapshot.amountSnapshot.supplyAmountCents,
        agentIncomeCents: order.snapshot.amountSnapshot.agentExpectedIncomeCents,
        alreadyRefundedCents: order.refundedAmountCents,
        refundAmountCents: input.refundAmountCents,
        responsibility: input.responsibility,
        platformBearCents: input.platformBearCents,
        agentBearCents: input.agentBearCents,
        serviceFeeBearer: input.serviceFeeBearer
      });
    } catch (error) {
      throw new ApiError(400, "REFUND_ALLOCATION_FAILED", getErrorMessage(error));
    }
    const wasSettlementGenerated = order.settlementStatus === "settled" || order.settlementStatus === "settling";
    afterSale.status = "refunding";
    afterSale.allocation = allocation;
    order.status = "refunding";
    order.refundStatus = "refunding";
    if (!wasSettlementGenerated) order.settlementStatus = "frozen";
    const refund: DemoRefund = {
      refundNo: nextId(this.store, "refund"),
      afterSaleNo,
      orderNo: order.orderNo,
      amountCents: allocation.refundAmountCents,
      agentClawbackCents: allocation.agentTotalCostCents,
      wasSettled: wasSettlementGenerated,
      status: "pending"
    };
    this.store.refunds.set(refund.refundNo, refund);
    if (order.couponId) {
      const coupon = this.store.userCoupons.get(order.couponId);
      if (coupon) coupon.status = "voided_after_refund";
    }
    this.audit(actor.role, "refund.approve", "after_sale", afterSaleNo, allocation);
    return { refund, allocation };
  }

  confirmManualRefund(actor: AdminActor, refundNo: string, input: { channelRefundNo?: string; voucherUrl?: string; note?: string }) {
    assertAdminPermission(actor, "settlement.confirm");
    const refund = requireEntity(this.store.refunds.get(refundNo), "RESOURCE_NOT_FOUND", "refund not found");
    const idempotencyKey = `manual-refund:${refundNo}:${input.channelRefundNo ?? input.voucherUrl ?? "confirmation"}`;
    const result = this.registry.runOnce(idempotencyKey, () => {
      const applied = this.markRefundSucceeded(refund, {
        channelRefundNo: input.channelRefundNo,
        voucherUrl: input.voucherUrl,
        note: input.note,
        source: "manual"
      });
      this.audit(actor.role, "refund.manual_confirm", "refund", refund.refundNo, {
        idempotencyKey,
        channelRefundNo: input.channelRefundNo,
        voucherUrl: input.voucherUrl,
        note: input.note
      });
      return { status: "processed" as const, idempotencyKey, ...applied };
    });
    return result ?? { status: "duplicate" as const, idempotencyKey, refund };
  }

  confirmOfflinePayment(actor: AdminActor, orderNo: string, input: { amountCents: bigint; voucherUrl?: string; note?: string }) {
    assertAdminPermission(actor, "settlement.confirm");
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    const expectedAmount = payableAmount(order);
    if (order.paymentSnapshot?.provider && order.paymentSnapshot.provider !== "personal_alipay") {
      throw new ApiError(400, "MANUAL_CONFIRM_NOT_ALLOWED", "only personal alipay orders can be manually confirmed");
    }
    if (input.amountCents !== expectedAmount) {
      throw new ApiError(400, "AMOUNT_MISMATCH", "offline payment amount does not match order amount");
    }
    const idempotencyKey = `offline-payment:${orderNo}:${input.voucherUrl ?? expectedAmount.toString()}`;
    const result = this.registry.runOnce(idempotencyKey, () => {
      if (order.paymentStatus === "paid") {
        return { status: "already_paid" as const, idempotencyKey, order: this.serializePublicOrder(order, { includeDeliveryCodes: false }) };
      }
      order.paymentStatus = "paid";
      order.status = "fulfilling";
      order.fulfillmentStatus = "processing";
      order.paidAt = new Date();
      if (order.salesChannelType !== "platform_self_operated") {
        this.store.pendingIncomeByAgent.set(order.agentId, (this.store.pendingIncomeByAgent.get(order.agentId) ?? 0n) + order.snapshot.amountSnapshot.agentExpectedIncomeCents);
        this.addChannelPendingIncome(order);
      }
      this.ledger("OFFLINE_PAYMENT_CONFIRMED", { orderNo: order.orderNo, agentId: order.agentId }, expectedAmount, {
        voucherUrl: input.voucherUrl,
        note: input.note,
        operatorId: actor.adminId
      });
      this.tryAutoFulfillWithRightsCode(order);
      this.audit(actor.role, "order.offline_payment.confirm", "order", order.orderNo, {
        amountCents: input.amountCents,
        voucherUrl: input.voucherUrl,
        note: input.note
      });
      return { status: "processed" as const, idempotencyKey, order: this.serializePublicOrder(order, { includeDeliveryCodes: false }) };
    });
    return result ?? { status: "duplicate" as const, idempotencyKey, order: this.serializePublicOrder(order, { includeDeliveryCodes: false }) };
  }

  paymentCallback(input: { channel: string; channelTradeNo: string; orderNo: string; amountCents: bigint }) {
    if (input.channel === "mock" && !mockPaymentEnabled()) {
      throw new ApiError(403, "MOCK_PAYMENT_DISABLED", "mock payment callback is disabled in this runtime");
    }
    const order = requireEntity(this.store.orders.get(input.orderNo), "RESOURCE_NOT_FOUND", "order not found");
    try {
      const result = processPaymentCallback({
        provider: this.paymentProvider,
        registry: this.registry,
        payload: input,
        order: {
          orderNo: order.orderNo,
          paidAmountCents: payableAmount(order),
          paymentStatus: order.paymentStatus
        },
        onProcessed: () => {
          order.paymentStatus = "paid";
          order.status = "fulfilling";
          order.fulfillmentStatus = "processing";
          order.paidAt = new Date();
          if (order.salesChannelType !== "platform_self_operated") {
            this.store.pendingIncomeByAgent.set(order.agentId, (this.store.pendingIncomeByAgent.get(order.agentId) ?? 0n) + order.snapshot.amountSnapshot.agentExpectedIncomeCents);
            this.addChannelPendingIncome(order);
          }
          this.ledger("PAYMENT_SUCCEEDED", { orderNo: order.orderNo, agentId: order.agentId }, order.snapshot.amountSnapshot.paidAmountCents, { channel: input.channel });
          this.tryAutoFulfillWithRightsCode(order);
        }
      });
      this.audit("system", "payment.callback", "order", order.orderNo, result);
      return result;
    } catch (error) {
      throw new ApiError(400, "PAYMENT_CALLBACK_REJECTED", getErrorMessage(error));
    }
  }

  paymentProviderCallback(provider: PaymentProviderType, input: {
    orderNo?: string;
    providerTradeNo: string;
    amountCents: bigint;
    merchantNo?: string;
    appId?: string;
    serviceProviderId?: string;
    tradeStatus: string;
    signature: string;
    rawPayload?: unknown;
  }) {
    const order = input.orderNo ? this.store.orders.get(input.orderNo) : undefined;
    const method = this.findPaymentMethodForCallback(provider, input, order);
    const logBase = {
      id: nextId(this.store, "pay-callback"),
      provider,
      orderNo: input.orderNo,
      providerTradeNo: input.providerTradeNo,
      amountCents: input.amountCents,
      merchantNoMasked: maskSecret(input.merchantNo),
      appIdMasked: maskSecret(input.appId),
      serviceProviderMasked: maskSecret(input.serviceProviderId),
      rawPayloadMasked: this.maskPaymentPayload(input.rawPayload ?? input),
      receivedAt: new Date()
    };
    if (!method || !this.verifyPaymentSignature(method, input.orderNo ?? "", input.amountCents, input.providerTradeNo, input.signature)) {
      const exception = this.recordPaymentException({
        ...logBase,
        orderNo: input.orderNo,
        reasonCode: "SIGNATURE_INVALID",
        reason: "payment callback signature verification failed",
        handled: false
      });
      this.store.paymentCallbackLogs.push({ ...logBase, verified: false, status: "rejected", exceptionId: exception.id });
      throw new ApiError(400, "PAYMENT_CALLBACK_SIGNATURE_INVALID", "payment callback signature verification failed");
    }
    const orderEntity = order ?? this.store.orders.get(input.orderNo ?? "");
    if (!orderEntity) {
      const exception = this.recordPaymentException({
        ...logBase,
        reasonCode: "ORDER_NOT_FOUND",
        reason: "payment callback order not found",
        handled: false
      });
      this.store.paymentCallbackLogs.push({ ...logBase, verified: true, status: "exception", exceptionId: exception.id });
      throw new ApiError(404, "PAYMENT_CALLBACK_ORDER_NOT_FOUND", "payment callback order not found");
    }
    const result = this.applyVerifiedPaymentResult({
      order: orderEntity,
      method,
      providerTradeNo: input.providerTradeNo,
      amountCents: input.amountCents,
      merchantNo: input.merchantNo,
      appId: input.appId,
      serviceProviderId: input.serviceProviderId,
      tradeStatus: input.tradeStatus,
      source: "callback",
      logBase
    });
    this.store.paymentCallbackLogs.push({
      ...logBase,
      orderNo: orderEntity.orderNo,
      verified: true,
      status: result.status === "processed" || result.status === "duplicate" ? "accepted" : "exception",
      exceptionId: "exception" in result ? result.exception.id : undefined
    });
    return result;
  }

  queryPaymentOrder(actor: AdminActor, orderNo: string, input: {
    providerTradeNo: string;
    amountCents: bigint;
    merchantNo?: string;
    appId?: string;
    serviceProviderId?: string;
    tradeStatus: string;
    signature: string;
  }) {
    assertAdminPermission(actor, "settlement.confirm");
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    const method = this.resolvePaymentMethodFromOrder(order);
    if (method.provider === "personal_alipay") throw new ApiError(400, "PAYMENT_QUERY_NOT_SUPPORTED", "personal alipay does not support automatic query confirmation");
    if (!this.verifyPaymentSignature(method, order.orderNo, input.amountCents, input.providerTradeNo, input.signature)) {
      const exception = this.recordPaymentException({
        id: nextId(this.store, "pay-exception"),
        provider: method.provider,
        orderNo: order.orderNo,
        providerTradeNo: input.providerTradeNo,
        amountCents: input.amountCents,
        reasonCode: "SIGNATURE_INVALID",
        reason: "payment query signature verification failed",
        handled: false,
        receivedAt: new Date()
      });
      throw new ApiError(400, "PAYMENT_QUERY_SIGNATURE_INVALID", exception.reason);
    }
    return this.applyVerifiedPaymentResult({
      order,
      method,
      providerTradeNo: input.providerTradeNo,
      amountCents: input.amountCents,
      merchantNo: input.merchantNo,
      appId: input.appId,
      serviceProviderId: input.serviceProviderId,
      tradeStatus: input.tradeStatus,
      source: "query",
      logBase: {
        id: nextId(this.store, "pay-query"),
        provider: method.provider,
        orderNo: order.orderNo,
        providerTradeNo: input.providerTradeNo,
        amountCents: input.amountCents,
        receivedAt: new Date()
      }
    });
  }

  listPaymentCallbackLogs(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return this.store.paymentCallbackLogs;
  }

  listPaymentExceptions(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return this.store.paymentExceptions;
  }

  handlePaymentException(actor: AdminActor, exceptionId: string, input: { action: "mark_handled" | "keep_exception"; note?: string }) {
    assertAdminPermission(actor, "settlement.confirm");
    const exception = requireEntity(this.store.paymentExceptions.find((item) => item.id === exceptionId), "RESOURCE_NOT_FOUND", "payment exception not found");
    exception.handled = input.action === "mark_handled";
    exception.handledBy = actor.adminId;
    exception.handledAt = new Date();
    exception.note = input.note;
    this.audit(actor.role, "payment_exception.handle", "payment_exception", exception.id, input);
    return exception;
  }

  refundCallback(input: { channel: string; channelRefundNo: string; refundNo: string }) {
    if (input.channel === "mock" && !mockPaymentEnabled()) {
      throw new ApiError(403, "MOCK_PAYMENT_DISABLED", "mock refund callback is disabled in this runtime");
    }
    const refund = requireEntity(this.store.refunds.get(input.refundNo), "RESOURCE_NOT_FOUND", "refund not found");
    const idempotencyKey = refundCallbackKey(input.channel, input.channelRefundNo);
    const result = this.registry.runOnce(idempotencyKey, () => {
      const applied = this.markRefundSucceeded(refund, {
        channelRefundNo: input.channelRefundNo,
        source: input.channel
      });
      this.audit("system", "refund.callback", "refund", refund.refundNo, { idempotencyKey });
      return { status: "processed" as const, idempotencyKey, ...applied };
    });
    return result ?? { status: "duplicate" as const, idempotencyKey };
  }

  private markRefundSucceeded(refund: DemoRefund, input: { channelRefundNo?: string; voucherUrl?: string; note?: string; source: string }) {
    if (refund.status === "refunded") {
      const existingOrder = requireEntity(this.store.orders.get(refund.orderNo), "RESOURCE_NOT_FOUND", "order not found");
      return { refund, order: existingOrder };
    }
    const order = requireEntity(this.store.orders.get(refund.orderNo), "RESOURCE_NOT_FOUND", "order not found");
    const afterSale = this.store.afterSales.get(refund.afterSaleNo);
    refund.status = "refunded";
    refund.channelRefundNo = input.channelRefundNo;
    refund.voucherUrl = input.voucherUrl;
    refund.note = input.note;
    refund.confirmedAt = new Date();
    if (afterSale) afterSale.status = "refunded";
    order.refundedAmountCents += refund.amountCents;
    order.refundStatus = "refunded";
    order.status = "refunded";
    order.settlementStatus = "frozen";
    this.ledger("REFUND_SUCCEEDED", { orderNo: order.orderNo, agentId: order.agentId }, refund.amountCents, {
      refundNo: refund.refundNo,
      source: input.source,
      channelRefundNo: input.channelRefundNo,
      voucherUrl: input.voucherUrl
    });

    if (order.salesChannelType === "platform_self_operated") {
      refund.pendingIncomeDeductedCents = 0n;
    } else if (refund.wasSettled) {
      this.createClawback(order, refund.agentClawbackCents, "refund", refund.refundNo);
    } else {
      const pending = this.store.pendingIncomeByAgent.get(order.agentId) ?? 0n;
      const deduction = pending > refund.agentClawbackCents ? refund.agentClawbackCents : pending;
      this.store.pendingIncomeByAgent.set(order.agentId, pending - deduction);
      refund.pendingIncomeDeductedCents = deduction;
    }
    if (order.couponId) {
      const coupon = this.store.userCoupons.get(order.couponId);
      if (coupon) coupon.status = "voided_after_refund";
    }
    return { refund, order, afterSale };
  }

  generateSettlement(actor: AdminActor, input: { agentId: string; now?: Date; batchNo: string }) {
    assertAdminPermission(actor, "settlement.generate");
    const idempotencyKey = `settlement:${input.agentId}:all:${input.batchNo}`;
    const duplicate = this.store.settlementSheets.find((sheet) => sheet.idempotencyKey === idempotencyKey);
    if (duplicate) return { status: "duplicate" as const, sheet: duplicate };
    const now = input.now ?? new Date();
    const orders = [...this.store.orders.values()]
      .filter((order) => order.salesChannelType !== "platform_self_operated")
      .flatMap((order) => {
        const channel = getChannelSnapshot(order.snapshot);
        const drafts: Array<SettlementCandidateDraft & { settlementRole: string }> = [];
        if (channel?.firstTierAgentId === input.agentId) {
          drafts.push({
            orderId: order.orderNo,
            settlementRole: "first_tier",
            agentId: channel.firstTierAgentId,
            shopId: channel.firstTierShopId,
            paymentStatus: order.paymentStatus,
            fulfillmentStatus: order.fulfillmentStatus,
            settlementStatus: order.settlementStatus,
            refundStatus: order.refundStatus,
            riskStatus: order.riskStatus,
            complaintStatus: order.complaintStatus,
            fulfilledAt: order.fulfilledAt,
            now,
            paidAmountCents: order.snapshot.amountSnapshot.paidAmountCents,
            supplyAmountCents: channel.platformSupplyPriceCents,
            serviceFeeCents: 0n,
            agentIncomeCents: channel.firstTierIncomeCents
          });
        }
        if (channel?.thirdTierAgentId && channel.secondTierAgentId === input.agentId) {
          drafts.push({
            orderId: order.orderNo,
            settlementRole: "second_tier",
            agentId: channel.secondTierAgentId,
            shopId: channel.secondTierShopId,
            paymentStatus: order.paymentStatus,
            fulfillmentStatus: order.fulfillmentStatus,
            settlementStatus: order.settlementStatus,
            refundStatus: order.refundStatus,
            riskStatus: order.riskStatus,
            complaintStatus: order.complaintStatus,
            fulfilledAt: order.fulfilledAt,
            now,
            paidAmountCents: order.snapshot.amountSnapshot.paidAmountCents,
            supplyAmountCents: channel.firstTierSupplyPriceCents,
            serviceFeeCents: 0n,
            agentIncomeCents: channel.secondTierIncomeCents
          });
        }
        if (order.agentId === input.agentId) drafts.push({
          orderId: order.orderNo,
          settlementRole: channel?.thirdTierAgentId ? "third_tier" : channel ? "second_tier" : "single_agent",
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
        });
        return drafts;
      });
    const candidates = orders.filter((order) => !this.store.settlementItemKeys.has(`${order.orderId}:${order.settlementRole}:${order.agentId}`));
    const items = buildSettlementItems(candidates, [], input.agentId).map((item) => {
      const source = candidates.find((candidate) => candidate.orderId === item.orderId && candidate.agentId === item.agentId);
      return { ...item, settlementRole: source?.settlementRole ?? "single_agent" };
    });
    const sheet: SettlementSheet = {
      settlementNo: nextId(this.store, "settlement"),
      agentId: input.agentId,
      idempotencyKey,
      status: "confirmed",
      items,
      totalOrderCount: items.length,
      totalPaidCents: sum(items.map((item) => item.paidAmountCents)),
      totalServiceFeeCents: sum(items.map((item) => item.serviceFeeCents)),
      totalAgentIncomeCents: sum(items.map((item) => item.agentIncomeCents))
    };
    for (const item of items) {
      this.store.settlementItemKeys.add(`${item.orderId}:${item.settlementRole}:${item.agentId}`);
      const order = this.store.orders.get(item.orderId);
      if (order) {
        const channel = getChannelSnapshot(order.snapshot);
        if (!channel || (!channel.thirdTierAgentId && item.settlementRole === "second_tier") || (channel.thirdTierAgentId && item.settlementRole === "third_tier")) {
          order.settlementStatus = "settling";
        }
      }
    }
    const pending = this.store.pendingIncomeByAgent.get(input.agentId) ?? 0n;
    this.store.pendingIncomeByAgent.set(input.agentId, pending > sheet.totalAgentIncomeCents ? pending - sheet.totalAgentIncomeCents : 0n);
    this.store.payableIncomeByAgent.set(input.agentId, (this.store.payableIncomeByAgent.get(input.agentId) ?? 0n) + sheet.totalAgentIncomeCents);
    this.store.settlementSheets.push(sheet);
    this.audit(actor.role, "settlement.generate", "settlement", sheet.settlementNo, { count: items.length });
    this.ledger("SETTLEMENT_GENERATED", { agentId: input.agentId }, sheet.totalAgentIncomeCents, { settlementNo: sheet.settlementNo });
    return { status: "processed" as const, sheet };
  }

  confirmManualPayout(actor: AdminActor, settlementNo: string, input: { voucherUrl: string; payoutMethod?: string }) {
    assertAdminPermission(actor, "payout.confirm");
    const sheet = requireEntity(this.store.settlementSheets.find((candidate) => candidate.settlementNo === settlementNo), "RESOURCE_NOT_FOUND", "settlement not found");
    if (sheet.status === "paid") return { status: "duplicate" as const, sheet };
    sheet.status = "paid";
    for (const item of sheet.items) {
      const order = this.store.orders.get(item.orderId);
      if (order) order.settlementStatus = "settled";
    }
    const payable = this.store.payableIncomeByAgent.get(sheet.agentId) ?? 0n;
    this.store.payableIncomeByAgent.set(sheet.agentId, payable > sheet.totalAgentIncomeCents ? payable - sheet.totalAgentIncomeCents : 0n);
    this.store.paidIncomeByAgent.set(sheet.agentId, (this.store.paidIncomeByAgent.get(sheet.agentId) ?? 0n) + sheet.totalAgentIncomeCents);
    const payout = {
      payoutNo: nextId(this.store, "payout"),
      settlementNo,
      agentId: sheet.agentId,
      amountCents: sheet.totalAgentIncomeCents,
      status: "paid",
      voucherUrl: input.voucherUrl,
      payoutMethod: input.payoutMethod ?? "manual"
    };
    this.store.manualPayouts.push(payout);
    this.audit(actor.role, "manual_payout.confirm", "settlement", settlementNo, payout);
    this.ledger("PAYOUT_CONFIRMED", { agentId: sheet.agentId }, sheet.totalAgentIncomeCents, { settlementNo });
    return { status: "processed" as const, sheet, payout };
  }

  deductDeposit(actor: AdminActor, agentId: string, input: { amountCents: bigint; sourceType: string; sourceId: string; reasonCode: string }) {
    assertAdminPermission(actor, "deposit.manage");
    const account = requireEntity(this.store.depositAccounts.get(agentId), "RESOURCE_NOT_FOUND", "deposit account not found");
    const result = deductDeposit({ registry: this.registry, account, ...input });
    if (result.status === "processed") {
      const agent = this.store.agents.get(agentId);
      if (agent && result.restricted) agent.depositStatus = "insufficient";
      this.addDepositTransaction(agentId, {
        type: "deduct",
        amountCents: result.deductedAmountCents,
        balanceBeforeCents: result.balanceBeforeCents,
        balanceAfterCents: result.balanceAfterCents,
        reasonCode: input.reasonCode,
        relatedType: input.sourceType,
        relatedId: input.sourceId,
        idempotencyKey: result.idempotencyKey
      });
    }
    this.audit(actor.role, "deposit.deduct", "agent", agentId, result);
    this.ledger("DEPOSIT_DEDUCTED", { agentId }, result.status === "processed" ? result.deductedAmountCents : 0n, { sourceType: input.sourceType, sourceId: input.sourceId });
    return result;
  }

  createRiskFreeze(actor: AdminActor, input: {
    targetType: "order" | "shop" | "agent" | "product" | "settlement";
    targetId: string;
    freezeType: "order_frozen" | "shop_frozen" | "settlement_restricted" | "product_removed" | "disabled";
    reasonCode: string;
  }) {
    assertAdminPermission(actor, "risk.freeze");
    const key = `${input.targetType}:${input.targetId}:${input.freezeType}`;
    if (this.store.activeRiskFreezeKeys.has(key)) return { status: "duplicate" as const, key };
    this.store.activeRiskFreezeKeys.add(key);
    const freeze = { id: nextId(this.store, "risk"), ...input, status: "active", createdAt: new Date(), releasedAt: null };
    this.store.riskFreezes.push(freeze);
    if (input.targetType === "order") {
      const order = requireEntity(this.store.orders.get(input.targetId), "RESOURCE_NOT_FOUND", "order not found");
      order.riskStatus = input.freezeType;
      order.settlementStatus = "frozen";
    }
    if (input.targetType === "shop") {
      const shop = requireEntity(this.store.shops.get(input.targetId), "RESOURCE_NOT_FOUND", "shop not found");
      shop.riskStatus = input.freezeType;
      if (input.freezeType === "shop_frozen") shop.status = "frozen";
      if (input.freezeType === "disabled") shop.status = "disabled";
    }
    if (input.targetType === "agent") {
      const agent = requireEntity(this.store.agents.get(input.targetId), "RESOURCE_NOT_FOUND", "agent not found");
      agent.riskStatus = input.freezeType;
      if (input.freezeType === "disabled") agent.status = "disabled";
      if (input.freezeType === "shop_frozen") agent.status = "frozen";
    }
    if (input.targetType === "product") {
      const product = this.store.platformProducts.get(input.targetId);
      const agentProduct = this.store.agentProducts.get(input.targetId);
      if (product) product.status = "risk_removed";
      if (agentProduct) agentProduct.status = "risk_removed";
      if (!product && !agentProduct) throw new ApiError(404, "RESOURCE_NOT_FOUND", "product not found");
    }
    this.audit(actor.role, "risk.freeze", input.targetType, input.targetId, input);
    return { status: "processed" as const, key, freeze };
  }

  listRiskFreezes(actor: AdminActor) {
    assertAdminPermission(actor, "risk.freeze");
    return this.store.riskFreezes;
  }

  releaseRiskFreeze(actor: AdminActor, freezeId: string) {
    assertAdminPermission(actor, "risk.freeze");
    const freeze = requireEntity(this.store.riskFreezes.find((item) => item.id === freezeId), "RESOURCE_NOT_FOUND", "risk freeze not found");
    freeze.status = "released";
    freeze.releasedAt = new Date();
    this.store.activeRiskFreezeKeys.delete(`${freeze.targetType}:${freeze.targetId}:${freeze.freezeType}`);
    this.audit(actor.role, "risk.release", String(freeze.targetType), String(freeze.targetId), freeze);
    return freeze;
  }

  listAuditLogs(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return this.store.auditLogs;
  }

  listLedgerEntries(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return this.store.ledgerEntries;
  }

  reconciliationSummary(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    const orders = [...this.store.orders.values()];
    const platformSelfOperatedOrders = orders.filter((order) => order.salesChannelType === "platform_self_operated" && order.paymentStatus === "paid");
    return {
      totalPaidCents: sum(orders.filter((order) => order.paymentStatus === "paid").map((order) => order.snapshot.amountSnapshot.paidAmountCents)),
      totalRefundedCents: sum(orders.map((order) => order.refundedAmountCents)),
      totalServiceFeeCents: sum(orders.filter((order) => order.paymentStatus === "paid").map((order) => order.snapshot.amountSnapshot.serviceFeeCents)),
      totalAgentIncomeCents: sum(orders.filter((order) => order.paymentStatus === "paid").map((order) => order.snapshot.amountSnapshot.agentExpectedIncomeCents)),
      platformSelfOperatedPaidCents: sum(platformSelfOperatedOrders.map((order) => order.snapshot.amountSnapshot.paidAmountCents)),
      platformSelfOperatedGrossMarginCents: sum(platformSelfOperatedOrders.map((order) => getPlatformSelfGrossMargin(order.snapshot))),
      settlementCount: this.store.settlementSheets.length,
      payoutCount: this.store.manualPayouts.length,
      clawbackCount: this.store.clawbacks.length,
      depositAvailableCents: sum([...this.store.depositAccounts.values()].map((account) => account.availableAmountCents))
    };
  }

  exportReconciliationSummary(actor: AdminActor) {
    const summary = this.reconciliationSummary(actor);
    this.audit(actor.role, "export.reconciliation_summary", "export", "reconciliation-summary", {
      totalPaidCents: summary.totalPaidCents,
      totalRefundedCents: summary.totalRefundedCents,
      settlementCount: summary.settlementCount,
      payoutCount: summary.payoutCount
    });
    return summary;
  }

  adminSalesDashboard(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    const orders = [...this.store.orders.values()];
    const paidOrders = orders.filter((order) => order.paymentStatus === "paid");
    const fulfilledOrders = orders.filter((order) => order.fulfillmentStatus === "success");
    const afterSaleOrders = orders.filter((order) => order.refundStatus !== "none");
    const productRows = [...this.store.platformProducts.values()].map((product) => {
      const relatedOrders = orders.filter((order) => getSnapshotProductId(order.snapshot) === product.id);
      const paid = relatedOrders.filter((order) => order.paymentStatus === "paid");
      const mode = isRecord(product.fulfillmentRule) ? String(product.fulfillmentRule.mode ?? "manual") : "manual";
      return {
        productId: product.id,
        name: product.name,
        category: product.category,
        fulfillmentMode: mode === "code_pool" ? "自动发码" : "人工交付",
        stockCount: product.stockCount,
        soldCount: product.soldCount,
        paidOrderCount: paid.length,
        totalPaidCents: sum(paid.map((order) => order.snapshot.amountSnapshot.paidAmountCents)),
        availableCodeCount: this.store.rightsCodes.filter((code) => code.productId === product.id && code.status === "available").length,
        issuedCodeCount: this.store.rightsCodes.filter((code) => code.productId === product.id && code.status === "issued").length
      };
    });
    const shopRows = [...this.store.shops.values()].map((shop) => {
      const shopOrders = orders.filter((order) => order.shopId === shop.id);
      const paid = shopOrders.filter((order) => order.paymentStatus === "paid");
      return {
        shopId: shop.id,
        name: shop.name,
        ownerType: shop.ownerType ?? "agent",
        orderCount: shopOrders.length,
        paidOrderCount: paid.length,
        totalPaidCents: sum(paid.map((order) => order.snapshot.amountSnapshot.paidAmountCents)),
        refundOrderCount: shopOrders.filter((order) => order.refundStatus !== "none").length
      };
    });
    return {
      orderCount: orders.length,
      paidOrderCount: paidOrders.length,
      fulfilledOrderCount: fulfilledOrders.length,
      afterSaleOrderCount: afterSaleOrders.length,
      totalPaidCents: sum(paidOrders.map((order) => order.snapshot.amountSnapshot.paidAmountCents)),
      totalRefundedCents: sum(orders.map((order) => order.refundedAmountCents)),
      averageOrderPaidCents: paidOrders.length === 0 ? 0n : sum(paidOrders.map((order) => order.snapshot.amountSnapshot.paidAmountCents)) / BigInt(paidOrders.length),
      productRows,
      shopRows
    };
  }

  adminRiskDashboard(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    const orders = [...this.store.orders.values()];
    const paidOrders = orders.filter((order) => order.paymentStatus === "paid");
    const refundOrders = orders.filter((order) => order.refundStatus === "refunded" || order.refundStatus === "refunding");
    const lowDepositAgents = [...this.store.depositAccounts.values()]
      .filter((account) => account.availableAmountCents < account.requiredAmountCents / 5n)
      .map((account) => ({ agentId: account.agentId, availableAmountCents: account.availableAmountCents, requiredAmountCents: account.requiredAmountCents }));
    const lowStockProducts = this.listPlatformProducts()
      .map((product) => ({
        productId: product.id,
        name: product.name,
        category: product.category,
        stockCount: product.stockCount,
        availableCodeCount: this.store.rightsCodes.filter((code) => code.productId === product.id && code.status === "available").length
      }))
      .filter((item) => item.availableCodeCount > 0 && item.availableCodeCount < 5);
    return {
      paidOrderCount: paidOrders.length,
      refundOrderCount: refundOrders.length,
      refundRateBps: paidOrders.length === 0 ? 0 : Math.round((refundOrders.length / paidOrders.length) * 10_000),
      activeRiskFreezeCount: this.store.riskFreezes.filter((freeze) => freeze.status === "active").length,
      lowDepositAgents,
      lowStockProducts,
      pendingAfterSaleCount: [...this.store.afterSales.values()].filter((item) => item.status === "pending").length
    };
  }

  listNotifications(actor: AgentActor) {
    return this.store.notifications.filter((item) => item.agentId === actor.agentId);
  }

  markNotificationRead(actor: AgentActor, notificationId: string) {
    const notification = requireEntity(
      this.store.notifications.find((item) => item.id === notificationId && item.agentId === actor.agentId),
      "RESOURCE_NOT_FOUND",
      "notification not found"
    );
    notification.readAt = notification.readAt ?? new Date();
    return notification;
  }

  paymentOnboardingGuide() {
    return {
      status: "not_configured",
      reason: "微信/支付宝商户收款能力尚未开通；生产环境只展示已审核启用的商户收款通道。",
      requiredAccounts: [
        "已认证微信 H5/公众号 JSAPI 支付或支付宝商户主体",
        "微信支付商户号 MCH_ID",
        "商户 API v3 密钥",
        "商户 API 证书/私钥",
        "微信支付平台证书或公钥",
        "支付回调域名与退款回调域名"
      ],
      setupSteps: [
        "完成微信或支付宝商户主体认证。",
        "在支付商户平台申请并绑定 H5/网页支付能力。",
        "开通 H5/JSAPI 支付并配置结算银行账户。",
        "生成 API 证书，设置 API v3 密钥，保存证书序列号。",
        "配置支付通知 URL 和退款通知 URL，域名必须 HTTPS 且可公网访问。",
        "把 AppID、MCH_ID、API v3 密钥、证书路径、证书序列号写入服务端环境变量。",
        "上线前用真实 1 分钱订单完成支付、退款、回调、对账验证。"
      ],
      envVars: [
        "WECHAT_APP_ID",
        "WECHAT_MCH_ID",
        "WECHAT_PAY_API_KEY",
        "WECHAT_PAY_CERT_SERIAL_NO",
        "WECHAT_PAY_PRIVATE_KEY_PATH",
        "WECHAT_PAY_PLATFORM_CERT_PATH",
        "WECHAT_PAY_NOTIFY_URL",
        "WECHAT_REFUND_NOTIFY_URL"
      ],
      productionRule: "生产环境必须拒绝未验签的支付/退款回调，并只允许已审核启用的商户收款通道。"
    };
  }

  paymentConfigStatus(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return this.store.paymentChannelConfigs;
  }

  updatePaymentConfigMetadata(actor: AdminActor, input: { channel: PaymentChannel; enabled?: boolean; feeBps?: number; fixedFeeCents?: bigint; statusNote?: string }) {
    assertAdminPermission(actor, "payment_config.manage");
    const existing = this.store.paymentChannelConfigs.find((item) => item.channel === input.channel);
    const config = existing ?? {
      channel: input.channel,
      enabled: false,
      feeBps: 0,
      fixedFeeCents: 0n,
      statusNote: "not_configured",
      updatedAt: new Date()
    };
    config.enabled = input.enabled ?? config.enabled;
    config.feeBps = input.feeBps ?? config.feeBps;
    config.fixedFeeCents = input.fixedFeeCents ?? config.fixedFeeCents;
    config.statusNote = input.statusNote ?? config.statusNote;
    config.updatedAt = new Date();
    if (!existing) this.store.paymentChannelConfigs.push(config);
    this.audit(actor.role, "payment_config.update", "payment_channel", input.channel, config);
    return config;
  }

  checkPaymentConfig(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    const missing = requiredPaymentEnv().filter((name) => !process.env[name]);
    return {
      mockReady: mockPaymentEnabled(),
      productionReady: missing.length === 0 && !mockPaymentEnabled() && !allowDemoAuth(),
      missing,
      demoAuthEnabled: allowDemoAuth(),
      channels: this.store.paymentChannelConfigs
    };
  }

  listAdminPaymentMethods(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return [...this.store.paymentMethods.values()].map((method) => this.serializePaymentMethod(method));
  }

  upsertAdminPaymentMethod(actor: AdminActor, input: PaymentMethodUpsertInput) {
    assertAdminPermission(actor, "payment_config.manage");
    const method = this.upsertPaymentMethod("platform", actor.adminId, input);
    this.audit(actor.role, "payment_method.upsert", "payment_method", method.id, this.serializePaymentMethod(method));
    return this.serializePaymentMethod(method);
  }

  setAdminPaymentMethodDefault(actor: AdminActor, methodId: string) {
    assertAdminPermission(actor, "payment_config.manage");
    const method = requireEntity(this.store.paymentMethods.get(methodId), "RESOURCE_NOT_FOUND", "payment method not found");
    if (method.ownerType !== "platform") throw new ApiError(403, "PAYMENT_METHOD_SCOPE_FORBIDDEN", "admin default route only manages platform payment methods");
    this.setPaymentMethodDefault(method);
    this.audit(actor.role, "payment_method.default", "payment_method", method.id, this.serializePaymentMethod(method));
    return this.serializePaymentMethod(method);
  }

  deleteAdminPaymentMethod(actor: AdminActor, methodId: string) {
    assertAdminPermission(actor, "payment_config.manage");
    const method = requireEntity(this.store.paymentMethods.get(methodId), "RESOURCE_NOT_FOUND", "payment method not found");
    if (method.ownerType !== "platform") throw new ApiError(403, "PAYMENT_METHOD_SCOPE_FORBIDDEN", "admin delete route only manages platform payment methods");
    method.status = "disabled";
    method.enabled = false;
    method.updatedAt = new Date();
    this.audit(actor.role, "payment_method.disable", "payment_method", method.id, this.serializePaymentMethod(method));
    return this.serializePaymentMethod(method);
  }

  testAdminPaymentMethod(actor: AdminActor, methodId: string) {
    assertAdminPermission(actor, "payment_config.manage");
    const method = requireEntity(this.store.paymentMethods.get(methodId), "RESOURCE_NOT_FOUND", "payment method not found");
    const result = this.testPaymentMethod(method);
    this.audit(actor.role, "payment_method.test", "payment_method", method.id, result);
    return result;
  }

  listAgentPaymentMethods(actor: AgentActor) {
    this.getAgentShop(actor);
    return [...this.store.paymentMethods.values()]
      .filter((method) => method.ownerType === "agent" && method.agentId === actor.agentId && method.shopId === actor.shopId)
      .map((method) => this.serializePaymentMethod(method));
  }

  upsertAgentPaymentMethod(actor: AgentActor, input: PaymentMethodUpsertInput) {
    this.getAgentShop(actor);
    const method = this.upsertPaymentMethod("agent", actor.agentId, {
      ...input,
      agentId: actor.agentId,
      shopId: actor.shopId
    });
    this.audit("agent", "payment_method.upsert", "payment_method", method.id, this.serializePaymentMethod(method));
    return this.serializePaymentMethod(method);
  }

  setAgentPaymentMethodDefault(actor: AgentActor, methodId: string) {
    this.getAgentShop(actor);
    const method = requireEntity(this.store.paymentMethods.get(methodId), "RESOURCE_NOT_FOUND", "payment method not found");
    assertAgentScope(actor, { agentId: required(method.agentId, "agentId"), shopId: method.shopId });
    this.setPaymentMethodDefault(method);
    this.audit("agent", "payment_method.default", "payment_method", method.id, this.serializePaymentMethod(method));
    return this.serializePaymentMethod(method);
  }

  deleteAgentPaymentMethod(actor: AgentActor, methodId: string) {
    this.getAgentShop(actor);
    const method = requireEntity(this.store.paymentMethods.get(methodId), "RESOURCE_NOT_FOUND", "payment method not found");
    assertAgentScope(actor, { agentId: required(method.agentId, "agentId"), shopId: method.shopId });
    method.status = "disabled";
    method.enabled = false;
    method.updatedAt = new Date();
    this.audit("agent", "payment_method.disable", "payment_method", method.id, this.serializePaymentMethod(method));
    return this.serializePaymentMethod(method);
  }

  testAgentPaymentMethod(actor: AgentActor, methodId: string) {
    this.getAgentShop(actor);
    const method = requireEntity(this.store.paymentMethods.get(methodId), "RESOURCE_NOT_FOUND", "payment method not found");
    assertAgentScope(actor, { agentId: required(method.agentId, "agentId"), shopId: method.shopId });
    const result = this.testPaymentMethod(method);
    this.audit("agent", "payment_method.test", "payment_method", method.id, result);
    return result;
  }

  listServiceQrCodes(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return [...this.store.shops.values()].map((shop) => ({
      shopId: shop.id,
      ownerType: shop.ownerType ?? "agent",
      agentId: shop.agentId,
      name: shop.name,
      customerServiceWechat: shop.customerServiceWechat,
      customerServiceQrUrl: shop.customerServiceQrUrl,
      customerServiceQq: shop.customerServiceQq,
      customerServiceQqQrUrl: shop.customerServiceQqQrUrl,
      customerServiceNote: shop.customerServiceNote,
      status: shop.status
    }));
  }

  listCollectionChannels(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return [...this.store.collectionChannels.values()];
  }

  listPublicCollectionChannels(shopId: string) {
    this.getShop(shopId);
    return [...this.store.collectionChannels.values()]
      .filter((channel) => channel.shopId === shopId && channel.status === "active" && channel.reviewStatus === "approved")
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.sortOrder - right.sortOrder)
      .map((channel) => this.serializePublicCollectionChannel(channel));
  }

  listAgentCollectionChannels(actor: AgentActor) {
    this.getAgentShop(actor);
    return [...this.store.collectionChannels.values()].filter((channel) => channel.shopId === actor.shopId && channel.agentId === actor.agentId);
  }

  submitAgentCollectionChannel(actor: AgentActor, input: {
    channelType: CollectionChannelType;
    displayName: string;
    accountName?: string;
    qrUrl?: string;
    paymentUrl?: string;
    isDefault?: boolean;
    sortOrder?: number;
    dailyLimitCents?: bigint;
    singleOrderLimitCents?: bigint;
  }) {
    this.getAgentShop(actor);
    const channel: CollectionChannel = {
      id: nextId(this.store, "collection"),
      shopId: actor.shopId,
      agentId: actor.agentId,
      ownerType: "agent",
      channelType: input.channelType,
      displayName: input.displayName,
      accountName: input.accountName,
      qrUrl: input.qrUrl,
      paymentUrl: input.paymentUrl,
      status: "pending_review",
      reviewStatus: "pending_review",
      reviewedBy: null,
      reviewedAt: null,
      isDefault: input.isDefault ?? false,
      sortOrder: input.sortOrder ?? 100,
      dailyLimitCents: input.dailyLimitCents,
      singleOrderLimitCents: input.singleOrderLimitCents,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.store.collectionChannels.set(channel.id, channel);
    this.audit("agent", "collection_channel.submit", "collection_channel", channel.id, channel);
    return channel;
  }

  reviewCollectionChannel(actor: AdminActor, channelId: string, input: { approved: boolean; reason?: string }) {
    assertAdminPermission(actor, "agent.review");
    const channel = requireEntity(this.store.collectionChannels.get(channelId), "RESOURCE_NOT_FOUND", "collection channel not found");
    channel.status = input.approved ? "active" : "rejected";
    channel.reviewStatus = input.approved ? "approved" : "rejected";
    channel.rejectReason = input.approved ? undefined : input.reason;
    channel.reviewedBy = actor.adminId;
    channel.reviewedAt = new Date();
    channel.updatedAt = new Date();
    if (input.approved && channel.isDefault) {
      for (const candidate of this.store.collectionChannels.values()) {
        if (candidate.id !== channel.id && candidate.shopId === channel.shopId && candidate.status === "active") {
          candidate.isDefault = false;
          candidate.updatedAt = new Date();
        }
      }
    }
    this.audit(actor.role, "collection_channel.review", "collection_channel", channel.id, channel);
    return channel;
  }

  createPaymentVoucher(actor: UserActor, orderNo: string, input: { channel?: PaymentChannel; payerName?: string; voucherUrl?: string; note?: string }) {
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertUserOrderScope(actor, order);
    if (order.paymentStatus === "paid") throw new ApiError(400, "ORDER_ALREADY_PAID", "order is already paid");
    const voucher: PaymentVoucher = {
      id: nextId(this.store, "pay-voucher"),
      orderNo,
      userId: actor.userId,
      shopId: order.shopId,
      amountCents: payableAmount(order),
      channel: input.channel ?? "alipay_wap",
      payerName: input.payerName,
      voucherUrl: input.voucherUrl,
      note: input.note,
      status: "pending_review",
      createdAt: new Date(),
      reviewedAt: null,
      reviewedBy: null
    };
    this.store.paymentVouchers.set(voucher.id, voucher);
    this.audit("user", "payment_voucher.submit", "order", orderNo, voucher);
    return voucher;
  }

  listPaymentVouchers(actor: AdminActor) {
    assertAdminPermission(actor, "settlement.confirm");
    return [...this.store.paymentVouchers.values()];
  }

  listAgentPaymentVouchers(actor: AgentActor) {
    this.getAgentShop(actor);
    return [...this.store.paymentVouchers.values()]
      .filter((voucher) => voucher.shopId === actor.shopId)
      .filter((voucher) => {
        const order = this.store.orders.get(voucher.orderNo);
        return order?.agentId === actor.agentId && order.shopId === actor.shopId;
      });
  }

  confirmPaymentVoucher(actor: AdminActor, voucherId: string, input: { approved: boolean; reason?: string }) {
    assertAdminPermission(actor, "settlement.confirm");
    const voucher = requireEntity(this.store.paymentVouchers.get(voucherId), "RESOURCE_NOT_FOUND", "payment voucher not found");
    if (voucher.status !== "pending_review") return voucher;
    voucher.status = input.approved ? "approved" : "rejected";
    voucher.reviewedAt = new Date();
    voucher.reviewedBy = actor.adminId;
    voucher.reason = input.reason;
    if (input.approved) {
      voucher.disputeMaterialOnly = true;
      this.audit(actor.role, "payment_voucher.dispute_material.accept", "payment_voucher", voucherId, {
        orderNo: voucher.orderNo,
        reason: input.reason
      });
    }
    this.audit(actor.role, "payment_voucher.review", "payment_voucher", voucherId, voucher);
    return voucher;
  }

  confirmAgentOfflinePayment(actor: AgentActor, orderNo: string, input: { amountCents: bigint; voucherUrl?: string; note?: string }) {
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertAgentScope(actor, { agentId: order.agentId, shopId: order.shopId });
    return this.confirmCollectedPayment({
      actor: "agent",
      operatorId: actor.agentId,
      order,
      amountCents: input.amountCents,
      voucherUrl: input.voucherUrl,
      note: input.note,
      auditRole: "agent"
    });
  }

  listAdminCoupons(actor: AdminActor) {
    assertAdminPermission(actor, "product.manage");
    return [...this.store.couponTemplates.values()];
  }

  createCouponTemplate(actor: AdminActor, input: {
    name: string;
    discountCents: bigint;
    productIds?: string[];
    validDays?: number;
    grantOnFirstRegister?: boolean;
    status?: string;
  }) {
    assertAdminPermission(actor, "product.manage");
    if (input.discountCents <= 0n) throw new ApiError(400, "COUPON_INVALID", "coupon discount must be positive");
    const template: CouponTemplate = {
      id: nextId(this.store, "coupon-template"),
      name: input.name,
      discountCents: input.discountCents,
      productIds: input.productIds ?? [],
      validDays: input.validDays ?? 30,
      grantOnFirstRegister: input.grantOnFirstRegister ?? false,
      status: input.status ?? "active",
      createdAt: new Date()
    };
    this.store.couponTemplates.set(template.id, template);
    this.audit(actor.role, "coupon_template.create", "coupon_template", template.id, template);
    return template;
  }

  updateCouponTemplateStatus(actor: AdminActor, couponId: string, input: { status: string }) {
    assertAdminPermission(actor, "product.manage");
    const coupon = requireEntity(this.store.couponTemplates.get(couponId), "RESOURCE_NOT_FOUND", "coupon template not found");
    coupon.status = input.status;
    this.audit(actor.role, "coupon_template.status", "coupon_template", couponId, input);
    return coupon;
  }

  updateShopCollection(actor: AdminActor, shopId: string, input: { collectionAccountName?: string; collectionQrUrl?: string; collectionNote?: string }) {
    assertAdminPermission(actor, "agent.review");
    const shop = this.getShop(shopId);
    shop.collectionAccountName = input.collectionAccountName ?? shop.collectionAccountName;
    shop.collectionQrUrl = input.collectionQrUrl ?? shop.collectionQrUrl;
    shop.collectionNote = input.collectionNote ?? shop.collectionNote;
    this.audit(actor.role, "shop.collection.update", "shop", shop.id, input);
    return shop;
  }

  updateShopServiceQrCode(actor: AdminActor, shopId: string, input: {
    customerServiceWechat?: string;
    customerServiceQrUrl?: string;
    customerServiceQq?: string;
    customerServiceQqQrUrl?: string;
    customerServiceNote?: string;
  }) {
    assertAdminPermission(actor, "agent.review");
    const shop = this.getShop(shopId);
    shop.customerServiceWechat = input.customerServiceWechat ?? shop.customerServiceWechat;
    shop.customerServiceQrUrl = input.customerServiceQrUrl ?? shop.customerServiceQrUrl;
    shop.customerServiceQq = input.customerServiceQq ?? shop.customerServiceQq;
    shop.customerServiceQqQrUrl = input.customerServiceQqQrUrl ?? shop.customerServiceQqQrUrl;
    shop.customerServiceNote = input.customerServiceNote ?? shop.customerServiceNote;
    this.audit(actor.role, "shop.service_qrcode.update", "shop", shop.id, input);
    return shop;
  }

  private upsertPaymentMethod(ownerType: "platform" | "agent", operatorId: string, input: PaymentMethodUpsertInput) {
    this.assertPaymentMethodInput(ownerType, input);
    const existing = input.id ? this.store.paymentMethods.get(input.id) : undefined;
    if (existing) {
      if (ownerType === "agent" && (existing.agentId !== input.agentId || existing.shopId !== input.shopId)) {
        throw new ApiError(403, "PAYMENT_METHOD_SCOPE_FORBIDDEN", "cannot update another merchant payment method");
      }
      existing.provider = input.provider ?? existing.provider;
      existing.displayName = input.displayName ?? existing.displayName;
      existing.productType = input.productType ?? existing.productType;
      existing.merchantNo = input.merchantNo ?? existing.merchantNo;
      existing.appId = input.appId ?? existing.appId;
      existing.serviceProviderId = input.serviceProviderId ?? existing.serviceProviderId;
      existing.gatewayUrl = input.gatewayUrl ?? existing.gatewayUrl;
      existing.accountName = input.accountName ?? existing.accountName;
      existing.qrUrl = input.qrUrl ?? existing.qrUrl;
      existing.paymentUrl = input.paymentUrl ?? existing.paymentUrl;
      existing.note = input.note ?? existing.note;
      existing.returnUrl = input.returnUrl ?? existing.returnUrl;
      existing.enabled = input.enabled ?? existing.enabled;
      existing.status = input.status ?? (existing.enabled ? "enabled" : existing.status);
      existing.isDefault = input.isDefault ?? existing.isDefault;
      existing.updatedAt = new Date();
      existing.updatedBy = operatorId;
      this.applyPaymentMethodSecrets(existing, input);
      if (existing.isDefault) this.setPaymentMethodDefault(existing);
      return existing;
    }
    const method: PaymentMethodConfig = {
      id: nextId(this.store, "payment-method"),
      ownerType,
      agentId: ownerType === "agent" ? required(input.agentId, "agentId") : input.agentId,
      shopId: ownerType === "agent" ? required(input.shopId, "shopId") : input.shopId,
      provider: required(input.provider, "provider"),
      confirmationMode: input.provider === "personal_alipay" ? "manual" : "automatic",
      displayName: required(input.displayName, "displayName"),
      productType: input.productType,
      merchantNo: input.merchantNo,
      appId: input.appId,
      serviceProviderId: input.serviceProviderId,
      gatewayUrl: input.gatewayUrl,
      accountName: input.accountName,
      qrUrl: input.qrUrl,
      paymentUrl: input.paymentUrl,
      note: input.note,
      returnUrl: input.returnUrl,
      enabled: input.enabled ?? false,
      status: input.status ?? (input.enabled ? "enabled" : "pending_test"),
      isDefault: input.isDefault ?? false,
      secretConfigured: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      updatedBy: operatorId
    };
    this.applyPaymentMethodSecrets(method, input);
    this.store.paymentMethods.set(method.id, method);
    if (method.isDefault) this.setPaymentMethodDefault(method);
    return method;
  }

  private assertPaymentMethodInput(ownerType: "platform" | "agent", input: PaymentMethodUpsertInput) {
    if (ownerType === "agent" && (!input.agentId || !input.shopId)) throw new ApiError(400, "PAYMENT_METHOD_SCOPE_REQUIRED", "merchant payment method requires agent and shop scope");
    if (!input.provider && !input.id) throw new ApiError(400, "PAYMENT_METHOD_PROVIDER_REQUIRED", "payment provider is required");
    if (input.provider === "personal_alipay") {
      if (!input.accountName || !input.qrUrl) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "personal alipay requires account name and QR code");
      return;
    }
    if (input.provider && ["alipay_merchant", "wechat_merchant", "epay"].includes(input.provider)) {
      if (!input.merchantNo) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "merchant number is required");
      if (input.provider !== "epay" && !input.appId) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "app id is required");
      if (input.provider === "epay" && !input.gatewayUrl) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "epay gateway url is required");
      if (!input.signingSecret && !input.id) throw new ApiError(400, "PAYMENT_METHOD_SECRET_REQUIRED", "signing secret is required");
    }
  }

  private applyPaymentMethodSecrets(method: PaymentMethodConfig, input: PaymentMethodUpsertInput) {
    if (input.signingSecret) {
      method.signingSecretHash = hashSecret(input.signingSecret);
      method.signingSecretPreview = previewSecret(input.signingSecret);
      method.signingSecretEncrypted = `sha256:${hashSecret(input.signingSecret)}`;
      method.secretConfigured = true;
    }
    if (input.privateKey) {
      method.privateKeyConfigured = true;
      method.privateKeyPreview = previewSecret(input.privateKey);
    }
    if (input.publicKey) {
      method.publicKeyConfigured = true;
      method.publicKeyPreview = previewSecret(input.publicKey);
    }
    if (input.certificate) {
      method.certificateConfigured = true;
      method.certificatePreview = previewSecret(input.certificate);
    }
  }

  private setPaymentMethodDefault(method: PaymentMethodConfig) {
    for (const candidate of this.store.paymentMethods.values()) {
      if (candidate.id === method.id) continue;
      if (candidate.ownerType === method.ownerType && candidate.agentId === method.agentId && candidate.shopId === method.shopId) candidate.isDefault = false;
    }
    method.isDefault = true;
    method.enabled = true;
    method.status = "enabled";
    method.updatedAt = new Date();
  }

  private serializePaymentMethod(method: PaymentMethodConfig) {
    return {
      id: method.id,
      ownerType: method.ownerType,
      agentId: method.agentId,
      shopId: method.shopId,
      provider: method.provider,
      confirmationMode: method.confirmationMode,
      displayName: method.displayName,
      productType: method.productType,
      merchantNoMasked: maskSecret(method.merchantNo),
      appIdMasked: maskSecret(method.appId),
      serviceProviderMasked: maskSecret(method.serviceProviderId),
      gatewayUrl: method.gatewayUrl,
      accountName: method.provider === "personal_alipay" ? method.accountName : maskSecret(method.accountName),
      qrUrl: method.provider === "personal_alipay" ? method.qrUrl : undefined,
      paymentUrl: method.provider === "personal_alipay" ? method.paymentUrl : undefined,
      note: method.note,
      returnUrl: method.returnUrl,
      callbackUrl: this.providerCallbackUrl(method.provider),
      enabled: method.enabled,
      status: method.status,
      isDefault: method.isDefault,
      keyStatus: {
        signingSecret: method.secretConfigured ? "configured" : "missing",
        privateKey: method.privateKeyConfigured ? "configured" : "missing",
        publicKey: method.publicKeyConfigured ? "configured" : "missing",
        certificate: method.certificateConfigured ? "configured" : "missing"
      },
      updatedAt: method.updatedAt,
      lastTestAt: method.lastTestAt,
      lastTestResult: method.lastTestResult,
      lastCallbackAt: method.lastCallbackAt
    };
  }

  private testPaymentMethod(method: PaymentMethodConfig) {
    const ok = method.provider === "personal_alipay"
      ? Boolean(method.accountName && method.qrUrl)
      : Boolean(method.merchantNo && method.secretConfigured && (method.provider === "epay" || method.appId));
    method.lastTestAt = new Date();
    method.lastTestResult = ok ? "passed" : "failed";
    return {
      status: ok ? "passed" as const : "failed" as const,
      provider: method.provider,
      methodId: method.id,
      callbackUrl: this.providerCallbackUrl(method.provider),
      message: ok ? "payment method configuration shape is valid" : "payment method configuration is incomplete"
    };
  }

  private resolvePaymentMethodForOrder(order: DemoOrder, paymentMethodId?: string) {
    const methods = [...this.store.paymentMethods.values()]
      .filter((method) => method.enabled && method.status === "enabled")
      .filter((method) =>
        method.ownerType === "platform"
        || (method.ownerType === "agent" && method.agentId === order.agentId && method.shopId === order.shopId)
      );
    const method = paymentMethodId
      ? methods.find((candidate) => candidate.id === paymentMethodId)
      : methods.find((candidate) => candidate.ownerType === "agent" && candidate.agentId === order.agentId && candidate.shopId === order.shopId && candidate.isDefault)
        ?? methods.find((candidate) => candidate.ownerType === "platform" && candidate.isDefault);
    return requireEntity(method, "PAYMENT_METHOD_UNAVAILABLE", "no enabled payment method is available for this order");
  }

  private resolvePaymentMethodFromOrder(order: DemoOrder) {
    const methodId = order.paymentSnapshot?.paymentMethodId;
    if (!methodId) throw new ApiError(400, "PAYMENT_SNAPSHOT_MISSING", "order has no payment snapshot");
    return requireEntity(this.store.paymentMethods.get(methodId), "RESOURCE_NOT_FOUND", "payment method not found");
  }

  private findPaymentMethodForCallback(provider: PaymentProviderType, input: { merchantNo?: string; appId?: string }, order?: DemoOrder) {
    const snapshotMethod = order?.paymentSnapshot?.paymentMethodId ? this.store.paymentMethods.get(order.paymentSnapshot.paymentMethodId) : undefined;
    if (snapshotMethod?.provider === provider) return snapshotMethod;
    return [...this.store.paymentMethods.values()].find((method) =>
      method.provider === provider
      && method.enabled
      && method.status === "enabled"
      && (!input.merchantNo || method.merchantNo === input.merchantNo)
      && (!input.appId || method.appId === input.appId)
    );
  }

  private paymentSignaturePayload(provider: PaymentProviderType, orderNo: string, amountCents: bigint, providerTradeNo: string, merchantNo?: string) {
    return `${provider}|${orderNo}|${amountCents.toString()}|${providerTradeNo}|${merchantNo ?? ""}`;
  }

  private signPaymentPayload(method: PaymentMethodConfig, orderNo: string, amountCents: bigint, providerTradeNo: string) {
    const secret = method.signingSecretEncrypted ?? method.signingSecretHash ?? "";
    return createHmac("sha256", secret).update(this.paymentSignaturePayload(method.provider, orderNo, amountCents, providerTradeNo, method.merchantNo)).digest("hex");
  }

  private verifyPaymentSignature(method: PaymentMethodConfig, orderNo: string, amountCents: bigint, providerTradeNo: string, signature: string) {
    if (!signature || !method.secretConfigured) return false;
    return this.signPaymentPayload(method, orderNo, amountCents, providerTradeNo) === signature;
  }

  private paymentMethodMaskedIdentity(method: PaymentMethodConfig) {
    return {
      merchantNoMasked: maskSecret(method.merchantNo),
      appIdMasked: maskSecret(method.appId),
      serviceProviderMasked: maskSecret(method.serviceProviderId)
    };
  }

  private providerCallbackUrl(provider: PaymentProviderType) {
    return `/api/callbacks/payments/${provider}`;
  }

  private applyVerifiedPaymentResult(input: {
    order: DemoOrder;
    method: PaymentMethodConfig;
    providerTradeNo: string;
    amountCents: bigint;
    merchantNo?: string;
    appId?: string;
    serviceProviderId?: string;
    tradeStatus: string;
    source: "callback" | "query";
    logBase: Record<string, unknown>;
  }) {
    const order = input.order;
    const exceptionBase = {
      id: nextId(this.store, "pay-exception"),
      provider: input.method.provider,
      orderNo: order.orderNo,
      providerTradeNo: input.providerTradeNo,
      amountCents: input.amountCents,
      receivedAt: new Date(),
      handled: false
    };
    if (order.refundStatus !== "none" || order.status === "refunded") {
      return { status: "exception" as const, exception: this.recordPaymentException({ ...exceptionBase, reasonCode: "ORDER_REFUNDED", reason: "payment arrived after refund" }) };
    }
    if (input.amountCents !== payableAmount(order)) {
      order.paymentStatus = "failed";
      order.riskStatus = "order_frozen";
      return { status: "exception" as const, exception: this.recordPaymentException({ ...exceptionBase, reasonCode: "AMOUNT_MISMATCH", reason: "payment amount does not match order amount" }) };
    }
    if (input.merchantNo && input.method.merchantNo && input.merchantNo !== input.method.merchantNo) {
      return { status: "exception" as const, exception: this.recordPaymentException({ ...exceptionBase, reasonCode: "MERCHANT_MISMATCH", reason: "payment merchant number does not match configuration" }) };
    }
    if (input.appId && input.method.appId && input.appId !== input.method.appId) {
      return { status: "exception" as const, exception: this.recordPaymentException({ ...exceptionBase, reasonCode: "APP_ID_MISMATCH", reason: "payment app id does not match configuration" }) };
    }
    if (!["SUCCESS", "TRADE_SUCCESS", "PAID"].includes(input.tradeStatus)) {
      return { status: "exception" as const, exception: this.recordPaymentException({ ...exceptionBase, reasonCode: "TRADE_STATUS_NOT_SUCCESS", reason: "payment trade status is not success" }) };
    }
    const key = `payment:${input.method.provider}:${input.providerTradeNo}`;
    const result = this.registry.runOnce(key, () => {
      if (order.paymentStatus === "paid") return { status: "duplicate" as const, idempotencyKey: key, order: this.serializePublicOrder(order, { includeDeliveryCodes: false }) };
      this.applyPaidOrder(order, input.amountCents, input.source, {
        provider: input.method.provider,
        paymentMethodId: input.method.id,
        providerTradeNo: input.providerTradeNo
      });
      order.paymentSnapshot = {
        ...(order.paymentSnapshot ?? {}),
        paymentMethodId: input.method.id,
        provider: input.method.provider,
        confirmationMode: input.method.confirmationMode,
        providerTradeNo: input.providerTradeNo,
        amountCents: input.amountCents,
        currency: "CNY",
        orderNo: order.orderNo,
        status: "paid",
        confirmationSource: input.source,
        paidAt: order.paidAt ?? new Date(),
        callbackProcessedAt: input.source === "callback" ? new Date() : order.paymentSnapshot?.callbackProcessedAt
      };
      input.method.lastCallbackAt = input.source === "callback" ? new Date() : input.method.lastCallbackAt;
      this.audit("system", `payment.${input.source}.success`, "order", order.orderNo, { provider: input.method.provider, providerTradeNo: input.providerTradeNo });
      return { status: "processed" as const, idempotencyKey: key, order: this.serializePublicOrder(order, { includeDeliveryCodes: false }) };
    });
    return result ?? { status: "duplicate" as const, idempotencyKey: key, order: this.serializePublicOrder(order, { includeDeliveryCodes: false }) };
  }

  private applyPaidOrder(order: DemoOrder, amountCents: bigint, source: string, metadata: Record<string, unknown>) {
    order.paymentStatus = "paid";
    order.status = "fulfilling";
    order.fulfillmentStatus = "processing";
    order.paidAt = order.paidAt ?? new Date();
    if (order.salesChannelType !== "platform_self_operated") {
      this.store.pendingIncomeByAgent.set(order.agentId, (this.store.pendingIncomeByAgent.get(order.agentId) ?? 0n) + order.snapshot.amountSnapshot.agentExpectedIncomeCents);
      this.addChannelPendingIncome(order);
    }
    this.ledger(source === "manual" ? "MANUAL_PAYMENT_CONFIRMED" : "PAYMENT_SUCCEEDED", { orderNo: order.orderNo, agentId: order.agentId }, amountCents, metadata);
    this.tryAutoFulfillWithRightsCode(order);
  }

  private recordPaymentException(input: PaymentException) {
    const existing = this.store.paymentExceptions.find((item) =>
      item.provider === input.provider
      && item.orderNo === input.orderNo
      && item.providerTradeNo === input.providerTradeNo
      && item.reasonCode === input.reasonCode
    );
    if (existing) return existing;
    this.store.paymentExceptions.push(input);
    this.audit("system", "payment.exception", "payment_exception", input.id, {
      provider: input.provider,
      orderNo: input.orderNo,
      reasonCode: input.reasonCode
    });
    return input;
  }

  private maskPaymentPayload(payload: unknown) {
    if (!isRecord(payload)) return payload;
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      output[key] = /secret|key|sign|cert|token|payload/i.test(key) ? maskSecret(String(value)) : value;
    }
    return output;
  }

  private buildSnapshot(input: { orderNo: string; userId: string; shopId: string; agentProductId: string; quantity?: number; entrySource?: string }): DemoOrderSnapshot {
    const shop = requireEntity(this.store.shops.get(input.shopId), "RESOURCE_NOT_FOUND", "shop not found");
    if ((shop.ownerType ?? "agent") === "platform") {
      return this.buildPlatformSelfOperatedSnapshot(input, shop);
    }
    const agent = requireEntity(this.store.agents.get(required(shop.agentId, "agentId")), "RESOURCE_NOT_FOUND", "agent not found");
    const account = requireEntity(this.store.depositAccounts.get(agent.id), "RESOURCE_NOT_FOUND", "deposit account not found");
    if (shouldRestrictForDeposit(account)) throw new ApiError(400, "DEPOSIT_INSUFFICIENT", "agent deposit is insufficient");
    const agentProduct = requireEntity(this.store.agentProducts.get(input.agentProductId), "RESOURCE_NOT_FOUND", "agent product not found");
    if (agentProduct.shopId !== shop.id) throw new ApiError(400, "RESOURCE_SCOPE_MISMATCH", "agent product does not belong to shop");
    const platformProduct = agentProduct.platformProductId ? this.store.platformProducts.get(agentProduct.platformProductId) : undefined;
    const ownProduct = agentProduct.ownProductReviewId ? this.store.ownProducts.get(agentProduct.ownProductReviewId) : undefined;
    const relation = this.findActiveChannelRelationForSellingAgent(agent.id);
    if (relation && agentProduct.productType === "platform" && platformProduct) {
      return this.buildChannelSnapshot(input, shop, agent, agentProduct, platformProduct, relation);
    }
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

  private resolvePublicCollectionChannel(shopId: string, channelId?: string) {
    const channels = [...this.store.collectionChannels.values()]
      .filter((channel) => channel.shopId === shopId && channel.status === "active" && channel.reviewStatus === "approved")
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.sortOrder - right.sortOrder);
    if (channelId) {
      return requireEntity(channels.find((channel) => channel.id === channelId), "COLLECTION_CHANNEL_UNAVAILABLE", "collection channel is not available");
    }
    return requireEntity(channels[0], "COLLECTION_CHANNEL_UNAVAILABLE", "no active collection channel for this shop");
  }

  private buildChannelSnapshot(
    input: { orderNo: string; userId: string; shopId: string; agentProductId: string; quantity?: number; entrySource?: string },
    shop: DemoShop,
    sellingAgent: DemoAgent,
    agentProduct: DemoAgentProduct,
    platformProduct: DemoPlatformProduct,
    relation: ChannelRelation
  ): DemoOrderSnapshot {
    const firstTier = requireEntity(this.store.agents.get(relation.firstTierAgentId), "RESOURCE_NOT_FOUND", "first tier agent not found");
    const secondTier = requireEntity(this.store.agents.get(relation.secondTierAgentId), "RESOURCE_NOT_FOUND", "second tier agent not found");
    const thirdTier = relation.thirdTierAgentId ? requireEntity(this.store.agents.get(relation.thirdTierAgentId), "RESOURCE_NOT_FOUND", "third tier agent not found") : undefined;
    const firstTierShop = requireEntity(this.findShopByAgentId(firstTier.id), "RESOURCE_NOT_FOUND", "first tier shop not found");
    const secondTierShop = requireEntity(this.findShopByAgentId(secondTier.id), "RESOURCE_NOT_FOUND", "second tier shop not found");
    const firstTierAccount = requireEntity(this.store.depositAccounts.get(firstTier.id), "RESOURCE_NOT_FOUND", "first tier deposit account not found");
    const secondTierAccount = requireEntity(this.store.depositAccounts.get(secondTier.id), "RESOURCE_NOT_FOUND", "second tier deposit account not found");
    if (sellingAgent.id !== (thirdTier?.id ?? secondTier.id)) throw new ApiError(400, "CHANNEL_RULE_FAILED", "selling agent does not match channel relation");
    if (sellingAgent.status !== "active" || secondTier.status !== "active" || firstTier.status !== "active" || (thirdTier && thirdTier.status !== "active")) throw new ApiError(400, "AGENT_NOT_ACTIVE", "channel agents must be active");
    if (shop.status !== "open" || firstTierShop.status !== "open" || secondTierShop.status !== "open") throw new ApiError(400, "SHOP_NOT_OPEN", "channel shops must be open");
    if (agentProduct.status !== "listed") throw new ApiError(400, "PRODUCT_NOT_LISTED", "agent product is not listed");
    if (platformProduct.status !== "active") throw new ApiError(400, "PRODUCT_NOT_ACTIVE", "platform product is not active");
    if (sellingAgent.riskStatus !== "normal" || secondTier.riskStatus !== "normal" || firstTier.riskStatus !== "normal" || shop.riskStatus !== "normal") {
      throw new ApiError(400, "RISK_BLOCKED", "risk freeze blocks order creation");
    }
    if (shouldRestrictForDeposit(firstTierAccount)) throw new ApiError(400, "DEPOSIT_INSUFFICIENT", "first tier deposit is insufficient");
    if (shouldRestrictForDeposit(secondTierAccount)) throw new ApiError(400, "DEPOSIT_INSUFFICIENT", "second tier deposit is insufficient");
    const firstTierOffer = requireEntity(
      this.store.channelProductOffers.find((item) => item.channelRelationId === this.firstSecondRelationFor(relation).id && item.platformProductId === platformProduct.id && item.status === "listed"),
      "RESOURCE_NOT_FOUND",
      "first tier channel product offer not found"
    );
    if (firstTierOffer.resellSupplyPriceCents < platformProduct.supplyPriceCents) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "first tier supply price cannot be below platform supply price");
    }
    const secondTierOffer = relation.thirdTierAgentId
      ? requireEntity(
        this.store.channelProductOffers.find((item) => item.channelRelationId === relation.id && item.platformProductId === platformProduct.id && item.status === "listed"),
        "RESOURCE_NOT_FOUND",
        "second tier channel product offer not found"
      )
      : undefined;
    if (secondTierOffer && secondTierOffer.resellSupplyPriceCents < firstTierOffer.resellSupplyPriceCents) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "second tier supply price cannot be below first tier supply price");
    }
    const quantity = input.quantity ?? 1;
    const sellerSupplyUnitPriceCents = secondTierOffer?.resellSupplyPriceCents ?? firstTierOffer.resellSupplyPriceCents;
    const quote = quotePlatformProduct({
      salePriceCents: agentProduct.salePriceCents,
      supplyPriceCents: sellerSupplyUnitPriceCents,
      minSalePriceCents: platformProduct.minSalePriceCents,
      quantity
    });
    const platformSupplyPriceCents = platformProduct.supplyPriceCents * BigInt(quantity);
    const firstTierSupplyPriceCents = firstTierOffer.resellSupplyPriceCents * BigInt(quantity);
    const secondTierSupplyPriceCents = secondTierOffer ? secondTierOffer.resellSupplyPriceCents * BigInt(quantity) : null;
    const firstTierIncomeCents = firstTierSupplyPriceCents - platformSupplyPriceCents;
    const secondTierIncomeCents = secondTierSupplyPriceCents ? secondTierSupplyPriceCents - firstTierSupplyPriceCents : quote.agentExpectedIncomeCents;
    const thirdTierIncomeCents = secondTierSupplyPriceCents ? quote.agentExpectedIncomeCents : 0n;

    return {
      orderNo: input.orderNo,
      userId: input.userId,
      agentId: sellingAgent.id,
      shopId: shop.id,
      agentProductId: agentProduct.id,
      salesChannelType: secondTierOffer ? "three_tier" : "two_tier",
      productType: "platform",
      productNameSnapshot: platformProduct.name,
      quantity,
      quote,
      amountSnapshot: {
        serviceFeeBps: quote.serviceFeeBps,
        paidAmountCents: quote.paidAmountCents,
        supplyAmountCents: quote.supplyAmountCents,
        serviceFeeCents: quote.serviceFeeCents,
        agentExpectedIncomeCents: quote.agentExpectedIncomeCents,
        platformSupplyPriceCents,
        resellSupplyPriceCents: firstTierSupplyPriceCents,
        firstTierSupplyPriceCents,
        secondTierSupplyPriceCents,
        finalSalePriceCents: quote.paidAmountCents,
        firstTierIncomeCents,
        secondTierIncomeCents,
        thirdTierIncomeCents
      },
      productSnapshot: { id: platformProduct.id, type: "platform", name: platformProduct.name },
      shopSnapshot: {
        id: shop.id,
        name: shop.name,
        customerServiceWechat: shop.customerServiceWechat,
        customerServiceQrUrl: shop.customerServiceQrUrl,
        customerServiceQq: shop.customerServiceQq,
        customerServiceQqQrUrl: shop.customerServiceQqQrUrl,
        customerServiceNote: shop.customerServiceNote,
        agentStatus: sellingAgent.status,
        shopStatus: shop.status,
        entrySource: input.entrySource
      },
      pricingSnapshot: {
        salePriceCents: agentProduct.salePriceCents,
        minSalePriceCents: platformProduct.minSalePriceCents,
        suggestedSalePriceCents: platformProduct.suggestedSalePriceCents
      },
      channelSnapshot: {
        relationId: relation.id,
        firstTierAgentId: firstTier.id,
        firstTierShopId: firstTierShop.id,
        secondTierAgentId: secondTier.id,
        secondTierShopId: secondTierShop.id,
        thirdTierAgentId: thirdTier?.id,
        thirdTierShopId: thirdTier ? shop.id : undefined,
        platformSupplyPriceCents,
        resellSupplyPriceCents: firstTierSupplyPriceCents,
        firstTierSupplyPriceCents,
        secondTierSupplyPriceCents,
        finalSalePriceCents: quote.paidAmountCents,
        firstTierIncomeCents,
        secondTierIncomeCents,
        thirdTierIncomeCents
      },
      fulfillmentRuleSnapshot: platformProduct.fulfillmentRule,
      afterSaleRuleSnapshot: platformProduct.afterSaleRule
    } as DemoOrderSnapshot;
  }

  private buildPlatformSelfOperatedSnapshot(
    input: { orderNo: string; userId: string; shopId: string; agentProductId: string; quantity?: number; entrySource?: string },
    shop: DemoShop
  ): PlatformSelfOperatedSnapshot {
    if (shop.status !== "open") throw new ApiError(400, "SHOP_NOT_OPEN", "platform shop is not open");
    if (shop.riskStatus !== "normal") throw new ApiError(400, "RISK_BLOCKED", "risk freeze blocks order creation");
    const shopProduct = requireEntity(this.store.platformShopProducts.get(input.agentProductId), "RESOURCE_NOT_FOUND", "platform shop product not found");
    if (shopProduct.shopId !== shop.id) throw new ApiError(400, "RESOURCE_SCOPE_MISMATCH", "product does not belong to platform shop");
    if (shopProduct.status !== "listed") throw new ApiError(400, "PRODUCT_NOT_LISTED", "platform shop product is not listed");
    const product = requireEntity(this.store.platformProducts.get(shopProduct.platformProductId), "RESOURCE_NOT_FOUND", "platform product not found");
    if (product.status !== "active") throw new ApiError(400, "PRODUCT_NOT_ACTIVE", "platform product is not active");
    if (shopProduct.salePriceCents < product.minSalePriceCents) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "sale price is below minimum sale price");
    }
    const quantity = input.quantity ?? 1;
    const paidAmountCents = shopProduct.salePriceCents * BigInt(quantity);
    const fulfillmentCostCents = shopProduct.fulfillmentCostCents * BigInt(quantity);
    const serviceFeeBps = 50n;
    const paymentChannelFeeCents = calculateServiceFeeCents(paidAmountCents, serviceFeeBps);
    const grossMarginCents = paidAmountCents - fulfillmentCostCents - paymentChannelFeeCents;
    if (grossMarginCents < 0n) throw new ApiError(400, "PRICE_RULE_FAILED", "platform self-operated margin cannot be negative");

    return {
      orderNo: input.orderNo,
      userId: input.userId,
      agentId: PLATFORM_AGENT_ID,
      shopId: shop.id,
      agentProductId: shopProduct.id,
      salesChannelType: "platform_self_operated",
      productType: "platform",
      productNameSnapshot: product.name,
      quantity,
      quote: {
        serviceFeeBps,
        paidAmountCents,
        supplyAmountCents: fulfillmentCostCents,
        serviceFeeCents: paymentChannelFeeCents,
        agentExpectedIncomeCents: 0n
      },
      amountSnapshot: {
        serviceFeeBps,
        paidAmountCents,
        supplyAmountCents: fulfillmentCostCents,
        serviceFeeCents: paymentChannelFeeCents,
        agentExpectedIncomeCents: 0n,
        platformSelfOperatedGrossMarginCents: grossMarginCents
      },
      productSnapshot: {
        id: product.id,
        type: "platform",
        name: product.name
      },
      shopSnapshot: {
        id: shop.id,
        name: shop.name,
        ownerType: "platform",
        customerServiceWechat: shop.customerServiceWechat,
        customerServiceQrUrl: shop.customerServiceQrUrl,
        customerServiceQq: shop.customerServiceQq,
        customerServiceQqQrUrl: shop.customerServiceQqQrUrl,
        customerServiceNote: shop.customerServiceNote,
        shopStatus: shop.status,
        entrySource: input.entrySource
      },
      pricingSnapshot: {
        salePriceCents: shopProduct.salePriceCents,
        minSalePriceCents: product.minSalePriceCents,
        suggestedSalePriceCents: product.suggestedSalePriceCents
      },
      selfOperatedSnapshot: {
        platformShopId: shop.id,
        finalSalePriceCents: paidAmountCents,
        fulfillmentCostCents,
        paymentChannelFeeCents,
        platformSelfOperatedGrossMarginCents: grossMarginCents
      },
      fulfillmentRuleSnapshot: product.fulfillmentRule,
      afterSaleRuleSnapshot: product.afterSaleRule
    };
  }

  private serializeAgentProduct(agentProduct: DemoAgentProduct) {
    const product = agentProduct.platformProductId
      ? this.store.platformProducts.get(agentProduct.platformProductId)
      : this.store.ownProducts.get(required(agentProduct.ownProductReviewId, "ownProductReviewId"));
    return { ...agentProduct, product };
  }

  private serializePlatformProductDetail(product: DemoPlatformProduct, audience: "admin" | "merchant", actor?: AdminActor) {
    const isCodePool = fulfillmentRuleMode(product.fulfillmentRule) === "code_pool";
    const rightsCodePool = this.rightsCodePoolSummary(product.id, {
      canImport: audience === "admin" && Boolean(actor) && hasAdminPermission(actor!, "product.manage") && isCodePool,
      canExportMasked: audience === "admin" && Boolean(actor) && hasAdminPermission(actor!, "product.manage"),
      canViewPlaintext: audience === "admin" && Boolean(actor) && hasAdminPermission(actor!, "rights_code.secret.read"),
      canExportPlaintext: audience === "admin" && Boolean(actor) && hasAdminPermission(actor!, "rights_code.secret.read")
    });
    const fulfillmentModeValue = fulfillmentRuleMode(product.fulfillmentRule);
    return {
      ...product,
      fulfillmentMode: fulfillmentModeValue,
      manualFulfillmentInstruction: manualFulfillmentInstruction(product.fulfillmentRule),
      rightsCodePool,
      fieldPermissions: audience === "admin"
        ? {
            editable: ["name", "category", "tags", "subtitle", "description", "usageGuide", "imageUrl", "specs", "detailSections", "supplyPriceCents", "minSalePriceCents", "suggestedSalePriceCents", "fulfillmentMode", "afterSaleRule", "status"],
            readonly: []
          }
        : {
            editable: [],
            readonly: ["name", "category", "tags", "subtitle", "description", "usageGuide", "imageUrl", "specs", "detailSections", "minSalePriceCents", "suggestedSalePriceCents", "fulfillmentMode", "afterSaleRule", "status"]
          },
      saveConfirmation: {
        requiresConfirmation: true,
        message: "保存会影响后续展示和新订单快照，既有订单不回写。"
      }
    };
  }

  private serializePlatformShopProductDetail(shopProduct: DemoPlatformShopProduct, actor?: AdminActor) {
    const product = requireEntity(this.store.platformProducts.get(shopProduct.platformProductId), "RESOURCE_NOT_FOUND", "platform product not found");
    const shop = this.store.shops.get(shopProduct.shopId);
    return {
      ...shopProduct,
      shop: shop ? { id: shop.id, name: shop.name, status: shop.status, ownerType: shop.ownerType ?? "agent" } : undefined,
      product: this.serializePlatformProductDetail(product, "admin", actor),
      fieldPermissions: {
        editable: ["salePriceCents", "fulfillmentCostCents", "status"],
        readonly: ["platformProductId", "product"]
      }
    };
  }

  private serializeAgentProductForActor(actor: AgentActor, agentProduct: DemoAgentProduct) {
    const base = this.serializeAgentProduct(agentProduct) as Record<string, unknown> & { product?: Record<string, unknown> };
    if (!base.product || agentProduct.productType !== "platform") return base;
    const visibility = this.priceVisibilityForAgent(actor.agentId, agentProduct.platformProductId);
    const product = { ...base.product };
    delete product.supplyPriceCents;
    if (visibility.canSeePlatformSupplyPrice) product.platformSupplyPriceCents = visibility.platformSupplyPriceCents;
    if (visibility.visibleUpstreamSupplyPriceCents !== undefined) product.visibleUpstreamSupplyPriceCents = visibility.visibleUpstreamSupplyPriceCents;
    if (visibility.ownTransferSupplyPriceCents !== undefined) product.ownTransferSupplyPriceCents = visibility.ownTransferSupplyPriceCents;
    return { ...base, product };
  }

  private serializeAgentProductDetailForActor(actor: AgentActor, agentProduct: DemoAgentProduct) {
    const base = this.serializeAgentProductForActor(actor, agentProduct) as Record<string, unknown> & { product?: Record<string, unknown> };
    const inventoryProductId = agentProduct.productType === "agent_owned" ? agentProduct.id : agentProduct.platformProductId;
    return {
      ...base,
      rightsCodePool: inventoryProductId ? this.rightsCodePoolSummary(inventoryProductId, {
        canImport: agentProduct.productType === "agent_owned",
        canExportMasked: agentProduct.productType === "agent_owned",
        canViewPlaintext: false,
        canExportPlaintext: false
      }) : undefined,
      fieldPermissions: {
        editable: ["salePriceCents", "status"],
        readonly: ["product", "fulfillmentMode", "afterSaleRule", "rightsCodePool"]
      },
      canViewPlainRightsCodes: agentProduct.productType === "agent_owned",
      priceVisibility: agentProduct.productType === "platform" ? this.priceVisibilityForAgent(actor.agentId, agentProduct.platformProductId) : undefined
    };
  }

  private serializeOwnProductDetail(product: DemoOwnProduct, audience: "admin" | "merchant") {
    const agent = this.store.agents.get(product.agentId);
    const shop = this.store.shops.get(product.shopId);
    const agentProduct = [...this.store.agentProducts.values()].find((item) => item.ownProductReviewId === product.id);
    const editable = audience === "admin"
      ? ["reviewStatus", "status"]
      : product.reviewStatus === "pending_review"
        ? ["name", "category", "tags", "subtitle", "description", "usageGuide", "imageUrl", "specs", "detailSections", "salePriceCents", "minSalePriceCents", "fulfillmentMode", "afterSaleRule"]
        : ["salePriceCents", "status"];
    return {
      ...product,
      ownProductId: product.id,
      agentProductId: agentProduct?.id,
      agent: agent ? { id: agent.id, name: agent.name, tier: agent.tier, status: agent.status } : undefined,
      shop: shop ? { id: shop.id, name: shop.name, status: shop.status } : undefined,
      fulfillmentMode: fulfillmentRuleMode(product.fulfillmentRule),
      manualFulfillmentInstruction: manualFulfillmentInstruction(product.fulfillmentRule),
      rightsCodePool: agentProduct ? this.rightsCodePoolSummary(agentProduct.id, {
        canImport: audience === "merchant" && fulfillmentRuleMode(product.fulfillmentRule) === "code_pool",
        canExportMasked: audience === "merchant",
        canViewPlaintext: false,
        canExportPlaintext: false
      }) : this.rightsCodePoolSummary(product.id, {
        canImport: false,
        canExportMasked: false,
        canViewPlaintext: false,
        canExportPlaintext: false
      }),
      fieldPermissions: { editable, readonly: audience === "admin" ? ["agent", "shop", "rightsCodePool"] : ["reviewStatus", "agent", "shop"] },
      saveConfirmation: {
        requiresConfirmation: true,
        message: "保存后只影响后续展示和新订单，已产生订单保持原快照。"
      }
    };
  }

  private rightsCodePoolSummary(productId: string, permissions: {
    canImport?: boolean;
    canExportMasked?: boolean;
    canViewPlaintext?: boolean;
    canExportPlaintext?: boolean;
  } = {}) {
    const codes = this.store.rightsCodes.filter((code) => code.productId === productId || code.agentProductId === productId);
    const available = codes.filter((code) => code.status === "available").length;
    const issued = codes.filter((code) => code.status === "issued").length;
    const voided = codes.filter((code) => code.status === "voided").length;
    return {
      productId,
      total: codes.length,
      available,
      issued,
      voided,
      lowStock: available > 0 && available <= 3,
      plaintextDefaultVisible: false,
      permissions: {
        canImport: permissions.canImport ?? false,
        canExportMasked: permissions.canExportMasked ?? true,
        canViewPlaintext: permissions.canViewPlaintext ?? false,
        canExportPlaintext: permissions.canExportPlaintext ?? false
      }
    };
  }

  private assertSafePlatformFulfillmentModeChange(productId: string, nextMode: "manual" | "code_pool") {
    if (nextMode === "code_pool") return;
    const hasCodes = this.store.rightsCodes.some((code) => code.productId === productId);
    const hasActiveOrders = [...this.store.orders.values()].some((order) =>
      getSnapshotProductId(order.snapshot) === productId
      && !["refunded", "closed"].includes(order.status)
      && order.fulfillmentStatus !== "not_started"
    );
    if (hasCodes || hasActiveOrders) {
      throw new ApiError(400, "FULFILLMENT_MODE_CHANGE_UNSAFE", "cannot switch to manual after code_pool orders or issued codes exist");
    }
  }

  private assertSafeOwnFulfillmentModeChange(ownProductId: string, nextMode: "manual" | "code_pool") {
    const agentProduct = [...this.store.agentProducts.values()].find((product) => product.ownProductReviewId === ownProductId);
    if (!agentProduct || nextMode === "code_pool") return;
    const hasCodes = this.store.rightsCodes.some((code) => (code.agentProductId ?? code.productId) === agentProduct.id);
    const hasActiveOrders = [...this.store.orders.values()].some((order) =>
      order.agentProductId === agentProduct.id
      && !["refunded", "closed"].includes(order.status)
      && order.fulfillmentStatus !== "not_started"
    );
    if (hasCodes || hasActiveOrders) {
      throw new ApiError(400, "FULFILLMENT_MODE_CHANGE_UNSAFE", "cannot switch to manual after code_pool orders or issued codes exist");
    }
  }

  private serializeAgentOrderForActor(actor: AgentActor, order: DemoOrder) {
    const channel = getChannelSnapshot(order.snapshot);
    const settlementBasisAmountCents = order.snapshot.amountSnapshot.paidAmountCents;
    const buyerPaidAmountCents = payableAmount(order);
    const result: Record<string, unknown> = {
      orderNo: order.orderNo,
      shopId: order.shopId,
      salesChannelType: order.salesChannelType,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      refundStatus: order.refundStatus,
      paidAmountCents: buyerPaidAmountCents,
      buyerPaidAmountCents,
      settlementBasisAmountCents,
      couponDiscountCents: order.couponDiscountCents ?? 0n,
      productName: order.snapshot.productNameSnapshot,
      quantity: order.snapshot.quantity,
      collectionChannel: order.collectionChannelSnapshot ? {
        id: order.collectionChannelSnapshot.id,
        channelType: order.collectionChannelSnapshot.channelType,
        displayName: order.collectionChannelSnapshot.displayName
      } : undefined
    };
    if (!channel) {
      result.visibleSupplyPriceCents = order.snapshot.amountSnapshot.supplyAmountCents;
      result.visibleIncomeCents = order.snapshot.amountSnapshot.agentExpectedIncomeCents;
      return result;
    }
    if (actor.agentId === channel.firstTierAgentId) {
      result.platformSupplyPriceCents = channel.platformSupplyPriceCents;
      result.firstTierSupplyPriceCents = channel.firstTierSupplyPriceCents;
      result.visibleIncomeCents = channel.firstTierIncomeCents;
    } else if (actor.agentId === channel.secondTierAgentId) {
      result.firstTierSupplyPriceCents = channel.firstTierSupplyPriceCents;
      result.secondTierSupplyPriceCents = channel.secondTierSupplyPriceCents;
      result.visibleIncomeCents = channel.secondTierIncomeCents;
    } else if (actor.agentId === channel.thirdTierAgentId) {
      result.secondTierSupplyPriceCents = channel.secondTierSupplyPriceCents;
      result.visibleIncomeCents = channel.thirdTierIncomeCents;
    }
    return result;
  }

  private serializePublicAgentProduct(agentProduct: DemoAgentProduct) {
    const product = agentProduct.platformProductId
      ? this.store.platformProducts.get(agentProduct.platformProductId)
      : this.store.ownProducts.get(required(agentProduct.ownProductReviewId, "ownProductReviewId"));
    return {
      id: agentProduct.id,
      shopId: agentProduct.shopId,
      productType: agentProduct.productType,
      salePriceCents: agentProduct.salePriceCents,
      status: agentProduct.status,
      groupName: agentProduct.groupName,
      product: product ? {
        id: product.id,
        name: product.name,
        category: product.category,
        tags: product.tags,
        subtitle: product.subtitle,
        description: product.description,
        usageGuide: product.usageGuide,
        imageUrl: product.imageUrl,
        specs: product.specs,
        detailSections: product.detailSections,
        stockCount: product.stockCount,
        soldCount: product.soldCount,
        ...(agentProduct.platformProductId ? {
          displayBadge: (product as DemoPlatformProduct).displayBadge,
          isRecommended: (product as DemoPlatformProduct).isRecommended,
          displaySort: (product as DemoPlatformProduct).displaySort
        } : {}),
        fulfillmentRule: product.fulfillmentRule,
        afterSaleRule: product.afterSaleRule,
        status: (product as { status?: string; reviewStatus?: string }).status
          ?? (product as { status?: string; reviewStatus?: string }).reviewStatus
      } : null
    };
  }

  private serializePublicShopProduct(shopProduct: DemoPlatformShopProduct) {
    const product = this.store.platformProducts.get(shopProduct.platformProductId);
    return {
      id: shopProduct.id,
      shopId: shopProduct.shopId,
      productType: "platform_self_operated",
      salePriceCents: shopProduct.salePriceCents,
      status: shopProduct.status,
      groupName: shopProduct.groupName,
      product: product ? {
        id: product.id,
        name: product.name,
        category: product.category,
        tags: product.tags,
        subtitle: product.subtitle,
        description: product.description,
        usageGuide: product.usageGuide,
        imageUrl: product.imageUrl,
        specs: product.specs,
        detailSections: product.detailSections,
        stockCount: product.stockCount,
        soldCount: product.soldCount,
        displayBadge: product.displayBadge,
        isRecommended: product.isRecommended,
        displaySort: product.displaySort,
        fulfillmentRule: product.fulfillmentRule,
        afterSaleRule: product.afterSaleRule,
        status: product.status
      } : null
    };
  }

  private serializePublicQuote(snapshot: DemoOrderSnapshot, coupon?: CouponResolution) {
    const discount = coupon?.discountCents ?? 0n;
    const buyerPaid = coupon?.buyerPaidAmountCents ?? snapshot.amountSnapshot.paidAmountCents;
    const settlementBasis = snapshot.amountSnapshot.paidAmountCents;
    return {
      paidAmountCents: buyerPaid,
      buyerPaidAmountCents: buyerPaid,
      settlementBasisAmountCents: settlementBasis,
      couponDiscountCents: discount,
      salePriceCents: settlementBasis / BigInt(snapshot.quantity),
      quantity: snapshot.quantity
    };
  }

  private serializePublicOrder(order: DemoOrder, options: { includeDeliveryCodes?: boolean; includeBuyerContact?: boolean } = {}) {
    const settlementBasisAmountCents = order.snapshot.amountSnapshot.paidAmountCents;
    const buyerPaidAmountCents = payableAmount(order);
    return {
      orderNo: order.orderNo,
      userId: order.userId,
      shopId: order.shopId,
      agentProductId: order.agentProductId,
      salesChannelType: order.salesChannelType,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      refundStatus: order.refundStatus,
      buyerEmail: options.includeBuyerContact ? order.buyerEmail : undefined,
      purchasePasswordSet: order.extractionCodeSet,
      paidAt: order.paidAt,
      fulfilledAt: order.fulfilledAt,
      refundedAmountCents: order.refundedAmountCents,
      paidAmountCents: buyerPaidAmountCents,
      buyerPaidAmountCents,
      settlementBasisAmountCents,
      couponDiscountCents: order.couponDiscountCents ?? 0n,
      salePriceCents: settlementBasisAmountCents / BigInt(order.snapshot.quantity),
      quantity: order.snapshot.quantity,
      productType: order.snapshot.productType,
      productName: order.snapshot.productNameSnapshot,
      shopName: (order.snapshot.shopSnapshot as { name?: string }).name,
      customerServiceWechat: (order.snapshot.shopSnapshot as { customerServiceWechat?: string }).customerServiceWechat,
      customerServiceQrUrl: (order.snapshot.shopSnapshot as { customerServiceQrUrl?: string }).customerServiceQrUrl,
      customerServiceQq: (order.snapshot.shopSnapshot as { customerServiceQq?: string }).customerServiceQq,
      customerServiceQqQrUrl: (order.snapshot.shopSnapshot as { customerServiceQqQrUrl?: string }).customerServiceQqQrUrl,
      customerServiceNote: (order.snapshot.shopSnapshot as { customerServiceNote?: string }).customerServiceNote,
      fulfillmentMode: fulfillmentMode(order.snapshot),
      delivery: this.serializeDelivery(order, options),
      collectionChannel: order.collectionChannelSnapshot,
      paymentSnapshot: order.paymentSnapshot,
      snapshot: {
        productType: order.snapshot.productType
      }
    };
  }

  private serializeDelivery(order: DemoOrder, options: { includeDeliveryCodes?: boolean; includeBuyerContact?: boolean }) {
    const mode = fulfillmentMode(order.snapshot);
    if (mode !== "code_pool") {
      const instruction = manualFulfillmentInstruction(order.snapshot.fulfillmentRuleSnapshot);
      return {
        mode: "manual",
        status: order.fulfillmentStatus,
        manualFulfillmentInstruction: instruction,
        customerServiceWechat: (order.snapshot.shopSnapshot as { customerServiceWechat?: string }).customerServiceWechat,
        customerServiceQrUrl: (order.snapshot.shopSnapshot as { customerServiceQrUrl?: string }).customerServiceQrUrl,
        customerServiceQq: (order.snapshot.shopSnapshot as { customerServiceQq?: string }).customerServiceQq,
        customerServiceQqQrUrl: (order.snapshot.shopSnapshot as { customerServiceQqQrUrl?: string }).customerServiceQqQrUrl,
        customerServiceNote: (order.snapshot.shopSnapshot as { customerServiceNote?: string }).customerServiceNote,
        message: instruction ?? "本商品为人工交付，请添加店铺客服领取账号、服务或权益。"
      };
    }
    const codes = this.store.rightsCodes
      .filter((code) => code.orderNo === order.orderNo && code.status === "issued")
      .map((code) => ({
        codeId: code.codeId,
        code: code.code,
        issuedAt: code.issuedAt
      }));
    return {
      mode: "automatic",
      status: order.fulfillmentStatus,
      buyerEmail: options.includeBuyerContact ? order.buyerEmail : undefined,
      purchasePasswordSet: order.extractionCodeSet,
      extractable: Boolean(order.extractionCodeSet) && order.paymentStatus === "paid" && order.fulfillmentStatus === "success" && order.refundStatus === "none",
      extractionToken: Boolean(order.extractionCodeSet) ? this.extractionTokenForOrder(order) : undefined,
      codes: !order.extractionCodeSet && options.includeBuyerContact && order.paymentStatus === "paid" && order.fulfillmentStatus === "success" && order.refundStatus === "none" ? codes : [],
      message: codes.length > 0 ? "卡密已自动发放，请使用购买时设置的购买密码查看。" : "付款后系统会自动发放卡密。"
    };
  }

  private serializeUserCoupon(coupon: UserCoupon, input: { shopId?: string; agentProductId?: string }) {
    const template = this.store.couponTemplates.get(coupon.templateId);
    const visible = Boolean(template) && coupon.status !== "voided";
    return {
      ...coupon,
      template,
      visible,
      applicable: template && input.agentProductId
        ? this.couponAppliesToProduct(template, input.agentProductId)
        : true
    };
  }

  private serializePublicCollectionChannel(channel: CollectionChannel) {
    return {
      id: channel.id,
      shopId: channel.shopId,
      ownerType: channel.ownerType,
      channelType: channel.channelType,
      displayName: channel.displayName,
      accountName: channel.accountName,
      qrUrl: channel.qrUrl,
      paymentUrl: channel.paymentUrl,
      isDefault: channel.isDefault,
      sortOrder: channel.sortOrder,
      singleOrderLimitCents: channel.singleOrderLimitCents
    };
  }

  private listVisibleUpstreamProducts(actor: AgentActor) {
    const visibleProductIds = new Set<string>();
    for (const relation of this.store.channelRelations) {
      if (relation.status !== "active") continue;
      if (relation.secondTierAgentId === actor.agentId || relation.thirdTierAgentId === actor.agentId) {
        for (const offer of this.store.channelProductOffers.filter((item) => item.channelRelationId === relation.id && item.status === "listed")) {
          visibleProductIds.add(offer.platformProductId);
        }
      }
    }
    return [...visibleProductIds]
      .map((productId) => this.store.platformProducts.get(productId))
      .filter((product): product is DemoPlatformProduct => Boolean(product))
      .map((product) => {
        const visibility = this.priceVisibilityForAgent(actor.agentId, product.id);
        return {
          id: product.id,
          name: product.name,
          category: product.category,
          tags: product.tags,
          subtitle: product.subtitle,
          description: product.description,
          usageGuide: product.usageGuide,
          imageUrl: product.imageUrl,
          specs: product.specs,
          detailSections: product.detailSections,
          stockCount: product.stockCount,
          soldCount: product.soldCount,
          minSalePriceCents: product.minSalePriceCents,
          suggestedSalePriceCents: product.suggestedSalePriceCents,
          fulfillmentRule: product.fulfillmentRule,
          afterSaleRule: product.afterSaleRule,
          status: product.status,
          visibleUpstreamSupplyPriceCents: visibility.visibleUpstreamSupplyPriceCents,
          ownTransferSupplyPriceCents: visibility.ownTransferSupplyPriceCents
        };
      });
  }

  private platformSelectionPricingForActor(actor: AgentActor, platformProductId: string) {
    const product = requireEntity(this.store.platformProducts.get(platformProductId), "RESOURCE_NOT_FOUND", "platform product not found");
    const tier = this.agentTier(actor.agentId);
    if (tier === "first_tier") {
      return {
        product,
        supplyPriceCents: product.supplyPriceCents,
        minSalePriceCents: product.minSalePriceCents
      };
    }
    const visibility = this.priceVisibilityForAgent(actor.agentId, platformProductId);
    if (visibility.visibleUpstreamSupplyPriceCents === undefined) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "platform product is not available to current merchant");
    }
    return {
      product,
      supplyPriceCents: visibility.visibleUpstreamSupplyPriceCents,
      minSalePriceCents: visibility.visibleUpstreamSupplyPriceCents > product.minSalePriceCents
        ? visibility.visibleUpstreamSupplyPriceCents
        : product.minSalePriceCents
    };
  }

  private priceVisibilityForAgent(agentId: string, platformProductId?: string | null) {
    if (!platformProductId) return {};
    const product = this.store.platformProducts.get(platformProductId);
    const firstTierRelation = this.store.channelRelations.find((relation) => relation.status === "active" && relation.firstTierAgentId === agentId && !relation.thirdTierAgentId);
    if (firstTierRelation && product) {
      const firstOffer = this.store.channelProductOffers.find((offer) => offer.channelRelationId === firstTierRelation.id && offer.platformProductId === platformProductId && offer.status === "listed");
      return {
        canSeePlatformSupplyPrice: true,
        platformSupplyPriceCents: product.supplyPriceCents,
        ownTransferSupplyPriceCents: firstOffer?.resellSupplyPriceCents
      };
    }
    const secondTierRelation = this.store.channelRelations.find((relation) => relation.status === "active" && relation.secondTierAgentId === agentId && !relation.thirdTierAgentId);
    const thirdTierRelation = this.store.channelRelations.find((relation) => relation.status === "active" && relation.thirdTierAgentId === agentId);
    if (secondTierRelation) {
      const firstOffer = this.store.channelProductOffers.find((offer) => offer.channelRelationId === secondTierRelation.id && offer.platformProductId === platformProductId && offer.status === "listed");
      const secondOffer = this.store.channelProductOffers.find((offer) => {
        const relation = this.store.channelRelations.find((candidate) => candidate.id === offer.channelRelationId);
        return relation?.secondTierAgentId === agentId && relation.thirdTierAgentId && offer.platformProductId === platformProductId && offer.status === "listed";
      });
      return {
        canSeePlatformSupplyPrice: false,
        visibleUpstreamSupplyPriceCents: firstOffer?.resellSupplyPriceCents,
        ownTransferSupplyPriceCents: secondOffer?.resellSupplyPriceCents
      };
    }
    if (thirdTierRelation) {
      const secondOffer = this.store.channelProductOffers.find((offer) => offer.channelRelationId === thirdTierRelation.id && offer.platformProductId === platformProductId && offer.status === "listed");
      return {
        canSeePlatformSupplyPrice: false,
        visibleUpstreamSupplyPriceCents: secondOffer?.resellSupplyPriceCents
      };
    }
    return product ? { canSeePlatformSupplyPrice: true, platformSupplyPriceCents: product.supplyPriceCents } : {};
  }

  private findDirectDownstreamRelation(upstreamAgentId: string, downstreamAgentId: string) {
    return this.store.channelRelations.find((relation) =>
      relation.status === "active"
      && (
        (!relation.thirdTierAgentId && relation.firstTierAgentId === upstreamAgentId && relation.secondTierAgentId === downstreamAgentId)
        || (relation.thirdTierAgentId === downstreamAgentId && relation.secondTierAgentId === upstreamAgentId)
      )
    );
  }

  private resolveCouponDiscount(actor: UserActor, snapshot: DemoOrderSnapshot, couponId?: string): CouponResolution {
    if (!couponId) {
      return { discountCents: 0n, buyerPaidAmountCents: snapshot.amountSnapshot.paidAmountCents };
    }
    const coupon = requireEntity(this.store.userCoupons.get(couponId), "RESOURCE_NOT_FOUND", "coupon not found");
    if (coupon.userId !== actor.userId || coupon.status !== "available") {
      throw new ApiError(400, "COUPON_INVALID", "coupon is not available");
    }
    const template = requireEntity(this.store.couponTemplates.get(coupon.templateId), "RESOURCE_NOT_FOUND", "coupon template not found");
    if (template.status !== "active") throw new ApiError(400, "COUPON_INVALID", "coupon template is inactive");
    if (!this.couponAppliesToSnapshot(template, snapshot)) throw new ApiError(400, "COUPON_INVALID", "coupon does not apply to this product");
    const expiresAt = new Date(coupon.grantedAt.getTime() + template.validDays * 24 * 60 * 60 * 1000);
    if (expiresAt < new Date()) throw new ApiError(400, "COUPON_INVALID", "coupon is expired");
    const discountCents = template.discountCents > snapshot.amountSnapshot.paidAmountCents ? snapshot.amountSnapshot.paidAmountCents : template.discountCents;
    return {
      userCoupon: coupon,
      discountCents,
      buyerPaidAmountCents: snapshot.amountSnapshot.paidAmountCents - discountCents
    };
  }

  private couponAppliesToSnapshot(template: CouponTemplate, snapshot: DemoOrderSnapshot) {
    if (template.productIds.length === 0) return true;
    const productId = getSnapshotProductId(snapshot);
    return Boolean(productId && template.productIds.includes(productId));
  }

  private couponAppliesToProduct(template: CouponTemplate, agentProductId: string) {
    if (template.productIds.length === 0) return true;
    const agentProduct = this.store.agentProducts.get(agentProductId);
    const shopProduct = this.store.platformShopProducts.get(agentProductId);
    const productId = agentProduct?.platformProductId ?? shopProduct?.platformProductId;
    return Boolean(productId && template.productIds.includes(productId));
  }

  private createClawback(order: DemoOrder, amountCents: bigint, sourceType: string, sourceId: string) {
    const balances = {
      pendingIncomeCents: this.store.pendingIncomeByAgent.get(order.agentId) ?? 0n,
      payableIncomeCents: this.store.payableIncomeByAgent.get(order.agentId) ?? 0n,
      depositAvailableCents: this.store.depositAccounts.get(order.agentId)?.availableAmountCents ?? 0n
    };
    const result = applyClawback(amountCents, balances);
    this.store.pendingIncomeByAgent.set(order.agentId, result.balances.pendingIncomeCents);
    this.store.payableIncomeByAgent.set(order.agentId, result.balances.payableIncomeCents);
    this.applyPayableClawbackToOpenSettlement(order, result.deductions);
    const deposit = this.store.depositAccounts.get(order.agentId);
    if (deposit) {
      deposit.availableAmountCents = result.balances.depositAvailableCents;
      deposit.status = shouldRestrictForDeposit(deposit) ? "insufficient" : deposit.status;
      const agent = this.store.agents.get(order.agentId);
      if (agent && shouldRestrictForDeposit(deposit)) agent.depositStatus = "insufficient";
    }
    const clawback = {
      clawbackNo: nextId(this.store, "clawback"),
      agentId: order.agentId,
      orderNo: order.orderNo,
      sourceType,
      sourceId,
      ...result
    };
    this.store.clawbacks.push(clawback);
    this.audit("system", "clawback.create", "order", order.orderNo, clawback);
    return clawback;
  }

  private tryAutoFulfillWithRightsCode(order: DemoOrder) {
    const agentProduct = this.store.agentProducts.get(order.agentProductId);
    const shopProduct = this.store.platformShopProducts.get(order.agentProductId);
    const productId = agentProduct?.platformProductId ?? shopProduct?.platformProductId;
    const product = productId ? this.store.platformProducts.get(productId) : undefined;
    const ownProduct = agentProduct?.ownProductReviewId ? this.store.ownProducts.get(agentProduct.ownProductReviewId) : undefined;
    const fulfillmentOwner = product ?? ownProduct;
    const inventoryProductId = product?.id ?? (ownProduct && agentProduct ? agentProduct.id : undefined);
    const rule = fulfillmentOwner?.fulfillmentRule;
    if (!isRecord(rule) || rule.mode !== "code_pool" || !fulfillmentOwner || !inventoryProductId) return;
    const quantity = order.snapshot.quantity;
    const issuedForOrder = this.store.rightsCodes
      .filter((item) => item.productId === inventoryProductId && item.status === "issued" && item.orderNo === order.orderNo);
    if (issuedForOrder.length >= quantity) {
      order.fulfillmentStatus = "success";
      order.status = "fulfilled";
      order.fulfilledAt ??= new Date();
      return;
    }
    const remainingQuantity = quantity - issuedForOrder.length;
    const codes = this.store.rightsCodes
      .filter((item) => item.productId === inventoryProductId && item.status === "available")
      .slice(0, remainingQuantity);
    if (codes.length < remainingQuantity) {
      order.fulfillmentStatus = "failed";
      order.status = "fulfillment_failed";
      order.settlementStatus = "frozen";
      if (order.salesChannelType !== "platform_self_operated") {
        this.notify(order.agentId, "stock.empty", "权益码库存不足", `${fulfillmentOwner.name} 库存不足，订单 ${order.orderNo} 已冻结结算。`);
      }
      return;
    }
    for (const [index, code] of codes.entries()) {
      code.status = "issued";
      code.orderNo = order.orderNo;
      code.issueKey = `${order.orderNo}:${issuedForOrder.length + index + 1}`;
      code.issuedAt = new Date();
    }
    order.fulfillmentStatus = "success";
    order.status = "fulfilled";
    order.fulfilledAt = new Date();
    this.store.fulfillmentRecords.set(order.orderNo, {
      fulfillmentId: `fulfillment-${order.orderNo}`,
      orderItemId: `${order.orderNo}-item-1`,
      status: "success",
      attemptCount: 1
    });
    if (order.salesChannelType !== "platform_self_operated") {
      this.notify(order.agentId, "order.auto_fulfilled", "订单已自动履约", `${order.orderNo} 已从权益码池自动发放。`);
    }
    this.recordEmailDelivery(order, codes);
    this.audit("system", "fulfillment.auto_code_pool", "order", order.orderNo, { codeIds: codes.map((code) => code.codeId) });
  }

  private confirmCollectedPayment(input: {
    actor: "agent" | "admin";
    operatorId: string;
    auditRole: string;
    order: DemoOrder;
    amountCents: bigint;
    voucherUrl?: string;
    note?: string;
  }) {
    const expectedAmount = payableAmount(input.order);
    if (input.order.paymentSnapshot?.provider && input.order.paymentSnapshot.provider !== "personal_alipay") {
      throw new ApiError(400, "MANUAL_CONFIRM_NOT_ALLOWED", "only personal alipay orders can be manually confirmed");
    }
    if (input.amountCents !== expectedAmount) {
      throw new ApiError(400, "AMOUNT_MISMATCH", "offline payment amount does not match order amount");
    }
    const idempotencyKey = `offline-payment:${input.order.orderNo}:${input.voucherUrl ?? expectedAmount.toString()}`;
    const result = this.registry.runOnce(idempotencyKey, () => {
      if (input.order.paymentStatus === "paid") {
        return { status: "already_paid" as const, idempotencyKey, order: this.serializePublicOrder(input.order, { includeDeliveryCodes: false }) };
      }
      this.applyPaidOrder(input.order, expectedAmount, "manual", {
        voucherUrl: input.voucherUrl,
        note: input.note,
        operatorId: input.operatorId,
        confirmActor: input.actor
      });
      input.order.paymentSnapshot = {
        ...(input.order.paymentSnapshot ?? {}),
        provider: input.order.paymentSnapshot?.provider ?? "personal_alipay",
        confirmationMode: "manual",
        amountCents: expectedAmount,
        currency: "CNY",
        orderNo: input.order.orderNo,
        status: "paid",
        confirmationSource: "manual",
        paidAt: input.order.paidAt ?? new Date()
      };
      this.audit(input.auditRole, "order.offline_payment.confirm", "order", input.order.orderNo, {
        amountCents: input.amountCents,
        voucherUrl: input.voucherUrl,
        note: input.note
      });
      return { status: "processed" as const, idempotencyKey, order: this.serializePublicOrder(input.order, { includeDeliveryCodes: false }) };
    });
    return result ?? { status: "duplicate" as const, idempotencyKey, order: this.serializePublicOrder(input.order, { includeDeliveryCodes: false }) };
  }

  private applyPayableClawbackToOpenSettlement(order: DemoOrder, deductions: Array<{ from: string; amountCents: bigint }>) {
    let payableDeductionCents = deductions
      .filter((deduction) => deduction.from === "payable_income")
      .reduce((total, deduction) => total + deduction.amountCents, 0n);
    if (payableDeductionCents === 0n) return;

    for (const sheet of this.store.settlementSheets) {
      if (sheet.status === "paid") continue;
      const item = sheet.items.find((candidate) => candidate.orderId === order.orderNo);
      if (!item) continue;

      const deducted = item.settleAmountCents > payableDeductionCents ? payableDeductionCents : item.settleAmountCents;
      item.deductedCents += deducted;
      item.settleAmountCents -= deducted;
      sheet.totalAgentIncomeCents -= deducted;
      payableDeductionCents -= deducted;
      if (payableDeductionCents === 0n) return;
    }
  }

  private addChannelPendingIncome(order: DemoOrder) {
    const channel = getChannelSnapshot(order.snapshot);
    if (!channel) return;
    this.store.pendingIncomeByAgent.set(
      channel.firstTierAgentId,
      (this.store.pendingIncomeByAgent.get(channel.firstTierAgentId) ?? 0n) + channel.firstTierIncomeCents
    );
    if (channel.thirdTierAgentId && channel.secondTierIncomeCents > 0n) {
      this.store.pendingIncomeByAgent.set(
        channel.secondTierAgentId,
        (this.store.pendingIncomeByAgent.get(channel.secondTierAgentId) ?? 0n) + channel.secondTierIncomeCents
      );
    }
  }

  private createInviteCode(input: {
    code?: string;
    issuerType: "platform" | "agent";
    issuerAgentId?: string;
    targetTier: AgentTier;
    maxUses?: number;
    expiresAt?: Date | null;
    createdBy: string;
    depositRequiredAmountCents?: bigint;
  }) {
    const code = input.code ?? `${input.targetTier.replace("_tier", "")}-${nextId(this.store, "invite").replace("invite-", "")}`;
    const codeHash = hashSecret(code);
    if (this.store.inviteCodes.has(code) || [...this.store.inviteCodes.values()].some((item) => item.code === code || item.codeHash === codeHash)) {
      throw new ApiError(400, "INVITE_CODE_DUPLICATE", "invite code already exists");
    }
    if (input.issuerType === "platform" && input.targetTier !== "first_tier") {
      throw new ApiError(400, "INVITE_RULE_FAILED", "platform invite can only target first tier");
    }
    if (input.issuerType === "platform" && (input.depositRequiredAmountCents === undefined || input.depositRequiredAmountCents <= 0n)) {
      throw new ApiError(400, "DEPOSIT_REQUIREMENT_MISSING", "platform invite requires deposit amount");
    }
    if (input.issuerType === "agent") {
      const issuer = requireEntity(input.issuerAgentId ? this.store.agents.get(input.issuerAgentId) : undefined, "RESOURCE_NOT_FOUND", "issuer agent not found");
      const issuerTier = this.agentTier(issuer.id);
      if (issuerTier === "first_tier" && input.targetTier !== "second_tier") throw new ApiError(400, "INVITE_RULE_FAILED", "first-tier invite must target second tier");
      if (issuerTier === "second_tier" && input.targetTier !== "third_tier") throw new ApiError(400, "INVITE_RULE_FAILED", "second-tier invite must target third tier");
      if (issuerTier === "third_tier") throw new ApiError(400, "FOURTH_TIER_FORBIDDEN", "third-tier merchants cannot create fourth-tier invite codes");
    }
    const invite: InviteCode = {
      id: nextId(this.store, "invite-code"),
      code,
      codeHash,
      issuerType: input.issuerType,
      issuerAgentId: input.issuerAgentId,
      targetTier: input.targetTier,
      status: "active",
      maxUses: input.maxUses ?? null,
      usedCount: 0,
      depositRequiredAmountCents: input.depositRequiredAmountCents,
      expiresAt: input.expiresAt ?? null,
      createdBy: input.createdBy,
      createdAt: new Date()
    };
    this.store.inviteCodes.set(invite.id, invite);
    return invite;
  }

  private assertInviteUsable(invite: InviteCode) {
    if (invite.status !== "active") throw new ApiError(400, "INVITE_CODE_INVALID", "invite code is not active");
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      invite.status = "expired";
      throw new ApiError(400, "INVITE_CODE_INVALID", "invite code is expired");
    }
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
      invite.status = "used_up";
      throw new ApiError(400, "INVITE_CODE_INVALID", "invite code has been used up");
    }
    if (invite.targetTier === "third_tier") {
      const issuer = requireEntity(invite.issuerAgentId ? this.store.agents.get(invite.issuerAgentId) : undefined, "INVITE_CODE_INVALID", "issuer not found");
      if (this.agentTier(issuer.id) !== "second_tier") throw new ApiError(400, "FOURTH_TIER_FORBIDDEN", "invalid third-tier invite issuer");
    }
  }

  private findInviteByCode(code: string) {
    const codeHash = hashSecret(code);
    return [...this.store.inviteCodes.values()].find((candidate) => (
      candidate.code === code || candidate.codeHash === codeHash
    ));
  }

  private depositRequirementForAgentInvite(agentId: string) {
    const account = requireEntity(this.store.depositAccounts.get(agentId), "RESOURCE_NOT_FOUND", "deposit account not found");
    if (account.requiredAmountCents <= 0n) {
      throw new ApiError(400, "DEPOSIT_REQUIREMENT_MISSING", "issuer deposit requirement is missing");
    }
    return account.requiredAmountCents;
  }

  private createPendingRelationForInvite(invite: InviteCode, childAgentId: string) {
    if (invite.targetTier === "first_tier") return;
    const parentAgentId = required(invite.issuerAgentId, "issuerAgentId");
    if (invite.targetTier === "second_tier") {
      this.store.channelRelations.push({
        id: nextId(this.store, "channel-rel"),
        firstTierAgentId: parentAgentId,
        secondTierAgentId: childAgentId,
        status: "pending_review",
        reason: "invite_registration",
        reviewedAt: null,
        activeUniqueKey: `second-tier:${childAgentId}`
      });
      return;
    }
    const upstream = requireEntity(
      this.store.channelRelations.find((relation) => relation.status === "active" && !relation.thirdTierAgentId && relation.secondTierAgentId === parentAgentId),
      "CHANNEL_RULE_FAILED",
      "second-tier issuer must have an active first-tier relation before inviting third tier"
    );
    this.store.channelRelations.push({
      id: nextId(this.store, "channel-rel"),
      firstTierAgentId: upstream.firstTierAgentId,
      secondTierAgentId: parentAgentId,
      thirdTierAgentId: childAgentId,
      status: "pending_review",
      reason: "invite_registration",
      reviewedAt: null,
      activeUniqueKey: `third-tier:${childAgentId}`
    });
  }

  private activateEligibleInviteRelations(agentId: string) {
    for (const relation of this.store.channelRelations) {
      if (relation.status !== "pending_deposit") continue;
      if (relation.secondTierAgentId !== agentId && relation.thirdTierAgentId !== agentId) continue;
      const second = this.store.agents.get(relation.secondTierAgentId);
      const third = relation.thirdTierAgentId ? this.store.agents.get(relation.thirdTierAgentId) : undefined;
      if (second?.status === "active" && (!relation.thirdTierAgentId || third?.status === "active")) {
        relation.status = "active";
        relation.reviewedAt = new Date();
      }
    }
  }

  private agentTier(agentId: string): AgentTier {
    const agent = requireEntity(this.store.agents.get(agentId), "RESOURCE_NOT_FOUND", "agent not found");
    if (agent.tier) return agent.tier;
    if (this.store.channelRelations.some((relation) => relation.status === "active" && relation.thirdTierAgentId === agentId)) return "third_tier";
    if (this.store.channelRelations.some((relation) => relation.status === "active" && relation.secondTierAgentId === agentId)) return "second_tier";
    return "first_tier";
  }

  private serializeInviteCode(invite: InviteCode, actor?: AgentActor) {
    return {
      id: invite.id,
      code: invite.code || undefined,
      targetTier: invite.targetTier,
      status: invite.status,
      maxUses: invite.maxUses,
      usedCount: invite.usedCount,
      expiresAt: invite.expiresAt,
      depositRequiredAmountCents: invite.depositRequiredAmountCents,
      issuer: {
        type: invite.issuerType,
        agentId: invite.issuerAgentId
      },
      currentMerchantScope: actor ? {
        agentId: actor.agentId,
        shopId: actor.shopId,
        ownsInvite: invite.issuerAgentId === actor.agentId
      } : undefined,
      createdAt: invite.createdAt
    };
  }

  private findActiveChannelRelationForSellingAgent(agentId: string) {
    return this.store.channelRelations.find((relation) => (relation.thirdTierAgentId === agentId || (!relation.thirdTierAgentId && relation.secondTierAgentId === agentId)) && relation.status === "active");
  }

  private findFirstSecondRelationFor(relation: ChannelRelation) {
    if (!relation.thirdTierAgentId) return relation;
    return this.store.channelRelations.find((candidate) => candidate.status === "active" && !candidate.thirdTierAgentId && candidate.firstTierAgentId === relation.firstTierAgentId && candidate.secondTierAgentId === relation.secondTierAgentId);
  }

  private firstSecondRelationFor(relation: ChannelRelation) {
    return requireEntity(this.findFirstSecondRelationFor(relation), "RESOURCE_NOT_FOUND", "first-to-second channel relation not found");
  }

  private upstreamSupplyPriceForRelation(relation: ChannelRelation, platformProductId: string) {
    if (!relation.thirdTierAgentId) {
      const product = requireEntity(this.store.platformProducts.get(platformProductId), "RESOURCE_NOT_FOUND", "platform product not found");
      return product.supplyPriceCents;
    }
    const firstSecondRelation = this.firstSecondRelationFor(relation);
    return requireEntity(
      this.store.channelProductOffers.find((item) => item.channelRelationId === firstSecondRelation.id && item.platformProductId === platformProductId && item.status === "listed"),
      "RESOURCE_NOT_FOUND",
      "upstream channel product offer not found"
    ).resellSupplyPriceCents;
  }

  private findShopByAgentId(agentId: string) {
    return [...this.store.shops.values()].find((candidate) => candidate.agentId === agentId);
  }

  private addDepositTransaction(agentId: string, input: Omit<DepositTransaction, "transactionNo" | "agentId">) {
    const transaction: DepositTransaction = {
      transactionNo: nextId(this.store, "deposit-tx"),
      agentId,
      ...input
    };
    this.store.depositTransactions.push(transaction);
    return transaction;
  }

  private audit(actor: string, action: string, targetType: string, targetId: string, after: unknown) {
    this.store.auditLogs.push({
      id: nextId(this.store, "audit"),
      actor,
      action,
      targetType,
      targetId,
      after,
      createdAt: new Date()
    });
  }

  private ledger(entryType: string, target: { orderNo?: string; agentId?: string }, amountCents: bigint, metadata: unknown) {
    this.store.ledgerEntries.push({
      ledgerNo: nextId(this.store, "ledger"),
      entryType,
      orderNo: target.orderNo,
      agentId: target.agentId,
      amountCents,
      metadata,
      createdAt: new Date()
    });
  }

  private notify(agentId: string, type: string, title: string, content: string) {
    const notification: NotificationItem = {
      id: nextId(this.store, "notice"),
      agentId,
      type,
      title,
      content,
      createdAt: new Date(),
      readAt: null
    };
    this.store.notifications.push(notification);
    return notification;
  }

  private recordExtractLog(order: DemoOrder, userId: string, attemptResult: string, failureReason?: string) {
    this.store.extractLogs.push({
      id: nextId(this.store, "extract-log"),
      orderNo: order.orderNo,
      userId,
      attemptResult,
      failureReason,
      failedAttemptsAfter: order.extractionAttemptCount ?? 0,
      lockedUntil: order.extractionLockedUntil,
      createdAt: new Date()
    });
  }

  private extractionTokenForOrder(order: DemoOrder) {
    const baseTime = order.fulfilledAt ?? order.paidAt ?? new Date();
    const expiresAt = baseTime.getTime() + 24 * 60 * 60 * 1000;
    return `ext_${expiresAt.toString(36)}_${this.extractionTokenSignature(order, expiresAt)}`;
  }

  private extractionTokenSignature(order: DemoOrder, expiresAt: number) {
    const secret = process.env.AUTH_TOKEN_SECRET ?? "dev-extraction-token-secret";
    const source = [
      order.orderNo,
      order.userId,
      order.shopId,
      "rights_code_extract",
      expiresAt.toString(),
      order.refundStatus,
      order.status,
      order.extractionCodeHash ?? "no-password",
      secret
    ].join(":");
    return hashSecret(source).slice(0, 40);
  }

  private recordEmailDelivery(order: DemoOrder, issuedCodes: RightsCode[], source: "auto_fulfillment" | "manual_resend" = "auto_fulfillment") {
    if (!order.buyerEmail) return undefined;
    const enabled = process.env.EMAIL_DELIVERY_ENABLED === "true";
    const item: EmailDelivery = {
      id: nextId(this.store, "email"),
      orderNo: order.orderNo,
      userId: order.userId,
      email: order.buyerEmail,
      codeCount: issuedCodes.length,
      source,
      status: enabled ? "sent" : "provider_not_configured",
      reason: enabled ? undefined : "EMAIL_PROVIDER_NOT_CONFIGURED",
      createdAt: new Date()
    };
    this.store.emailDeliveries.push(item);
    this.audit("system", "email.delivery.record", "order", order.orderNo, {
      email: item.email,
      status: item.status,
      codeCount: item.codeCount,
      source,
      reason: item.reason
    });
    return item;
  }

  listExtractLogs(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return this.store.extractLogs;
  }

  private isSecondTierSupplier(agentId: string) {
    return this.store.channelRelations.some((relation) => relation.status === "active" && relation.secondTierAgentId === agentId && relation.thirdTierAgentId);
  }

  private assertAgentDepositConfirmed(agentId: string, action: string) {
    const account = requireEntity(this.store.depositAccounts.get(agentId), "RESOURCE_NOT_FOUND", "deposit account not found");
    if (shouldRestrictForDeposit(account)) {
      throw new ApiError(403, "DEPOSIT_INSUFFICIENT", `agent deposit is required before ${action}`);
    }
  }
}

class PrismaStateRepository {
  private readonly loadedOrderNos = new Set<string>();

  constructor(
    private readonly prisma: PrismaClient,
    readonly repositories: PrismaRepositoryRegistry
  ) {}

  async verifyAdmin(input: { username: string; password: string }): Promise<AdminLoginResult> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{
        id: string;
        username: string;
        display_name: string;
        password_hash: string;
        status: string;
        role_code: "operator" | "finance" | "admin" | null;
      }>>`
        SELECT au.id, au.username, au.display_name, au.password_hash, au.status, r.code AS role_code
          FROM admin_users au
          LEFT JOIN admin_user_roles aur ON aur.admin_user_id = au.id
          LEFT JOIN roles r ON r.id = aur.role_id
         WHERE au.username = ${input.username}
         LIMIT 1
      `;
      const admin = rows[0];
      if (admin && admin.status === "active" && verifyPassword(input.password, admin.password_hash)) {
        return {
          adminId: admin.id,
          username: admin.username,
          displayName: admin.display_name,
          role: admin.role_code ?? "operator"
        };
      }
    } catch (error) {
      if (!isPrismaConnectionError(error)) throw error;
    }

    const bootstrapUsername = process.env.ADMIN_USERNAME;
    const bootstrapPassword = process.env.ADMIN_PASSWORD;
    if (bootstrapUsername && bootstrapPassword && input.username === bootstrapUsername && input.password === bootstrapPassword) {
      return {
        adminId: process.env.ADMIN_ID ?? "admin-bootstrap",
        username: bootstrapUsername,
        displayName: process.env.ADMIN_DISPLAY_NAME ?? "生产管理员",
        role: (process.env.ADMIN_ROLE as AdminLoginResult["role"] | undefined) ?? "admin"
      };
    }

    throw new ApiError(401, "AUTH_INVALID", "invalid admin credentials");
  }

  async verifyAgent(input: { account: string; password: string }): Promise<AgentLoginResult> {
    const rows = await this.prisma.$queryRaw<Array<{
      username: string;
      password_hash: string | null;
      status: string;
      must_change_password: boolean;
      agent_id: string | null;
      shop_id: string | null;
      display_name: string | null;
      tier: AgentTier | null;
      agent_status: string | null;
      deposit_status: string | null;
      shop_name: string | null;
      shop_status: string | null;
    }>>`
	      SELECT ma.username, ma.password_hash, ma.status, ma.must_change_password,
	             a.id AS agent_id, s.id AS shop_id, a.name AS display_name,
	             CASE
	               WHEN EXISTS (
	                 SELECT 1 FROM channel_relations cr
	                  WHERE cr.third_tier_agent_id = a.id
	                    AND cr.status IN ('active', 'pending_review')
	               ) THEN 'third_tier'
	               WHEN EXISTS (
	                 SELECT 1 FROM channel_relations cr
	                  WHERE cr.second_tier_agent_id = a.id
	                    AND cr.status IN ('active', 'pending_review')
	               ) THEN 'second_tier'
	               ELSE 'first_tier'
	             END AS tier,
	             a.status AS agent_status, a.deposit_status, s.name AS shop_name, s.status AS shop_status
	        FROM merchant_accounts ma
	        JOIN agents a ON a.user_id = ma.user_id
        JOIN shops s ON s.agent_id = a.id
       WHERE ma.username = ${input.account}
          OR ma.phone = ${input.account}
          OR ma.email = ${input.account}
       ORDER BY ma.created_at DESC
       LIMIT 1
    `;
    const account = rows[0];
    if (!account || account.status !== "active" || !account.password_hash || !verifyPassword(input.password, account.password_hash)) {
      throw new ApiError(401, "AUTH_INVALID", "invalid merchant credentials");
    }
    if (!account.agent_id || !account.shop_id) {
      throw new ApiError(401, "AUTH_INVALID", "merchant account is not linked to an active shop");
    }
    if (account.agent_status !== "active" && account.agent_status !== "pending_deposit") {
      throw new ApiError(403, "AUTH_DISABLED", "merchant account is not active");
    }
    return {
      agentId: account.agent_id,
      shopId: account.shop_id,
      username: account.username,
      displayName: account.display_name ?? account.username,
      tier: account.tier ?? undefined,
      status: account.agent_status ?? "pending_review",
      depositStatus: account.deposit_status ?? "pending_payment",
      shopName: account.shop_name ?? account.username,
      shopStatus: account.shop_status ?? "not_opened",
      mustChangePassword: account.must_change_password
    };
  }

  async load(): Promise<MemoryStore> {
    const store = createEmptyMemoryStore();
    await Promise.all([
      this.loadAgentsAndDeposits(store),
      this.loadShops(store),
      this.loadPlatformProducts(store),
      this.loadOwnProductReviews(store),
      this.loadAgentProducts(store),
      this.loadCollectionChannels(store),
      this.loadRightsCodes(store),
      this.loadOrders(store),
      this.loadCoupons(store),
      this.loadInviteAndChannelState(store),
      this.loadFinancialState(store),
      this.loadEmailDeliveries(store)
    ]);
    await this.loadPaymentConfig(store);
    await this.loadPaymentMethodConfigs(store);
    await this.loadPaymentRuntimeState(store);
    return store;
  }

  async save(_store: MemoryStore): Promise<void> {
    await this.persistInShortTransaction((tx) => this.persistUsers(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistAgents(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistMerchantAccounts(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistShops(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistProducts(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistCollectionChannels(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistCoupons(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistInviteAndChannelState(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistDeposits(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistOrders(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistAfterSalesAndRefunds(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistFulfillmentAndExtraction(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistSettlements(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistRiskAuditLedger(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistNotificationsAndPaymentConfig(tx, _store));
  }

	  async saveForMethod(method: string, store: MemoryStore): Promise<void> {
	    if (method === "createAgentByAdmin") {
	      await this.persistInShortTransaction((tx) => this.persistLatestManualAgentCreation(tx, store));
	      return;
	    }
    if (method === "createPlatformInviteCode" || method === "createAgentInviteCode") {
      await this.persistInShortTransaction((tx) => this.persistLatestInviteCodeCreation(tx, store));
      return;
    }
	    if (method === "registerAgentByInvite") {
	      await this.persistInShortTransaction((tx) => this.persistLatestInviteRegistration(tx, store));
	      return;
	    }
    if (method === "reviewAgent") {
      await this.persistInShortTransaction((tx) => this.persistLatestAgentReview(tx, store));
      return;
    }
	    if ([
	      "submitAgentApplication"
	    ].includes(method)) {
      await this.persistInShortTransaction((tx) => this.persistUsers(tx, store));
      await this.persistInShortTransaction((tx) => this.persistAgents(tx, store));
      await this.persistInShortTransaction((tx) => this.persistMerchantAccounts(tx, store));
      await this.persistInShortTransaction((tx) => this.persistShops(tx, store));
      await this.persistInShortTransaction((tx) => this.persistInviteAndChannelState(tx, store));
      await this.persistInShortTransaction((tx) => this.persistDeposits(tx, store));
      await this.persistInShortTransaction((tx) => this.persistRiskAuditLedger(tx, store));
      return;
    }
    if (method === "confirmDeposit") {
      await this.persistInShortTransaction((tx) => this.persistLatestDepositConfirmation(tx, store));
      return;
    }
    if (method === "deductDeposit") {
      await this.persistInShortTransaction((tx) => this.persistAgents(tx, store));
      await this.persistInShortTransaction((tx) => this.persistDeposits(tx, store));
      await this.persistInShortTransaction((tx) => this.persistRiskAuditLedger(tx, store));
      return;
    }
    if (method === "createPlatformProduct") {
      await this.persistInShortTransaction((tx) => this.persistLatestPlatformProductCreation(tx, store));
      return;
    }
    if (method === "addRightsCodes") {
      await this.persistInShortTransaction((tx) => this.persistLatestRightsCodeImport(tx, store));
      return;
    }
    if (method === "addAgentRightsCodes") {
      await this.persistInShortTransaction((tx) => this.persistLatestAgentRightsCodeImport(tx, store));
      return;
    }
    if (method === "submitAgentCollectionChannel") {
      await this.persistInShortTransaction((tx) => this.persistLatestCollectionChannelSubmission(tx, store));
      return;
    }
    if (method === "reviewCollectionChannel") {
      await this.persistInShortTransaction((tx) => this.persistLatestCollectionChannelReview(tx, store));
      return;
    }
    if (method === "selectPlatformProduct") {
      await this.persistInShortTransaction((tx) => this.persistLatestPlatformProductSelection(tx, store));
      return;
    }
    if (method === "upsertPlatformShopProduct") {
      await this.persistInShortTransaction((tx) => this.persistLatestPlatformShopProductUpsert(tx, store));
      return;
    }
    if (method === "updatePlatformShopProductDetail") {
      await this.persistInShortTransaction((tx) => this.persistLatestPlatformShopProductUpdate(tx, store));
      return;
    }
    if (method === "upsertChannelProductOffer" || method === "upsertAgentChannelProductOffer") {
      await this.persistInShortTransaction((tx) => this.persistLatestChannelProductOfferUpsert(tx, store));
      return;
    }
    if (method === "reviewChannelAuthorization") {
      await this.persistInShortTransaction((tx) => this.persistLatestChannelAuthorizationReview(tx, store));
      return;
    }
    if (method === "createChannelRelation") {
      await this.persistInShortTransaction((tx) => this.persistLatestChannelRelationCreation(tx, store));
      return;
    }
    if (method === "updatePlatformProduct") {
      await this.persistInShortTransaction((tx) => this.persistLatestPlatformProductUpdate(tx, store));
      return;
    }
    if (method === "submitOwnProduct") {
      await this.persistInShortTransaction((tx) => this.persistLatestOwnProductSubmission(tx, store));
      return;
    }
    if (method === "updateOwnProductDetail") {
      await this.persistInShortTransaction((tx) => this.persistLatestOwnProductUpdate(tx, store));
      return;
    }
    if (method === "reviewOwnProduct") {
      await this.persistInShortTransaction((tx) => this.persistLatestOwnProductReview(tx, store));
      return;
    }
    if (method === "batchSelectPlatformProducts") {
      await this.persistInShortTransaction((tx) => this.persistLatestPlatformProductBatchSelection(tx, store));
      return;
    }
    if (method === "setAgentProductPrice") {
      await this.persistInShortTransaction((tx) => this.persistLatestAgentProductPriceUpdate(tx, store));
      return;
    }
    if (method === "updateAgentProductDetail") {
      await this.persistInShortTransaction((tx) => this.persistLatestAgentProductDetailUpdate(tx, store));
      return;
    }
    if ([
      "updateAgentShop",
      "updateAgentShopCollection",
      "updateShopDecor",
      "updateShopCollection",
      "updateShopServiceQrCode"
    ].includes(method)) {
      await this.persistInShortTransaction((tx) => this.persistShops(tx, store));
      await this.persistInShortTransaction((tx) => this.persistCollectionChannels(tx, store));
      await this.persistInShortTransaction((tx) => this.persistRiskAuditLedger(tx, store));
      return;
    }
    if (method === "createCouponTemplate" || method === "updateCouponTemplateStatus") {
      await this.persistInShortTransaction((tx) => this.persistLatestCouponTemplateMutation(tx, store));
      return;
    }
    if (method === "grantRegistrationCoupon") {
      await this.persistInShortTransaction((tx) => this.persistLatestRegistrationCouponGrant(tx, store));
      return;
    }
    if (method === "createOrder") {
      await this.persistInShortTransaction((tx) => this.persistLatestOrderCreation(tx, store));
      return;
    }
    if (method === "confirmAgentOfflinePayment" || method === "confirmOfflinePayment") {
      await this.persistInShortTransaction((tx) => this.persistLatestOfflinePaymentConfirmation(tx, store));
      return;
    }
    if (method === "createPaymentVoucher") {
      await this.persistInShortTransaction((tx) => this.persistLatestPaymentVoucher(tx, store));
      return;
    }
    if (method === "confirmPaymentVoucher") {
      await this.persistInShortTransaction((tx) => this.persistLatestPaymentVoucher(tx, store));
      return;
    }
    if (method === "createPaymentOrder") {
      await this.persistInShortTransaction((tx) => this.persistLatestPaymentOrderCreation(tx, store));
      return;
    }
    if (method === "fulfillAgentOrder") {
      await this.persistInShortTransaction((tx) => this.persistLatestFulfillmentUpdate(tx, store));
      return;
    }
    if (method === "resendOrderEmailDelivery") {
      await this.persistInShortTransaction((tx) => this.persistRiskAuditLedger(tx, store));
      return;
    }
    if (method === "createAfterSale") {
      await this.persistInShortTransaction((tx) => this.persistLatestAfterSaleCreation(tx, store));
      return;
    }
    if (method === "updateAgentAfterSaleAssist") {
      await this.persistInShortTransaction((tx) => {
        const audit = this.latestAuditLog(store, ["after_sale.agent_assist"]);
        return this.persistAuditLogs(tx, audit ? [audit] : []);
      });
      return;
    }
    if (method === "approveRefund") {
      await this.persistInShortTransaction((tx) => this.persistLatestRefundApproval(tx, store));
      return;
    }
    if (method === "confirmManualRefund") {
      await this.persistInShortTransaction((tx) => this.persistLatestManualRefundConfirmation(tx, store));
      return;
    }
    if (method === "revealRightsCodesPlaintext") {
      await this.persistInShortTransaction((tx) => {
        const audit = this.latestAuditLog(store, ["rights_code.secret.read"]);
        return this.persistAuditLogs(tx, audit ? [audit] : []);
      });
      return;
    }
    if (method === "exportReconciliationSummary") {
      await this.persistInShortTransaction((tx) => {
        const audit = this.latestAuditLog(store, ["export.reconciliation_summary"]);
        return this.persistAuditLogs(tx, audit ? [audit] : []);
      });
      return;
    }
    if ([
      "fulfillOrder",
      "refundCallback",
      "paymentCallback",
      "paymentProviderCallback",
      "queryPaymentOrder"
    ].includes(method)) {
      await this.persistInShortTransaction((tx) => this.persistLatestPaymentResult(tx, store, method));
      return;
    }
    if (method === "generateSettlement") {
      await this.persistInShortTransaction((tx) => this.persistLatestSettlementGeneration(tx, store));
      return;
    }
    if (method === "confirmManualPayout") {
      await this.persistInShortTransaction((tx) => this.persistLatestManualPayoutConfirmation(tx, store));
      return;
    }
    if (method === "createRiskFreeze" || method === "releaseRiskFreeze") {
      await this.persistInShortTransaction((tx) => this.persistRiskAuditLedger(tx, store));
      return;
    }
    if (method === "handlePaymentException") {
      await this.persistInShortTransaction((tx) => this.persistLatestPaymentExceptionHandling(tx, store));
      return;
    }
    if ([
      "upsertAdminPaymentMethod",
      "setAdminPaymentMethodDefault",
      "deleteAdminPaymentMethod",
      "testAdminPaymentMethod",
      "upsertAgentPaymentMethod",
      "setAgentPaymentMethodDefault",
      "deleteAgentPaymentMethod",
      "testAgentPaymentMethod"
    ].includes(method)) {
      await this.persistInShortTransaction((tx) => this.persistLatestPaymentMethodMutation(tx, store));
      return;
    }
    if (method === "markNotificationRead" || method === "updatePaymentConfigMetadata") {
      await this.persistInShortTransaction((tx) => this.persistNotificationsAndPaymentConfig(tx, store));
      await this.persistInShortTransaction((tx) => this.persistRiskAuditLedger(tx, store));
      return;
    }
    throw new ApiError(501, "PERSISTENCE_NOT_IMPLEMENTED", `Prisma targeted persistence is not implemented for ${method}`);
  }

  private persistInShortTransaction<T>(fn: (tx: PrismaTx) => Promise<T>): Promise<T> {
    return this.repositories.tx.transaction(fn, { maxWait: 10_000, timeout: 30_000 });
  }

  private async persistUsers(tx: PrismaTx, store: MemoryStore) {
    const userIds = new Set<string>();
    for (const agent of store.agents.values()) userIds.add(agent.userId);
    for (const application of store.agentApplications.values()) userIds.add(application.userId);
    for (const order of store.orders.values()) userIds.add(order.userId);
    for (const coupon of store.userCoupons.values()) userIds.add(coupon.userId);
    for (const userId of userIds) {
      await tx.$executeRaw`
        INSERT INTO users (id, status, created_at, updated_at)
        VALUES (${userId}, 'active', now(), now())
        ON CONFLICT (id) DO UPDATE SET updated_at = now()
      `;
    }
  }

  private async persistMerchantAccounts(tx: PrismaTx, store: MemoryStore) {
    for (const agent of store.agents.values()) {
      if (agent.initialPasswordSet && agent.passwordHash) {
        await this.persistMerchantAccountForAgent(tx, agent);
      }
    }
  }

  private async persistLatestManualAgentCreation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["agent.admin_create_first_tier"]);
    const agentId = audit ? stringValue(audit.targetId) : undefined;
    const agent = agentId ? store.agents.get(agentId) : undefined;
    if (!agent) throw new Error("manual agent creation missing current agent");
    const shop = [...store.shops.values()].find((item) => item.agentId === agent.id);
    if (!shop) throw new Error("manual agent creation missing current shop");
    const depositAccount = store.depositAccounts.get(agent.id);
    if (!depositAccount) throw new Error("manual agent creation missing deposit account");
    const depositTransaction = [...store.depositTransactions]
      .reverse()
      .find((item) => item.agentId === agent.id && item.reasonCode === "admin_manual_create");

    await this.persistUserId(tx, agent.userId);
    await this.persistAgent(tx, agent);
    await this.persistMerchantAccountForAgent(tx, agent);
    await this.persistShop(tx, shop);
    await this.persistDepositAccount(tx, agent.id, depositAccount);
    if (depositTransaction) await this.persistDepositTransaction(tx, depositTransaction);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

	  private async persistUserId(tx: PrismaTx, userId: string) {
	    await tx.$executeRaw`
	      INSERT INTO users (id, status, created_at, updated_at)
	      VALUES (${userId}, 'active', now(), now())
	      ON CONFLICT (id) DO UPDATE SET updated_at = now()
	    `;
	  }

  private async persistLatestInviteCodeCreation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["invite_code.create.platform", "invite_code.create.agent"]);
    const inviteId = audit ? stringValue(audit.targetId) : undefined;
    const invite = inviteId ? store.inviteCodes.get(inviteId) : undefined;
    if (!invite) throw new Error("invite code creation missing current invite");
    await this.persistInviteCode(tx, invite);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestInviteRegistration(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["agent.register_by_invite"]);
    const agentId = audit ? stringValue(audit.targetId) : undefined;
    const agent = agentId ? store.agents.get(agentId) : undefined;
    if (!agent) throw new Error("invite registration missing current agent");
    const shop = [...store.shops.values()].find((item) => item.agentId === agent.id);
    if (!shop) throw new Error("invite registration missing current shop");
    const application = [...store.agentApplications.values()].find((item) => item.agentId === agent.id);
    if (!application) throw new Error("invite registration missing current application");
    const depositAccount = store.depositAccounts.get(agent.id);
    if (!depositAccount) throw new Error("invite registration missing deposit account");
    const inviteId = stringValue((audit?.after as Record<string, unknown> | undefined)?.inviteCodeId) ?? application.inviteCodeId;
    const invite = inviteId ? store.inviteCodes.get(inviteId) : undefined;
    if (!invite) throw new Error("invite registration missing invite code");
    const relation = store.channelRelations.find((item) =>
      item.reason === "invite_registration"
      && (item.secondTierAgentId === agent.id || item.thirdTierAgentId === agent.id)
    );

    await this.persistUserId(tx, agent.userId);
    await this.persistAgent(tx, agent);
    await this.persistMerchantAccountForAgent(tx, agent);
    await this.persistShop(tx, shop);
    await this.persistAgentApplication(tx, application);
    await this.persistInviteCode(tx, invite);
    if (relation) await this.persistChannelRelation(tx, relation);
    await this.persistDepositAccount(tx, agent.id, depositAccount);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestAgentReview(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["agent.review"]);
    const agentId = audit ? stringValue(audit.targetId) : undefined;
    const agent = agentId ? store.agents.get(agentId) : undefined;
    if (!agent) throw new Error("agent review missing current agent");
    const shop = [...store.shops.values()].find((item) => item.agentId === agent.id);
    const application = [...store.agentApplications.values()].find((item) => item.agentId === agent.id);
    const depositAccount = store.depositAccounts.get(agent.id);
    const relations = store.channelRelations.filter((item) =>
      item.secondTierAgentId === agent.id || item.thirdTierAgentId === agent.id
    );

    await this.persistUserId(tx, agent.userId);
    await this.persistAgent(tx, agent);
    await this.persistMerchantAccountForAgent(tx, agent);
    if (shop) await this.persistShop(tx, shop);
    if (application) await this.persistAgentApplication(tx, application);
    if (depositAccount) await this.persistDepositAccount(tx, agent.id, depositAccount);
    for (const relation of relations) await this.persistChannelRelation(tx, relation);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestChannelAuthorizationReview(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["channel.authorization.review"]);
    const agentId = audit ? stringValue(audit.targetId) : undefined;
    const authorization = agentId
      ? store.channelAuthorizations.find((item) => item.firstTierAgentId === agentId)
      : undefined;
    if (!authorization) throw new Error("channel authorization review missing current authorization");
    await this.persistChannelAuthorization(tx, authorization);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestChannelRelationCreation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["channel.relation.create"]);
    if (!audit) return;
    const relationId = stringValue(audit.targetId);
    const relation = relationId ? store.channelRelations.find((item) => item.id === relationId) : undefined;
    if (!relation) throw new Error("channel relation creation missing current relation");
    await this.persistChannelRelation(tx, relation);
    await this.persistAuditLogs(tx, [audit]);
  }

			  private async persistMerchantAccountForAgent(tx: PrismaTx, agent: DemoAgent) {
    if (!agent.initialPasswordSet || !agent.passwordHash) return;
    const username = agent.merchantUsername ?? agent.id;
    await tx.$executeRaw`
      INSERT INTO merchant_accounts (
        id, user_id, merchant_id, username, phone, password_hash, role, status,
        initial_delivery_status, initial_delivered_at, must_change_password,
        created_by_admin_id, created_at, updated_at
      )
      VALUES (
        ${stableDbId("merchant_account", agent.id)}, ${agent.userId}, NULL,
        ${username}, ${agent.contactPhone ?? null}, ${agent.passwordHash},
        CAST('owner' AS "MerchantAccountRole"), CAST('active' AS "MerchantAccountStatus"),
        CAST('delivered' AS "InitialAccountDeliveryStatus"), now(), true,
        NULL, now(), now()
      )
      ON CONFLICT (username) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        phone = EXCLUDED.phone,
        password_hash = EXCLUDED.password_hash,
        status = EXCLUDED.status,
        initial_delivery_status = EXCLUDED.initial_delivery_status,
        initial_delivered_at = COALESCE(merchant_accounts.initial_delivered_at, EXCLUDED.initial_delivered_at),
        updated_at = now()
    `;
  }

	  private async persistAgent(tx: PrismaTx, agent: DemoAgent) {
	    await tx.$executeRaw`
      INSERT INTO agents (
        id, user_id, agent_no, name, contact_phone, status, risk_status,
        deposit_status, approved_at, created_at, updated_at
      )
      VALUES (
        ${agent.id}, ${agent.userId}, ${agent.id}, ${agent.name}, ${agent.contactPhone ?? null},
        CAST(${mapAgentStatus(agent.status)} AS "AgentStatus"),
        CAST(${mapRiskStatus(agent.riskStatus)} AS "RiskStatus"),
        CAST(${mapDepositStatus(agent.depositStatus)} AS "DepositStatus"),
        ${agent.status === "active" ? new Date() : null}, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        contact_phone = EXCLUDED.contact_phone,
        status = EXCLUDED.status,
        risk_status = EXCLUDED.risk_status,
        deposit_status = EXCLUDED.deposit_status,
        updated_at = now()
	      `;
      await this.persistMerchantForAgent(tx, agent);
	  }

  private async persistMerchantForAgent(tx: PrismaTx, agent: DemoAgent) {
    await tx.$executeRaw`
      INSERT INTO merchants (
        id, merchant_no, tier, name, contact_phone, status, risk_status,
        deposit_status, creation_source, created_by_admin_id,
        initial_account_status, approved_at, created_at, updated_at
      )
      VALUES (
        ${agent.id}, ${agent.id}, CAST(${agent.tier ?? "first_tier"} AS "MerchantTier"),
        ${agent.name}, ${agent.contactPhone ?? null},
        CAST(${mapAgentStatus(agent.status)} AS "AgentStatus"),
        CAST(${mapRiskStatus(agent.riskStatus)} AS "RiskStatus"),
        CAST(${mapDepositStatus(agent.depositStatus)} AS "DepositStatus"),
        CAST(${agent.createdByAdminId ? "admin_manual" : "invite_application"} AS "MerchantCreationSource"),
        ${agent.createdByAdminId ?? null},
        CAST(${agent.initialPasswordSet ? "delivered" : "pending"} AS "InitialAccountDeliveryStatus"),
        ${agent.status === "active" ? new Date() : null}, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        tier = EXCLUDED.tier,
        name = EXCLUDED.name,
        contact_phone = EXCLUDED.contact_phone,
        status = EXCLUDED.status,
        risk_status = EXCLUDED.risk_status,
        deposit_status = EXCLUDED.deposit_status,
        initial_account_status = EXCLUDED.initial_account_status,
        approved_at = EXCLUDED.approved_at,
        updated_at = now()
    `;
  }

  private async persistAgentApplication(tx: PrismaTx, application: AgentApplication) {
    await tx.$executeRaw`
      INSERT INTO agent_applications (
        id, agent_id, user_id, identity_info_json, contact_info_json,
        customer_service_wechat, status, reject_reason, reviewed_by,
        reviewed_at, created_at, updated_at
      )
      VALUES (
        ${application.applicationNo}, ${application.agentId}, ${application.userId},
        ${jsonForDb({ inviteCodeId: application.inviteCodeId, targetTier: application.targetTier, parentAgentId: application.parentAgentId })}::jsonb,
        ${jsonForDb({ phone: application.contactPhone, inviteCode: application.inviteCode })}::jsonb,
        ${application.customerServiceWechat},
        CAST(${mapReviewStatus(application.status)} AS "ReviewStatus"),
        NULL, NULL, NULL, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        contact_info_json = EXCLUDED.contact_info_json,
        customer_service_wechat = EXCLUDED.customer_service_wechat,
        updated_at = now()
    `;
  }

	  private async persistShop(tx: PrismaTx, shop: DemoShop) {
    await tx.$executeRaw`
      INSERT INTO shops (
        id, owner_type, agent_id, merchant_id, shop_no, name, announcement,
        customer_service_wechat, customer_service_qr_url, customer_service_qq,
        customer_service_qq_qr_url, customer_service_note, collection_account_name, collection_qr_url,
        collection_note, theme_color, banner_url, share_title, share_path,
        status, risk_status, creation_source, created_by_admin_id, created_at, updated_at
      )
      VALUES (
        ${shop.id}, CAST(${shop.ownerType ?? "agent"} AS "ShopOwnerType"),
        ${shop.ownerType === "platform" ? null : shop.agentId ?? null}, NULL,
        ${shop.id}, ${shop.name}, ${shop.announcement ?? null},
        ${shop.customerServiceWechat ?? null}, ${shop.customerServiceQrUrl ?? null},
        ${shop.customerServiceQq ?? null}, ${shop.customerServiceQqQrUrl ?? null},
        ${shop.customerServiceNote ?? null}, ${shop.collectionAccountName ?? null},
        ${shop.collectionQrUrl ?? null}, ${shop.collectionNote ?? null},
        ${shop.themeColor ?? null}, ${shop.bannerUrl ?? null}, ${shop.shareTitle ?? null},
        ${`/shops/${shop.id}`}, CAST(${mapShopStatus(shop.status)} AS "ShopStatus"),
        CAST(${mapRiskStatus(shop.riskStatus)} AS "RiskStatus"),
        CAST(${shop.createdByAdminId ? "admin_manual" : shop.agentId ? "self_application" : "migration"} AS "MerchantCreationSource"),
        ${shop.createdByAdminId ?? null}, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        announcement = EXCLUDED.announcement,
        customer_service_wechat = EXCLUDED.customer_service_wechat,
        customer_service_qr_url = EXCLUDED.customer_service_qr_url,
        customer_service_qq = EXCLUDED.customer_service_qq,
        customer_service_qq_qr_url = EXCLUDED.customer_service_qq_qr_url,
        customer_service_note = EXCLUDED.customer_service_note,
        collection_account_name = EXCLUDED.collection_account_name,
        collection_qr_url = EXCLUDED.collection_qr_url,
        collection_note = EXCLUDED.collection_note,
        theme_color = EXCLUDED.theme_color,
        banner_url = EXCLUDED.banner_url,
        share_title = EXCLUDED.share_title,
        status = EXCLUDED.status,
        risk_status = EXCLUDED.risk_status,
        updated_at = now()
    `;
  }

  private async persistDepositAccount(tx: PrismaTx, agentId: string, account: {
    requiredAmountCents: bigint;
    availableAmountCents: bigint;
    frozenAmountCents: bigint;
    deductedAmountCents: bigint;
    status: string;
  }) {
    await tx.$executeRaw`
      INSERT INTO deposit_accounts (
        id, agent_id, merchant_id, required_amount_cents, available_amount_cents,
        frozen_amount_cents, deducted_amount_cents, status, created_at, updated_at
      )
      VALUES (
        ${stableDbId("deposit_account", agentId)}, ${agentId}, NULL,
        ${account.requiredAmountCents}, ${account.availableAmountCents},
        ${account.frozenAmountCents}, ${account.deductedAmountCents},
        CAST(${mapDepositStatus(account.status)} AS "DepositStatus"), now(), now()
      )
      ON CONFLICT (agent_id) DO UPDATE SET
        required_amount_cents = EXCLUDED.required_amount_cents,
        available_amount_cents = EXCLUDED.available_amount_cents,
        frozen_amount_cents = EXCLUDED.frozen_amount_cents,
        deducted_amount_cents = EXCLUDED.deducted_amount_cents,
        status = EXCLUDED.status,
        updated_at = now()
    `;
  }

  private async persistDepositTransaction(tx: PrismaTx, txItem: DepositTransaction) {
    await tx.$executeRaw`
      INSERT INTO deposit_transactions (
        id, agent_id, merchant_id, account_id, type, amount_cents,
        balance_before_cents, balance_after_cents, reason_code, related_type,
        related_id, voucher_url, note, idempotency_key, operator_id, created_at
      )
      VALUES (
        ${stableDbId("deposit_tx", txItem.idempotencyKey)}, ${txItem.agentId}, NULL,
        (SELECT id FROM deposit_accounts WHERE agent_id = ${txItem.agentId} LIMIT 1),
        CAST(${mapDepositTransactionType(txItem.type)} AS "DepositTransactionType"),
        ${txItem.amountCents}, ${txItem.balanceBeforeCents}, ${txItem.balanceAfterCents},
        ${txItem.reasonCode}, ${txItem.relatedType}, ${txItem.relatedId},
        ${txItem.proofUrl ?? null}, ${txItem.remark ?? null}, ${txItem.idempotencyKey},
        ${txItem.operatorId ?? null}, now()
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
  }

  private async persistLatestDepositConfirmation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["deposit.confirm"]);
    const agentId = audit ? stringValue(audit.targetId) : undefined;
    const agent = agentId ? store.agents.get(agentId) : undefined;
    if (!agent) throw new Error("deposit confirmation missing current agent");
    const shop = [...store.shops.values()].find((item) => item.agentId === agent.id);
    const account = store.depositAccounts.get(agent.id);
    if (!account) throw new Error("deposit confirmation missing deposit account");
    const transaction = [...store.depositTransactions]
      .reverse()
      .find((item) => item.agentId === agent.id && item.reasonCode === "manual_confirm");
    const ledger = [...store.ledgerEntries]
      .reverse()
      .find((item) => item.agentId === agent.id && item.entryType === "DEPOSIT_CONFIRMED");
    const relations = store.channelRelations.filter((item) =>
      item.secondTierAgentId === agent.id || item.thirdTierAgentId === agent.id
    );

    await this.persistAgent(tx, agent);
    if (shop) await this.persistShop(tx, shop);
    await this.persistDepositAccount(tx, agent.id, account);
    if (transaction) await this.persistDepositTransaction(tx, transaction);
    for (const relation of relations) await this.persistChannelRelation(tx, relation);
    await this.persistLedgerEntries(tx, ledger ? [ledger] : []);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestPlatformProductCreation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["product.create"]);
    const productId = audit ? stringValue(audit.targetId) : undefined;
    const product = productId ? store.platformProducts.get(productId) : undefined;
    if (!product) throw new Error("platform product creation missing current product");
    await this.persistPlatformProduct(tx, product);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestRightsCodeImport(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["rights_code.import"]);
    const productId = audit ? stringValue(audit.targetId) : undefined;
    const product = productId ? store.platformProducts.get(productId) : undefined;
    if (!product) throw new Error("rights code import missing current product");
    const auditAfter = isRecord(audit?.after) ? audit.after : {};
    const importedCodeIds = Array.isArray(auditAfter.codeIds)
      ? auditAfter.codeIds.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const batchNo = stringValue(auditAfter.batchNo);
    const importedAt = dateValue(audit?.createdAt) ?? new Date(0);
    const codes = store.rightsCodes.filter((code) =>
      code.productId === product.id
      && code.status === "available"
      && !code.orderNo
      && (
        importedCodeIds.length > 0
          ? importedCodeIds.includes(code.codeId)
          : batchNo
            ? code.batchNo === batchNo
            : code.createdAt >= importedAt
      )
    );
    await this.persistPlatformProduct(tx, product);
    for (const code of codes) await this.persistAvailableRightsCode(tx, code, store);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestAgentRightsCodeImport(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["rights_code.agent_import"]);
    const agentProductId = audit ? stringValue(audit.targetId) : undefined;
    const agentProduct = agentProductId ? store.agentProducts.get(agentProductId) : undefined;
    if (!agentProduct) throw new Error("agent rights code import missing current product");
    const auditAfter = isRecord(audit?.after) ? audit.after : {};
    const importedCodeIds = Array.isArray(auditAfter.codeIds)
      ? auditAfter.codeIds.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const batchNo = stringValue(auditAfter.batchNo);
    const importedAt = dateValue(audit?.createdAt) ?? new Date(0);
    const codes = store.rightsCodes.filter((code) =>
      (code.agentProductId ?? code.productId) === agentProduct.id
      && code.status === "available"
      && !code.orderNo
      && (
        importedCodeIds.length > 0
          ? importedCodeIds.includes(code.codeId)
          : batchNo
            ? code.batchNo === batchNo
            : code.createdAt >= importedAt
      )
    );
    await this.persistAgentProductWithDependencies(tx, store, agentProduct);
    for (const code of codes) await this.persistAvailableRightsCode(tx, code, store);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestCollectionChannelSubmission(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["collection_channel.submit"]);
    const channelId = audit ? stringValue(audit.targetId) : undefined;
    const channel = channelId ? store.collectionChannels.get(channelId) : undefined;
    if (!channel) throw new Error("collection channel submission missing current channel");
    await this.persistCollectionChannel(tx, channel);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestCollectionChannelReview(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["collection_channel.review"]);
    const channelId = audit ? stringValue(audit.targetId) : undefined;
    const channel = channelId ? store.collectionChannels.get(channelId) : undefined;
    if (!channel) throw new Error("collection channel review missing current channel");
    if (channel.status === "active" && channel.isDefault) {
      await tx.$executeRaw`
        UPDATE shop_collection_channels
           SET is_default = false,
               updated_at = now()
         WHERE shop_id = ${channel.shopId}
           AND id <> ${channel.id}
           AND status = CAST('active' AS "CollectionChannelStatus")
           AND is_default = true
      `;
    }
    await this.persistCollectionChannel(tx, channel);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestPlatformProductSelection(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["agent_product.select_platform"]);
    const agentProductId = audit ? stringValue(audit.targetId) : undefined;
    const agentProduct = agentProductId ? store.agentProducts.get(agentProductId) : undefined;
    if (!agentProduct || agentProduct.productType !== "platform" || !agentProduct.platformProductId) {
      throw new Error("platform product selection missing current agent product");
    }
    await this.persistAgentProductWithDependencies(tx, store, agentProduct);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestPlatformProductUpdate(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["platform_product.update"]);
    const productId = audit ? stringValue(audit.targetId) : undefined;
    const product = productId ? store.platformProducts.get(productId) : undefined;
    if (!product) throw new Error("platform product update missing current product");
    await this.persistPlatformProduct(tx, product);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestOwnProductSubmission(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["own_product.submit"]);
    const ownProductId = audit ? stringValue(audit.targetId) : undefined;
    const ownProduct = ownProductId ? store.ownProducts.get(ownProductId) : undefined;
    if (!ownProduct) throw new Error("own product submission missing current product");
    const agent = store.agents.get(ownProduct.agentId);
    const shop = store.shops.get(ownProduct.shopId);
    if (!agent) throw new Error("own product submission missing current agent");
    if (!shop) throw new Error("own product submission missing current shop");
    await this.persistAgent(tx, agent);
    await this.persistMerchantAccountForAgent(tx, agent);
    await this.persistShop(tx, shop);
    await this.persistOwnProductReview(tx, ownProduct);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestOwnProductReview(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["own_product.review"]);
    const ownProductId = audit ? stringValue(audit.targetId) : undefined;
    const ownProduct = ownProductId ? store.ownProducts.get(ownProductId) : undefined;
    if (!ownProduct) throw new Error("own product review missing current product");
    await this.persistOwnProductReview(tx, ownProduct);
    const agentProduct = [...store.agentProducts.values()]
      .find((product) => product.ownProductReviewId === ownProduct.id);
    if (agentProduct) await this.persistAgentProductWithDependencies(tx, store, agentProduct);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestOwnProductUpdate(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["own_product.update"]);
    const ownProductId = audit ? stringValue(audit.targetId) : undefined;
    const ownProduct = ownProductId ? store.ownProducts.get(ownProductId) : undefined;
    if (!ownProduct) throw new Error("own product update missing current product");
    await this.persistOwnProductReview(tx, ownProduct);
    const agentProduct = [...store.agentProducts.values()].find((product) => product.ownProductReviewId === ownProduct.id);
    if (agentProduct) await this.persistAgentProductWithDependencies(tx, store, agentProduct);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestPlatformProductBatchSelection(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["agent_product.batch_select_platform"]);
    const shopId = audit ? stringValue(audit.targetId) : undefined;
    if (!shopId) throw new Error("platform product batch selection missing current shop");
    const products = [...store.agentProducts.values()]
      .filter((product) => product.shopId === shopId && product.productType === "platform");
    for (const product of products) await this.persistAgentProductWithDependencies(tx, store, product);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestAgentProductPriceUpdate(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["agent_product.price_update"]);
    const agentProductId = audit ? stringValue(audit.targetId) : undefined;
    const agentProduct = agentProductId ? store.agentProducts.get(agentProductId) : undefined;
    if (!agentProduct) throw new Error("agent product price update missing current product");
    await this.persistAgentProductWithDependencies(tx, store, agentProduct);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestAgentProductDetailUpdate(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["agent_product.detail_update", "agent_product.price_update"]);
    const agentProductId = audit ? stringValue(audit.targetId) : undefined;
    const agentProduct = agentProductId ? store.agentProducts.get(agentProductId) : undefined;
    if (!agentProduct) throw new Error("agent product detail update missing current product");
    await this.persistAgentProductWithDependencies(tx, store, agentProduct);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestPlatformShopProductUpsert(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["platform_shop_product.upsert"]);
    const shopProductId = audit ? stringValue(audit.targetId) : undefined;
    const shopProduct = shopProductId ? store.platformShopProducts.get(shopProductId) : undefined;
    if (!shopProduct) throw new Error("platform shop product upsert missing current shop product");
    const shop = store.shops.get(shopProduct.shopId);
    const product = store.platformProducts.get(shopProduct.platformProductId);
    if (!shop) throw new Error("platform shop product upsert missing current shop");
    if (!product) throw new Error("platform shop product upsert missing current platform product");
    await this.persistShop(tx, shop);
    await this.persistPlatformProduct(tx, product);
    await this.persistPlatformShopProduct(tx, shopProduct);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestPlatformShopProductUpdate(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["platform_shop_product.update"]);
    const shopProductId = audit ? stringValue(audit.targetId) : undefined;
    const shopProduct = shopProductId ? store.platformShopProducts.get(shopProductId) : undefined;
    if (!shopProduct) throw new Error("platform shop product update missing current shop product");
    await this.persistPlatformShopProduct(tx, shopProduct);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestChannelProductOfferUpsert(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["channel.offer.upsert"]);
    const offerId = audit ? stringValue(audit.targetId) : undefined;
    const offer = offerId ? store.channelProductOffers.find((item) => item.id === offerId) : undefined;
    if (!offer) throw new Error("channel product offer upsert missing current offer");
    const product = store.platformProducts.get(offer.platformProductId);
    if (!product) throw new Error("channel product offer upsert missing current platform product");
    await this.persistPlatformProduct(tx, product);
    await this.persistChannelProductOffer(tx, offer);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestRegistrationCouponGrant(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["coupon.grant.first_register"]);
    if (!audit) return;
    const userId = stringValue(audit.targetId);
    if (!userId) throw new Error("registration coupon grant missing current user");
    const coupon = [...store.userCoupons.values()]
      .reverse()
      .find((item) => item.userId === userId && item.grantReason === "first_register");
    if (!coupon) throw new Error("registration coupon grant missing current user coupon");
    await this.persistUserId(tx, userId);
    await this.persistUserCoupon(tx, coupon, store.couponTemplates.get(coupon.templateId));
    await this.persistAuditLogs(tx, [audit]);
  }

  private async persistLatestOrderCreation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["order.create"]);
    const orderNo = audit ? stringValue(audit.targetId) : undefined;
    const order = orderNo ? store.orders.get(orderNo) : undefined;
    if (!order) throw new Error("order creation missing current order");

    await this.persistUserId(tx, order.userId);
    const shop = store.shops.get(order.shopId);
    if (!shop) throw new Error("order creation missing current shop");
    if (order.salesChannelType !== "platform_self_operated" && order.agentId !== PLATFORM_AGENT_ID) {
      const agent = store.agents.get(order.agentId);
      if (!agent) throw new Error("order creation missing current agent");
      await this.persistAgent(tx, agent);
    }
    await this.persistShop(tx, shop);

    if (order.salesChannelType === "platform_self_operated") {
      const platformShopProduct = store.platformShopProducts.get(order.agentProductId);
      if (platformShopProduct) {
        const product = store.platformProducts.get(platformShopProduct.platformProductId);
        if (!product) throw new Error("order creation missing current platform product");
        await this.persistPlatformProduct(tx, product);
        await this.persistPlatformShopProduct(tx, platformShopProduct);
      }
    } else {
      const agentProduct = store.agentProducts.get(order.agentProductId);
      if (!agentProduct) throw new Error("order creation missing current agent product");
      const product = agentProduct.platformProductId ? store.platformProducts.get(agentProduct.platformProductId) : undefined;
      if (product) await this.persistPlatformProduct(tx, product);
      await this.persistAgentProduct(tx, agentProduct);
    }

    const collectionChannel = order.collectionChannelId ? store.collectionChannels.get(order.collectionChannelId) : undefined;
    if (collectionChannel) await this.persistCollectionChannel(tx, collectionChannel);
    if (order.couponId) {
      const coupon = store.userCoupons.get(order.couponId);
      if (!coupon) throw new Error("order creation missing current user coupon");
      await this.persistUserCoupon(tx, coupon, store.couponTemplates.get(coupon.templateId));
    }
    await this.persistOrder(tx, order);
    if (order.extractionCodeHash) await this.persistOrderExtractSecret(tx, order);
    if (order.couponId) await this.persistCouponUsageForOrder(tx, order);
    const ledger = [...store.ledgerEntries]
      .reverse()
      .find((item) => item.orderNo === order.orderNo && item.entryType === "ORDER_CREATED");
    await this.persistLedgerEntries(tx, ledger ? [ledger] : []);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestOfflinePaymentConfirmation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["order.offline_payment.confirm"]);
    const orderNo = audit ? stringValue(audit.targetId) : undefined;
    const order = orderNo ? store.orders.get(orderNo) : undefined;
    if (!order) throw new Error("offline payment confirmation missing current order");
    await this.persistOrder(tx, order);
    const method = this.paymentMethodForOrder(store, order);
    if (method) await this.persistPaymentMethodConfig(tx, method);
    await this.persistPaymentSnapshotForOrder(tx, store, order);
    await this.persistPaymentConfirmation(tx, order, audit);
    if (order.extractionCodeHash) await this.persistOrderExtractSecret(tx, order);
    await this.persistIssuedRightsCodesForOrder(tx, store, order);
    await this.persistFulfillmentRecordForOrder(tx, store, order);
    await this.persistEmailDeliveriesForOrder(tx, store, order);
    const ledger = [...store.ledgerEntries]
      .reverse()
      .find((item) => item.orderNo === order.orderNo && item.entryType === "OFFLINE_PAYMENT_CONFIRMED");
    const autoFulfillmentAudit = [...store.auditLogs]
      .reverse()
      .find((item) => stringValue(item.action) === "fulfillment.auto_code_pool" && stringValue(item.targetId) === order.orderNo);
    await this.persistLedgerEntries(tx, ledger ? [ledger] : []);
    await this.persistAuditLogs(tx, [autoFulfillmentAudit, audit].filter((item): item is Record<string, unknown> => Boolean(item)));
  }

  private async persistLatestPaymentVoucher(tx: PrismaTx, store: MemoryStore) {
    const voucher = this.latestPaymentVoucher(store);
    if (!voucher) throw new Error("payment voucher persistence missing current voucher");
    await this.persistPaymentDisputeMaterial(tx, voucher);
    const audits = store.auditLogs.filter((item) => {
      const action = stringValue(item.action);
      if (action !== "payment_voucher.submit" && action !== "payment_voucher.review" && action !== "payment_voucher.dispute_material.accept") return false;
      const targetId = stringValue(item.targetId);
      if (targetId === voucher.id || targetId === voucher.orderNo) return true;
      const after = isRecord(item.afterJson) ? item.afterJson : undefined;
      return stringValue(after?.id) === voucher.id;
    });
    await this.persistAuditLogs(tx, audits);
  }

  private async persistLatestPaymentMethodMutation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, [
      "payment_method.upsert",
      "payment_method.default",
      "payment_method.disable",
      "payment_method.test"
    ]);
    const methodId = audit ? stringValue(audit.targetId) : undefined;
    const method = methodId ? store.paymentMethods.get(methodId) : undefined;
    if (!method) throw new Error("payment method persistence missing current method");
    await this.persistPaymentMethodConfig(tx, method);
    await this.persistPaymentMethodOwnerDefaults(tx, store, method);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestPaymentOrderCreation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["payment.manual.create", "payment.order.create"]);
    const orderNo = audit ? stringValue(audit.targetId) : undefined;
    const order = orderNo ? store.orders.get(orderNo) : undefined;
    if (!order) throw new Error("payment order persistence missing current order");
    await this.persistOrder(tx, order);
    const method = this.paymentMethodForOrder(store, order);
    if (method) await this.persistPaymentMethodConfig(tx, method);
    await this.persistPaymentSnapshotForOrder(tx, store, order);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestPaymentResult(tx: PrismaTx, store: MemoryStore, methodName: string) {
    const latestLog = [...store.paymentCallbackLogs].reverse()[0];
    const latestException = [...store.paymentExceptions].reverse()[0];
    const audit = this.latestAuditLog(store, ["payment.callback.success", "payment.query.success", "payment.exception"]);
    const orderNo = stringValue(audit?.targetId) ?? latestLog?.orderNo ?? latestException?.orderNo;
    const order = orderNo ? store.orders.get(orderNo) : undefined;
    if (order) {
      await this.persistOrder(tx, order);
      const method = this.paymentMethodForOrder(store, order);
      if (method) await this.persistPaymentMethodConfig(tx, method);
      await this.persistPaymentSnapshotForOrder(tx, store, order);
      if (order.extractionCodeHash) await this.persistOrderExtractSecret(tx, order);
      await this.persistIssuedRightsCodesForOrder(tx, store, order);
      await this.persistFulfillmentRecordForOrder(tx, store, order);
      await this.persistEmailDeliveriesForOrder(tx, store, order);
    }
    const logs = store.paymentCallbackLogs.filter((item) =>
      item === latestLog || (orderNo && item.orderNo === orderNo)
    );
    const exceptions = store.paymentExceptions.filter((item) =>
      item === latestException || (orderNo && item.orderNo === orderNo)
    );
    for (const log of logs) await this.persistPaymentCallbackLog(tx, store, log);
    for (const exception of exceptions) await this.persistPaymentException(tx, store, exception);
    const recentLedgers = store.ledgerEntries.filter((item) =>
      orderNo && item.orderNo === orderNo && (item.entryType === "PAYMENT_SUCCEEDED" || item.entryType === "MANUAL_PAYMENT_CONFIRMED")
    );
    await this.persistLedgerEntries(tx, recentLedgers);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
    if (!order && !logs.length && !exceptions.length && methodName !== "paymentCallback") {
      throw new Error("payment result persistence missing current payment mutation");
    }
  }

  private async persistLatestPaymentExceptionHandling(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["payment.exception.handle"]);
    const exceptionId = audit ? stringValue(audit.targetId) : undefined;
    const exception = exceptionId
      ? store.paymentExceptions.find((item) => item.id === exceptionId)
      : [...store.paymentExceptions].reverse()[0];
    if (!exception) throw new Error("payment exception handling missing current exception");
    await this.persistPaymentException(tx, store, exception);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private latestPaymentVoucher(store: MemoryStore) {
    return [...store.paymentVouchers.values()]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  }

  private paymentMethodForOrder(store: MemoryStore, order: DemoOrder) {
    return order.paymentSnapshot?.paymentMethodId ? store.paymentMethods.get(order.paymentSnapshot.paymentMethodId) : undefined;
  }

  private async persistLatestFulfillmentUpdate(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["fulfillment.update"]);
    const orderNo = audit ? stringValue(audit.targetId) : undefined;
    const order = orderNo ? store.orders.get(orderNo) : undefined;
    if (!order) throw new Error("fulfillment update missing current order");
    await this.persistOrder(tx, order);
    await this.persistFulfillmentRecordForOrder(tx, store, order);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestAfterSaleCreation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["after_sale.create"]);
    const afterSaleNo = audit ? stringValue(audit.targetId) : undefined;
    const afterSale = afterSaleNo ? store.afterSales.get(afterSaleNo) : undefined;
    if (!afterSale) throw new Error("after sale creation missing current after sale");
    const order = store.orders.get(afterSale.orderNo);
    if (!order) throw new Error("after sale creation missing current order");
    await this.persistOrder(tx, order);
    await this.persistAfterSale(tx, afterSale);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestRefundApproval(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["refund.approve"]);
    const afterSaleNo = audit ? stringValue(audit.targetId) : undefined;
    const afterSale = afterSaleNo ? store.afterSales.get(afterSaleNo) : undefined;
    if (!afterSale) throw new Error("refund approval missing current after sale");
    const order = store.orders.get(afterSale.orderNo);
    if (!order) throw new Error("refund approval missing current order");
    const refund = [...store.refunds.values()]
      .reverse()
      .find((item) => item.afterSaleNo === afterSale.afterSaleNo);
    if (!refund) throw new Error("refund approval missing current refund");
    await this.persistOrder(tx, order);
    await this.persistAfterSale(tx, afterSale);
    await this.persistRefund(tx, refund);
    if (order.extractionCodeHash) await this.persistOrderExtractSecret(tx, order);
    if (order.couponId) {
      const coupon = store.userCoupons.get(order.couponId);
      if (coupon) {
        await this.persistUserCoupon(tx, coupon, store.couponTemplates.get(coupon.templateId));
        await this.persistCouponVoidForRefund(tx, coupon, refund);
      }
    }
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestManualRefundConfirmation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["refund.manual_confirm", "refund.callback"]);
    const refundNo = audit ? stringValue(audit.targetId) : undefined;
    const refund = refundNo ? store.refunds.get(refundNo) : undefined;
    if (!refund) throw new Error("manual refund confirmation missing current refund");
    const afterSale = store.afterSales.get(refund.afterSaleNo);
    if (!afterSale) throw new Error("manual refund confirmation missing current after sale");
    const order = store.orders.get(refund.orderNo);
    if (!order) throw new Error("manual refund confirmation missing current order");
    await this.persistOrder(tx, order);
    await this.persistAfterSale(tx, afterSale);
    await this.persistRefund(tx, refund);
    if (order.extractionCodeHash) await this.persistOrderExtractSecret(tx, order);
    if (order.couponId) {
      const coupon = store.userCoupons.get(order.couponId);
      if (coupon) {
        await this.persistUserCoupon(tx, coupon, store.couponTemplates.get(coupon.templateId));
        await this.persistCouponVoidForRefund(tx, coupon, refund);
      }
    }
    const ledgers = store.ledgerEntries.filter((item) => item.orderNo === order.orderNo && ["REFUND_SUCCEEDED", "CLAWBACK_CREATE"].includes(item.entryType));
    await this.persistLedgerEntries(tx, ledgers);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestSettlementGeneration(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["settlement.generate"]);
    const settlementNo = audit ? stringValue(audit.targetId) : undefined;
    const sheet = settlementNo ? store.settlementSheets.find((item) => item.settlementNo === settlementNo) : undefined;
    if (!sheet) throw new Error("settlement generation missing current settlement sheet");
    await this.persistSettlementSheet(tx, sheet);
    for (const item of sheet.items) {
      const order = store.orders.get(item.orderId);
      if (order) await this.persistOrderSettlementState(tx, order);
    }
    const ledger = [...store.ledgerEntries]
      .reverse()
      .find((item) => item.entryType === "SETTLEMENT_GENERATED" && item.agentId === sheet.agentId);
    await this.persistLedgerEntries(tx, ledger ? [ledger] : []);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestManualPayoutConfirmation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["manual_payout.confirm"]);
    const settlementNo = audit ? stringValue(audit.targetId) : undefined;
    const sheet = settlementNo ? store.settlementSheets.find((item) => item.settlementNo === settlementNo) : undefined;
    if (!sheet) throw new Error("manual payout confirmation missing current settlement sheet");
    const payout = [...store.manualPayouts]
      .reverse()
      .find((item) => stringValue((item as Record<string, unknown>).settlementNo) === sheet.settlementNo);
    await this.persistSettlementSheet(tx, sheet);
    if (payout) await this.persistManualPayout(tx, payout);
    for (const item of sheet.items) {
      const order = store.orders.get(item.orderId);
      if (order) await this.persistOrderSettlementState(tx, order);
    }
    const ledger = [...store.ledgerEntries]
      .reverse()
      .find((item) => item.entryType === "PAYOUT_CONFIRMED" && item.agentId === sheet.agentId);
    await this.persistLedgerEntries(tx, ledger ? [ledger] : []);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistAgents(tx: PrismaTx, store: MemoryStore) {
    for (const agent of store.agents.values()) {
      await tx.$executeRaw`
        INSERT INTO agents (
          id, user_id, agent_no, name, contact_phone, status, risk_status,
          deposit_status, approved_at, created_at, updated_at
        )
        VALUES (
          ${agent.id}, ${agent.userId}, ${agent.id}, ${agent.name}, ${agent.contactPhone ?? null},
          CAST(${mapAgentStatus(agent.status)} AS "AgentStatus"),
          CAST(${mapRiskStatus(agent.riskStatus)} AS "RiskStatus"),
          CAST(${mapDepositStatus(agent.depositStatus)} AS "DepositStatus"),
          ${agent.status === "active" ? new Date() : null}, now(), now()
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          contact_phone = EXCLUDED.contact_phone,
          status = EXCLUDED.status,
          risk_status = EXCLUDED.risk_status,
          deposit_status = EXCLUDED.deposit_status,
          updated_at = now()
      `;
      await this.persistMerchantAccountForAgent(tx, agent);
    }

	    for (const application of store.agentApplications.values()) {
      await this.persistAgentApplication(tx, application);
	    }
	  }

  private async persistShops(tx: PrismaTx, store: MemoryStore) {
    for (const shop of store.shops.values()) {
      await tx.$executeRaw`
        INSERT INTO shops (
          id, owner_type, agent_id, merchant_id, shop_no, name, announcement,
          customer_service_wechat, customer_service_qr_url, customer_service_qq,
          customer_service_qq_qr_url, customer_service_note, collection_account_name, collection_qr_url,
          collection_note, theme_color, banner_url, share_title, share_path,
          status, risk_status, creation_source, created_by_admin_id, created_at, updated_at
        )
        VALUES (
          ${shop.id}, CAST(${shop.ownerType ?? "agent"} AS "ShopOwnerType"),
          ${shop.ownerType === "platform" ? null : shop.agentId ?? null}, NULL,
          ${shop.id}, ${shop.name}, ${shop.announcement ?? null},
          ${shop.customerServiceWechat ?? null}, ${shop.customerServiceQrUrl ?? null},
          ${shop.customerServiceQq ?? null}, ${shop.customerServiceQqQrUrl ?? null},
          ${shop.customerServiceNote ?? null}, ${shop.collectionAccountName ?? null},
          ${shop.collectionQrUrl ?? null}, ${shop.collectionNote ?? null},
          ${shop.themeColor ?? null}, ${shop.bannerUrl ?? null}, ${shop.shareTitle ?? null},
          ${`/shops/${shop.id}`}, CAST(${mapShopStatus(shop.status)} AS "ShopStatus"),
          CAST(${mapRiskStatus(shop.riskStatus)} AS "RiskStatus"),
          CAST(${shop.agentId ? "self_application" : "migration"} AS "MerchantCreationSource"),
          NULL, now(), now()
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          announcement = EXCLUDED.announcement,
          customer_service_wechat = EXCLUDED.customer_service_wechat,
          customer_service_qr_url = EXCLUDED.customer_service_qr_url,
          customer_service_qq = EXCLUDED.customer_service_qq,
          customer_service_qq_qr_url = EXCLUDED.customer_service_qq_qr_url,
          customer_service_note = EXCLUDED.customer_service_note,
          collection_account_name = EXCLUDED.collection_account_name,
          collection_qr_url = EXCLUDED.collection_qr_url,
          collection_note = EXCLUDED.collection_note,
          theme_color = EXCLUDED.theme_color,
          banner_url = EXCLUDED.banner_url,
          share_title = EXCLUDED.share_title,
          status = EXCLUDED.status,
          risk_status = EXCLUDED.risk_status,
          updated_at = now()
      `;
      await tx.$executeRaw`DELETE FROM shop_product_groups WHERE shop_id = ${shop.id}`;
      for (const [index, group] of (shop.productGroups ?? []).entries()) {
        await tx.$executeRaw`
          INSERT INTO shop_product_groups (id, shop_id, name, sort_order, agent_product_ids, created_at, updated_at)
          VALUES (${stableDbId("shop_group", `${shop.id}:${group.name}:${index}`)}, ${shop.id}, ${group.name}, ${index + 1},
                  ${jsonForDb(group.agentProductIds)}::jsonb, now(), now())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            sort_order = EXCLUDED.sort_order,
            agent_product_ids = EXCLUDED.agent_product_ids,
            updated_at = now()
        `;
      }
    }
  }

  private async persistProducts(tx: PrismaTx, store: MemoryStore) {
    for (const product of store.platformProducts.values()) {
      await this.persistPlatformProduct(tx, product);
    }

    for (const product of store.platformShopProducts.values()) {
      await this.persistPlatformShopProduct(tx, product);
    }

    for (const ownProduct of store.ownProducts.values()) {
      await this.persistOwnProductReview(tx, ownProduct);
    }

    for (const product of store.agentProducts.values()) {
      await this.persistAgentProduct(tx, product);
    }
  }

  private async persistAgentProductWithDependencies(tx: PrismaTx, store: MemoryStore, product: DemoAgentProduct) {
    const agent = store.agents.get(product.agentId);
    const shop = store.shops.get(product.shopId);
    if (!agent) throw new Error("agent product persistence missing current agent");
    if (!shop) throw new Error("agent product persistence missing current shop");
    await this.persistAgent(tx, agent);
    await this.persistMerchantAccountForAgent(tx, agent);
    await this.persistShop(tx, shop);

    if (product.productType === "platform" && product.platformProductId) {
      const platformProduct = store.platformProducts.get(product.platformProductId);
      if (!platformProduct) throw new Error("agent product persistence missing current platform product");
      await this.persistPlatformProduct(tx, platformProduct);
    }

    if (product.productType === "agent_owned" && product.ownProductReviewId) {
      const ownProduct = store.ownProducts.get(product.ownProductReviewId);
      if (!ownProduct) throw new Error("agent product persistence missing current own product review");
      await this.persistOwnProductReview(tx, ownProduct);
    }

    await this.persistAgentProduct(tx, product);
  }

  private async persistOwnProductReview(tx: PrismaTx, ownProduct: DemoOwnProduct) {
    await tx.$executeRaw`
      INSERT INTO agent_product_reviews (
        id, agent_id, shop_id, name, detail_json, sale_price_cents,
        after_sale_rule_json, fulfillment_rule_json, fulfillment_type, status, reject_reason,
        risk_reason, reviewed_by, reviewed_at, created_at, updated_at
      )
      VALUES (
        ${ownProduct.id}, ${ownProduct.agentId}, ${ownProduct.shopId}, ${ownProduct.name},
        ${jsonForDb(ownProduct)}::jsonb, ${ownProduct.salePriceCents},
        ${jsonForDb(ownProduct.afterSaleRule)}::jsonb, ${jsonForDb(ownProduct.fulfillmentRule)}::jsonb,
        CAST(${fulfillmentModeFromRule(ownProduct.fulfillmentRule)} AS "FulfillmentType"),
        CAST(${mapReviewStatus(ownProduct.reviewStatus)} AS "ReviewStatus"), NULL, NULL, NULL,
        ${ownProduct.reviewStatus === "approved" ? ownProduct.updatedAt ?? new Date() : null},
        ${ownProduct.createdAt ?? new Date()}, ${ownProduct.updatedAt ?? new Date()}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        detail_json = EXCLUDED.detail_json,
        sale_price_cents = EXCLUDED.sale_price_cents,
        after_sale_rule_json = EXCLUDED.after_sale_rule_json,
        fulfillment_rule_json = EXCLUDED.fulfillment_rule_json,
        fulfillment_type = EXCLUDED.fulfillment_type,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
    `;
  }

  private async persistAgentProduct(tx: PrismaTx, product: DemoAgentProduct) {
    await tx.$executeRaw`
      INSERT INTO agent_products (
        id, agent_id, shop_id, product_type, platform_product_id, own_product_review_id,
        sale_price_cents, status, listed_at, created_at, updated_at
      )
      VALUES (
        ${product.id}, ${product.agentId}, ${product.shopId},
        CAST(${product.productType} AS "ProductType"), ${product.platformProductId ?? null},
        ${product.ownProductReviewId ?? null}, ${product.salePriceCents},
        CAST(${mapAgentProductStatus(product.status)} AS "AgentProductStatus"),
        ${product.status === "listed" ? new Date() : null}, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        sale_price_cents = EXCLUDED.sale_price_cents,
        status = EXCLUDED.status,
        listed_at = EXCLUDED.listed_at,
        updated_at = now()
    `;
  }

  private async persistPlatformShopProduct(tx: PrismaTx, product: DemoPlatformShopProduct) {
    await tx.$executeRaw`
      INSERT INTO platform_shop_products (
        id, shop_id, platform_product_id, sale_price_cents, fulfillment_cost_cents,
        status, listed_at, created_at, updated_at
      )
      VALUES (
        ${product.id}, ${product.shopId}, ${product.platformProductId}, ${product.salePriceCents},
        ${product.fulfillmentCostCents}, CAST(${mapAgentProductStatus(product.status)} AS "AgentProductStatus"),
        ${product.status === "listed" ? new Date() : null}, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        sale_price_cents = EXCLUDED.sale_price_cents,
        fulfillment_cost_cents = EXCLUDED.fulfillment_cost_cents,
        status = EXCLUDED.status,
        updated_at = now()
    `;
  }

  private async persistChannelProductOffer(tx: PrismaTx, offer: ChannelProductOffer) {
    await tx.$executeRaw`
      INSERT INTO channel_product_offers (
        id, channel_relation_id, platform_product_id, resell_supply_price_cents,
        status, listed_at, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${offer.id}, ${offer.channelRelationId}, ${offer.platformProductId},
        ${offer.resellSupplyPriceCents}, CAST(${mapAgentProductStatus(offer.status)} AS "AgentProductStatus"),
        ${offer.status === "listed" ? new Date() : null}, ${`channel-offer:${offer.id}`}, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        resell_supply_price_cents = EXCLUDED.resell_supply_price_cents,
        status = EXCLUDED.status,
        updated_at = now()
    `;
  }

  private async persistPlatformProduct(tx: PrismaTx, product: DemoPlatformProduct) {
    await tx.$executeRaw`
      INSERT INTO platform_products (
        id, product_no, name, category_name, tags_json, detail, rights_desc,
        image_url, specs_json, detail_sections_json, stock_count, sold_count,
        display_badge, is_recommended, display_sort,
        supply_price_cents, min_sale_price_cents, suggested_sale_price_cents,
        fulfillment_type, fulfillment_rule_json, after_sale_rule_json,
        extract_code_required, status, created_at, updated_at
      )
      VALUES (
        ${product.id}, ${product.id}, ${product.name}, ${product.category ?? null},
        ${jsonForDb(product.tags ?? [])}::jsonb, ${product.description ?? product.subtitle ?? product.name},
        ${product.subtitle ?? product.name}, ${product.imageUrl ?? null},
        ${jsonForDb(product.specs ?? [])}::jsonb, ${jsonForDb(product.detailSections ?? [])}::jsonb,
        ${product.stockCount ?? 0}, ${product.soldCount ?? 0}, ${product.displayBadge ?? null},
        ${product.isRecommended ?? false}, ${product.displaySort ?? 0},
        ${product.supplyPriceCents}, ${product.minSalePriceCents},
        ${product.suggestedSalePriceCents}, CAST(${fulfillmentModeFromRule(product.fulfillmentRule)} AS "FulfillmentType"),
        ${jsonForDb(product.fulfillmentRule)}::jsonb, ${jsonForDb(product.afterSaleRule)}::jsonb,
        ${isRecord(product.fulfillmentRule) && product.fulfillmentRule.extractCodeRequired === true},
        CAST(${mapProductStatus(product.status)} AS "ProductStatus"), now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        category_name = EXCLUDED.category_name,
        tags_json = EXCLUDED.tags_json,
        detail = EXCLUDED.detail,
        rights_desc = EXCLUDED.rights_desc,
        image_url = EXCLUDED.image_url,
        specs_json = EXCLUDED.specs_json,
        detail_sections_json = EXCLUDED.detail_sections_json,
        stock_count = EXCLUDED.stock_count,
        sold_count = EXCLUDED.sold_count,
        display_badge = EXCLUDED.display_badge,
        is_recommended = EXCLUDED.is_recommended,
        display_sort = EXCLUDED.display_sort,
        supply_price_cents = EXCLUDED.supply_price_cents,
        min_sale_price_cents = EXCLUDED.min_sale_price_cents,
        suggested_sale_price_cents = EXCLUDED.suggested_sale_price_cents,
        fulfillment_type = EXCLUDED.fulfillment_type,
        fulfillment_rule_json = EXCLUDED.fulfillment_rule_json,
        after_sale_rule_json = EXCLUDED.after_sale_rule_json,
        extract_code_required = EXCLUDED.extract_code_required,
        status = EXCLUDED.status,
        updated_at = now()
    `;
  }

  private async persistAvailableRightsCode(tx: PrismaTx, code: RightsCode, store: MemoryStore) {
    const shape = this.rightsCodeDbShape(code, store);
    await tx.$executeRaw`
      INSERT INTO rights_codes (
        id, product_id, agent_product_id, code_ciphertext, code_hash, secret_preview,
        owner_type, owner_agent_id, shop_id, batch_no, status, order_id,
        issue_key, issued_at, import_audit_json, created_at, updated_at
      )
      VALUES (
        ${code.codeId}, ${shape.platformProductId}, ${shape.agentProductId}, ${code.code},
        ${shape.codeHash}, ${shape.secretPreview}, CAST(${shape.ownerType} AS "RightsCodeOwnerType"),
        ${shape.ownerAgentId}, ${shape.shopId}, ${code.batchNo},
        CAST('available' AS "RightsCodeStatus"), NULL, NULL, NULL,
        ${jsonForDb({ batchNo: code.batchNo, source: "targeted_import" })}::jsonb,
        ${code.createdAt}, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        status = CASE
          WHEN rights_codes.order_id IS NULL THEN EXCLUDED.status
          ELSE rights_codes.status
        END,
        code_hash = COALESCE(rights_codes.code_hash, EXCLUDED.code_hash),
        secret_preview = COALESCE(rights_codes.secret_preview, EXCLUDED.secret_preview),
        owner_type = EXCLUDED.owner_type,
        owner_agent_id = EXCLUDED.owner_agent_id,
        shop_id = EXCLUDED.shop_id,
        updated_at = now()
    `;
  }

  private rightsCodeDbShape(code: RightsCode, store: MemoryStore) {
    const platformProductId = code.platformProductId ?? (store.platformProducts.has(code.productId) ? code.productId : null);
    const agentProductId = code.agentProductId ?? (store.agentProducts.has(code.productId) ? code.productId : null);
    const agentProduct = agentProductId ? store.agentProducts.get(agentProductId) : undefined;
    return {
      platformProductId,
      agentProductId,
      ownerType: agentProductId ? "agent" : "platform",
      ownerAgentId: agentProduct?.agentId ?? null,
      shopId: agentProduct?.shopId ?? null,
      codeHash: hashSecret(code.code),
      secretPreview: previewSecret(code.code)
    };
  }

  private async persistCollectionChannels(tx: PrismaTx, store: MemoryStore) {
    for (const channel of store.collectionChannels.values()) {
      await this.persistCollectionChannel(tx, channel);
    }
  }

  private async persistCollectionChannel(tx: PrismaTx, channel: CollectionChannel) {
    await tx.$executeRaw`
      INSERT INTO shop_collection_channels (
        id, shop_id, channel_type, account_name, qr_url, note, status,
        review_status, is_default, reviewed_by, reviewed_at, idempotency_key,
        created_at, updated_at
      )
      VALUES (
        ${channel.id}, ${channel.shopId},
        CAST(${mapCollectionChannelType(channel.channelType)} AS "CollectionChannelType"),
        ${channel.accountName ?? channel.displayName}, ${channel.qrUrl ?? channel.paymentUrl ?? null},
        ${channel.rejectReason ?? null},
        CAST(${mapCollectionStatus(channel.status)} AS "CollectionChannelStatus"),
        CAST(${mapReviewStatus(channel.reviewStatus)} AS "ReviewStatus"),
        ${channel.isDefault}, ${channel.reviewedBy}, ${channel.reviewedAt},
        ${`collection:${channel.id}`}, ${channel.createdAt}, ${channel.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        channel_type = EXCLUDED.channel_type,
        account_name = EXCLUDED.account_name,
        qr_url = EXCLUDED.qr_url,
        note = EXCLUDED.note,
        status = EXCLUDED.status,
        review_status = EXCLUDED.review_status,
        is_default = EXCLUDED.is_default,
        reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = EXCLUDED.reviewed_at,
        updated_at = now()
    `;
  }

  private async persistCoupons(tx: PrismaTx, store: MemoryStore) {
    for (const template of store.couponTemplates.values()) {
      await this.persistCouponTemplate(tx, template);
    }

    for (const coupon of store.userCoupons.values()) {
      await this.persistUserCoupon(tx, coupon, store.couponTemplates.get(coupon.templateId));
    }
  }

  private async persistUserCoupon(tx: PrismaTx, coupon: UserCoupon, template?: CouponTemplate) {
    const validTo = new Date(coupon.grantedAt.getTime() + (template?.validDays ?? 30) * 24 * 60 * 60 * 1000);
    await tx.$executeRaw`
      INSERT INTO user_coupons (
        id, user_id, coupon_template_id, status, source_type, source_id,
        valid_from, valid_to, void_reason, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${coupon.id}, ${coupon.userId}, ${coupon.templateId},
        CAST(${mapCouponStatus(coupon.status)} AS "CouponStatus"),
        ${coupon.grantReason}, ${coupon.orderNo}, ${coupon.grantedAt}, ${validTo},
        ${coupon.status.startsWith("voided") ? coupon.status : null},
        ${`user-coupon:${coupon.id}`}, ${coupon.grantedAt}, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        source_id = EXCLUDED.source_id,
        void_reason = EXCLUDED.void_reason,
        updated_at = now()
    `;
    await tx.$executeRaw`
      INSERT INTO coupon_grant_records (
        id, user_coupon_id, coupon_template_id, user_id, source_type, source_id,
        idempotency_key, created_at
      )
      VALUES (
        ${stableDbId("coupon_grant", coupon.id)}, ${coupon.id}, ${coupon.templateId},
        ${coupon.userId}, ${coupon.grantReason}, ${coupon.orderNo},
        ${`coupon-grant:${coupon.id}`}, ${coupon.grantedAt}
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
  }

	  private async persistLatestCouponTemplateMutation(tx: PrismaTx, store: MemoryStore) {
	    const audit = this.latestAuditLog(store, ["coupon_template.create", "coupon_template.status"]);
	    const templateId = audit ? stringValue(audit.targetId) : undefined;
	    const template = templateId ? store.couponTemplates.get(templateId) : undefined;
	    if (!template) throw new Error("coupon template mutation missing current template");
	    await this.persistCouponTemplate(tx, template);
	    await this.persistAuditLogs(tx, audit ? [audit] : []);
	  }

  private async persistInviteCode(tx: PrismaTx, invite: InviteCode) {
    await tx.$executeRaw`
      INSERT INTO merchant_invite_codes (
        id, code_hash, issuer_merchant_id, tier, max_uses, used_count,
        deposit_required_amount_cents, status, expires_at, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${invite.id}, ${invite.codeHash ?? hashSecret(invite.code)}, NULL,
        CAST(${invite.targetTier} AS "MerchantTier"), ${invite.maxUses ?? 1},
        ${invite.usedCount}, ${invite.depositRequiredAmountCents ?? null},
        CAST(${mapInviteStatus(invite.status)} AS "ReviewStatus"),
        ${invite.expiresAt}, ${`invite:${invite.id}`}, ${invite.createdAt}, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        used_count = EXCLUDED.used_count,
        deposit_required_amount_cents = EXCLUDED.deposit_required_amount_cents,
        status = EXCLUDED.status,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    `;
  }

  private async persistChannelRelation(tx: PrismaTx, relation: ChannelRelation) {
    await tx.$executeRaw`
      INSERT INTO channel_relations (
        id, relation_type, first_tier_agent_id, second_tier_agent_id,
        third_tier_agent_id, first_tier_merchant_id, second_tier_merchant_id,
        third_tier_merchant_id, status, reviewed_by, reviewed_at, reason,
        active_unique_key, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${relation.id}, CAST(${relation.thirdTierAgentId ? "three_tier" : "two_tier"} AS "ChannelRelationType"),
        ${relation.firstTierAgentId}, ${relation.secondTierAgentId}, ${relation.thirdTierAgentId ?? null},
        ${relation.firstTierAgentId}, ${relation.secondTierAgentId}, ${relation.thirdTierAgentId ?? null},
        CAST(${mapChannelStatus(relation.status)} AS "ChannelStatus"), NULL,
        ${relation.reviewedAt}, ${relation.reason}, ${relation.activeUniqueKey ?? null},
        ${`channel-relation:${relation.id}`}, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        relation_type = EXCLUDED.relation_type,
        first_tier_agent_id = EXCLUDED.first_tier_agent_id,
        second_tier_agent_id = EXCLUDED.second_tier_agent_id,
        third_tier_agent_id = EXCLUDED.third_tier_agent_id,
        first_tier_merchant_id = EXCLUDED.first_tier_merchant_id,
        second_tier_merchant_id = EXCLUDED.second_tier_merchant_id,
        third_tier_merchant_id = EXCLUDED.third_tier_merchant_id,
        status = EXCLUDED.status,
        reviewed_at = EXCLUDED.reviewed_at,
        reason = EXCLUDED.reason,
        active_unique_key = EXCLUDED.active_unique_key,
        updated_at = now()
    `;
  }

		  private latestAuditLog(store: MemoryStore, actions: string[]) {
    for (let index = store.auditLogs.length - 1; index >= 0; index -= 1) {
      const audit = store.auditLogs[index];
      if (actions.includes(stringValue(audit.action) ?? "")) return audit;
    }
    return undefined;
  }

  private async persistCouponTemplate(tx: PrismaTx, template: CouponTemplate) {
    const validFrom = template.createdAt;
    const validTo = new Date(validFrom.getTime() + template.validDays * 24 * 60 * 60 * 1000);
    await tx.$executeRaw`
      INSERT INTO coupon_templates (
        id, coupon_no, name, discount_type, discount_amount_cents,
        platform_subsidy_cents, threshold_amount_cents, stackable,
        first_registration_only, status, valid_from, valid_to,
        idempotency_key, created_at, updated_at
      )
      VALUES (
        ${template.id}, ${template.id}, ${template.name}, CAST('fixed_amount' AS "CouponDiscountType"),
        ${template.discountCents}, 0, 0, false, ${template.grantOnFirstRegister},
        CAST(${mapCouponTemplateStatus(template.status)} AS "CouponTemplateStatus"),
        ${validFrom}, ${validTo}, ${`coupon-template:${template.id}`}, ${template.createdAt}, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        discount_amount_cents = EXCLUDED.discount_amount_cents,
        first_registration_only = EXCLUDED.first_registration_only,
        status = EXCLUDED.status,
        valid_to = EXCLUDED.valid_to,
        updated_at = now()
    `;
    if (!template.productIds.length) {
      await tx.$executeRaw`
        INSERT INTO coupon_scopes (id, coupon_template_id, scope_type, created_at)
        VALUES (${stableDbId("coupon_scope", `${template.id}:all`)}, ${template.id},
                CAST('all_products' AS "CouponScopeType"), now())
        ON CONFLICT (id) DO NOTHING
      `;
    }
    for (const productId of template.productIds) {
      await tx.$executeRaw`
        INSERT INTO coupon_scopes (id, coupon_template_id, scope_type, platform_product_id, created_at)
        VALUES (${stableDbId("coupon_scope", `${template.id}:${productId}`)}, ${template.id},
                CAST('platform_product' AS "CouponScopeType"), ${productId}, now())
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }

	  private async persistInviteAndChannelState(tx: PrismaTx, store: MemoryStore) {
	    for (const invite of store.inviteCodes.values()) {
      await this.persistInviteCode(tx, invite);
    }

    for (const authorization of store.channelAuthorizations) {
      await this.persistChannelAuthorization(tx, authorization);
    }

	    for (const relation of store.channelRelations) {
      await this.persistChannelRelation(tx, relation);
	    }

	    for (const offer of store.channelProductOffers) {
      await this.persistChannelProductOffer(tx, offer);
	    }
	  }

  private async persistChannelAuthorization(tx: PrismaTx, authorization: ChannelAuthorization) {
    await tx.$executeRaw`
      INSERT INTO channel_authorizations (
        id, first_tier_agent_id, status, reviewed_by, reviewed_at,
        reason, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${authorization.id}, ${authorization.firstTierAgentId},
        CAST(${mapChannelStatus(authorization.status)} AS "ChannelStatus"),
        NULL, ${authorization.reviewedAt}, ${authorization.reason},
        ${`channel-auth:${authorization.id}`}, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        reviewed_at = EXCLUDED.reviewed_at,
        reason = EXCLUDED.reason,
        updated_at = now()
    `;
  }

  private async persistDeposits(tx: PrismaTx, store: MemoryStore) {
    for (const [agentId, account] of store.depositAccounts.entries()) {
      await tx.$executeRaw`
        INSERT INTO deposit_accounts (
          id, agent_id, merchant_id, required_amount_cents, available_amount_cents,
          frozen_amount_cents, deducted_amount_cents, status, created_at, updated_at
        )
        VALUES (
          ${stableDbId("deposit_account", agentId)}, ${agentId}, NULL,
          ${account.requiredAmountCents}, ${account.availableAmountCents},
          ${account.frozenAmountCents}, ${account.deductedAmountCents},
          CAST(${mapDepositStatus(account.status)} AS "DepositStatus"), now(), now()
        )
        ON CONFLICT (agent_id) DO UPDATE SET
          required_amount_cents = EXCLUDED.required_amount_cents,
          available_amount_cents = EXCLUDED.available_amount_cents,
          frozen_amount_cents = EXCLUDED.frozen_amount_cents,
          deducted_amount_cents = EXCLUDED.deducted_amount_cents,
          status = EXCLUDED.status,
          updated_at = now()
      `;
    }

    for (const txItem of store.depositTransactions) {
      await tx.$executeRaw`
        INSERT INTO deposit_transactions (
          id, agent_id, merchant_id, account_id, type, amount_cents,
          balance_before_cents, balance_after_cents, reason_code, related_type,
          related_id, voucher_url, note, idempotency_key, operator_id, created_at
        )
        VALUES (
          ${stableDbId("deposit_tx", txItem.idempotencyKey)}, ${txItem.agentId}, NULL,
          (SELECT id FROM deposit_accounts WHERE agent_id = ${txItem.agentId} LIMIT 1),
          CAST(${mapDepositTransactionType(txItem.type)} AS "DepositTransactionType"),
          ${txItem.amountCents}, ${txItem.balanceBeforeCents}, ${txItem.balanceAfterCents},
          ${txItem.reasonCode}, ${txItem.relatedType}, ${txItem.relatedId},
          ${txItem.proofUrl ?? null}, ${txItem.remark ?? null}, ${txItem.idempotencyKey},
          ${txItem.operatorId ?? null}, now()
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
    }

    for (const clawback of store.clawbacks) {
      const item = clawback as Record<string, unknown>;
      const clawbackNo = stringValue(item.clawbackNo) ?? stringValue(item.id) ?? stableDbId("clawback_no", JSON.stringify(item));
      const agentId = requiredStringValue(item.agentId, "agentId");
      await tx.$executeRaw`
        INSERT INTO clawbacks (
          id, clawback_no, agent_id, source_type, source_id, order_id,
          settlement_role, amount_cents, status, deduct_from, reason_code,
          idempotency_key, created_at, updated_at
        )
        VALUES (
          ${stableDbId("clawback", clawbackNo)}, ${clawbackNo}, ${agentId},
          ${stringValue(item.sourceType) ?? "manual"}, ${stringValue(item.sourceId) ?? clawbackNo},
          NULL, NULL, ${bigintValue(item.amountCents)}, CAST(${mapClawbackStatus(stringValue(item.status) ?? "pending")} AS "ClawbackStatus"),
          NULL, ${stringValue(item.reasonCode) ?? "manual_adjustment"},
          ${stringValue(item.idempotencyKey) ?? `clawback:${clawbackNo}`}, now(), now()
        )
        ON CONFLICT (idempotency_key) DO UPDATE SET
          status = EXCLUDED.status,
          updated_at = now()
      `;
    }
  }

  private async persistOrders(tx: PrismaTx, store: MemoryStore) {
    for (const order of store.orders.values()) {
      if (this.loadedOrderNos.has(order.orderNo)) continue;
      await this.persistOrder(tx, order);
    }
  }

  private async persistOrder(tx: PrismaTx, order: DemoOrder) {
    const amount = order.snapshot.amountSnapshot;
    const channel = getChannelSnapshot(order.snapshot);
    const orderId = stableDbId("order", order.orderNo);
    const itemId = stableDbId("order_item", order.orderNo);
    const amountId = stableDbId("amount_snapshot", order.orderNo);
    const agentId = order.salesChannelType === "platform_self_operated" || order.agentId === PLATFORM_AGENT_ID ? null : order.agentId;
    const platformShopProductId = order.salesChannelType === "platform_self_operated" ? order.agentProductId : null;
    const agentProductId = platformShopProductId ? null : order.agentProductId;
    await tx.$executeRaw`
      INSERT INTO orders (
        id, order_no, user_id, agent_id, merchant_id, shop_id, buyer_email,
        sales_channel_type, first_tier_agent_id, second_tier_agent_id, third_tier_agent_id,
        channel_relation_id, collection_channel_id, collection_snapshot_json,
        coupon_discount_cents, status, payment_status, fulfillment_status, refund_status,
        settlement_status, risk_status, paid_amount_cents, paid_at, fulfilled_at,
        created_at, updated_at
      )
      VALUES (
        ${orderId}, ${order.orderNo}, ${order.userId}, ${agentId}, NULL, ${order.shopId}, ${order.buyerEmail ?? null},
        CAST(${order.salesChannelType} AS "SalesChannelType"),
        ${channel?.firstTierAgentId ?? null}, ${channel?.secondTierAgentId ?? null}, ${channel?.thirdTierAgentId ?? null},
        ${channel?.relationId ?? null}, ${order.collectionChannelId ?? null}, ${jsonForDb(order.collectionChannelSnapshot)}::jsonb,
        ${order.couponDiscountCents ?? 0n},
        CAST(${mapOrderStatus(order.status)} AS "OrderStatus"),
        CAST(${mapPaymentStatus(order.paymentStatus)} AS "PaymentStatus"),
        CAST(${mapFulfillmentStatus(order.fulfillmentStatus)} AS "FulfillmentStatus"),
        CAST(${mapRefundStatus(order.refundStatus)} AS "RefundStatus"),
        CAST(${mapSettlementStatus(order.settlementStatus)} AS "SettlementStatus"),
        CAST(${mapRiskStatus(order.riskStatus)} AS "RiskStatus"),
        ${payableAmount(order)}, ${order.paidAt}, ${order.fulfilledAt}, now(), now()
      )
      ON CONFLICT (order_no) DO UPDATE SET
        payment_status = EXCLUDED.payment_status,
        fulfillment_status = EXCLUDED.fulfillment_status,
        refund_status = EXCLUDED.refund_status,
        settlement_status = EXCLUDED.settlement_status,
        risk_status = EXCLUDED.risk_status,
        paid_amount_cents = EXCLUDED.paid_amount_cents,
        paid_at = EXCLUDED.paid_at,
        fulfilled_at = EXCLUDED.fulfilled_at,
        updated_at = now()
    `;
    await tx.$executeRaw`
      INSERT INTO order_items (
        id, order_id, agent_product_id, merchant_product_id, platform_shop_product_id,
        sale_source_type, product_type, product_id_snapshot, product_name_snapshot,
        sale_price_cents, quantity, supply_price_cents, service_fee_cents,
        agent_income_cents, created_at
      )
      VALUES (
        ${itemId}, (SELECT id FROM orders WHERE order_no = ${order.orderNo}), ${agentProductId}, NULL, ${platformShopProductId},
        CAST(${platformShopProductId ? "platform_shop_product" : "agent_product"} AS "SaleSourceType"),
        CAST(${order.snapshot.productType} AS "ProductType"), ${getSnapshotProductId(order.snapshot) ?? order.agentProductId},
        ${order.snapshot.productNameSnapshot}, ${amount.paidAmountCents}, ${order.snapshot.quantity},
        ${amount.supplyAmountCents}, ${amount.serviceFeeCents}, ${amount.agentExpectedIncomeCents}, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        sale_price_cents = EXCLUDED.sale_price_cents,
        quantity = EXCLUDED.quantity,
        supply_price_cents = EXCLUDED.supply_price_cents,
        service_fee_cents = EXCLUDED.service_fee_cents,
        agent_income_cents = EXCLUDED.agent_income_cents
    `;
    await tx.$executeRaw`
      INSERT INTO order_amount_snapshots (
        id, order_id, service_fee_bps, paid_amount_cents, supply_amount_cents,
        service_fee_cents, agent_expected_income_cents, platform_supply_price_cents,
        resell_supply_price_cents, first_tier_supply_price_cents, second_tier_supply_price_cents,
        final_sale_price_cents, first_tier_income_cents, second_tier_income_cents,
        third_tier_income_cents, fulfillment_cost_cents, payment_channel_fee_cents,
        platform_gross_profit_cents, product_snapshot_json, shop_snapshot_json,
        pricing_snapshot_json, fulfillment_rule_snapshot_json, after_sale_rule_snapshot_json,
        created_at
      )
      VALUES (
        ${amountId}, (SELECT id FROM orders WHERE order_no = ${order.orderNo}), ${Number(amount.serviceFeeBps)},
        ${amount.paidAmountCents}, ${amount.supplyAmountCents}, ${amount.serviceFeeCents},
        ${amount.agentExpectedIncomeCents}, ${channel?.platformSupplyPriceCents ?? amount.supplyAmountCents},
        ${channel?.resellSupplyPriceCents ?? 0n}, ${channel?.firstTierSupplyPriceCents ?? 0n},
        ${channel?.secondTierSupplyPriceCents ?? 0n}, ${channel?.finalSalePriceCents ?? amount.paidAmountCents},
        ${channel?.firstTierIncomeCents ?? 0n}, ${channel?.secondTierIncomeCents ?? 0n},
        ${channel?.thirdTierIncomeCents ?? 0n}, ${getPlatformSelfGrossMargin(order.snapshot) > 0n ? amount.supplyAmountCents : 0n},
        0, ${getPlatformSelfGrossMargin(order.snapshot)}, ${jsonForDb(order.snapshot.productSnapshot)}::jsonb,
        ${jsonForDb(order.snapshot.shopSnapshot)}::jsonb, ${jsonForDb(order.snapshot.pricingSnapshot)}::jsonb,
        ${jsonForDb(order.snapshot.fulfillmentRuleSnapshot)}::jsonb, ${jsonForDb(order.snapshot.afterSaleRuleSnapshot)}::jsonb,
        now()
      )
      ON CONFLICT (order_id) DO UPDATE SET
        paid_amount_cents = EXCLUDED.paid_amount_cents,
        supply_amount_cents = EXCLUDED.supply_amount_cents,
        service_fee_cents = EXCLUDED.service_fee_cents,
        agent_expected_income_cents = EXCLUDED.agent_expected_income_cents
    `;
    if (order.paymentStatus === "paid") {
      await tx.$executeRaw`
        INSERT INTO payments (
          id, payment_no, order_id, user_id, collection_channel_id, channel,
          amount_cents, channel_fee_cents, status, idempotency_key, paid_at,
          created_at, updated_at
        )
        VALUES (
          ${stableDbId("payment", order.orderNo)}, ${`payment:${order.orderNo}`},
          (SELECT id FROM orders WHERE order_no = ${order.orderNo}), ${order.userId},
          ${order.collectionChannelId ?? null}, CAST('alipay_wap' AS "PaymentChannel"),
          ${payableAmount(order)}, 0, CAST('paid' AS "PaymentStatus"),
          ${`payment:offline:${order.orderNo}`}, ${order.paidAt ?? new Date()}, now(), now()
        )
        ON CONFLICT (payment_no) DO UPDATE SET
          status = EXCLUDED.status,
          paid_at = EXCLUDED.paid_at,
          updated_at = now()
      `;
    }
  }

  private async persistOrderExtractSecret(tx: PrismaTx, order: DemoOrder) {
    if (!order.extractionCodeHash) return;
    const refunded = order.refundStatus === "refunded" || order.refundStatus === "refunding";
    await tx.$executeRaw`
      INSERT INTO order_extract_secrets (
        id, order_id, order_item_id, claim_code_hash, status, failed_attempts,
        locked_until, revoked_at, revoke_reason, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${stableDbId("extract_secret", order.orderNo)},
        (SELECT id FROM orders WHERE order_no = ${order.orderNo}), ${stableDbId("order_item", order.orderNo)},
        ${order.extractionCodeHash}, CAST(${refunded ? "revoked" : order.extractionLockedUntil ? "locked" : "active"} AS "ExtractSecretStatus"),
        ${order.extractionAttemptCount ?? 0}, ${order.extractionLockedUntil ?? null},
        ${refunded ? new Date() : null}, ${refunded ? "refund" : null}, ${`extract:${order.orderNo}`},
        now(), now()
      )
      ON CONFLICT (idempotency_key) DO UPDATE SET
        status = EXCLUDED.status,
        failed_attempts = EXCLUDED.failed_attempts,
        locked_until = EXCLUDED.locked_until,
        revoked_at = EXCLUDED.revoked_at,
        revoke_reason = EXCLUDED.revoke_reason,
        updated_at = now()
    `;
  }

  private async persistCouponUsageForOrder(tx: PrismaTx, order: DemoOrder) {
    if (!order.couponId || !order.couponDiscountCents || order.couponDiscountCents <= 0n) return;
    const usageKey = `${order.couponId}:${order.orderNo}`;
    await tx.$executeRaw`
      INSERT INTO coupon_usage (
        id, user_coupon_id, coupon_template_id, order_id, discount_cents,
        subsidy_cents, idempotency_key, created_at
      )
      VALUES (
        ${stableDbId("coupon_usage", usageKey)}, ${order.couponId},
        (SELECT coupon_template_id FROM user_coupons WHERE id = ${order.couponId}),
        (SELECT id FROM orders WHERE order_no = ${order.orderNo}),
        ${order.couponDiscountCents}, ${order.couponDiscountCents},
        ${`coupon-usage:${usageKey}`}, now()
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
  }

  private async persistPaymentConfirmation(tx: PrismaTx, order: DemoOrder, audit?: Record<string, unknown>) {
    const after = isRecord(audit?.after) ? audit.after : {};
    const amountCents = bigintValue(after.amountCents) ?? payableAmount(order);
    const voucherUrl = stringValue(after.voucherUrl);
    const note = stringValue(after.note);
    const idempotencyKey = `offline-payment:${order.orderNo}:${voucherUrl ?? amountCents.toString()}`;
    await tx.$executeRaw`
      INSERT INTO payment_confirmations (
        id, confirmation_no, order_id, payment_id, shop_id, collection_channel_id,
        amount_cents, payer_name, voucher_url, note, status, reviewed_by,
        reviewed_at, reject_reason, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${stableDbId("payment_confirmation", idempotencyKey)}, ${idempotencyKey},
        (SELECT id FROM orders WHERE order_no = ${order.orderNo}),
        (SELECT id FROM payments WHERE payment_no = ${`payment:${order.orderNo}`}),
        ${order.shopId}, ${order.collectionChannelId ?? null}, ${amountCents}, NULL,
        ${voucherUrl ?? null}, ${note ?? null}, CAST('confirmed' AS "PaymentConfirmationStatus"),
        ${stringValue(audit?.actorId) ?? stringValue(after.operatorId) ?? null},
        ${dateValue(audit?.createdAt) ?? order.paidAt ?? new Date()}, NULL,
        ${idempotencyKey}, ${dateValue(audit?.createdAt) ?? new Date()}, now()
      )
      ON CONFLICT (idempotency_key) DO UPDATE SET
        status = EXCLUDED.status,
        reviewed_at = EXCLUDED.reviewed_at,
        voucher_url = EXCLUDED.voucher_url,
        note = EXCLUDED.note,
        updated_at = now()
    `;
  }

  private async persistPaymentVoucher(tx: PrismaTx, voucher: PaymentVoucher) {
    await tx.$executeRaw`
      INSERT INTO payment_confirmations (
        id, confirmation_no, order_id, payment_id, shop_id, collection_channel_id,
        amount_cents, payer_name, voucher_url, note, status, reviewed_by,
        reviewed_at, reject_reason, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${stableDbId("payment_voucher", voucher.id)}, ${voucher.id},
        (SELECT id FROM orders WHERE order_no = ${voucher.orderNo}),
        (SELECT id FROM payments WHERE payment_no = ${`payment:${voucher.orderNo}`}),
        ${voucher.shopId}, NULL, ${voucher.amountCents}, ${voucher.payerName ?? null},
        ${voucher.voucherUrl ?? null}, ${voucher.note ?? null},
        CAST(${mapPaymentVoucherStatus(voucher.status)} AS "PaymentConfirmationStatus"),
        ${voucher.reviewedBy}, ${voucher.reviewedAt}, ${voucher.reason ?? null},
        ${`payment-voucher:${voucher.id}`}, ${voucher.createdAt}, now()
      )
      ON CONFLICT (idempotency_key) DO UPDATE SET
        status = EXCLUDED.status,
        reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = EXCLUDED.reviewed_at,
        reject_reason = EXCLUDED.reject_reason,
        payer_name = EXCLUDED.payer_name,
        voucher_url = EXCLUDED.voucher_url,
        note = EXCLUDED.note,
        updated_at = now()
      `;
  }

  private async persistPaymentMethodOwnerDefaults(tx: PrismaTx, store: MemoryStore, changed: PaymentMethodConfig) {
    const scoped = [...store.paymentMethods.values()].filter((method) =>
      method.ownerType === changed.ownerType
      && (method.agentId ?? null) === (changed.agentId ?? null)
      && (method.shopId ?? null) === (changed.shopId ?? null)
    );
    for (const method of scoped) await this.persistPaymentMethodConfig(tx, method);
  }

  private async persistPaymentMethodConfig(tx: PrismaTx, method: PaymentMethodConfig) {
    const ownerType = method.ownerType === "agent" ? "agent" : "platform";
    const status = mapCollectionPaymentConfigStatus(method.status, method.enabled);
    const actorType = method.ownerType === "agent" ? "agent" : "admin";
    const credentialStatus = method.secretConfigured || method.provider === "personal_alipay" ? "configured" : "not_configured";
    const maskedIdentity = {
      merchantNoMasked: maskSecret(method.merchantNo),
      appIdMasked: maskSecret(method.appId),
      serviceProviderMasked: maskSecret(method.serviceProviderId)
    };
    await tx.$executeRaw`
      INSERT INTO collection_payment_configs (
        id, config_no, owner_type, owner_agent_id, owner_merchant_id, shop_id,
        provider, confirm_mode, environment, status, is_default, display_name,
        merchant_no_masked, app_id_masked, service_provider_masked,
        credential_ref, credential_ciphertext, secret_version, credential_status,
        notify_url, return_url, test_status, last_test_at, last_test_result_json,
        last_callback_at, qr_url, account_masked, instruction,
        created_by_type, created_by_id, updated_by_type, updated_by_id,
        enabled_at, disabled_at, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${method.id}, ${method.id}, CAST(${ownerType} AS "CollectionConfigOwnerType"),
        ${method.agentId ?? null}, NULL, ${method.shopId ?? null},
        CAST(${mapPaymentProviderToDb(method.provider)} AS "PaymentProvider"),
        CAST(${mapPaymentConfirmModeToDb(method.confirmationMode)} AS "PaymentConfirmMode"),
        CAST('production' AS "PaymentEnvironment"),
        CAST(${status} AS "CollectionConfigStatus"),
        ${method.isDefault}, ${method.displayName},
        ${maskedIdentity.merchantNoMasked ?? null}, ${maskedIdentity.appIdMasked ?? null}, ${maskedIdentity.serviceProviderMasked ?? null},
        ${method.signingSecretPreview ?? method.privateKeyPreview ?? method.publicKeyPreview ?? method.certificatePreview ?? null},
        ${method.signingSecretEncrypted ?? null}, 1, CAST(${credentialStatus} AS "CredentialStatus"),
        ${providerCallbackUrlForPersistence(method.provider)}, ${method.returnUrl ?? null},
        ${method.lastTestResult ?? null}, ${method.lastTestAt ?? null},
        ${method.lastTestResult ? jsonForDb({ status: method.lastTestResult }) : null}::jsonb,
        ${method.lastCallbackAt ?? null}, ${method.qrUrl ?? method.paymentUrl ?? null},
        ${method.accountName ? maskSecret(method.accountName) : null}, ${method.note ?? null},
        CAST(${actorType} AS "ActorType"), ${method.updatedBy ?? null},
        CAST(${actorType} AS "ActorType"), ${method.updatedBy ?? null},
        ${method.enabled ? method.updatedAt : null}, ${method.enabled ? null : method.updatedAt},
        ${`collection-payment-config:${method.id}`}, ${method.createdAt}, ${method.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        owner_type = EXCLUDED.owner_type,
        owner_agent_id = EXCLUDED.owner_agent_id,
        owner_merchant_id = EXCLUDED.owner_merchant_id,
        shop_id = EXCLUDED.shop_id,
        provider = EXCLUDED.provider,
        confirm_mode = EXCLUDED.confirm_mode,
        status = EXCLUDED.status,
        is_default = EXCLUDED.is_default,
        display_name = EXCLUDED.display_name,
        merchant_no_masked = EXCLUDED.merchant_no_masked,
        app_id_masked = EXCLUDED.app_id_masked,
        service_provider_masked = EXCLUDED.service_provider_masked,
        credential_ref = EXCLUDED.credential_ref,
        credential_ciphertext = EXCLUDED.credential_ciphertext,
        credential_status = EXCLUDED.credential_status,
        notify_url = EXCLUDED.notify_url,
        return_url = EXCLUDED.return_url,
        test_status = EXCLUDED.test_status,
        last_test_at = EXCLUDED.last_test_at,
        last_test_result_json = EXCLUDED.last_test_result_json,
        last_callback_at = EXCLUDED.last_callback_at,
        qr_url = EXCLUDED.qr_url,
        account_masked = EXCLUDED.account_masked,
        instruction = EXCLUDED.instruction,
        updated_by_type = EXCLUDED.updated_by_type,
        updated_by_id = EXCLUDED.updated_by_id,
        enabled_at = EXCLUDED.enabled_at,
        disabled_at = EXCLUDED.disabled_at,
        updated_at = EXCLUDED.updated_at
    `;
  }

  private async persistPaymentSnapshotForOrder(tx: PrismaTx, store: MemoryStore, order: DemoOrder) {
    const snapshot = order.paymentSnapshot;
    if (!snapshot?.paymentMethodId || !snapshot.provider) return;
    const method = store.paymentMethods.get(snapshot.paymentMethodId);
    const paymentNo = snapshot.paymentNo ?? `payment:${order.orderNo}`;
    const paymentId = stableDbId("payment", paymentNo);
    const providerPaymentNo = snapshot.providerPaymentNo ?? null;
    const providerTradeNo = snapshot.providerTradeNo ?? null;
    const channelTradeNo = providerTradeNo ?? providerPaymentNo;
    const status = mapPaymentSnapshotStatus(snapshot.status ?? order.paymentStatus);
    const confirmSource = mapPaymentConfirmSource(snapshot.confirmationSource);
    const amountCents = snapshot.amountCents ?? payableAmount(order);
    const configSnapshot = method ? serializePaymentMethodForPersistence(method) : {
      id: snapshot.paymentMethodId,
      provider: snapshot.provider,
      confirmationMode: snapshot.confirmationMode
    };
    await tx.$executeRaw`
      INSERT INTO payments (
        id, payment_no, order_id, user_id, collection_channel_id, collection_payment_config_id,
        collection_snapshot_json, channel, provider, confirm_mode, environment,
        channel_trade_no, provider_payment_no, provider_trade_no, amount_cents,
        channel_fee_cents, status, confirm_source, idempotency_key, expires_at,
        paid_at, callback_handled_at, exception_reason, created_at, updated_at
      )
      VALUES (
        ${paymentId}, ${paymentNo},
        (SELECT id FROM orders WHERE order_no = ${order.orderNo}), ${order.userId},
        ${order.collectionChannelId ?? null}, ${snapshot.paymentMethodId},
        ${jsonForDb(order.collectionChannelSnapshot ?? {})}::jsonb,
        CAST(${mapProviderToLegacyPaymentChannel(snapshot.provider)} AS "PaymentChannel"),
        CAST(${mapPaymentProviderToDb(snapshot.provider)} AS "PaymentProvider"),
        CAST(${mapPaymentConfirmModeToDb(snapshot.confirmationMode ?? "automatic")} AS "PaymentConfirmMode"),
        CAST('production' AS "PaymentEnvironment"),
        ${channelTradeNo}, ${providerPaymentNo}, ${providerTradeNo}, ${amountCents},
        0, CAST(${status} AS "PaymentStatus"),
        CAST(${confirmSource} AS "PaymentConfirmSource"),
        ${`payment:${paymentNo}`}, ${snapshot.expiresAt ?? null}, ${snapshot.paidAt ?? order.paidAt ?? null},
        ${snapshot.callbackProcessedAt ?? null}, ${status === "failed" ? "payment_exception" : null},
        ${snapshot.createdAt ?? new Date()}, now()
      )
      ON CONFLICT (payment_no) DO UPDATE SET
        collection_payment_config_id = EXCLUDED.collection_payment_config_id,
        collection_snapshot_json = EXCLUDED.collection_snapshot_json,
        provider = EXCLUDED.provider,
        confirm_mode = EXCLUDED.confirm_mode,
        channel_trade_no = COALESCE(EXCLUDED.channel_trade_no, payments.channel_trade_no),
        provider_payment_no = COALESCE(EXCLUDED.provider_payment_no, payments.provider_payment_no),
        provider_trade_no = COALESCE(EXCLUDED.provider_trade_no, payments.provider_trade_no),
        amount_cents = EXCLUDED.amount_cents,
        status = EXCLUDED.status,
        confirm_source = EXCLUDED.confirm_source,
        expires_at = EXCLUDED.expires_at,
        paid_at = EXCLUDED.paid_at,
        callback_handled_at = EXCLUDED.callback_handled_at,
        exception_reason = EXCLUDED.exception_reason,
        updated_at = now()
    `;
    await tx.$executeRaw`
      INSERT INTO payment_snapshots (
        id, snapshot_no, order_id, payment_id, collection_config_id, provider,
        confirm_mode, environment, config_snapshot_json, merchant_no_masked,
        app_id_masked, service_provider_masked, payable_amount_cents, currency,
        payment_no, provider_payment_no, provider_trade_no, status, confirm_source,
        expires_at, paid_at, callback_handled_at, exception_reason, idempotency_key,
        created_at, updated_at
      )
      VALUES (
        ${stableDbId("payment_snapshot", order.orderNo)}, ${`snapshot:${order.orderNo}`},
        (SELECT id FROM orders WHERE order_no = ${order.orderNo}), ${paymentId}, ${snapshot.paymentMethodId},
        CAST(${mapPaymentProviderToDb(snapshot.provider)} AS "PaymentProvider"),
        CAST(${mapPaymentConfirmModeToDb(snapshot.confirmationMode ?? "automatic")} AS "PaymentConfirmMode"),
        CAST('production' AS "PaymentEnvironment"),
        ${jsonForDb(configSnapshot)}::jsonb,
        ${snapshot.merchantNoMasked ?? null}, ${snapshot.appIdMasked ?? null}, ${snapshot.serviceProviderMasked ?? null},
        ${amountCents}, ${snapshot.currency ?? "CNY"}, ${paymentNo}, ${providerPaymentNo}, ${providerTradeNo},
        CAST(${status} AS "PaymentStatus"),
        CAST(${confirmSource} AS "PaymentConfirmSource"),
        ${snapshot.expiresAt ?? null}, ${snapshot.paidAt ?? order.paidAt ?? null},
        ${snapshot.callbackProcessedAt ?? null}, ${status === "failed" ? "payment_exception" : null},
        ${`payment-snapshot:${order.orderNo}`}, ${snapshot.createdAt ?? new Date()}, now()
      )
      ON CONFLICT (snapshot_no) DO UPDATE SET
        payment_id = EXCLUDED.payment_id,
        collection_config_id = EXCLUDED.collection_config_id,
        provider = EXCLUDED.provider,
        confirm_mode = EXCLUDED.confirm_mode,
        config_snapshot_json = EXCLUDED.config_snapshot_json,
        provider_payment_no = COALESCE(EXCLUDED.provider_payment_no, payment_snapshots.provider_payment_no),
        provider_trade_no = COALESCE(EXCLUDED.provider_trade_no, payment_snapshots.provider_trade_no),
        status = EXCLUDED.status,
        confirm_source = EXCLUDED.confirm_source,
        paid_at = EXCLUDED.paid_at,
        callback_handled_at = EXCLUDED.callback_handled_at,
        exception_reason = EXCLUDED.exception_reason,
        updated_at = now()
    `;
  }

  private async persistPaymentCallbackLog(tx: PrismaTx, store: MemoryStore, log: PaymentCallbackLog) {
    const order = log.orderNo ? store.orders.get(log.orderNo) : undefined;
    const method = order ? this.paymentMethodForOrder(store, order) : undefined;
    const paymentNo = order?.paymentSnapshot?.paymentNo ?? (log.orderNo ? `payment:${log.orderNo}` : null);
    await tx.$executeRaw`
      INSERT INTO payment_callback_logs (
        id, callback_no, payment_id, order_id, payment_snapshot_id, collection_config_id,
        provider, source, order_no, provider_payment_no, provider_trade_no, notified_at,
        signature_valid, amount_matched, merchant_matched, processed_status,
        provider_event_id, idempotency_key, error_code, error_message,
        raw_payload_ciphertext, raw_payload_masked_json, created_at, processed_at
      )
      VALUES (
        ${log.id}, ${log.id},
        ${paymentNo ? stableDbId("payment", paymentNo) : null},
        ${log.orderNo ? stableDbId("order", log.orderNo) : null},
        ${log.orderNo ? stableDbId("payment_snapshot", log.orderNo) : null},
        ${method?.id ?? null}, CAST(${mapPaymentProviderToDb(log.provider)} AS "PaymentProvider"),
        'callback', ${log.orderNo ?? null}, ${log.providerTradeNo}, ${log.providerTradeNo},
        ${log.receivedAt}, ${log.verified}, ${log.status !== "exception"}, ${log.status !== "exception"},
        CAST(${mapCallbackProcessStatus(log.status)} AS "CallbackProcessStatus"),
        ${`callback:${log.provider}:${log.providerTradeNo}:${log.id}`},
        ${`payment-callback:${log.id}`}, ${log.status === "accepted" ? null : log.status},
        ${log.exceptionId ?? null}, NULL, ${jsonForDb(log.rawPayloadMasked ?? {})}::jsonb,
        ${log.receivedAt}, ${log.status === "accepted" ? log.receivedAt : null}
      )
      ON CONFLICT (callback_no) DO UPDATE SET
        processed_status = EXCLUDED.processed_status,
        error_code = EXCLUDED.error_code,
        error_message = EXCLUDED.error_message,
        raw_payload_masked_json = EXCLUDED.raw_payload_masked_json,
        processed_at = EXCLUDED.processed_at
    `;
  }

  private async persistPaymentException(tx: PrismaTx, store: MemoryStore, exception: PaymentException) {
    const order = exception.orderNo ? store.orders.get(exception.orderNo) : undefined;
    const method = order ? this.paymentMethodForOrder(store, order) : undefined;
    const paymentNo = order?.paymentSnapshot?.paymentNo ?? (exception.orderNo ? `payment:${exception.orderNo}` : null);
    const relatedLog = store.paymentCallbackLogs.find((log) => log.exceptionId === exception.id);
    await tx.$executeRaw`
      INSERT INTO payment_exceptions (
        id, exception_no, order_id, payment_id, payment_snapshot_id, callback_log_id,
        collection_config_id, exception_type, status, reason, action_taken,
        resolution_json, handled_by_type, handled_by_id, handled_at, idempotency_key,
        created_at, updated_at
      )
      VALUES (
        ${exception.id}, ${exception.id},
        ${exception.orderNo ? stableDbId("order", exception.orderNo) : null},
        ${paymentNo ? stableDbId("payment", paymentNo) : null},
        ${exception.orderNo ? stableDbId("payment_snapshot", exception.orderNo) : null},
        ${relatedLog?.id ?? null}, ${method?.id ?? null},
        CAST(${mapPaymentExceptionType(exception.reasonCode)} AS "PaymentExceptionType"),
        CAST(${exception.handled ? "resolved" : "open"} AS "PaymentExceptionStatus"),
        ${exception.reason}, ${exception.handled ? exception.note ?? "handled" : null},
        ${jsonForDb({
          reasonCode: exception.reasonCode,
          amountCents: exception.amountCents,
          providerTradeNo: exception.providerTradeNo,
          merchantNoMasked: exception.merchantNoMasked,
          appIdMasked: exception.appIdMasked,
          serviceProviderMasked: exception.serviceProviderMasked
        })}::jsonb,
        ${exception.handledBy ? "admin" : null}::"ActorType",
        ${exception.handledBy ?? null}, ${exception.handledAt ?? null},
        ${`payment-exception:${exception.id}`}, ${exception.receivedAt}, now()
      )
      ON CONFLICT (exception_no) DO UPDATE SET
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        action_taken = EXCLUDED.action_taken,
        resolution_json = EXCLUDED.resolution_json,
        handled_by_type = EXCLUDED.handled_by_type,
        handled_by_id = EXCLUDED.handled_by_id,
        handled_at = EXCLUDED.handled_at,
        updated_at = now()
    `;
  }

  private async persistPaymentDisputeMaterial(tx: PrismaTx, voucher: PaymentVoucher) {
    await tx.$executeRaw`
      INSERT INTO payment_dispute_materials (
        id, material_no, order_id, payment_id, payment_exception_id, material_type,
        status, file_url, file_hash, note, uploaded_by_type, uploaded_by_id,
        reviewed_by_type, reviewed_by_id, reviewed_at, review_note, idempotency_key,
        created_at, updated_at
      )
      VALUES (
        ${stableDbId("payment_dispute_material", voucher.id)}, ${voucher.id},
        (SELECT id FROM orders WHERE order_no = ${voucher.orderNo}),
        (SELECT id FROM payments WHERE payment_no = ${`payment:${voucher.orderNo}`}),
        NULL, CAST('payment_screenshot' AS "PaymentDisputeMaterialType"),
        CAST(${voucher.status === "pending_review" ? "submitted" : "reviewed"} AS "PaymentDisputeMaterialStatus"),
        ${voucher.voucherUrl ?? null}, ${voucher.voucherUrl ? hashSecret(voucher.voucherUrl) : null},
        ${voucher.note ?? voucher.reason ?? null}, CAST('user' AS "ActorType"), ${voucher.userId},
        ${voucher.reviewedBy ? "admin" : null}::"ActorType", ${voucher.reviewedBy ?? null},
        ${voucher.reviewedAt}, ${voucher.reason ?? null}, ${`payment-dispute-material:${voucher.id}`},
        ${voucher.createdAt}, now()
      )
      ON CONFLICT (material_no) DO UPDATE SET
        status = EXCLUDED.status,
        file_url = EXCLUDED.file_url,
        file_hash = EXCLUDED.file_hash,
        note = EXCLUDED.note,
        reviewed_by_type = EXCLUDED.reviewed_by_type,
        reviewed_by_id = EXCLUDED.reviewed_by_id,
        reviewed_at = EXCLUDED.reviewed_at,
        review_note = EXCLUDED.review_note,
        updated_at = now()
    `;
  }

  private async persistIssuedRightsCodesForOrder(tx: PrismaTx, store: MemoryStore, order: DemoOrder) {
    const codes = store.rightsCodes.filter((code) => code.orderNo === order.orderNo && code.status === "issued");
    for (const code of codes) {
      const shape = this.rightsCodeDbShape(code, store);
      await tx.$executeRaw`
        INSERT INTO rights_codes (
          id, product_id, agent_product_id, code_ciphertext, code_hash, secret_preview,
          owner_type, owner_agent_id, shop_id, batch_no, status, order_id,
          issue_key, issued_at, import_audit_json, created_at, updated_at
        )
        VALUES (
          ${code.codeId}, ${shape.platformProductId}, ${shape.agentProductId}, ${code.code},
          ${shape.codeHash}, ${shape.secretPreview}, CAST(${shape.ownerType} AS "RightsCodeOwnerType"),
          ${shape.ownerAgentId}, ${shape.shopId}, ${code.batchNo},
          CAST('issued' AS "RightsCodeStatus"),
          (SELECT id FROM orders WHERE order_no = ${order.orderNo}),
          ${code.issueKey ?? null}, ${code.issuedAt ?? new Date()},
          ${jsonForDb({ batchNo: code.batchNo, orderNo: order.orderNo, source: "auto_fulfillment" })}::jsonb,
          ${code.createdAt}, now()
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          order_id = EXCLUDED.order_id,
          issue_key = EXCLUDED.issue_key,
          issued_at = EXCLUDED.issued_at,
          code_hash = COALESCE(rights_codes.code_hash, EXCLUDED.code_hash),
          secret_preview = COALESCE(rights_codes.secret_preview, EXCLUDED.secret_preview),
          owner_type = EXCLUDED.owner_type,
          owner_agent_id = EXCLUDED.owner_agent_id,
          shop_id = EXCLUDED.shop_id,
          updated_at = now()
      `;
      await tx.$executeRaw`
        INSERT INTO entitlements (
          id, order_id, order_item_id, user_id, rights_code, rights_payload_json,
          status, idempotency_key, issued_at, created_at, updated_at
        )
        VALUES (
          ${stableDbId("entitlement", `${order.orderNo}:${code.codeId}`)},
          (SELECT id FROM orders WHERE order_no = ${order.orderNo}),
          ${stableDbId("order_item", order.orderNo)}, ${order.userId},
          ${code.code}, ${jsonForDb({ codeId: code.codeId })}::jsonb,
          CAST('success' AS "FulfillmentStatus"), ${`entitlement:${order.orderNo}:${code.codeId}`},
          ${code.issuedAt ?? new Date()}, now(), now()
        )
        ON CONFLICT (idempotency_key) DO UPDATE SET
          status = EXCLUDED.status,
          issued_at = EXCLUDED.issued_at,
          updated_at = now()
      `;
    }
  }

  private async persistFulfillmentRecordForOrder(tx: PrismaTx, store: MemoryStore, order: DemoOrder) {
    const record = store.fulfillmentRecords.get(order.orderNo);
    if (!record) return;
    await tx.$executeRaw`
      INSERT INTO fulfillment_records (
        id, order_id, order_item_id, agent_id, shop_id, idempotency_key,
        fulfillment_type, status, success_at, fail_reason, created_at, updated_at
      )
      VALUES (
        ${stableDbId("fulfillment", order.orderNo)}, (SELECT id FROM orders WHERE order_no = ${order.orderNo}),
        ${stableDbId("order_item", order.orderNo)}, (SELECT agent_id FROM orders WHERE order_no = ${order.orderNo}),
        (SELECT shop_id FROM orders WHERE order_no = ${order.orderNo}), ${`fulfillment:${order.orderNo}`},
        CAST(${fulfillmentMode(order.snapshot) === "code_pool" ? "automatic" : "manual"} AS "FulfillmentType"),
        CAST(${mapFulfillmentStatus(record.status)} AS "FulfillmentStatus"),
        ${record.status === "success" ? order.fulfilledAt ?? new Date() : null}, NULL, now(), now()
      )
      ON CONFLICT (idempotency_key) DO UPDATE SET
        status = EXCLUDED.status,
        success_at = COALESCE(fulfillment_records.success_at, EXCLUDED.success_at),
        updated_at = now()
    `;
  }

  private async persistAfterSalesAndRefunds(tx: PrismaTx, store: MemoryStore) {
    for (const afterSale of store.afterSales.values()) {
      await this.persistAfterSale(tx, afterSale);
    }

    for (const refund of store.refunds.values()) {
      await this.persistRefund(tx, refund);
      await tx.$executeRaw`
        UPDATE order_extract_secrets
           SET status = CAST('revoked' AS "ExtractSecretStatus"),
               revoked_at = COALESCE(revoked_at, now()),
               revoke_reason = 'refund'
         WHERE order_id = (SELECT id FROM orders WHERE order_no = ${refund.orderNo})
      `;
    }
  }

  private async persistRefund(tx: PrismaTx, refund: DemoRefund) {
    await tx.$executeRaw`
      INSERT INTO refunds (
        id, refund_no, after_sale_id, order_id, payment_id, amount_cents,
        status, channel_refund_no, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${stableDbId("refund", refund.refundNo)}, ${refund.refundNo},
        (SELECT id FROM after_sales WHERE after_sale_no = ${refund.afterSaleNo}),
        (SELECT id FROM orders WHERE order_no = ${refund.orderNo}),
        (SELECT id FROM payments WHERE payment_no = ${`payment:${refund.orderNo}`}),
        ${refund.amountCents}, CAST(${mapRefundStatus(refund.status)} AS "RefundStatus"),
        ${refund.channelRefundNo ?? null}, ${`refund:${refund.refundNo}`}, now(), now()
      )
      ON CONFLICT (refund_no) DO UPDATE SET
        status = EXCLUDED.status,
        channel_refund_no = COALESCE(EXCLUDED.channel_refund_no, refunds.channel_refund_no),
        amount_cents = EXCLUDED.amount_cents,
        updated_at = now()
    `;
  }

  private async persistCouponVoidForRefund(tx: PrismaTx, coupon: UserCoupon, refund: DemoRefund) {
    if (coupon.status !== "voided_after_refund") return;
    const idempotencyKey = `coupon-void:${coupon.id}:${refund.refundNo}`;
    await tx.$executeRaw`
      INSERT INTO coupon_void_records (
        id, user_coupon_id, coupon_template_id, reason_code, source_type,
        source_id, voided_by, idempotency_key, created_at
      )
      VALUES (
        ${stableDbId("coupon_void", idempotencyKey)}, ${coupon.id}, ${coupon.templateId},
        'refund', 'refund', ${refund.refundNo}, NULL, ${idempotencyKey}, now()
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
    await tx.$executeRaw`
      UPDATE coupon_usage
         SET reversed_at = COALESCE(reversed_at, now()),
             reverse_reason = 'refund'
       WHERE user_coupon_id = ${coupon.id}
         AND order_id = (SELECT id FROM orders WHERE order_no = ${refund.orderNo})
    `;
  }

  private async persistFulfillmentAndExtraction(tx: PrismaTx, store: MemoryStore) {
    for (const code of store.rightsCodes) {
      const shape = this.rightsCodeDbShape(code, store);
      await tx.$executeRaw`
        INSERT INTO rights_codes (
          id, product_id, agent_product_id, code_ciphertext, code_hash, secret_preview,
          owner_type, owner_agent_id, shop_id, batch_no, status, order_id,
          issue_key, issued_at, import_audit_json, created_at, updated_at
        )
        VALUES (
          ${code.codeId}, ${shape.platformProductId}, ${shape.agentProductId}, ${code.code},
          ${shape.codeHash}, ${shape.secretPreview}, CAST(${shape.ownerType} AS "RightsCodeOwnerType"),
          ${shape.ownerAgentId}, ${shape.shopId}, ${code.batchNo},
          CAST(${code.status} AS "RightsCodeStatus"),
          ${code.orderNo ? stableDbId("order", code.orderNo) : null},
          ${code.issueKey ?? null}, ${code.issuedAt ?? null},
          ${jsonForDb({ batchNo: code.batchNo, orderNo: code.orderNo ?? null, source: "fulfillment_sync" })}::jsonb,
          ${code.createdAt}, now()
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          order_id = EXCLUDED.order_id,
          issue_key = EXCLUDED.issue_key,
          issued_at = EXCLUDED.issued_at,
          code_hash = COALESCE(rights_codes.code_hash, EXCLUDED.code_hash),
          secret_preview = COALESCE(rights_codes.secret_preview, EXCLUDED.secret_preview),
          owner_type = EXCLUDED.owner_type,
          owner_agent_id = EXCLUDED.owner_agent_id,
          shop_id = EXCLUDED.shop_id,
          updated_at = now()
      `;
      if (code.status === "issued" && code.orderNo) {
        await tx.$executeRaw`
          INSERT INTO entitlements (
            id, order_id, order_item_id, user_id, rights_code, rights_payload_json,
            status, idempotency_key, issued_at, created_at, updated_at
          )
          VALUES (
            ${stableDbId("entitlement", `${code.orderNo}:${code.codeId}`)},
            (SELECT id FROM orders WHERE order_no = ${code.orderNo}),
            ${stableDbId("order_item", code.orderNo)},
            (SELECT user_id FROM orders WHERE order_no = ${code.orderNo}),
            ${code.code}, ${jsonForDb({ codeId: code.codeId })}::jsonb,
            CAST('success' AS "FulfillmentStatus"), ${`entitlement:${code.orderNo}:${code.codeId}`},
            ${code.issuedAt ?? new Date()}, now(), now()
          )
          ON CONFLICT (idempotency_key) DO UPDATE SET
            status = EXCLUDED.status,
            issued_at = EXCLUDED.issued_at,
            updated_at = now()
        `;
      }
    }

    for (const [orderNo, record] of store.fulfillmentRecords.entries()) {
      await tx.$executeRaw`
        INSERT INTO fulfillment_records (
          id, order_id, order_item_id, agent_id, shop_id, idempotency_key,
          fulfillment_type, status, success_at, fail_reason, created_at, updated_at
        )
        VALUES (
          ${stableDbId("fulfillment", orderNo)}, (SELECT id FROM orders WHERE order_no = ${orderNo}),
          ${stableDbId("order_item", orderNo)}, (SELECT agent_id FROM orders WHERE order_no = ${orderNo}),
          (SELECT shop_id FROM orders WHERE order_no = ${orderNo}), ${`fulfillment:${orderNo}`},
          CAST('manual' AS "FulfillmentType"),
          CAST(${mapFulfillmentStatus(record.status)} AS "FulfillmentStatus"),
          ${record.status === "success" ? new Date() : null}, NULL, now(), now()
        )
        ON CONFLICT (idempotency_key) DO UPDATE SET
          status = EXCLUDED.status,
          success_at = COALESCE(fulfillment_records.success_at, EXCLUDED.success_at),
          updated_at = now()
      `;
    }

    for (const order of store.orders.values()) {
      if (order.extractionCodeHash) {
        const refunded = order.refundStatus === "refunded" || order.refundStatus === "refunding";
        await tx.$executeRaw`
          INSERT INTO order_extract_secrets (
            id, order_id, order_item_id, claim_code_hash, status, failed_attempts,
            locked_until, revoked_at, revoke_reason, idempotency_key, created_at, updated_at
          )
          VALUES (
            ${stableDbId("extract_secret", order.orderNo)},
            (SELECT id FROM orders WHERE order_no = ${order.orderNo}), ${stableDbId("order_item", order.orderNo)},
            ${order.extractionCodeHash}, CAST(${refunded ? "revoked" : order.extractionLockedUntil ? "locked" : "active"} AS "ExtractSecretStatus"),
            ${order.extractionAttemptCount ?? 0}, ${order.extractionLockedUntil ?? null},
            ${refunded ? new Date() : null}, ${refunded ? "refund" : null}, ${`extract:${order.orderNo}`},
            now(), now()
          )
          ON CONFLICT (idempotency_key) DO UPDATE SET
            status = EXCLUDED.status,
            failed_attempts = EXCLUDED.failed_attempts,
            locked_until = EXCLUDED.locked_until,
            revoked_at = EXCLUDED.revoked_at,
            revoke_reason = EXCLUDED.revoke_reason,
            updated_at = now()
        `;
      }
    }

    for (const log of store.extractLogs) {
      const orderNo = requiredStringValue(log.orderNo, "orderNo");
      await tx.$executeRaw`
        INSERT INTO order_extract_logs (
          id, extract_secret_id, order_id, actor_type, actor_id, result,
          reason_code, idempotency_key, created_at
        )
        VALUES (
          ${stringValue(log.id) ?? stableDbId("extract_log", JSON.stringify(log))},
          (SELECT id FROM order_extract_secrets WHERE order_id = (SELECT id FROM orders WHERE order_no = ${orderNo}) LIMIT 1),
          (SELECT id FROM orders WHERE order_no = ${orderNo}), CAST('user' AS "ActorType"),
          ${stringValue(log.userId) ?? null}, CAST(${mapExtractLogResult(stringValue(log.attemptResult))} AS "ExtractLogResult"),
          ${stringValue(log.failureReason) ?? null}, ${`extract-log:${stringValue(log.id) ?? hashSecret(JSON.stringify(log))}`},
          ${dateValue(log.createdAt) ?? new Date()}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
    }

    for (const delivery of store.emailDeliveries) {
      await this.persistEmailDelivery(tx, store, delivery);
    }
  }

  private async persistEmailDeliveriesForOrder(tx: PrismaTx, store: MemoryStore, order: DemoOrder) {
    const deliveries = store.emailDeliveries.filter((delivery) => delivery.orderNo === order.orderNo);
    for (const delivery of deliveries) await this.persistEmailDelivery(tx, store, delivery);
  }

  private async persistEmailDelivery(tx: PrismaTx, store: MemoryStore, delivery: EmailDelivery) {
    const order = store.orders.get(delivery.orderNo);
    if (!order) return;
    const issuedCodeCount = store.rightsCodes.filter((code) => code.orderNo === delivery.orderNo && code.status === "issued").length;
    const status = order.refundStatus === "refunded" ? "skipped_refunded" : delivery.status;
    await tx.$executeRaw`
      INSERT INTO email_delivery_records (
        id, delivery_no, order_id, order_item_id, email, scope, status, code_count,
        extract_token_hash, error_code, error_message, retry_count, actor_type, actor_id,
        source, idempotency_key, sent_at, created_at, updated_at
      )
      VALUES (
        ${stableDbId("email_delivery", delivery.id)}, ${delivery.id},
        (SELECT id FROM orders WHERE order_no = ${delivery.orderNo}), ${stableDbId("order_item", delivery.orderNo)},
        ${delivery.email}, CAST(${order.extractionCodeHash ? "extract_link" : "codes"} AS "EmailDeliveryScope"),
        CAST(${status} AS "EmailDeliveryStatus"), ${issuedCodeCount || delivery.codeCount},
        ${order.extractionCodeHash ? hashSecret(`extract-email:${order.orderNo}:${order.extractionCodeHash}`) : null},
        ${delivery.reason ?? null}, ${delivery.reason ?? null}, 0, CAST('system' AS "ActorType"), 'system',
        'auto_fulfillment', ${`email-delivery:${delivery.id}`},
        ${delivery.status === "sent" ? delivery.createdAt : null}, ${delivery.createdAt}, now()
      )
      ON CONFLICT (idempotency_key) DO UPDATE SET
        status = EXCLUDED.status,
        code_count = EXCLUDED.code_count,
        error_code = EXCLUDED.error_code,
        error_message = EXCLUDED.error_message,
        sent_at = COALESCE(email_delivery_records.sent_at, EXCLUDED.sent_at),
        updated_at = now()
    `;
  }

  private async persistAfterSale(tx: PrismaTx, afterSale: DemoAfterSale) {
    await tx.$executeRaw`
      INSERT INTO after_sales (
        id, after_sale_no, order_id, user_id, agent_id, merchant_id, shop_id,
        status, reason_code, responsibility, requested_refund_cents,
        approved_refund_cents, platform_bear_cents, agent_bear_cents,
        service_fee_refund_cents, service_fee_bearer, evidence_json,
        created_at, updated_at
      )
      VALUES (
        ${stableDbId("after_sale", afterSale.afterSaleNo)}, ${afterSale.afterSaleNo},
        (SELECT id FROM orders WHERE order_no = ${afterSale.orderNo}), ${afterSale.userId},
        ${afterSale.agentId === PLATFORM_AGENT_ID ? null : afterSale.agentId}, NULL, ${afterSale.shopId},
        CAST(${mapAfterSaleStatus(afterSale.status)} AS "AfterSaleStatus"), ${afterSale.reasonCode},
        CAST(${afterSale.allocation ? "mixed" : "undecided"} AS "Responsibility"),
        ${afterSale.requestedRefundCents}, ${afterSale.allocation?.refundAmountCents ?? 0n},
        ${afterSale.allocation?.platformBearCents ?? 0n}, ${afterSale.allocation?.agentBearCents ?? 0n},
        ${afterSale.allocation?.serviceFeeRefundCents ?? 0n},
        CAST(${afterSale.allocation?.serviceFeeBearer ?? "none"} AS "ServiceFeeBearer"),
        ${jsonForDb({ description: afterSale.description, allocation: afterSale.allocation })}::jsonb,
        now(), now()
      )
      ON CONFLICT (after_sale_no) DO UPDATE SET
        status = EXCLUDED.status,
        responsibility = EXCLUDED.responsibility,
        approved_refund_cents = EXCLUDED.approved_refund_cents,
        platform_bear_cents = EXCLUDED.platform_bear_cents,
        agent_bear_cents = EXCLUDED.agent_bear_cents,
        service_fee_refund_cents = EXCLUDED.service_fee_refund_cents,
        service_fee_bearer = EXCLUDED.service_fee_bearer,
        evidence_json = EXCLUDED.evidence_json,
        updated_at = now()
    `;
  }

  private async persistSettlements(tx: PrismaTx, store: MemoryStore) {
    for (const sheet of store.settlementSheets) {
      await this.persistSettlementSheet(tx, sheet);
    }

    for (const payout of store.manualPayouts) {
      await this.persistManualPayout(tx, payout);
    }
  }

  private async persistSettlementSheet(tx: PrismaTx, sheet: SettlementSheet) {
    await tx.$executeRaw`
      INSERT INTO settlement_sheets (
        id, settlement_no, agent_id, period_start, period_end, status,
        total_order_count, total_paid_cents, total_service_fee_cents,
        total_agent_income_cents, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${stableDbId("settlement", sheet.settlementNo)}, ${sheet.settlementNo}, ${sheet.agentId},
        ${new Date(0)}, ${new Date()}, CAST(${mapSettlementSheetStatus(sheet.status)} AS "SettlementSheetStatus"),
        ${sheet.totalOrderCount}, ${sheet.totalPaidCents}, ${sheet.totalServiceFeeCents},
        ${sheet.totalAgentIncomeCents}, ${sheet.idempotencyKey}, now(), now()
      )
      ON CONFLICT (settlement_no) DO UPDATE SET
        status = EXCLUDED.status,
        total_order_count = EXCLUDED.total_order_count,
        total_paid_cents = EXCLUDED.total_paid_cents,
        total_service_fee_cents = EXCLUDED.total_service_fee_cents,
        total_agent_income_cents = EXCLUDED.total_agent_income_cents,
        updated_at = now()
    `;
    for (const item of sheet.items) {
      await tx.$executeRaw`
        INSERT INTO settlement_items (
          id, settlement_id, order_id, settlement_role, agent_id, shop_id,
          paid_amount_cents, supply_amount_cents, service_fee_cents,
          agent_income_cents, deducted_cents, settle_amount_cents,
          fulfilled_at, settleable_at, created_at
        )
        VALUES (
          ${stableDbId("settlement_item", `${sheet.settlementNo}:${item.orderId}:${item.settlementRole ?? "single_agent"}`)},
          (SELECT id FROM settlement_sheets WHERE settlement_no = ${sheet.settlementNo}),
          (SELECT id FROM orders WHERE order_no = ${item.orderId}),
          CAST(${item.settlementRole ?? "single_agent"} AS "SettlementRole"), ${item.agentId}, ${item.shopId},
          ${item.paidAmountCents}, ${item.supplyAmountCents}, ${item.serviceFeeCents},
          ${item.agentIncomeCents}, ${item.deductedCents ?? 0n}, ${item.settleAmountCents},
          ${item.fulfilledAt}, ${item.settleableAt}, now()
        )
        ON CONFLICT (order_id, settlement_role) DO UPDATE SET
          settlement_id = EXCLUDED.settlement_id,
          agent_income_cents = EXCLUDED.agent_income_cents,
          settle_amount_cents = EXCLUDED.settle_amount_cents
      `;
    }
  }

  private async persistManualPayout(tx: PrismaTx, payout: Record<string, unknown>) {
    const settlementNo = requiredStringValue(payout.settlementNo, "settlementNo");
    const payoutNo = stringValue(payout.payoutNo) ?? stableDbId("payout_no", JSON.stringify(payout));
    await tx.$executeRaw`
      INSERT INTO manual_payouts (
        id, settlement_id, agent_id, amount_cents, payee_info_snapshot_json,
        payout_method, payout_voucher_url, status, idempotency_key,
        paid_at, created_at, updated_at
      )
      VALUES (
        ${stableDbId("payout", payoutNo)}, (SELECT id FROM settlement_sheets WHERE settlement_no = ${settlementNo}),
        ${requiredStringValue(payout.agentId, "agentId")}, ${bigintValue(payout.amountCents)},
        ${jsonForDb(payout)}::jsonb, ${stringValue(payout.payoutMethod) ?? "manual"},
        ${stringValue(payout.voucherUrl) ?? null}, CAST(${mapManualPayoutStatus(stringValue(payout.status) ?? "pending")} AS "ManualPayoutStatus"),
        ${`payout:${payoutNo}`}, ${stringValue(payout.status) === "paid" ? new Date() : null}, now(), now()
      )
      ON CONFLICT (idempotency_key) DO UPDATE SET
        status = EXCLUDED.status,
        payout_voucher_url = EXCLUDED.payout_voucher_url,
        paid_at = EXCLUDED.paid_at,
        updated_at = now()
    `;
  }

  private async persistOrderSettlementState(tx: PrismaTx, order: DemoOrder) {
    await tx.$executeRaw`
      UPDATE orders
         SET settlement_status = CAST(${mapSettlementStatus(order.settlementStatus)} AS "SettlementStatus"),
             updated_at = now()
       WHERE order_no = ${order.orderNo}
    `;
  }

  private async persistRiskAuditLedger(tx: PrismaTx, store: MemoryStore) {
    for (const freeze of store.riskFreezes) {
      await tx.$executeRaw`
        INSERT INTO risk_freezes (
          id, target_type, target_id, agent_id, freeze_type, status,
          reason_code, reason_text, active_unique_key, released_at,
          created_at, updated_at
        )
        VALUES (
          ${freeze.id}, ${freeze.targetType}, ${freeze.targetId}, ${stringValue(freeze.agentId) ?? null},
          ${freeze.freezeType}, CAST(${freeze.status === "active" ? "active" : "released"} AS "RiskFreezeStatus"),
          ${stringValue(freeze.reasonCode) ?? "risk"}, ${stringValue(freeze.reasonText) ?? stringValue(freeze.reasonCode) ?? "risk"},
          ${stringValue(freeze.activeUniqueKey) ?? null}, ${freeze.releasedAt}, now(), now()
        )
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          released_at = EXCLUDED.released_at,
          updated_at = now()
      `;
    }

    await this.persistAuditLogs(tx, store.auditLogs);

    await this.persistLedgerEntries(tx, store.ledgerEntries);
  }

  private async persistLedgerEntries(tx: PrismaTx, ledgerEntries: LedgerEntry[]) {
    for (const ledger of ledgerEntries) {
      await tx.$executeRaw`
        INSERT INTO ledger_entries (
          id, ledger_no, agent_id, merchant_id, shop_id, subject_type, subject_id,
          account_type, entry_type, direction, amount_cents, currency, source_type,
          source_id, idempotency_key, created_at
        )
        VALUES (
          ${stableDbId("ledger", ledger.ledgerNo)}, ${ledger.ledgerNo}, ${ledger.agentId ?? null}, NULL, NULL,
          CAST(${ledger.agentId ? "agent" : "platform"} AS "LedgerSubjectType"),
          ${ledger.agentId ?? "platform"},
          CAST(${ledger.agentId ? "agent_pending_income" : "platform_service_fee_income"} AS "LedgerAccountType"),
          CAST(${mapLedgerEntryType(ledger.entryType)} AS "LedgerEntryType"),
          CAST(${ledger.amountCents < 0n ? "debit" : "credit"} AS "LedgerDirection"),
          ${ledger.amountCents < 0n ? -ledger.amountCents : ledger.amountCents}, 'CNY',
          ${ledger.orderNo ? "order" : "system"}, ${ledger.orderNo ?? ledger.ledgerNo},
          ${`ledger:${ledger.ledgerNo}`}, ${ledger.createdAt}
        )
        ON CONFLICT (ledger_no) DO NOTHING
      `;
    }
  }

  private async persistAuditLogs(tx: PrismaTx, auditLogs: Array<Record<string, unknown>>) {
    for (const audit of auditLogs) {
      const idempotencyKey = stringValue(audit.idempotencyKey) ?? `audit:${stringValue(audit.action) ?? "unknown"}:${stringValue(audit.targetId) ?? hashSecret(JSON.stringify(audit))}`;
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id,
          before_json, after_json, reason, idempotency_key, request_id, ip, created_at
        )
        VALUES (
          ${stableDbId("audit", idempotencyKey)},
          CAST(${mapActorType(stringValue(audit.actorType) ?? stringValue(audit.actor) ?? "system")} AS "ActorType"),
          ${stringValue(audit.actorId) ?? "system"}, ${stringValue(audit.action) ?? "unknown"},
          ${stringValue(audit.targetType) ?? "unknown"}, ${stringValue(audit.targetId) ?? "unknown"},
          ${jsonForDb(audit.beforeJson ?? {})}::jsonb, ${jsonForDb(audit.afterJson ?? audit)}::jsonb,
          ${stringValue(audit.reason) ?? null}, ${idempotencyKey}, ${stringValue(audit.requestId) ?? idempotencyKey},
          ${stringValue(audit.ip) ?? null}, ${dateValue(audit.createdAt) ?? new Date()}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
    }
  }

  private async persistNotificationsAndPaymentConfig(tx: PrismaTx, store: MemoryStore) {
    for (const notification of store.notifications) {
      await tx.$executeRaw`
        INSERT INTO agent_notifications (id, agent_id, type, title, content, read_at, created_at)
        VALUES (${notification.id}, ${notification.agentId}, ${notification.type}, ${notification.title},
                ${notification.content}, ${notification.readAt}, ${notification.createdAt})
        ON CONFLICT (id) DO UPDATE SET read_at = EXCLUDED.read_at
      `;
    }

    for (const config of store.paymentChannelConfigs) {
      await tx.$executeRaw`
        INSERT INTO payment_channel_configs (
          id, channel, enabled, fee_bps, fixed_fee_cents, status_note,
          created_at, updated_at
        )
        VALUES (
          ${stableDbId("payment_config", config.channel)}, CAST(${config.channel} AS "PaymentChannel"),
          ${config.enabled}, ${config.feeBps}, ${config.fixedFeeCents}, ${config.statusNote},
          now(), ${config.updatedAt}
        )
        ON CONFLICT (channel) DO UPDATE SET
          enabled = EXCLUDED.enabled,
          fee_bps = EXCLUDED.fee_bps,
          fixed_fee_cents = EXCLUDED.fixed_fee_cents,
          status_note = EXCLUDED.status_note,
          updated_at = now()
      `;
    }
  }

  async persistCreatedOrder(order: DemoOrder): Promise<void> {
    const orderId = dbId("order");
    const orderItemId = dbId("order_item");
    const amountSnapshotId = dbId("order_amount_snapshot");
    const ledgerId = dbId("ledger");
    const auditId = dbId("audit");
    const amount = order.snapshot.amountSnapshot;
    const channel = getChannelSnapshot(order.snapshot);
    const agentId = order.salesChannelType === "platform_self_operated" || order.agentId === PLATFORM_AGENT_ID ? null : order.agentId;
    const platformShopProductId = order.salesChannelType === "platform_self_operated" ? order.agentProductId : null;
    const agentProductId = platformShopProductId ? null : order.agentProductId;
    const saleSourceType = platformShopProductId ? "platform_shop_product" : "agent_product";
    const finalPaidAmountCents = payableAmount(order);
    const productIdSnapshot = getSnapshotProductId(order.snapshot) ?? order.agentProductId;
    const grossMarginCents = getPlatformSelfGrossMargin(order.snapshot);
    const auditKey = `audit:order.create:${order.orderNo}`;
    const ledgerKey = `ledger:order.create:${order.orderNo}`;

    await this.repositories.tx.createOrder(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO users (id, status, created_at, updated_at)
        VALUES (${order.userId}, 'active', now(), now())
        ON CONFLICT (id) DO NOTHING
      `;
      await tx.$executeRaw`
        INSERT INTO orders (
          id, order_no, user_id, agent_id, merchant_id, shop_id, buyer_email,
          sales_channel_type, first_tier_agent_id, second_tier_agent_id, third_tier_agent_id,
          channel_relation_id, collection_channel_id, collection_snapshot_json,
          coupon_discount_cents, status, payment_status, fulfillment_status, refund_status,
          settlement_status, risk_status, paid_amount_cents, paid_at, fulfilled_at,
          created_at, updated_at
        )
        VALUES (
          ${orderId}, ${order.orderNo}, ${order.userId}, ${agentId}, NULL, ${order.shopId}, ${order.buyerEmail ?? null},
          ${order.salesChannelType}, ${channel?.firstTierAgentId ?? null}, ${channel?.secondTierAgentId ?? null}, ${channel?.thirdTierAgentId ?? null},
          ${channel?.relationId ?? null}, ${order.collectionChannelId ?? null}, ${jsonForDb(order.collectionChannelSnapshot)}::jsonb,
          ${order.couponDiscountCents ?? 0n}, ${mapOrderStatus(order.status)}, ${mapPaymentStatus(order.paymentStatus)}, ${mapFulfillmentStatus(order.fulfillmentStatus)}, ${mapRefundStatus(order.refundStatus)},
          ${mapSettlementStatus(order.settlementStatus)}, ${mapRiskStatus(order.riskStatus)}, ${finalPaidAmountCents}, ${order.paidAt}, ${order.fulfilledAt},
          now(), now()
        )
      `;
      await tx.$executeRaw`
        INSERT INTO order_items (
          id, order_id, agent_product_id, merchant_product_id, platform_shop_product_id,
          sale_source_type, product_type, product_id_snapshot, product_name_snapshot,
          sale_price_cents, quantity, supply_price_cents, service_fee_cents, agent_income_cents, created_at
        )
        VALUES (
          ${orderItemId}, ${orderId}, ${agentProductId}, NULL, ${platformShopProductId},
          ${saleSourceType}, ${order.snapshot.productType}, ${productIdSnapshot}, ${order.snapshot.productNameSnapshot},
          ${amount.paidAmountCents}, ${order.snapshot.quantity}, ${amount.supplyAmountCents},
          ${amount.serviceFeeCents}, ${amount.agentExpectedIncomeCents}, now()
        )
      `;
      await tx.$executeRaw`
        INSERT INTO order_amount_snapshots (
          id, order_id, service_fee_bps, paid_amount_cents, supply_amount_cents,
          service_fee_cents, agent_expected_income_cents, platform_supply_price_cents,
          resell_supply_price_cents, first_tier_supply_price_cents, second_tier_supply_price_cents,
          final_sale_price_cents, first_tier_income_cents, second_tier_income_cents,
          third_tier_income_cents, fulfillment_cost_cents, payment_channel_fee_cents,
          platform_gross_profit_cents, product_snapshot_json, shop_snapshot_json,
          pricing_snapshot_json, fulfillment_rule_snapshot_json, after_sale_rule_snapshot_json,
          created_at
        )
        VALUES (
          ${amountSnapshotId}, ${orderId}, ${Number(amount.serviceFeeBps)}, ${amount.paidAmountCents}, ${amount.supplyAmountCents},
          ${amount.serviceFeeCents}, ${amount.agentExpectedIncomeCents}, ${channel?.platformSupplyPriceCents ?? amount.supplyAmountCents},
          ${channel?.resellSupplyPriceCents ?? 0n}, ${channel?.firstTierSupplyPriceCents ?? 0n}, ${channel?.secondTierSupplyPriceCents ?? 0n},
          ${channel?.finalSalePriceCents ?? amount.paidAmountCents}, ${channel?.firstTierIncomeCents ?? 0n}, ${channel?.secondTierIncomeCents ?? 0n},
          ${channel?.thirdTierIncomeCents ?? 0n}, ${grossMarginCents > 0n ? amount.supplyAmountCents : 0n}, 0,
          ${grossMarginCents}, ${jsonForDb(order.snapshot.productSnapshot)}::jsonb, ${jsonForDb(order.snapshot.shopSnapshot)}::jsonb,
          ${jsonForDb(order.snapshot.pricingSnapshot)}::jsonb, ${jsonForDb(order.snapshot.fulfillmentRuleSnapshot)}::jsonb, ${jsonForDb(order.snapshot.afterSaleRuleSnapshot)}::jsonb,
          now()
        )
      `;
      await tx.$executeRaw`
        INSERT INTO ledger_entries (
          id, ledger_no, agent_id, merchant_id, shop_id, subject_type, subject_id,
          account_type, entry_type, direction, amount_cents, currency, source_type, source_id,
          order_id, idempotency_key, created_at
        )
        VALUES (
          ${ledgerId}, ${`ledger-${order.orderNo}`}, ${agentId}, NULL, ${order.shopId},
          ${agentId ? "agent" : "platform"}, ${agentId ?? "platform"},
          ${agentId ? "agent_pending_income" : "platform_self_operated_revenue"},
          ${agentId ? "ORDER_AGENT_INCOME_PENDING" : "ORDER_PLATFORM_SELF_REVENUE"},
          'credit', ${agentId ? amount.agentExpectedIncomeCents : finalPaidAmountCents}, 'CNY', 'order', ${order.orderNo},
          ${orderId}, ${ledgerKey}, now()
        )
      `;
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id, after_json,
          idempotency_key, request_id, created_at
        )
        VALUES (
          ${auditId}, 'system', 'api', 'order.create', 'order', ${order.orderNo},
          ${jsonForDb({ orderNo: order.orderNo, userId: order.userId, shopId: order.shopId, agentId: order.agentId })}::jsonb,
          ${auditKey}, ${auditKey}, now()
        )
      `;
    });
  }

  private async loadAgentsAndDeposits(store: MemoryStore) {
    const agents = await this.prisma.$queryRaw<Array<{
      id: string;
      user_id: string;
      name: string;
      contact_phone: string | null;
      status: string;
      risk_status: string;
      deposit_status: string;
    }>>`
      SELECT id, user_id, name, contact_phone, status, risk_status, deposit_status
        FROM agents
    `;
    for (const row of agents) {
      store.agents.set(row.id, {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        contactPhone: row.contact_phone ?? undefined,
        status: row.status,
        riskStatus: row.risk_status,
        depositStatus: row.deposit_status
      });
    }

    const deposits = await this.prisma.$queryRaw<Array<{
      agent_id: string;
      required_amount_cents: bigint;
      available_amount_cents: bigint;
      frozen_amount_cents: bigint;
      deducted_amount_cents: bigint;
      status: string;
    }>>`
      SELECT agent_id, required_amount_cents, available_amount_cents, frozen_amount_cents,
             deducted_amount_cents, status
        FROM deposit_accounts
       WHERE agent_id IS NOT NULL
    `;
    for (const row of deposits) {
      store.depositAccounts.set(row.agent_id, {
        agentId: row.agent_id,
        requiredAmountCents: row.required_amount_cents,
        availableAmountCents: row.available_amount_cents,
        frozenAmountCents: row.frozen_amount_cents,
        deductedAmountCents: row.deducted_amount_cents,
        status: mapDepositStatus(row.status)
      });
    }
  }

  private async loadShops(store: MemoryStore) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      owner_type: "platform" | "agent";
      agent_id: string | null;
      merchant_id: string | null;
      name: string;
      status: string;
      risk_status: string;
      announcement: string | null;
      customer_service_wechat: string | null;
      customer_service_qr_url: string | null;
      customer_service_qq: string | null;
      customer_service_qq_qr_url: string | null;
      customer_service_note: string | null;
      collection_account_name: string | null;
      collection_qr_url: string | null;
      collection_note: string | null;
      theme_color: string | null;
      banner_url: string | null;
      share_title: string | null;
    }>>`
      SELECT s.id, s.owner_type, s.agent_id, s.merchant_id, s.name, s.status, s.risk_status, s.announcement,
             COALESCE(s.customer_service_wechat, cs.wechat_id) AS customer_service_wechat,
             COALESCE(s.customer_service_qr_url, cs.qr_code_url) AS customer_service_qr_url,
             s.customer_service_qq, s.customer_service_qq_qr_url, s.customer_service_note,
             collection_account_name, collection_qr_url, collection_note,
             theme_color, banner_url, share_title
        FROM shops s
        LEFT JOIN LATERAL (
          SELECT wechat_id, qr_code_url
            FROM shop_customer_service_bindings
           WHERE shop_id = s.id AND status = 'active' AND review_status = 'approved'
           ORDER BY updated_at DESC
           LIMIT 1
        ) cs ON TRUE
    `;
    for (const row of rows) {
      store.shops.set(row.id, {
        id: row.id,
        ownerType: row.owner_type,
        agentId: row.agent_id ?? row.merchant_id ?? undefined,
        name: row.name,
        status: row.status,
        riskStatus: row.risk_status,
        announcement: row.announcement ?? undefined,
        customerServiceWechat: row.customer_service_wechat ?? undefined,
        customerServiceQrUrl: row.customer_service_qr_url ?? undefined,
        customerServiceQq: row.customer_service_qq ?? undefined,
        customerServiceQqQrUrl: row.customer_service_qq_qr_url ?? undefined,
        customerServiceNote: row.customer_service_note ?? undefined,
        collectionAccountName: row.collection_account_name ?? undefined,
        collectionQrUrl: row.collection_qr_url ?? undefined,
        collectionNote: row.collection_note ?? undefined,
        themeColor: row.theme_color ?? undefined,
        bannerUrl: row.banner_url ?? undefined,
        shareTitle: row.share_title ?? undefined
      });
    }
  }

  private async loadPlatformProducts(store: MemoryStore) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      name: string;
      category_name: string | null;
      tags_json: unknown;
      image_url: string | null;
      specs_json: unknown;
      detail_sections_json: unknown;
      stock_count: number;
      sold_count: number;
      display_badge: string | null;
      is_recommended: boolean;
      display_sort: number;
      detail: string;
      rights_desc: string;
      supply_price_cents: bigint;
      min_sale_price_cents: bigint;
      suggested_sale_price_cents: bigint;
      fulfillment_rule_json: unknown;
      after_sale_rule_json: unknown;
      status: string;
    }>>`
      SELECT id, name, category_name, tags_json, image_url, specs_json, detail_sections_json,
             stock_count, sold_count, display_badge, is_recommended, display_sort,
             detail, rights_desc, supply_price_cents,
             min_sale_price_cents, suggested_sale_price_cents, fulfillment_rule_json,
             after_sale_rule_json, status
        FROM platform_products
    `;
    for (const row of rows) {
      store.platformProducts.set(row.id, {
        id: row.id,
        name: row.name,
        category: row.category_name ?? undefined,
        tags: Array.isArray(row.tags_json) ? row.tags_json as string[] : undefined,
        imageUrl: row.image_url ?? undefined,
        specs: Array.isArray(row.specs_json) ? row.specs_json as string[] : undefined,
        detailSections: Array.isArray(row.detail_sections_json) ? row.detail_sections_json as ProductDetailSection[] : undefined,
        stockCount: row.stock_count,
        soldCount: row.sold_count,
        displayBadge: row.display_badge ?? undefined,
        isRecommended: row.is_recommended,
        displaySort: row.display_sort,
        description: row.detail,
        subtitle: row.rights_desc,
        supplyPriceCents: row.supply_price_cents,
        minSalePriceCents: row.min_sale_price_cents,
        suggestedSalePriceCents: row.suggested_sale_price_cents,
        fulfillmentRule: row.fulfillment_rule_json,
        afterSaleRule: row.after_sale_rule_json,
        status: row.status
      });
    }
  }

  private async loadOwnProductReviews(store: MemoryStore) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      agent_id: string;
      shop_id: string;
      name: string;
      detail_json: unknown;
      sale_price_cents: bigint;
      after_sale_rule_json: unknown;
      fulfillment_rule_json: unknown;
      status: string;
      created_at: Date;
      updated_at: Date;
    }>>`
      SELECT id, agent_id, shop_id, name, detail_json, sale_price_cents,
             after_sale_rule_json, fulfillment_rule_json, status, created_at, updated_at
        FROM agent_product_reviews
    `;
    for (const row of rows) {
      const detail = decodeStoreValue(row.detail_json);
      store.ownProducts.set(row.id, {
        id: row.id,
        agentId: row.agent_id,
        shopId: row.shop_id,
        name: row.name,
        category: isRecord(detail) ? stringValue(detail.category) : undefined,
        tags: isRecord(detail) && Array.isArray(detail.tags) ? detail.tags as string[] : undefined,
        subtitle: isRecord(detail) ? stringValue(detail.subtitle) : undefined,
        description: isRecord(detail) ? stringValue(detail.description) : undefined,
        usageGuide: isRecord(detail) ? stringValue(detail.usageGuide) : undefined,
        imageUrl: isRecord(detail) ? stringValue(detail.imageUrl) : undefined,
        specs: isRecord(detail) && Array.isArray(detail.specs) ? detail.specs as string[] : undefined,
        detailSections: isRecord(detail) && Array.isArray(detail.detailSections) ? detail.detailSections as ProductDetailSection[] : undefined,
        stockCount: isRecord(detail) && typeof detail.stockCount === "number" ? detail.stockCount : undefined,
        soldCount: isRecord(detail) && typeof detail.soldCount === "number" ? detail.soldCount : undefined,
        salePriceCents: row.sale_price_cents,
        minSalePriceCents: isRecord(detail) ? bigintValue(detail.minSalePriceCents) || undefined : undefined,
        fulfillmentRule: decodeStoreValue(row.fulfillment_rule_json),
        afterSaleRule: decodeStoreValue(row.after_sale_rule_json),
        reviewStatus: row.status,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    }
  }

  private async loadAgentProducts(store: MemoryStore) {
    const agentRows = await this.prisma.$queryRaw<Array<{
      id: string;
      agent_id: string;
      shop_id: string;
      product_type: "platform" | "agent_owned";
      platform_product_id: string | null;
      own_product_review_id: string | null;
      sale_price_cents: bigint;
      status: string;
    }>>`
      SELECT id, agent_id, shop_id, product_type, platform_product_id, own_product_review_id,
             sale_price_cents, status
        FROM agent_products
    `;
    for (const row of agentRows) {
      store.agentProducts.set(row.id, {
        id: row.id,
        agentId: row.agent_id,
        shopId: row.shop_id,
        productType: row.product_type,
        platformProductId: row.platform_product_id,
        ownProductReviewId: row.own_product_review_id,
        salePriceCents: row.sale_price_cents,
        status: row.status
      });
    }

    const platformRows = await this.prisma.$queryRaw<Array<{
      id: string;
      shop_id: string;
      platform_product_id: string;
      sale_price_cents: bigint;
      fulfillment_cost_cents: bigint;
      status: string;
    }>>`
      SELECT id, shop_id, platform_product_id, sale_price_cents, fulfillment_cost_cents, status
        FROM platform_shop_products
    `;
    for (const row of platformRows) {
      store.platformShopProducts.set(row.id, {
        id: row.id,
        shopId: row.shop_id,
        platformProductId: row.platform_product_id,
        salePriceCents: row.sale_price_cents,
        fulfillmentCostCents: row.fulfillment_cost_cents,
        status: row.status
      });
    }
  }

  private async loadCollectionChannels(store: MemoryStore) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      shop_id: string;
      channel_type: CollectionChannelType;
      account_name: string;
      qr_url: string | null;
      note: string | null;
      status: string;
      review_status: string;
      is_default: boolean;
      reviewed_by: string | null;
      reviewed_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>>`
      SELECT id, shop_id, channel_type, account_name, qr_url, note, status, review_status,
             is_default, reviewed_by, reviewed_at, created_at, updated_at
        FROM shop_collection_channels
    `;
    for (const row of rows) {
      store.collectionChannels.set(row.id, {
        id: row.id,
        shopId: row.shop_id,
        ownerType: "agent",
        channelType: row.channel_type,
        displayName: row.account_name,
        accountName: row.account_name,
        qrUrl: row.qr_url ?? undefined,
        status: row.status as CollectionChannel["status"],
        reviewStatus: row.review_status as CollectionChannel["reviewStatus"],
        isDefault: row.is_default,
        sortOrder: 0,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    }
  }

  private async loadPaymentConfig(store: MemoryStore) {
    const rows = await this.prisma.$queryRaw<Array<PaymentChannelConfig>>`
      SELECT channel, enabled, fee_bps AS "feeBps", fixed_fee_cents AS "fixedFeeCents",
             status_note AS "statusNote", updated_at AS "updatedAt"
        FROM payment_channel_configs
    `;
    if (rows.length) store.paymentChannelConfigs = rows;
  }

  private async loadPaymentMethodConfigs(store: MemoryStore) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      owner_type: string;
      owner_agent_id: string | null;
      shop_id: string | null;
      provider: string;
      confirm_mode: string;
      status: string;
      is_default: boolean;
      display_name: string;
      merchant_no_masked: string | null;
      app_id_masked: string | null;
      service_provider_masked: string | null;
      credential_ref: string | null;
      credential_ciphertext: string | null;
      credential_status: string;
      return_url: string | null;
      test_status: string | null;
      last_test_at: Date | null;
      last_test_result_json: unknown;
      last_callback_at: Date | null;
      qr_url: string | null;
      account_masked: string | null;
      instruction: string | null;
      updated_by_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>>`
      SELECT id, owner_type, owner_agent_id, shop_id, provider, confirm_mode, status,
             is_default, display_name, merchant_no_masked, app_id_masked, service_provider_masked,
             credential_ref, credential_ciphertext, credential_status, return_url, test_status,
             last_test_at, last_test_result_json, last_callback_at, qr_url, account_masked,
             instruction, updated_by_id, created_at, updated_at
        FROM collection_payment_configs
    `;
    for (const row of rows) {
      const provider = mapPaymentProviderFromDb(row.provider);
      const status = mapCollectionPaymentConfigStatusFromDb(row.status);
      store.paymentMethods.set(row.id, {
        id: row.id,
        ownerType: row.owner_type === "agent" ? "agent" : "platform",
        agentId: row.owner_agent_id ?? undefined,
        shopId: row.shop_id ?? undefined,
        provider,
        confirmationMode: mapPaymentConfirmModeFromDb(row.confirm_mode),
        displayName: row.display_name,
        merchantNo: row.merchant_no_masked ?? undefined,
        appId: row.app_id_masked ?? undefined,
        serviceProviderId: row.service_provider_masked ?? undefined,
        accountName: row.account_masked ?? undefined,
        qrUrl: row.qr_url ?? undefined,
        paymentUrl: row.qr_url ?? undefined,
        note: row.instruction ?? undefined,
        returnUrl: row.return_url ?? undefined,
        enabled: row.status === "active",
        status,
        isDefault: row.is_default,
        signingSecretEncrypted: row.credential_ciphertext ?? undefined,
        signingSecretPreview: row.credential_ref ?? undefined,
        secretConfigured: row.credential_status === "configured",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by_id ?? undefined,
        lastTestAt: row.last_test_at ?? undefined,
        lastTestResult: row.test_status === "passed" || row.test_status === "failed" ? row.test_status : undefined,
        lastCallbackAt: row.last_callback_at ?? undefined
      });
    }
  }

  private async loadPaymentRuntimeState(store: MemoryStore) {
    const snapshots = await this.prisma.$queryRaw<Array<{
      order_no: string;
      payment_no: string;
      collection_config_id: string | null;
      provider: string;
      confirm_mode: string;
      merchant_no_masked: string | null;
      app_id_masked: string | null;
      service_provider_masked: string | null;
      payable_amount_cents: bigint;
      currency: string;
      provider_payment_no: string | null;
      provider_trade_no: string | null;
      status: string;
      confirm_source: string;
      expires_at: Date | null;
      paid_at: Date | null;
      callback_handled_at: Date | null;
      created_at: Date;
    }>>`
      SELECT o.order_no, ps.payment_no, ps.collection_config_id, ps.provider, ps.confirm_mode,
             ps.merchant_no_masked, ps.app_id_masked, ps.service_provider_masked,
             ps.payable_amount_cents, ps.currency, ps.provider_payment_no, ps.provider_trade_no,
             ps.status, ps.confirm_source, ps.expires_at, ps.paid_at, ps.callback_handled_at,
             ps.created_at
        FROM payment_snapshots ps
        JOIN orders o ON o.id = ps.order_id
    `;
    for (const row of snapshots) {
      const order = store.orders.get(row.order_no);
      if (!order) continue;
      order.paymentSnapshot = {
        paymentNo: row.payment_no,
        paymentMethodId: row.collection_config_id ?? undefined,
        provider: mapPaymentProviderFromDb(row.provider),
        confirmationMode: mapPaymentConfirmModeFromDb(row.confirm_mode),
        merchantNoMasked: row.merchant_no_masked ?? undefined,
        appIdMasked: row.app_id_masked ?? undefined,
        serviceProviderMasked: row.service_provider_masked ?? undefined,
        amountCents: row.payable_amount_cents,
        currency: row.currency,
        orderNo: row.order_no,
        providerPaymentNo: row.provider_payment_no ?? undefined,
        providerTradeNo: row.provider_trade_no ?? undefined,
        status: row.status,
        confirmationSource: mapPaymentConfirmSourceFromDb(row.confirm_source),
        expiresAt: row.expires_at ?? undefined,
        createdAt: row.created_at,
        paidAt: row.paid_at ?? undefined,
        callbackProcessedAt: row.callback_handled_at ?? undefined
      };
    }

    const callbackLogs = await this.prisma.$queryRaw<Array<{
      callback_no: string;
      provider: string;
      order_no: string | null;
      provider_trade_no: string | null;
      raw_payload_masked_json: unknown;
      notified_at: Date | null;
      created_at: Date;
      signature_valid: boolean | null;
      processed_status: string;
      error_message: string | null;
    }>>`
      SELECT callback_no, provider, order_no, provider_trade_no, raw_payload_masked_json,
             notified_at, created_at, signature_valid, processed_status, error_message
        FROM payment_callback_logs
    `;
    store.paymentCallbackLogs = callbackLogs.map((row) => ({
      id: row.callback_no,
      provider: mapPaymentProviderFromDb(row.provider),
      orderNo: row.order_no ?? undefined,
      providerTradeNo: row.provider_trade_no ?? "",
      amountCents: 0n,
      rawPayloadMasked: row.raw_payload_masked_json,
      receivedAt: row.notified_at ?? row.created_at,
      verified: row.signature_valid ?? false,
      status: mapCallbackProcessStatusFromDb(row.processed_status),
      exceptionId: row.error_message ?? undefined
    }));

    const exceptions = await this.prisma.$queryRaw<Array<{
      exception_no: string;
      order_no: string | null;
      provider: string | null;
      provider_trade_no: string | null;
      exception_type: string;
      status: string;
      reason: string | null;
      handled_by_id: string | null;
      handled_at: Date | null;
      created_at: Date;
    }>>`
      SELECT pe.exception_no, o.order_no, ps.provider, ps.provider_trade_no, pe.exception_type,
             pe.status, pe.reason, pe.handled_by_id, pe.handled_at, pe.created_at
        FROM payment_exceptions pe
        LEFT JOIN orders o ON o.id = pe.order_id
        LEFT JOIN payment_snapshots ps ON ps.id = pe.payment_snapshot_id
    `;
    store.paymentExceptions = exceptions.map((row) => ({
      id: row.exception_no,
      provider: mapPaymentProviderFromDb(row.provider ?? "alipay_merchant"),
      orderNo: row.order_no ?? undefined,
      providerTradeNo: row.provider_trade_no ?? undefined,
      reasonCode: mapPaymentExceptionReasonCodeFromDb(row.exception_type),
      reason: row.reason ?? row.exception_type,
      handled: row.status === "resolved" || row.status === "ignored",
      receivedAt: row.created_at,
      handledBy: row.handled_by_id ?? undefined,
      handledAt: row.handled_at ?? undefined
    }));

    const materials = await this.prisma.$queryRaw<Array<{
      material_no: string;
      order_no: string;
      user_id: string;
      shop_id: string;
      amount_cents: bigint;
      file_url: string | null;
      note: string | null;
      status: string;
      uploaded_by_id: string | null;
      created_at: Date;
      reviewed_at: Date | null;
      reviewed_by_id: string | null;
      review_note: string | null;
    }>>`
      SELECT pdm.material_no, o.order_no, o.user_id, o.shop_id, p.amount_cents,
             pdm.file_url, pdm.note, pdm.status, pdm.uploaded_by_id, pdm.created_at,
             pdm.reviewed_at, pdm.reviewed_by_id, pdm.review_note
        FROM payment_dispute_materials pdm
        JOIN orders o ON o.id = pdm.order_id
        LEFT JOIN payments p ON p.id = pdm.payment_id
    `;
    for (const row of materials) {
      store.paymentVouchers.set(row.material_no, {
        id: row.material_no,
        orderNo: row.order_no,
        userId: row.uploaded_by_id ?? row.user_id,
        shopId: row.shop_id,
        amountCents: row.amount_cents ?? 0n,
        channel: "alipay_wap",
        voucherUrl: row.file_url ?? undefined,
        note: row.note ?? undefined,
        status: row.status === "submitted" ? "pending_review" : "approved",
        reason: row.review_note ?? undefined,
        disputeMaterialOnly: true,
        createdAt: row.created_at,
        reviewedAt: row.reviewed_at,
        reviewedBy: row.reviewed_by_id
      });
    }
  }

  private async loadRightsCodes(store: MemoryStore) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      product_id: string | null;
      agent_product_id: string | null;
      code_ciphertext: string;
      batch_no: string;
      status: RightsCode["status"];
      order_id: string | null;
      issue_key: string | null;
      issued_at: Date | null;
      created_at: Date;
    }>>`
      SELECT id, product_id, agent_product_id, code_ciphertext, batch_no, status, order_id, issue_key, issued_at, created_at
        FROM rights_codes
    `;
    store.rightsCodes = rows.map((row) => ({
      codeId: row.id,
      productId: row.product_id ?? row.agent_product_id ?? row.id,
      platformProductId: row.product_id ?? undefined,
      agentProductId: row.agent_product_id ?? undefined,
      code: row.code_ciphertext,
      batchNo: row.batch_no,
      status: row.status,
      orderNo: row.order_id ?? undefined,
      issueKey: row.issue_key ?? undefined,
      issuedAt: row.issued_at ?? undefined,
      createdAt: row.created_at
    }));
  }

  private async loadOrders(store: MemoryStore) {
    const rows = await this.prisma.order.findMany({
      include: {
        amountSnapshot: true,
        items: true,
        collectionChannel: true
      }
    });
    for (const order of rows) {
      this.loadedOrderNos.add(order.orderNo);
      const item = order.items[0];
      const amount = order.amountSnapshot;
      if (!item || !amount) continue;
      const snapshot: DemoOrderSnapshot = {
        orderNo: order.orderNo,
        userId: order.userId,
        agentId: order.agentId ?? PLATFORM_AGENT_ID,
        shopId: order.shopId,
        agentProductId: item.agentProductId ?? item.platformShopProductId ?? item.productIdSnapshot,
        salesChannelType: order.salesChannelType as SalesChannelType,
        productType: "platform",
        productNameSnapshot: item.productNameSnapshot,
        quantity: item.quantity,
        quote: {
          paidAmountCents: amount.paidAmountCents,
          salePriceCents: item.salePriceCents,
          supplyAmountCents: amount.supplyAmountCents,
          serviceFeeCents: amount.serviceFeeCents,
          agentExpectedIncomeCents: amount.agentExpectedIncomeCents,
          serviceFeeBps: BigInt(amount.serviceFeeBps)
        },
        amountSnapshot: {
          serviceFeeBps: BigInt(amount.serviceFeeBps),
          paidAmountCents: amount.paidAmountCents,
          supplyAmountCents: amount.supplyAmountCents,
          serviceFeeCents: amount.serviceFeeCents,
          agentExpectedIncomeCents: amount.agentExpectedIncomeCents
        },
        productSnapshot: amount.productSnapshotJson,
        shopSnapshot: amount.shopSnapshotJson,
        pricingSnapshot: amount.pricingSnapshotJson,
        fulfillmentRuleSnapshot: amount.fulfillmentRuleSnapshotJson,
        afterSaleRuleSnapshot: amount.afterSaleRuleSnapshotJson
      } as DemoOrderSnapshot;
      store.orders.set(order.orderNo, {
        orderNo: order.orderNo,
        userId: order.userId,
        agentId: order.agentId ?? PLATFORM_AGENT_ID,
        shopId: order.shopId,
        agentProductId: item.agentProductId ?? item.platformShopProductId ?? item.productIdSnapshot,
        salesChannelType: order.salesChannelType as SalesChannelType,
        status: order.status,
        paymentStatus: order.paymentStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        refundStatus: order.refundStatus,
        settlementStatus: order.settlementStatus,
        riskStatus: order.riskStatus,
        complaintStatus: "none",
        fulfilledAt: order.fulfilledAt,
        paidAt: order.paidAt,
        buyerEmail: order.buyerEmail ?? undefined,
        couponDiscountCents: order.couponDiscountCents,
        buyerPaidAmountCents: order.paidAmountCents,
        collectionChannelId: order.collectionChannelId ?? undefined,
        collectionChannelSnapshot: order.collectionSnapshotJson as unknown as CollectionChannelPublicSnapshot | undefined,
        refundedAmountCents: 0n,
        snapshot
      });
    }
  }

  private async loadCoupons(store: MemoryStore) {
    const templates = await this.prisma.$queryRaw<Array<{
      id: string;
      name: string;
      discount_amount_cents: bigint;
      first_registration_only: boolean;
      status: string;
      valid_from: Date;
      valid_to: Date;
    }>>`
      SELECT id, name, discount_amount_cents, first_registration_only, status, valid_from, valid_to
        FROM coupon_templates
    `;
    const scopes = await this.prisma.$queryRaw<Array<{
      coupon_template_id: string;
      platform_product_id: string | null;
    }>>`
      SELECT coupon_template_id, platform_product_id
        FROM coupon_scopes
       WHERE platform_product_id IS NOT NULL
    `;
    for (const row of templates) {
      const validDays = Math.max(1, Math.ceil((row.valid_to.getTime() - row.valid_from.getTime()) / (24 * 60 * 60 * 1000)));
      store.couponTemplates.set(row.id, {
        id: row.id,
        name: row.name,
        discountCents: row.discount_amount_cents,
        productIds: scopes.filter((scope) => scope.coupon_template_id === row.id && scope.platform_product_id).map((scope) => scope.platform_product_id as string),
        validDays,
        grantOnFirstRegister: row.first_registration_only,
        status: row.status,
        createdAt: row.valid_from
      });
    }

    const userCoupons = await this.prisma.$queryRaw<Array<{
      id: string;
      coupon_template_id: string;
      user_id: string;
      status: string;
      source_type: string;
      source_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>>`
      SELECT id, coupon_template_id, user_id, status, source_type, source_id, created_at, updated_at
        FROM user_coupons
    `;
    for (const row of userCoupons) {
      store.userCoupons.set(row.id, {
        id: row.id,
        templateId: row.coupon_template_id,
        userId: row.user_id,
        status: row.status === "active" ? "available" : mapUserCouponMemoryStatus(row.status),
        grantReason: row.source_type,
        grantedAt: row.created_at,
        usedAt: row.status === "used" ? row.updated_at : null,
        orderNo: row.source_id
      });
    }
  }

  private async loadInviteAndChannelState(store: MemoryStore) {
    const invites = await this.prisma.$queryRaw<Array<{
      id: string;
      code_hash: string;
      tier: AgentTier;
      max_uses: number;
      used_count: number;
      deposit_required_amount_cents: bigint | null;
      status: string;
      expires_at: Date | null;
      created_at: Date;
    }>>`
      SELECT id, code_hash, tier, max_uses, used_count, deposit_required_amount_cents, status, expires_at, created_at
        FROM merchant_invite_codes
    `;
    for (const row of invites) {
      store.inviteCodes.set(row.id, {
        id: row.id,
        code: "",
        codeHash: row.code_hash,
        issuerType: "platform",
        targetTier: row.tier,
        status: row.status === "approved" ? "active" : "disabled",
        maxUses: row.max_uses,
        usedCount: row.used_count,
        depositRequiredAmountCents: row.deposit_required_amount_cents ?? undefined,
        expiresAt: row.expires_at,
        createdBy: "db",
        createdAt: row.created_at
      });
    }

    const authorizations = await this.prisma.$queryRaw<Array<{
      id: string;
      first_tier_agent_id: string;
      status: string;
      reason: string | null;
      reviewed_at: Date | null;
    }>>`
      SELECT id, first_tier_agent_id, status, reason, reviewed_at
        FROM channel_authorizations
    `;
    store.channelAuthorizations = authorizations.map((row) => ({
      id: row.id,
      firstTierAgentId: row.first_tier_agent_id,
      status: row.status,
      reason: row.reason,
      reviewedAt: row.reviewed_at
    }));

    const relations = await this.prisma.$queryRaw<Array<{
      id: string;
      first_tier_agent_id: string;
      second_tier_agent_id: string;
      third_tier_agent_id: string | null;
      status: string;
      reason: string | null;
      reviewed_at: Date | null;
      active_unique_key: string | null;
    }>>`
      SELECT id, first_tier_agent_id, second_tier_agent_id, third_tier_agent_id,
             status, reason, reviewed_at, active_unique_key
        FROM channel_relations
       WHERE first_tier_agent_id IS NOT NULL AND second_tier_agent_id IS NOT NULL
    `;
    store.channelRelations = relations.map((row) => ({
      id: row.id,
      firstTierAgentId: row.first_tier_agent_id,
      secondTierAgentId: row.second_tier_agent_id,
      thirdTierAgentId: row.third_tier_agent_id ?? undefined,
      status: row.status,
      reason: row.reason,
      reviewedAt: row.reviewed_at,
      activeUniqueKey: row.active_unique_key ?? undefined
    }));

    const offers = await this.prisma.$queryRaw<Array<{
      id: string;
      channel_relation_id: string;
      platform_product_id: string;
      resell_supply_price_cents: bigint;
      status: string;
    }>>`
      SELECT id, channel_relation_id, platform_product_id, resell_supply_price_cents, status
        FROM channel_product_offers
    `;
    store.channelProductOffers = offers.map((row) => ({
      id: row.id,
      channelRelationId: row.channel_relation_id,
      platformProductId: row.platform_product_id,
      resellSupplyPriceCents: row.resell_supply_price_cents,
      status: row.status
    }));
  }

  private async loadFinancialState(store: MemoryStore) {
    const settlements = await this.prisma.$queryRaw<Array<{
      settlement_no: string;
      agent_id: string;
      status: string;
      total_order_count: number;
      total_paid_cents: bigint;
      total_service_fee_cents: bigint;
      total_agent_income_cents: bigint;
      idempotency_key: string;
    }>>`
      SELECT settlement_no, agent_id, status, total_order_count, total_paid_cents,
             total_service_fee_cents, total_agent_income_cents, idempotency_key
        FROM settlement_sheets
    `;
    store.settlementSheets = settlements.map((row) => ({
      settlementNo: row.settlement_no,
      agentId: row.agent_id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      items: [],
      totalOrderCount: row.total_order_count,
      totalPaidCents: row.total_paid_cents,
      totalServiceFeeCents: row.total_service_fee_cents,
      totalAgentIncomeCents: row.total_agent_income_cents
    }));

    const paymentVouchers = await this.prisma.$queryRaw<Array<{
      confirmation_no: string;
      order_no: string;
      user_id: string;
      shop_id: string;
      amount_cents: bigint;
      channel: PaymentChannel | null;
      payer_name: string | null;
      voucher_url: string | null;
      note: string | null;
      status: string;
      reviewed_at: Date | null;
      reviewed_by: string | null;
      reject_reason: string | null;
      created_at: Date;
    }>>`
      SELECT pc.confirmation_no, o.order_no, o.user_id, pc.shop_id, pc.amount_cents,
             p.channel, pc.payer_name, pc.voucher_url, pc.note, pc.status,
             pc.reviewed_at, pc.reviewed_by, pc.reject_reason, pc.created_at
        FROM payment_confirmations pc
        JOIN orders o ON o.id = pc.order_id
        LEFT JOIN payments p ON p.id = pc.payment_id
       WHERE pc.idempotency_key LIKE 'payment-voucher:%'
       ORDER BY pc.created_at DESC
       LIMIT 500
    `;
    store.paymentVouchers = new Map(paymentVouchers.map((row) => [row.confirmation_no, {
      id: row.confirmation_no,
      orderNo: row.order_no,
      userId: row.user_id,
      shopId: row.shop_id,
      amountCents: row.amount_cents,
      channel: row.channel ?? "alipay_wap",
      payerName: row.payer_name ?? undefined,
      voucherUrl: row.voucher_url ?? undefined,
      note: row.note ?? undefined,
      status: row.status === "confirmed" ? "approved" : row.status === "rejected" ? "rejected" : "pending_review",
      reason: row.reject_reason ?? undefined,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      reviewedBy: row.reviewed_by
    }]));

    const audits = await this.prisma.$queryRaw<Array<{
      actor_type: string;
      actor_id: string;
      action: string;
      target_type: string;
      target_id: string;
      after_json: unknown;
      idempotency_key: string;
      request_id: string;
      created_at: Date;
    }>>`
      SELECT actor_type, actor_id, action, target_type, target_id, after_json,
             idempotency_key, request_id, created_at
        FROM audit_logs
       ORDER BY created_at DESC
       LIMIT 500
    `;
    store.auditLogs = audits.map((row) => ({
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      afterJson: row.after_json,
      idempotencyKey: row.idempotency_key,
      requestId: row.request_id,
      createdAt: row.created_at
    }));

    const ledgers = await this.prisma.$queryRaw<Array<{
      ledger_no: string;
      entry_type: string;
      agent_id: string | null;
      amount_cents: bigint;
      source_type: string;
      source_id: string;
      created_at: Date;
    }>>`
      SELECT ledger_no, entry_type, agent_id, amount_cents, source_type, source_id, created_at
        FROM ledger_entries
       ORDER BY created_at DESC
       LIMIT 500
    `;
    store.ledgerEntries = ledgers.map((row) => ({
      ledgerNo: row.ledger_no,
      entryType: row.entry_type,
      agentId: row.agent_id ?? undefined,
      amountCents: row.amount_cents,
      orderNo: row.source_type === "order" ? row.source_id : undefined,
      metadata: { sourceType: row.source_type, sourceId: row.source_id },
      createdAt: row.created_at
    }));
  }

  private async loadEmailDeliveries(store: MemoryStore) {
    const rows = await this.prisma.$queryRaw<Array<{
      delivery_no: string;
      order_no: string;
      user_id: string;
      email: string;
      code_count: number;
      source: string;
      status: EmailDelivery["status"];
      error_code: string | null;
      error_message: string | null;
      created_at: Date;
    }>>`
      SELECT ed.delivery_no, o.order_no, o.user_id, ed.email, ed.code_count,
             ed.source, ed.status, ed.error_code, ed.error_message, ed.created_at
        FROM email_delivery_records ed
        JOIN orders o ON o.id = ed.order_id
       ORDER BY ed.created_at DESC
       LIMIT 500
    `;
    store.emailDeliveries = rows.map((row) => ({
      id: row.delivery_no,
      orderNo: row.order_no,
      userId: row.user_id,
      email: row.email,
      codeCount: row.code_count,
      source: row.source === "manual_resend" ? "manual_resend" : "auto_fulfillment",
      status: row.status,
      reason: row.error_message ?? row.error_code ?? undefined,
      createdAt: row.created_at
    }));
  }
}

function requiredPaymentEnv() {
  return [
    "WECHAT_APP_ID",
    "WECHAT_MCH_ID",
    "WECHAT_PAY_API_KEY",
    "WECHAT_PAY_CERT_SERIAL_NO",
    "WECHAT_PAY_PRIVATE_KEY_PATH",
    "WECHAT_PAY_NOTIFY_URL",
    "WECHAT_REFUND_NOTIFY_URL"
  ];
}

function runtimeMode() {
  return isProductionRuntime() ? "production" : "development";
}

function isProductionRuntime() {
  return process.env.APP_ENV === "production"
    || process.env.NODE_ENV === "production"
    || process.env.VERCEL_ENV === "production";
}

function allowDemoAuth() {
  if (isProductionRuntime()) return false;
  const configured = process.env.ALLOW_DEMO_AUTH ?? process.env.DEMO_AUTH_ENABLED;
  if (configured !== undefined) return configured === "true";
  return true;
}

function mockPaymentEnabled() {
  if (isProductionRuntime()) return false;
  const configured = process.env.MOCK_PAYMENT_ENABLED;
  if (configured !== undefined) return configured === "true";
  return true;
}

function fulfillmentMode(snapshot: DemoOrderSnapshot) {
  const rule = snapshot.fulfillmentRuleSnapshot;
  return isRecord(rule) && rule.mode === "code_pool" ? "code_pool" : "manual";
}

function fulfillmentRuleMode(rule: unknown): "manual" | "code_pool" {
  return isRecord(rule) && rule.mode === "code_pool" ? "code_pool" : "manual";
}

function manualFulfillmentInstruction(rule: unknown): string | undefined {
  if (!isRecord(rule)) return undefined;
  return stringValue(rule.manualFulfillmentInstruction);
}

function parseExtractionToken(token: string): { expiresAt: number; signature: string } | undefined {
  const match = /^ext_([0-9a-z]+)_([0-9a-f]{40})$/.exec(token);
  if (!match) return undefined;
  const expiresAt = Number.parseInt(match[1], 36);
  if (!Number.isFinite(expiresAt)) return undefined;
  return { expiresAt, signature: match[2] };
}

function requiresExtractionCode(snapshot: DemoOrderSnapshot) {
  const rule = snapshot.fulfillmentRuleSnapshot;
  if (!isRecord(rule) || fulfillmentMode(snapshot) !== "code_pool") return false;
  return rule.extractCodeRequired === true;
}

function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function previewSecret(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= 6) return "***";
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

function maskSecret(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "***";
  return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
}

function verifyPassword(password: string, storedHash: string) {
  if (storedHash.startsWith("sha256:")) return hashSecret(password) === storedHash.slice("sha256:".length);
  const envHash = process.env.ADMIN_PASSWORD_HASH;
  if (envHash?.startsWith("sha256:")) return hashSecret(password) === envHash.slice("sha256:".length);
  return process.env.NODE_ENV !== "production" && storedHash === password;
}

function assertUserOrderScope(actor: UserActor, resource: { userId: string }) {
  if (actor.userId !== resource.userId) {
    throw new ApiError(403, "FORBIDDEN_USER_SCOPE", "user cannot access another user resource");
  }
}

function dbId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function stableDbId(prefix: string, seed: string) {
  return `${prefix}_${hashSecret(seed).slice(0, 24)}`;
}

function jsonForDb(value: unknown) {
  return JSON.stringify(encodeStoreValue(value ?? {}));
}

function jsonValue(value: unknown): never {
  return encodeStoreValue(value ?? {}) as never;
}

function mapAgentStatus(status: string): "draft" | "pending_review" | "rejected" | "pending_deposit" | "active" | "frozen" | "disabled" | "exit_observation" | "exited" {
  return ["draft", "pending_review", "rejected", "pending_deposit", "active", "frozen", "disabled", "exit_observation", "exited"].includes(status)
    ? status as ReturnType<typeof mapAgentStatus>
    : "draft";
}

function mapDepositStatus(status: string): "pending_payment" | "paid" | "partially_deducted" | "frozen" | "refund_reviewing" | "refunded" | "insufficient" {
  return ["pending_payment", "paid", "partially_deducted", "frozen", "refund_reviewing", "refunded", "insufficient"].includes(status)
    ? status as ReturnType<typeof mapDepositStatus>
    : "pending_payment";
}

function mapPaymentVoucherStatus(status: PaymentVoucher["status"]): "pending" | "confirmed" | "rejected" {
  if (status === "approved") return "confirmed";
  if (status === "rejected") return "rejected";
  return "pending";
}

function mapRiskStatus(status: string): "normal" | "order_frozen" | "shop_frozen" | "settlement_restricted" | "product_removed" | "disabled" {
  return ["normal", "order_frozen", "shop_frozen", "settlement_restricted", "product_removed", "disabled"].includes(status)
    ? status as ReturnType<typeof mapRiskStatus>
    : "normal";
}

function mapShopStatus(status: string): "not_opened" | "configuring" | "open" | "frozen" | "disabled" {
  return ["not_opened", "configuring", "open", "frozen", "disabled"].includes(status)
    ? status as ReturnType<typeof mapShopStatus>
    : "not_opened";
}

function mapProductStatus(status: string): "draft" | "active" | "inactive" | "risk_removed" {
  return ["draft", "active", "inactive", "risk_removed"].includes(status) ? status as ReturnType<typeof mapProductStatus> : "draft";
}

function mapAgentProductStatus(status: string): "draft" | "pending_review" | "rejected" | "approved" | "listed" | "delisted" | "risk_removed" {
  return ["draft", "pending_review", "rejected", "approved", "listed", "delisted", "risk_removed"].includes(status)
    ? status as ReturnType<typeof mapAgentProductStatus>
    : "draft";
}

function mapCollectionStatus(status: string): "pending_review" | "active" | "disabled" | "rejected" {
  return ["pending_review", "active", "disabled", "rejected"].includes(status) ? status as ReturnType<typeof mapCollectionStatus> : "pending_review";
}

function mapChannelStatus(status: string): "pending_review" | "active" | "frozen" | "closed" | "rejected" {
  if (status === "disabled") return "closed";
  return ["pending_review", "active", "frozen", "closed", "rejected"].includes(status) ? status as ReturnType<typeof mapChannelStatus> : "pending_review";
}

function mapReviewStatus(status: string): "draft" | "pending_review" | "rejected" | "approved" {
  return ["draft", "pending_review", "rejected", "approved"].includes(status) ? status as ReturnType<typeof mapReviewStatus> : "pending_review";
}

function mapInviteStatus(status: string): "draft" | "pending_review" | "rejected" | "approved" {
  if (status === "active" || status === "used_up") return "approved";
  if (status === "disabled" || status === "expired") return "rejected";
  return mapReviewStatus(status);
}

function mapCouponTemplateStatus(status: string): "draft" | "active" | "inactive" | "voided" {
  return ["draft", "active", "inactive", "voided"].includes(status) ? status as ReturnType<typeof mapCouponTemplateStatus> : "draft";
}

function mapCouponStatus(status: string): "active" | "used" | "expired" | "voided" {
  if (status === "available") return "active";
  if (status === "voided_after_refund") return "voided";
  return ["active", "used", "expired", "voided"].includes(status) ? status as ReturnType<typeof mapCouponStatus> : "active";
}

function mapUserCouponMemoryStatus(status: string): UserCoupon["status"] {
  if (status === "active") return "available";
  if (status === "used" || status === "expired" || status === "voided") return status;
  return "available";
}

function mapDepositTransactionType(status: string): "pay" | "freeze" | "unfreeze" | "deduct" | "refund" | "adjustment" {
  return ["pay", "freeze", "unfreeze", "deduct", "refund", "adjustment"].includes(status)
    ? status as ReturnType<typeof mapDepositTransactionType>
    : "adjustment";
}

function mapClawbackStatus(status: string): "pending" | "deducting" | "completed" | "insufficient" | "cancelled" {
  return ["pending", "deducting", "completed", "insufficient", "cancelled"].includes(status)
    ? status as ReturnType<typeof mapClawbackStatus>
    : "pending";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredStringValue(value: unknown, name: string): string {
  const result = stringValue(value);
  if (!result) throw new ApiError(500, "PERSISTENCE_SHAPE_INVALID", `${name} is required`);
  return result;
}

function bigintValue(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && value.length > 0) return BigInt(value);
  return 0n;
}

function dateValue(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return undefined;
}

function mapAfterSaleStatus(status: string): "pending" | "agent_processing" | "platform_intervening" | "refund_approved" | "refunding" | "refunded" | "rejected" | "cancelled" {
  return ["pending", "agent_processing", "platform_intervening", "refund_approved", "refunding", "refunded", "rejected", "cancelled"].includes(status)
    ? status as ReturnType<typeof mapAfterSaleStatus>
    : "pending";
}

function mapExtractLogResult(status: string | undefined): "success" | "failed" | "locked" | "revoked" | "expired" {
  if (status === "success" || status === "failed" || status === "locked" || status === "revoked" || status === "expired") return status;
  return "failed";
}

function mapSettlementSheetStatus(status: string): "draft" | "confirmed" | "payout_pending" | "paid" | "cancelled" {
  return ["draft", "confirmed", "payout_pending", "paid", "cancelled"].includes(status)
    ? status as ReturnType<typeof mapSettlementSheetStatus>
    : "draft";
}

function mapManualPayoutStatus(status: string): "pending" | "paid" | "failed" | "cancelled" {
  return ["pending", "paid", "failed", "cancelled"].includes(status)
    ? status as ReturnType<typeof mapManualPayoutStatus>
    : "pending";
}

function mapActorType(status: string): "user" | "agent" | "admin" | "system" {
  if (status === "user" || status === "agent" || status === "system") return status;
  if (status === "admin" || status === "operator" || status === "finance") return "admin";
  return "system";
}

function mapLedgerEntryType(status: string): "ORDER_AGENT_INCOME_PENDING" | "ORDER_SERVICE_FEE_ACCRUAL" | "ORDER_PLATFORM_SELF_REVENUE" | "ORDER_PLATFORM_SELF_COST" | "ORDER_PAYMENT_CHANNEL_FEE" | "ORDER_FIRST_TIER_INCOME_PENDING" | "ORDER_SECOND_TIER_INCOME_PENDING" | "ORDER_THIRD_TIER_INCOME_PENDING" | "REFUND_AGENT_BEAR" | "REFUND_PLATFORM_BEAR" | "REFUND_FIRST_TIER_BEAR" | "REFUND_SECOND_TIER_BEAR" | "REFUND_THIRD_TIER_BEAR" | "SERVICE_FEE_REFUND" | "SETTLEMENT_LOCK" | "SETTLEMENT_PAYOUT" | "CLAWBACK_CREATE" | "CLAWBACK_DEDUCT_PENDING" | "CLAWBACK_DEDUCT_PAYOUT" | "CLAWBACK_DEDUCT_DEPOSIT" | "DEPOSIT_PAY" | "DEPOSIT_DEDUCT" | "DEPOSIT_REFUND" | "RISK_FREEZE" | "RISK_UNFREEZE" | "MANUAL_ADJUST" {
  if (status === "ORDER_AGENT_INCOME_PENDING" || status === "ORDER_PLATFORM_SELF_REVENUE") return status;
  if (status === "DEPOSIT_CONFIRMED") return "DEPOSIT_PAY";
  if (status === "DEPOSIT_DEDUCTED") return "DEPOSIT_DEDUCT";
  if (status === "SETTLEMENT_GENERATED") return "SETTLEMENT_LOCK";
  if (status === "PAYOUT_CONFIRMED") return "SETTLEMENT_PAYOUT";
  return "MANUAL_ADJUST";
}

function mapOrderStatus(status: string): "pending_payment" | "paid" | "fulfilling" | "fulfilled" | "fulfillment_failed" | "after_sale_pending" | "refunding" | "refunded" | "closed" {
  if (status === "pending_payment_confirmation") return "pending_payment";
  return ["pending_payment", "paid", "fulfilling", "fulfilled", "fulfillment_failed", "after_sale_pending", "refunding", "refunded", "closed"].includes(status)
    ? status as ReturnType<typeof mapOrderStatus>
    : "pending_payment";
}

function mapPaymentStatus(status: string): "unpaid" | "paying" | "paid" | "failed" | "cancelled" | "expired" {
  return ["unpaid", "paying", "paid", "failed", "cancelled", "expired"].includes(status) ? status as ReturnType<typeof mapPaymentStatus> : "unpaid";
}

function mapPaymentProviderToDb(provider: PaymentProviderType): "alipay_merchant" | "wechat_merchant" | "epay" | "alipay_personal" {
  return provider === "personal_alipay" ? "alipay_personal" : provider;
}

function mapPaymentProviderFromDb(provider: string): PaymentProviderType {
  return provider === "alipay_personal" ? "personal_alipay" : provider as PaymentProviderType;
}

function mapPaymentConfirmModeToDb(mode: "automatic" | "manual"): "callback_query" | "manual_confirm" {
  return mode === "manual" ? "manual_confirm" : "callback_query";
}

function mapPaymentConfirmModeFromDb(mode: string): "automatic" | "manual" {
  return mode === "manual_confirm" ? "manual" : "automatic";
}

function mapCollectionPaymentConfigStatus(status: string, enabled: boolean): "disabled" | "pending_test" | "active" | "paused" {
  if (!enabled || status === "disabled") return "disabled";
  if (status === "enabled") return "active";
  if (status === "paused") return "paused";
  return "pending_test";
}

function mapCollectionPaymentConfigStatusFromDb(status: string): PaymentMethodConfig["status"] {
  if (status === "active") return "enabled";
  if (status === "paused") return "paused";
  if (status === "disabled") return "disabled";
  return "pending_test";
}

function mapPaymentSnapshotStatus(status: string): "unpaid" | "paying" | "paid" | "failed" | "cancelled" | "expired" {
  if (status === "created") return "paying";
  if (status === "pending_manual_confirmation") return "unpaid";
  return mapPaymentStatus(status);
}

function mapPaymentConfirmSource(source?: "callback" | "query" | "manual"): "unconfirmed" | "callback" | "query" | "manual_confirm" {
  if (source === "callback" || source === "query") return source;
  if (source === "manual") return "manual_confirm";
  return "unconfirmed";
}

function mapPaymentConfirmSourceFromDb(source: string): PaymentSnapshot["confirmationSource"] | undefined {
  if (source === "callback" || source === "query") return source;
  if (source === "manual_confirm") return "manual";
  return undefined;
}

function mapCallbackProcessStatus(status: PaymentCallbackLog["status"]): "received" | "processed" | "ignored_duplicate" | "failed" {
  if (status === "accepted") return "processed";
  return "failed";
}

function mapCallbackProcessStatusFromDb(status: string): PaymentCallbackLog["status"] {
  if (status === "processed" || status === "ignored_duplicate") return "accepted";
  if (status === "failed") return "rejected";
  return "exception";
}

function mapPaymentExceptionType(reasonCode: string): "signature_failed" | "amount_mismatch" | "merchant_mismatch" | "duplicate_callback" | "order_not_found" | "refunded_order_callback" | "fulfilled_dispute" | "provider_error" | "manual_review" {
  if (reasonCode === "SIGNATURE_INVALID") return "signature_failed";
  if (reasonCode === "AMOUNT_MISMATCH") return "amount_mismatch";
  if (reasonCode === "MERCHANT_MISMATCH" || reasonCode === "APP_ID_MISMATCH") return "merchant_mismatch";
  if (reasonCode === "ORDER_NOT_FOUND") return "order_not_found";
  if (reasonCode === "ORDER_REFUNDED") return "refunded_order_callback";
  if (reasonCode === "DUPLICATE_CALLBACK") return "duplicate_callback";
  return "manual_review";
}

function mapPaymentExceptionReasonCodeFromDb(type: string): string {
  if (type === "signature_failed") return "SIGNATURE_INVALID";
  if (type === "amount_mismatch") return "AMOUNT_MISMATCH";
  if (type === "merchant_mismatch") return "MERCHANT_MISMATCH";
  if (type === "order_not_found") return "ORDER_NOT_FOUND";
  if (type === "refunded_order_callback") return "ORDER_REFUNDED";
  if (type === "duplicate_callback") return "DUPLICATE_CALLBACK";
  return "MANUAL_REVIEW";
}

function mapProviderToLegacyPaymentChannel(provider: PaymentProviderType): "wechat_h5" | "alipay_wap" {
  return provider === "wechat_merchant" ? "wechat_h5" : "alipay_wap";
}

function providerCallbackUrlForPersistence(provider: PaymentProviderType) {
  return `/api/callbacks/payments/${provider}`;
}

function serializePaymentMethodForPersistence(method: PaymentMethodConfig) {
  return {
    id: method.id,
    ownerType: method.ownerType,
    agentId: method.agentId,
    shopId: method.shopId,
    provider: method.provider,
    confirmationMode: method.confirmationMode,
    displayName: method.displayName,
    productType: method.productType,
    merchantNoMasked: maskSecret(method.merchantNo),
    appIdMasked: maskSecret(method.appId),
    serviceProviderMasked: maskSecret(method.serviceProviderId),
    gatewayUrl: method.gatewayUrl,
    accountName: method.provider === "personal_alipay" ? method.accountName : maskSecret(method.accountName),
    qrUrl: method.provider === "personal_alipay" ? method.qrUrl : undefined,
    paymentUrl: method.provider === "personal_alipay" ? method.paymentUrl : undefined,
    note: method.note,
    returnUrl: method.returnUrl,
    callbackUrl: providerCallbackUrlForPersistence(method.provider),
    enabled: method.enabled,
    status: method.status,
    isDefault: method.isDefault,
    keyStatus: {
      signingSecret: method.secretConfigured ? "configured" : "missing",
      privateKey: method.privateKeyConfigured ? "configured" : "missing",
      publicKey: method.publicKeyConfigured ? "configured" : "missing",
      certificate: method.certificateConfigured ? "configured" : "missing"
    },
    updatedAt: method.updatedAt,
    lastTestAt: method.lastTestAt,
    lastTestResult: method.lastTestResult,
    lastCallbackAt: method.lastCallbackAt
  };
}

function mapFulfillmentStatus(status: string): "not_started" | "processing" | "success" | "failed" | "resent" | "revoked" {
  return ["not_started", "processing", "success", "failed", "resent", "revoked"].includes(status) ? status as ReturnType<typeof mapFulfillmentStatus> : "not_started";
}

function mapRefundStatus(status: string): "none" | "pending" | "refunding" | "refunded" | "rejected" | "cancelled" {
  return ["none", "pending", "refunding", "refunded", "rejected", "cancelled"].includes(status) ? status as ReturnType<typeof mapRefundStatus> : "none";
}

function mapSettlementStatus(status: string): "pending" | "frozen" | "settleable" | "settling" | "settled" | "clawback_pending" | "clawed_back" {
  return ["pending", "frozen", "settleable", "settling", "settled", "clawback_pending", "clawed_back"].includes(status)
    ? status as ReturnType<typeof mapSettlementStatus>
    : "pending";
}

function mapCollectionChannelType(type: CollectionChannelType): "wechat_qr" | "alipay_qr" | "bank_transfer" | "other" {
  if (type.startsWith("wechat_")) return "wechat_qr";
  if (type.startsWith("alipay_")) return "alipay_qr";
  return "other";
}

function fulfillmentModeFromRule(rule: unknown): "manual" | "code_pool" {
  return isRecord(rule) && rule.mode === "code_pool" ? "code_pool" : "manual";
}

function pickAdminRole(roleCodes: string[]): AdminLoginResult["role"] {
  if (roleCodes.includes("admin")) return "admin";
  if (roleCodes.includes("finance")) return "finance";
  return "operator";
}

function payableAmount(order: DemoOrder) {
  return order.buyerPaidAmountCents ?? order.snapshot.amountSnapshot.paidAmountCents;
}

const PLATFORM_AGENT_ID = "platform";

function getPlatformSelfGrossMargin(snapshot: DemoOrderSnapshot) {
  const amount = snapshot.amountSnapshot as { platformSelfOperatedGrossMarginCents?: bigint };
  return amount.platformSelfOperatedGrossMarginCents ?? 0n;
}

function getChannelSnapshot(snapshot: DemoOrderSnapshot): ChannelSnapshot | undefined {
  return (snapshot as { channelSnapshot?: ChannelSnapshot }).channelSnapshot;
}

function getSnapshotProductId(snapshot: DemoOrderSnapshot): string | undefined {
  const productSnapshot = snapshot.productSnapshot as { id?: string } | undefined;
  return productSnapshot?.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assignDefined<T extends object>(target: T, input: object) {
  const writable = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) writable[key] = value;
  }
  return target;
}

function createMemoryStore(): MemoryStore {
  const store = createEmptyMemoryStore();

  store.agents.set("agent-1", { id: "agent-1", userId: "agent-user-1", name: "测试代理 A", tier: "first_tier", status: "active", riskStatus: "normal", depositStatus: "paid", contactPhone: "13800000000" });
  store.agents.set("agent-2", { id: "agent-2", userId: "agent-user-2", name: "测试代理 B", tier: "second_tier", parentAgentId: "agent-1", status: "active", riskStatus: "normal", depositStatus: "paid", contactPhone: "13900000000" });
  store.agents.set("agent-3", { id: "agent-3", userId: "agent-user-3", name: "测试代理 C", tier: "third_tier", parentAgentId: "agent-2", status: "active", riskStatus: "normal", depositStatus: "paid", contactPhone: "13700000000" });
  store.agents.set("agent-new", { id: "agent-new", userId: "agent-user-new", name: "新代理", tier: "first_tier", status: "draft", riskStatus: "normal", depositStatus: "pending_payment" });
  store.shops.set("shop-1", {
    id: "shop-1",
    agentId: "agent-1",
    name: virtualShopSeed.name,
    status: "open",
    riskStatus: "normal",
    announcement: virtualShopSeed.announcement,
    customerServiceWechat: virtualShopSeed.customerServiceWechat,
    customerServiceQrUrl: "https://example.test/qr-agent-a.png",
    collectionAccountName: virtualShopSeed.collectionAccountName,
    collectionQrUrl: "https://example.test/pay-agent-a.png",
    collectionNote: virtualShopSeed.collectionNote,
    themeColor: virtualShopSeed.themeColor,
    bannerUrl: virtualShopSeed.bannerUrl,
    shareTitle: virtualShopSeed.shareTitle,
    productGroups: virtualShopSeed.productGroups
  });
  store.shops.set("shop-2", { id: "shop-2", agentId: "agent-2", ownerType: "agent", name: "测试代理 B 小店", status: "open", riskStatus: "normal", customerServiceWechat: "agent_b_service", customerServiceQrUrl: "https://example.test/qr-agent-b.png", collectionAccountName: "测试代理B人工收款", collectionQrUrl: "https://example.test/pay-agent-b.png", collectionNote: "二级店铺人工收款码" });
  store.shops.set("shop-3", { id: "shop-3", agentId: "agent-3", ownerType: "agent", name: "测试代理 C 小店", status: "open", riskStatus: "normal", customerServiceWechat: "agent_c_service", customerServiceQrUrl: "https://example.test/qr-agent-c.png", collectionAccountName: "测试代理C人工收款", collectionQrUrl: "https://example.test/pay-agent-c.png", collectionNote: "三级店铺人工收款码" });
  store.shops.set("shop-new", { id: "shop-new", agentId: "agent-new", name: "新代理小店", status: "not_opened", riskStatus: "normal" });
  store.shops.set("shop-platform", {
    id: "shop-platform",
    ownerType: "platform",
    name: "ToSell 平台自营店",
    status: "open",
    riskStatus: "normal",
    announcement: "平台自营虚拟权益，购买后按商品规则发放",
    customerServiceWechat: "tosell_service",
    customerServiceQrUrl: "https://example.test/qr-platform-service.png",
    collectionAccountName: "ToSell 平台自营人工收款",
    collectionQrUrl: "https://example.test/pay-platform.png",
    collectionNote: "平台自营店人工收款码",
    themeColor: "#0f5f6f",
    bannerUrl: "https://example.test/banner-platform.png",
    shareTitle: "ToSell 官方权益精选",
    productGroups: [{ name: "官方精选", agentProductIds: ["psp-1", "psp-code"] }]
  });
  seedCollectionChannel(store, {
    id: "collection-shop-1",
    shopId: "shop-1",
    agentId: "agent-1",
    ownerType: "agent",
    channelType: "alipay_personal_qr",
    displayName: "支付宝个人收款码",
    accountName: virtualShopSeed.collectionAccountName,
    qrUrl: "https://example.test/pay-agent-a.png",
    isDefault: true,
    sortOrder: 10
  });
  seedCollectionChannel(store, {
    id: "collection-shop-2",
    shopId: "shop-2",
    agentId: "agent-2",
    ownerType: "agent",
    channelType: "wechat_personal_qr",
    displayName: "微信个人收款码",
    accountName: "测试代理B人工收款",
    qrUrl: "https://example.test/pay-agent-b.png",
    isDefault: true,
    sortOrder: 10
  });
  seedCollectionChannel(store, {
    id: "collection-shop-3",
    shopId: "shop-3",
    agentId: "agent-3",
    ownerType: "agent",
    channelType: "alipay_personal_qr",
    displayName: "支付宝个人收款码",
    accountName: "测试代理C人工收款",
    qrUrl: "https://example.test/pay-agent-c.png",
    isDefault: true,
    sortOrder: 10
  });
  seedCollectionChannel(store, {
    id: "collection-platform",
    shopId: "shop-platform",
    ownerType: "platform",
    channelType: "alipay_merchant_qr",
    displayName: "平台自营支付宝收款",
    accountName: "ToSell 平台自营人工收款",
    qrUrl: "https://example.test/pay-platform.png",
    isDefault: true,
    sortOrder: 10
  });
  seedMemoryCatalog(store);
  store.notifications.push({ id: "notice-1", agentId: "agent-1", type: "system", title: "V2 经营工具已开启", content: "可以使用店铺装修、批量选品、权益码自动履约和经营看板。", createdAt: new Date(), readAt: null });
  store.depositAccounts.set("agent-1", { agentId: "agent-1", requiredAmountCents: 50_000n, availableAmountCents: 50_000n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "paid" });
  store.depositAccounts.set("agent-2", { agentId: "agent-2", requiredAmountCents: 50_000n, availableAmountCents: 50_000n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "paid" });
  store.depositAccounts.set("agent-3", { agentId: "agent-3", requiredAmountCents: 50_000n, availableAmountCents: 50_000n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "paid" });
  store.depositAccounts.set("agent-new", { agentId: "agent-new", requiredAmountCents: 50_000n, availableAmountCents: 0n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "pending_payment" });
  store.channelAuthorizations.push({ id: "channel-auth-1", firstTierAgentId: "agent-1", status: "active", reason: null, reviewedAt: new Date() });
  store.channelRelations.push({ id: "channel-rel-1", firstTierAgentId: "agent-1", secondTierAgentId: "agent-2", status: "active", reason: null, reviewedAt: new Date(), activeUniqueKey: "second-tier:agent-2" });
  store.channelRelations.push({ id: "channel-rel-2", firstTierAgentId: "agent-1", secondTierAgentId: "agent-2", thirdTierAgentId: "agent-3", status: "active", reason: null, reviewedAt: new Date(), activeUniqueKey: "third-tier:agent-3" });
  store.channelProductOffers.push({ id: "channel-offer-1", channelRelationId: "channel-rel-1", platformProductId: "prod-1", resellSupplyPriceCents: 11_000n, status: "listed" });
  store.channelProductOffers.push({ id: "channel-offer-2", channelRelationId: "channel-rel-2", platformProductId: "prod-1", resellSupplyPriceCents: 13_000n, status: "listed" });
  store.couponTemplates.set("coupon-first-register", {
    id: "coupon-first-register",
    name: "新用户无门槛券",
    discountCents: 500n,
    productIds: [],
    validDays: 30,
    grantOnFirstRegister: true,
    status: "active",
    createdAt: new Date()
  });
  store.inviteCodes.set("invite-platform-first", {
    id: "invite-platform-first",
    code: "PLATFORM-FIRST",
    issuerType: "platform",
    targetTier: "first_tier",
    status: "active",
    maxUses: null,
    usedCount: 0,
    depositRequiredAmountCents: store.depositAccounts.get("agent-1")?.requiredAmountCents,
    expiresAt: null,
    createdBy: "seed",
    createdAt: new Date()
  });
  store.sequence = Date.now();
  return store;
}

function createEmptyMemoryStore(): MemoryStore {
  return {
    sequence: 0,
    agentApplications: new Map(),
    agents: new Map(),
    shops: new Map(),
    platformProducts: new Map(),
    platformShopProducts: new Map(),
    ownProducts: new Map(),
    agentProducts: new Map(),
    depositAccounts: new Map(),
    depositTransactions: [],
    orders: new Map(),
    afterSales: new Map(),
    refunds: new Map(),
    fulfillmentRecords: new Map(),
    settlementSheets: [],
    settlementItemKeys: new Set(),
    manualPayouts: [],
    clawbacks: [],
    riskFreezes: [],
    activeRiskFreezeKeys: new Set(),
    auditLogs: [],
    ledgerEntries: [],
    rightsCodes: [],
    notifications: [],
    channelAuthorizations: [],
    channelRelations: [],
    channelProductOffers: [],
    paymentVouchers: new Map(),
    couponTemplates: new Map(),
    userCoupons: new Map(),
    inviteCodes: new Map(),
    collectionChannels: new Map(),
    paymentMethods: new Map(),
    paymentCallbackLogs: [],
    paymentExceptions: [],
    extractLogs: [],
    emailDeliveries: [],
    paymentChannelConfigs: [
      { channel: "mock", enabled: true, feeBps: 50, fixedFeeCents: 0n, statusNote: "dev_only", updatedAt: new Date() },
      { channel: "wechat_miniprogram", enabled: false, feeBps: 0, fixedFeeCents: 0n, statusNote: "merchant_account_required", updatedAt: new Date() },
      { channel: "wechat_h5_jsapi", enabled: false, feeBps: 0, fixedFeeCents: 0n, statusNote: "merchant_account_required", updatedAt: new Date() },
      { channel: "wechat_h5", enabled: false, feeBps: 0, fixedFeeCents: 0n, statusNote: "merchant_account_required", updatedAt: new Date() },
      { channel: "alipay_wap", enabled: false, feeBps: 0, fixedFeeCents: 0n, statusNote: "alipay_account_required", updatedAt: new Date() }
    ],
    pendingIncomeByAgent: new Map(),
    payableIncomeByAgent: new Map(),
    paidIncomeByAgent: new Map()
  };
}

const storeMapKeys = [
  "agentApplications",
  "agents",
  "shops",
  "platformProducts",
  "platformShopProducts",
  "ownProducts",
  "agentProducts",
  "depositAccounts",
  "orders",
  "afterSales",
  "refunds",
  "fulfillmentRecords",
  "paymentVouchers",
  "couponTemplates",
  "userCoupons",
  "inviteCodes",
  "collectionChannels",
  "paymentMethods"
] as const;

const storeSetKeys = ["settlementItemKeys", "activeRiskFreezeKeys"] as const;

const storeArrayKeys = [
  "depositTransactions",
  "settlementSheets",
  "manualPayouts",
  "clawbacks",
  "riskFreezes",
  "auditLogs",
  "ledgerEntries",
  "rightsCodes",
  "notifications",
  "channelAuthorizations",
  "channelRelations",
  "channelProductOffers",
  "paymentCallbackLogs",
  "paymentExceptions",
  "extractLogs",
  "emailDeliveries",
  "paymentChannelConfigs"
] as const;

function serializeMemoryStore(store: MemoryStore) {
  const output: Record<string, unknown> = { sequence: store.sequence };
  for (const key of storeMapKeys) output[key] = [...store[key].entries()];
  for (const key of storeSetKeys) output[key] = [...store[key].values()];
  for (const key of storeArrayKeys) output[key] = store[key];
  output.pendingIncomeByAgent = [...store.pendingIncomeByAgent.entries()];
  output.payableIncomeByAgent = [...store.payableIncomeByAgent.entries()];
  output.paidIncomeByAgent = [...store.paidIncomeByAgent.entries()];
  return encodeStoreValue(output);
}

function hydrateMemoryStore(snapshot: unknown): MemoryStore {
  const decoded = decodeStoreValue(snapshot) as Record<string, unknown>;
  const store = createEmptyMemoryStore();
  store.sequence = typeof decoded.sequence === "number" ? decoded.sequence : 0;
  for (const key of storeMapKeys) {
    const entries = Array.isArray(decoded[key]) ? decoded[key] as Array<[string, unknown]> : [];
    store[key] = new Map(entries) as never;
  }
  for (const key of storeSetKeys) {
    const values = Array.isArray(decoded[key]) ? decoded[key] as string[] : [];
    store[key] = new Set(values) as never;
  }
  for (const key of storeArrayKeys) {
    store[key] = (Array.isArray(decoded[key]) ? decoded[key] : []) as never;
  }
  store.pendingIncomeByAgent = new Map(Array.isArray(decoded.pendingIncomeByAgent) ? decoded.pendingIncomeByAgent as Array<[string, bigint]> : []);
  store.payableIncomeByAgent = new Map(Array.isArray(decoded.payableIncomeByAgent) ? decoded.payableIncomeByAgent as Array<[string, bigint]> : []);
  store.paidIncomeByAgent = new Map(Array.isArray(decoded.paidIncomeByAgent) ? decoded.paidIncomeByAgent as Array<[string, bigint]> : []);
  return store;
}

function encodeStoreValue(value: unknown): unknown {
  if (typeof value === "bigint") return { __storeType: "bigint", value: value.toString() };
  if (value instanceof Date) return { __storeType: "date", value: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeStoreValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeStoreValue(item)]));
  }
  return value;
}

function decodeStoreValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeStoreValue);
  if (isRecord(value)) {
    if (value.__storeType === "bigint" && typeof value.value === "string") return BigInt(value.value);
    if (value.__storeType === "date" && typeof value.value === "string") return new Date(value.value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeStoreValue(item)]));
  }
  return value;
}

function seedCollectionChannel(store: MemoryStore, input: {
  id: string;
  shopId: string;
  agentId?: string;
  ownerType: "platform" | "agent";
  channelType: CollectionChannelType;
  displayName: string;
  accountName?: string;
  qrUrl?: string;
  paymentUrl?: string;
  isDefault: boolean;
  sortOrder: number;
}) {
  store.collectionChannels.set(input.id, {
    ...input,
    status: "active",
    reviewStatus: "approved",
    reviewedBy: "seed",
    reviewedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date()
  });
}

function seedMemoryCatalog(store: MemoryStore) {
  for (const item of virtualCatalogProducts) {
    store.platformProducts.set(item.demoId, {
      id: item.demoId,
      name: item.name,
      category: item.category,
      tags: item.tags,
      subtitle: item.subtitle,
      description: item.description,
      usageGuide: item.usageGuide,
      imageUrl: item.imageUrl,
      specs: item.specs,
      detailSections: item.detailSections,
      stockCount: item.stockCount,
      soldCount: item.soldCount,
      supplyPriceCents: item.supplyPriceCents,
      minSalePriceCents: item.minSalePriceCents,
      suggestedSalePriceCents: item.suggestedSalePriceCents,
      fulfillmentRule: {
        mode: item.fulfillmentMode,
        ...(item.fulfillmentMode === "code_pool" ? { extractCodeRequired: true } : {})
      },
      afterSaleRule: { refundBeforeFulfillment: true },
      status: "active"
    });
    if (item.platformShopProductId && item.platformSalePriceCents !== undefined) {
      store.platformShopProducts.set(item.platformShopProductId, {
        id: item.platformShopProductId,
        shopId: "shop-platform",
        platformProductId: item.demoId,
        salePriceCents: item.platformSalePriceCents,
        fulfillmentCostCents: item.fulfillmentCostCents ?? item.supplyPriceCents,
        status: "listed",
        groupName: "官方精选"
      });
    }
    store.agentProducts.set(item.agentProductId, {
      id: item.agentProductId,
      agentId: "agent-1",
      shopId: "shop-1",
      productType: "platform",
      platformProductId: item.demoId,
      ownProductReviewId: null,
      salePriceCents: item.agentSalePriceCents,
      status: "listed",
      groupName: item.groupName
    });
    for (const [index, code] of (item.rightsCodes ?? []).entries()) {
      store.rightsCodes.push({
        codeId: `code-${item.demoId}-${index + 1}`,
        productId: item.demoId,
        platformProductId: item.demoId,
        code,
        batchNo: `seed-${item.productNo.toLowerCase()}`,
        status: "available",
        createdAt: new Date()
      });
    }
  }
  store.agentProducts.set("ap-2", { id: "ap-2", agentId: "agent-2", shopId: "shop-2", productType: "platform", platformProductId: "prod-1", ownProductReviewId: null, salePriceCents: 16_000n, status: "listed" });
  store.agentProducts.set("ap-3", { id: "ap-3", agentId: "agent-3", shopId: "shop-3", productType: "platform", platformProductId: "prod-1", ownProductReviewId: null, salePriceCents: 15_000n, status: "listed" });
}

function requireEntity<T>(value: T | undefined, code: string, message: string): T {
  if (!value) throw new ApiError(404, code, message);
  return value;
}

function required<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) throw new ApiError(400, "PARAM_ERROR", `${name} is required`);
  return value;
}

function nextId(store: MemoryStore, prefix: string) {
  store.sequence += 1;
  return `${prefix}-${store.sequence}`;
}

function sum(values: bigint[]) {
  return values.reduce((total, value) => total + value, 0n);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown error";
}

export type RefundAllocationRequest = {
  paidAmountCents: bigint;
  supplyAmountCents: bigint;
  agentIncomeCents: bigint;
  alreadyRefundedCents?: bigint;
  refundAmountCents: bigint;
  responsibility: RefundResponsibility;
  platformBearCents?: bigint;
  agentBearCents?: bigint;
  serviceFeeBearer?: "platform" | "agent" | "mixed" | "none";
};

type AgentApplication = {
  applicationNo: string;
  agentId: string;
  userId: string;
  status: string;
  contactPhone: string;
  customerServiceWechat: string;
  inviteCode?: string;
  inviteCodeId?: string;
  targetTier?: AgentTier;
  parentAgentId?: string;
};

type AgentTier = "first_tier" | "second_tier" | "third_tier";

type DemoAgent = {
  id: string;
  userId: string;
  name: string;
  contactPhone?: string;
  tier?: AgentTier;
  parentAgentId?: string;
  status: string;
  riskStatus: string;
  depositStatus: string;
  createdByAdminId?: string;
  initialPasswordSet?: boolean;
  merchantUsername?: string;
  passwordHash?: string;
};

type DemoShop = {
  id: string;
  ownerType?: "platform" | "agent";
  agentId?: string;
  name: string;
  status: string;
  riskStatus: string;
  announcement?: string;
  customerServiceWechat?: string;
  customerServiceQrUrl?: string;
  customerServiceQq?: string;
  customerServiceQqQrUrl?: string;
  customerServiceNote?: string;
  collectionAccountName?: string;
  collectionQrUrl?: string;
  collectionNote?: string;
  themeColor?: string;
  bannerUrl?: string;
  shareTitle?: string;
  createdByAdminId?: string;
  productGroups?: Array<{ name: string; agentProductIds: string[] }>;
};

type DemoPlatformProduct = {
  id: string;
  name: string;
  category?: string;
  tags?: string[];
  subtitle?: string;
  description?: string;
  usageGuide?: string;
  imageUrl?: string;
  specs?: string[];
  detailSections?: ProductDetailSection[];
  stockCount?: number;
  soldCount?: number;
  displayBadge?: string;
  isRecommended?: boolean;
  displaySort?: number;
  supplyPriceCents: bigint;
  minSalePriceCents: bigint;
  suggestedSalePriceCents: bigint;
  fulfillmentRule: unknown;
  afterSaleRule: unknown;
  status: string;
};

type DemoOwnProduct = {
  id: string;
  agentId: string;
  shopId: string;
  name: string;
  category?: string;
  tags?: string[];
  subtitle?: string;
  description?: string;
  usageGuide?: string;
  imageUrl?: string;
  specs?: string[];
  detailSections?: ProductDetailSection[];
  stockCount?: number;
  soldCount?: number;
  salePriceCents: bigint;
  minSalePriceCents?: bigint;
  fulfillmentRule: unknown;
  afterSaleRule: unknown;
  reviewStatus: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
};

type ProductDetailSection = {
  title: string;
  items: string[];
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
  groupName?: string;
};

type SalesChannelType = "platform_self_operated" | "single_agent" | "two_tier" | "three_tier";
type PaymentChannel = "wechat_miniprogram" | "wechat_h5_jsapi" | "wechat_h5" | "alipay_wap" | "mock";
type PaymentProviderType = "alipay_merchant" | "wechat_merchant" | "epay" | "personal_alipay";
type CollectionChannelType =
  | "alipay_personal_qr"
  | "alipay_merchant_qr"
  | "alipay_merchant_link"
  | "wechat_personal_qr"
  | "wechat_merchant_qr"
  | "wechat_merchant_link"
  | "epay_qr"
  | "epay_link";

type DemoPlatformShopProduct = {
  id: string;
  shopId: string;
  platformProductId: string;
  salePriceCents: bigint;
  fulfillmentCostCents: bigint;
  status: string;
  groupName?: string;
};

type DemoOrderSnapshot = ReturnType<typeof buildOrderSnapshot> | PlatformSelfOperatedSnapshot;

type PlatformSelfOperatedSnapshot = Omit<ReturnType<typeof buildOrderSnapshot>, "salesChannelType" | "amountSnapshot" | "shopSnapshot"> & {
  salesChannelType: "platform_self_operated";
  amountSnapshot: ReturnType<typeof buildOrderSnapshot>["amountSnapshot"] & {
    platformSelfOperatedGrossMarginCents: bigint;
  };
  shopSnapshot: {
    id: string;
    name: string;
    ownerType: "platform";
    customerServiceWechat?: string;
    customerServiceQrUrl?: string;
    customerServiceQq?: string;
    customerServiceQqQrUrl?: string;
    customerServiceNote?: string;
    shopStatus: string;
    entrySource?: string;
  };
  selfOperatedSnapshot: {
    platformShopId: string;
    finalSalePriceCents: bigint;
    fulfillmentCostCents: bigint;
    paymentChannelFeeCents: bigint;
    platformSelfOperatedGrossMarginCents: bigint;
  };
};

type DemoOrder = {
  orderNo: string;
  userId: string;
  agentId: string;
  shopId: string;
  agentProductId: string;
  salesChannelType: SalesChannelType;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  refundStatus: string;
  settlementStatus: string;
  riskStatus: string;
  complaintStatus: string;
  fulfilledAt: Date | null;
  paidAt: Date | null;
  buyerEmail?: string;
  extractionCodeSet?: boolean;
  extractionCodeHash?: string;
  extractionAttemptCount?: number;
  extractionLockedUntil?: Date | null;
  couponId?: string;
  couponDiscountCents?: bigint;
  buyerPaidAmountCents?: bigint;
  collectionChannelId?: string;
  collectionChannelSnapshot?: CollectionChannelPublicSnapshot;
  paymentSnapshot?: PaymentSnapshot;
  refundedAmountCents: bigint;
  snapshot: DemoOrderSnapshot;
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
  description?: string;
  allocation?: ReturnType<typeof allocateRefund>;
};

type DemoRefund = {
  refundNo: string;
  afterSaleNo: string;
  orderNo: string;
  amountCents: bigint;
  agentClawbackCents: bigint;
  wasSettled: boolean;
  pendingIncomeDeductedCents?: bigint;
  channelRefundNo?: string;
  voucherUrl?: string;
  note?: string;
  confirmedAt?: Date;
  status: string;
};

type DepositTransaction = {
  transactionNo: string;
  agentId: string;
  type: string;
  amountCents: bigint;
  balanceBeforeCents: bigint;
  balanceAfterCents: bigint;
  reasonCode: string;
  relatedType: string;
  relatedId: string;
  idempotencyKey: string;
  proofUrl?: string;
  operatorId?: string;
  remark?: string;
};

type SettlementSheet = {
  settlementNo: string;
  agentId: string;
  idempotencyKey: string;
  status: string;
  items: Array<ReturnType<typeof buildSettlementItems>[number] & { settlementRole?: string }>;
  totalOrderCount: number;
  totalPaidCents: bigint;
  totalServiceFeeCents: bigint;
  totalAgentIncomeCents: bigint;
};

type SettlementCandidateDraft = Parameters<typeof buildSettlementItems>[0][number];

type ChannelSnapshot = {
  relationId: string;
  firstTierAgentId: string;
  firstTierShopId: string;
  secondTierAgentId: string;
  secondTierShopId: string;
  thirdTierAgentId?: string;
  thirdTierShopId?: string;
  platformSupplyPriceCents: bigint;
  resellSupplyPriceCents: bigint;
  firstTierSupplyPriceCents: bigint;
  secondTierSupplyPriceCents: bigint | null;
  finalSalePriceCents: bigint;
  firstTierIncomeCents: bigint;
  secondTierIncomeCents: bigint;
  thirdTierIncomeCents: bigint;
};

type LedgerEntry = {
  ledgerNo: string;
  entryType: string;
  orderNo?: string;
  agentId?: string;
  amountCents: bigint;
  metadata: unknown;
  createdAt: Date;
};

type RightsCode = {
  codeId: string;
  productId: string;
  platformProductId?: string;
  agentProductId?: string;
  code: string;
  batchNo: string;
  status: "available" | "issued" | "voided";
  orderNo?: string;
  issueKey?: string;
  createdAt: Date;
  issuedAt?: Date;
};

type RightsCodeImportDetail = {
  line: number;
  action: "create" | "skip" | "fail";
  reasonCode: "EMPTY_LINE" | "INVALID_FORMAT" | "DUPLICATE_IN_REQUEST" | "DUPLICATE_EXISTING" | null;
  reason: string | null;
  normalizedCode?: string;
  codePreview?: string;
};

type RightsCodeImportPrecheck = {
  summary: {
    total: number;
    create: number;
    created: number;
    skipped: number;
    failed: number;
    importable: number;
  };
  details: RightsCodeImportDetail[];
};

type EmailDelivery = {
  id: string;
  orderNo: string;
  userId: string;
  email: string;
  codeCount: number;
  source?: "auto_fulfillment" | "manual_resend";
  status: "pending" | "sent" | "provider_not_configured" | "failed" | "skipped_refunded";
  reason?: string;
  createdAt: Date;
};

type NotificationItem = {
  id: string;
  agentId: string;
  type: string;
  title: string;
  content: string;
  createdAt: Date;
  readAt: Date | null;
};

type ChannelAuthorization = {
  id: string;
  firstTierAgentId: string;
  status: string;
  reason: string | null;
  reviewedAt: Date | null;
};

type ChannelRelation = {
  id: string;
  firstTierAgentId: string;
  secondTierAgentId: string;
  thirdTierAgentId?: string;
  status: string;
  reason: string | null;
  reviewedAt: Date | null;
  activeUniqueKey?: string;
};

type ChannelProductOffer = {
  id: string;
  channelRelationId: string;
  platformProductId: string;
  resellSupplyPriceCents: bigint;
  status: string;
};

type PaymentChannelConfig = {
  channel: PaymentChannel;
  enabled: boolean;
  feeBps: number;
  fixedFeeCents: bigint;
  statusNote: string;
  updatedAt: Date;
};

type PaymentMethodConfig = {
  id: string;
  ownerType: "platform" | "agent";
  agentId?: string;
  shopId?: string;
  provider: PaymentProviderType;
  confirmationMode: "automatic" | "manual";
  displayName: string;
  productType?: string;
  merchantNo?: string;
  appId?: string;
  serviceProviderId?: string;
  gatewayUrl?: string;
  accountName?: string;
  qrUrl?: string;
  paymentUrl?: string;
  note?: string;
  returnUrl?: string;
  enabled: boolean;
  status: "pending_test" | "enabled" | "disabled" | "paused";
  isDefault: boolean;
  signingSecretEncrypted?: string;
  signingSecretHash?: string;
  signingSecretPreview?: string;
  secretConfigured: boolean;
  privateKeyConfigured?: boolean;
  privateKeyPreview?: string;
  publicKeyConfigured?: boolean;
  publicKeyPreview?: string;
  certificateConfigured?: boolean;
  certificatePreview?: string;
  createdAt: Date;
  updatedAt: Date;
  updatedBy?: string;
  lastTestAt?: Date;
  lastTestResult?: "passed" | "failed";
  lastCallbackAt?: Date;
};

type PaymentMethodUpsertInput = Partial<PaymentMethodConfig> & {
  signingSecret?: string;
  privateKey?: string;
  publicKey?: string;
  certificate?: string;
};

type PaymentSnapshot = {
  paymentNo?: string;
  paymentMethodId?: string;
  provider?: PaymentProviderType;
  confirmationMode?: "automatic" | "manual";
  merchantNoMasked?: string;
  appIdMasked?: string;
  serviceProviderMasked?: string;
  amountCents?: bigint;
  currency?: string;
  orderNo?: string;
  providerPaymentNo?: string;
  providerTradeNo?: string;
  status?: string;
  confirmationSource?: "callback" | "query" | "manual";
  expiresAt?: Date;
  createdAt?: Date;
  paidAt?: Date;
  callbackProcessedAt?: Date;
};

type PaymentException = {
  id: string;
  provider: PaymentProviderType;
  orderNo?: string;
  providerTradeNo?: string;
  amountCents?: bigint;
  merchantNoMasked?: string;
  appIdMasked?: string;
  serviceProviderMasked?: string;
  rawPayloadMasked?: unknown;
  reasonCode: string;
  reason: string;
  handled: boolean;
  receivedAt: Date;
  handledBy?: string;
  handledAt?: Date;
  note?: string;
};

type PaymentCallbackLog = {
  id: string;
  provider: PaymentProviderType;
  orderNo?: string;
  providerTradeNo: string;
  amountCents: bigint;
  merchantNoMasked?: string;
  appIdMasked?: string;
  serviceProviderMasked?: string;
  rawPayloadMasked?: unknown;
  receivedAt: Date;
  verified: boolean;
  status: "accepted" | "rejected" | "exception";
  exceptionId?: string;
};

type CollectionChannel = {
  id: string;
  shopId: string;
  agentId?: string;
  ownerType: "platform" | "agent";
  channelType: CollectionChannelType;
  displayName: string;
  accountName?: string;
  qrUrl?: string;
  paymentUrl?: string;
  status: "pending_review" | "active" | "disabled" | "rejected";
  reviewStatus: "pending_review" | "approved" | "rejected";
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectReason?: string;
  isDefault: boolean;
  sortOrder: number;
  dailyLimitCents?: bigint;
  singleOrderLimitCents?: bigint;
  createdAt: Date;
  updatedAt: Date;
};

type CollectionChannelPublicSnapshot = {
  id: string;
  shopId: string;
  ownerType: "platform" | "agent";
  channelType: CollectionChannelType;
  displayName: string;
  accountName?: string;
  qrUrl?: string;
  paymentUrl?: string;
  isDefault: boolean;
  sortOrder: number;
  singleOrderLimitCents?: bigint;
};

type PaymentVoucher = {
  id: string;
  orderNo: string;
  userId: string;
  shopId: string;
  amountCents: bigint;
  channel: PaymentChannel;
  payerName?: string;
  voucherUrl?: string;
  note?: string;
  status: "pending_review" | "approved" | "rejected";
  reason?: string;
  disputeMaterialOnly?: boolean;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
};

type CouponTemplate = {
  id: string;
  name: string;
  discountCents: bigint;
  productIds: string[];
  validDays: number;
  grantOnFirstRegister: boolean;
  status: string;
  createdAt: Date;
};

type UserCoupon = {
  id: string;
  templateId: string;
  userId: string;
  status: "available" | "used" | "expired" | "voided" | "voided_after_refund";
  grantReason: string;
  grantedAt: Date;
  usedAt: Date | null;
  orderNo: string | null;
};

type InviteCode = {
  id: string;
  code: string;
  codeHash?: string;
  issuerType: "platform" | "agent";
  issuerAgentId?: string;
  targetTier: AgentTier;
  status: "active" | "used_up" | "expired" | "disabled";
  maxUses: number | null;
  usedCount: number;
  depositRequiredAmountCents?: bigint;
  expiresAt: Date | null;
  createdBy: string;
  createdAt: Date;
};

type CouponResolution = {
  userCoupon?: UserCoupon;
  discountCents: bigint;
  buyerPaidAmountCents: bigint;
};

type RiskFreezeItem = Record<string, unknown> & {
  id: string;
  targetType: string;
  targetId: string;
  freezeType: string;
  status: string;
  releasedAt: Date | null;
};

type MemoryStore = {
  sequence: number;
  agentApplications: Map<string, AgentApplication>;
  agents: Map<string, DemoAgent>;
  shops: Map<string, DemoShop>;
  platformProducts: Map<string, DemoPlatformProduct>;
  platformShopProducts: Map<string, DemoPlatformShopProduct>;
  ownProducts: Map<string, DemoOwnProduct>;
  agentProducts: Map<string, DemoAgentProduct>;
  depositAccounts: Map<string, Parameters<typeof deductDeposit>[0]["account"]>;
  depositTransactions: DepositTransaction[];
  orders: Map<string, DemoOrder>;
  afterSales: Map<string, DemoAfterSale>;
  refunds: Map<string, DemoRefund>;
  fulfillmentRecords: Map<string, Parameters<typeof applyFulfillmentAttempt>[0]["record"]>;
  settlementSheets: SettlementSheet[];
  settlementItemKeys: Set<string>;
  manualPayouts: Array<Record<string, unknown>>;
  clawbacks: Array<Record<string, unknown>>;
  riskFreezes: RiskFreezeItem[];
  activeRiskFreezeKeys: Set<string>;
  auditLogs: Array<Record<string, unknown>>;
  ledgerEntries: LedgerEntry[];
  rightsCodes: RightsCode[];
  notifications: NotificationItem[];
  channelAuthorizations: ChannelAuthorization[];
  channelRelations: ChannelRelation[];
  channelProductOffers: ChannelProductOffer[];
  paymentVouchers: Map<string, PaymentVoucher>;
  couponTemplates: Map<string, CouponTemplate>;
  userCoupons: Map<string, UserCoupon>;
  inviteCodes: Map<string, InviteCode>;
  collectionChannels: Map<string, CollectionChannel>;
  paymentMethods: Map<string, PaymentMethodConfig>;
  paymentCallbackLogs: PaymentCallbackLog[];
  paymentExceptions: PaymentException[];
  extractLogs: Array<Record<string, unknown>>;
  emailDeliveries: EmailDelivery[];
  paymentChannelConfigs: PaymentChannelConfig[];
  pendingIncomeByAgent: Map<string, bigint>;
  payableIncomeByAgent: Map<string, bigint>;
  paidIncomeByAgent: Map<string, bigint>;
};

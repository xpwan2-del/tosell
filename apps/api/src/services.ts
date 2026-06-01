import {
  IdempotencyRegistry,
  MockPaymentProvider,
  type Actor,
  type RefundResponsibility,
  allocateRefund,
  applyClawback,
  applyFulfillmentAttempt,
  assertAdminPermission,
  assertMerchantScope,
  buildOrderSnapshot,
  buildSettlementItems,
  calculateServiceFeeCents,
  deductDeposit,
  hasAdminPermission,
  processPaymentCallback,
  quoteMerchantOwnedProduct,
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
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

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
export type MerchantActor = Extract<Actor, { role: "merchant" }>;
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

const prismaRetryDelaysMs = [400, 1200, 2500] as const;

async function withPrismaRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= prismaRetryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isPrismaConnectionError(error) || attempt === prismaRetryDelaysMs.length) break;
      await sleepMs(prismaRetryDelaysMs[attempt]);
    }
  }
  throw lastError;
}

function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPrismaConnectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === "P1001"
    || (typeof candidate.message === "string" && (
      candidate.message.includes("Can't reach database server")
      || candidate.message.includes("ECONNREFUSED")
      || candidate.message.includes("Connection refused")
    ));
}

function normalizeShopIdentifier(value: string): string {
  const decoded = safeDecodeURIComponent(value.trim());
  return stripShopPath(decoded);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripShopPath(value?: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  const shopMatch = trimmed.match(/^\/?s\/([^/?#]+)/);
  if (shopMatch) return safeDecodeURIComponent(shopMatch[1]);
  const legacyMatch = trimmed.match(/^\/?shops\/([^/?#]+)/);
  if (legacyMatch) return safeDecodeURIComponent(legacyMatch[1]);
  const miniProgramShopNo = new URLSearchParams(trimmed.split("?")[1] ?? "").get("shopNo");
  if (miniProgramShopNo) return miniProgramShopNo;
  return trimmed.replace(/^\/+|\/+$/g, "");
}

function publicShopPath(shop: DemoShop): string {
  if ((shop.ownerType ?? "merchant") === "platform") return "/";
  const handle = shop.shopNo && !shop.shopNo.startsWith("shop-") ? shop.shopNo : stripShopPath(shop.sharePath) || shop.id;
  return `/s/${handle}`;
}

function createPrismaProductionServices() {
  const prisma = prismaClient();
  const repositories = createPrismaRepositories(prisma);
  const repository = new PrismaStateRepository(prisma, repositories);
  const service = new BackendServices(createEmptyMemoryStore(), {
    persistenceMode: "prisma",
    adminAuth: (input) => withPrismaRetry(() => repository.verifyAdmin(input)),
    merchantAuth: (input) => withPrismaRetry(() => repository.verifyMerchant(input))
  });
  let hydrated = false;
  let hydrationPromise: Promise<void> | undefined;
  async function hydrate() {
    if (hydrated) return;
    if (hydrationPromise) {
      await hydrationPromise;
      return;
    }
    hydrationPromise = (async () => {
      service.store = await withPrismaRetry(() => repository.load());
      service.store.sequence = Math.max(service.store.sequence, Date.now());
      hydrated = true;
    })().catch((error) => {
      hydrationPromise = undefined;
      throw error;
    });
    try {
      await hydrationPromise;
    } catch (error) {
      throw toPrismaApiError(error);
    }
  }
  const proxy = new Proxy(service, {
    get(target, property) {
      if (property === "health") {
        return async () => {
          return {
            ok: true,
            service: "tosell-api",
            runtime: runtimeMode(),
            persistenceMode: "prisma",
            databaseConfigured: Boolean(process.env.DATABASE_URL),
            repositories: Object.keys(repositories).filter((key) => key !== "tx"),
            demoAuthEnabled: allowDemoAuth(),
            mockPaymentEnabled: mockPaymentEnabled(),
            schemaRepairVersion: 2,
            schemaRepairReady: true
          };
        };
      }
      const value = target[property as keyof typeof target];
      if (typeof value !== "function") return value;
      if (property === "loginAdmin") {
        return async (...args: unknown[]) => target.loginAdmin(...(args as Parameters<BackendServices["loginAdmin"]>));
      }
      if (property === "loginMerchant") {
        return async (...args: unknown[]) => target.loginMerchant(...(args as Parameters<BackendServices["loginMerchant"]>));
      }
      if (property === "getMerchantShop") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.getMerchantShop(args[0] as MerchantActor));
      }
      if (property === "getPublicShop") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.getPublicShop(String(args[0] ?? "default")));
      }
      if (property === "listShopProducts") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.listPublicShopProducts(String(args[0] ?? "default")));
      }
      if (property === "listPublicPaymentMethods") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.listPublicPaymentMethods(String(args[0] ?? "default")));
      }
      if (property === "listPlatformProducts") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.listPlatformProducts(args[0] as MerchantActor | undefined));
      }
      if (property === "listMerchantProducts") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.listMerchantProducts(args[0] as MerchantActor));
      }
      if (property === "getMerchantProductDetail") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.getMerchantProductDetail(
          args[0] as MerchantActor,
          String(args[1] ?? "")
        ));
      }
      if (property === "updateMerchantProductDetail") {
        return async (...args: unknown[]) => {
          const result = await withPrismaRetry(() => repository.updateMerchantProductDetail(
            args[0] as MerchantActor,
            String(args[1] ?? ""),
            args[2] as MerchantProductListingDetailUpdateInput
          ));
          hydrated = false;
          hydrationPromise = undefined;
          return result;
        };
      }
      if (property === "getUserWallet") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.getDirectUserWallet(args[0] as UserActor));
      }
      if (property === "quoteOrder") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.quoteOrder(args[0] as UserActor, args[1] as Parameters<BackendServices["quoteOrder"]>[1]));
      }
      if (property === "createCouponTemplate") {
        return async (...args: unknown[]) => {
          const actor = args[0] as AdminActor;
          const input = args[1] as Parameters<BackendServices["createCouponTemplate"]>[1];
          assertAdminPermission(actor, "product.manage");
          if (input.discountCents <= 0n) throw new ApiError(400, "COUPON_INVALID", "coupon discount must be positive");
          const id = `coupon-template-${Date.now()}-${randomUUID().slice(0, 8)}`;
          const createdAt = new Date();
          const validDays = input.validDays ?? 30;
          const validTo = new Date(createdAt.getTime() + validDays * 24 * 60 * 60 * 1000);
          const status = mapCouponTemplateStatus(input.status ?? "active");
          await withPrismaRetry(() => prisma.$transaction(async (tx) => {
            await tx.$executeRaw`
              INSERT INTO coupon_templates (
                id, coupon_no, name, discount_type, discount_amount_cents,
                platform_subsidy_cents, threshold_amount_cents, stackable,
                first_registration_only, status, valid_from, valid_to,
                idempotency_key, created_by, created_at, updated_at
              )
              VALUES (
                ${id}, ${id}, ${input.name}, CAST('fixed_amount' AS "CouponDiscountType"),
                ${input.discountCents}, 0, 0, false, ${input.grantOnFirstRegister ?? false},
                CAST(${status} AS "CouponTemplateStatus"), ${createdAt}, ${validTo},
                ${`coupon-template:${id}`}, ${actor.adminId}, ${createdAt}, now()
              )
            `;
            const productIds = input.productIds ?? [];
            if (productIds.length === 0) {
              await tx.$executeRaw`
                INSERT INTO coupon_scopes (id, coupon_template_id, scope_type, created_at)
                VALUES (${stableDbId("coupon_scope", `${id}:all`)}, ${id},
                        CAST('all_products' AS "CouponScopeType"), now())
              `;
            }
            for (const productId of productIds) {
              await tx.$executeRaw`
                INSERT INTO coupon_scopes (id, coupon_template_id, scope_type, platform_product_id, created_at)
                VALUES (${stableDbId("coupon_scope", `${id}:${productId}`)}, ${id},
                        CAST('platform_product' AS "CouponScopeType"), ${productId}, now())
              `;
            }
            await tx.$executeRaw`
              INSERT INTO audit_logs (
                id, actor_type, actor_id, action, target_type, target_id,
                after_json, idempotency_key, request_id, ip, created_at
              )
              VALUES (
                ${stableDbId("audit", `coupon_template.create:${id}`)}, CAST('admin' AS "ActorType"), ${actor.adminId},
                'coupon_template.create', 'coupon_template', ${id},
                ${jsonForDb({ id, name: input.name, discountCents: input.discountCents, productIds })}::jsonb,
                ${`audit:coupon_template.create:${id}`}, ${`coupon_template.create:${id}`}, '127.0.0.1', now()
              )
              ON CONFLICT (idempotency_key) DO NOTHING
            `;
          }, { maxWait: 10_000, timeout: 30_000 }));
          hydrated = false;
          hydrationPromise = undefined;
          return {
            id,
            name: input.name,
            discountCents: input.discountCents,
            productIds: input.productIds ?? [],
            validDays,
            grantOnFirstRegister: input.grantOnFirstRegister ?? false,
            status,
            createdAt
          };
        };
      }
      if (property === "createMerchantByAdmin") {
        return async (...args: unknown[]) => {
          const result = await withPrismaRetry(() => repository.createMerchantByAdmin(
            args[0] as AdminActor,
            args[1] as Parameters<BackendServices["createMerchantByAdmin"]>[1]
          ));
          hydrated = false;
          hydrationPromise = undefined;
          return result;
        };
      }
      if (property === "createPaymentOrder") {
        return async (...args: unknown[]) => {
          const result = await withPrismaRetry(() => repository.createPaymentOrder(args[0] as UserActor, String(args[1] ?? ""), args[2] as { paymentMethodId?: string } | undefined ?? {}));
          hydrated = false;
          hydrationPromise = undefined;
          return result;
        };
      }
      if (property === "createOrder") {
        return async (...args: unknown[]) => {
          try {
            const result = await withPrismaRetry(() => repository.createOrder(args[0] as UserActor, args[1] as Parameters<BackendServices["createOrder"]>[1]));
            hydrated = false;
            hydrationPromise = undefined;
            return result;
          } catch (error) {
            throw toPrismaApiError(error);
          }
        };
      }
      if (property === "confirmMerchantOfflinePayment") {
        return async (...args: unknown[]) => {
          const result = await withPrismaRetry(() => repository.confirmMerchantOfflinePayment(
            args[0] as MerchantActor,
            String(args[1] ?? ""),
            args[2] as { amountCents: bigint; voucherUrl?: string; note?: string }
          ));
          hydrated = false;
          hydrationPromise = undefined;
          return result;
        };
      }
      if (property === "generateSettlement") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.generateSettlement(
          args[0] as AdminActor,
          args[1] as { merchantId: string; now?: Date; batchNo: string }
        ));
      }
      if (property === "confirmManualPayout") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.confirmManualPayout(
          args[0] as AdminActor,
          String(args[1] ?? ""),
          args[2] as { voucherUrl: string; payoutMethod?: string }
        ));
      }
      if (property === "selectPlatformProduct") {
        return async (...args: unknown[]) => {
          const result = await withPrismaRetry(() => repository.selectPlatformProduct(
            args[0] as MerchantActor,
            args[1] as MerchantProductListingSelectionInput
          ));
          hydrated = false;
          hydrationPromise = undefined;
          return result;
        };
      }
      if (property === "upsertMerchantPaymentMethod") {
        return async (...args: unknown[]) => {
          const result = await withPrismaRetry(() => repository.upsertMerchantPaymentMethod(
            args[0] as MerchantActor,
            args[1] as PaymentMethodUpsertInput
          ));
          hydrated = false;
          hydrationPromise = undefined;
          return result;
        };
      }
      if (property === "listMerchantOrders") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.listMerchantOrders(args[0] as MerchantActor));
      }
      if (property === "getMerchantOrder") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.getMerchantOrder(
          args[0] as MerchantActor,
          String(args[1] ?? "")
        ));
      }
      if (property === "fulfillMerchantOrder") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.fulfillMerchantOrder(
          args[0] as MerchantActor,
          String(args[1] ?? ""),
          args[2] as { status: "success" | "failed"; attemptNo: number; evidence?: string; failReason?: string }
        ));
      }
      if (property === "extractOrderCodes") {
        return async (...args: unknown[]) => withPrismaRetry(() => repository.extractOrderCodes(
          args[0] as UserActor,
          String(args[1] ?? ""),
          String(args[2] ?? "")
        ));
      }
      return async (...args: unknown[]) => {
        await hydrate();
        const actor = args[0] as Partial<MerchantActor> | undefined;
        if (actor?.role === "merchant" && actor.shopId && !target.store.shops.has(actor.shopId)) {
          const shop = await withPrismaRetry(() => repository.getMerchantShop(actor as MerchantActor));
          target.store.shops.set(shop.id, shop);
        }
        let result: unknown;
        try {
          result = await (value as (...methodArgs: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          if (property === "paymentProviderCallback" || property === "queryPaymentOrder") {
            try {
              await withPrismaRetry(() => repository.saveForMethod(String(property), service.store));
            } catch (persistError) {
              throw toPrismaApiError(persistError);
            }
          }
          throw toPrismaApiError(error);
        }
        if (isMutatingServiceMethod(String(property))) {
          try {
            await withPrismaRetry(() => repository.saveForMethod(String(property), service.store));
          } catch (error) {
            throw toPrismaApiError(error);
          }
        }
        return result;
      };
    }
  });
  if (process.env.PRISMA_PREHYDRATE !== "false") {
    setTimeout(() => {
      void hydrate().catch(() => {
        hydrationPromise = undefined;
      });
    }, 0);
  }
  return proxy;
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
  merchantAuth?: (input: { account: string; password: string }) => Promise<MerchantLoginResult>;
};

export type AdminLoginResult = {
  adminId: string;
  username: string;
  displayName: string;
  role: "operator" | "finance" | "admin";
};

export type MerchantLoginResult = {
  merchantId: string;
  shopId: string;
  username: string;
  displayName: string;
  tier?: MerchantTier;
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

  private activeServiceFeeConfig() {
    return this.store.serviceFeeConfig;
  }

  private activeServiceFeeBps() {
    const config = this.activeServiceFeeConfig();
    return config.enabled ? BigInt(config.feeBps) : 0n;
  }

  async loginAdmin(input: { username: string; password: string }): Promise<AdminLoginResult> {
    if (this.options.adminAuth) return this.options.adminAuth(input);
    const username = process.env.ADMIN_USERNAME ?? "admin";
    const password = process.env.ADMIN_PASSWORD ?? "123";
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

  async loginMerchant(input: { account: string; password: string }): Promise<MerchantLoginResult> {
    if (this.options.merchantAuth) return this.options.merchantAuth(input);
    const account = input.account.trim();
    const merchant = requireEntity(
      [...this.store.merchants.values()].find((candidate) =>
        candidate.merchantUsername === account || candidate.id === account || candidate.contactPhone === account
      ),
      "AUTH_INVALID",
      "invalid merchant credentials"
    );
    if (!merchant.passwordHash || !verifyPassword(input.password, merchant.passwordHash)) {
      throw new ApiError(401, "AUTH_INVALID", "invalid merchant credentials");
    }
    if (merchant.status !== "active" && merchant.status !== "pending_deposit") {
      throw new ApiError(403, "AUTH_DISABLED", "merchant account is not active");
    }
    const shop = requireEntity([...this.store.shops.values()].find((candidate) => candidate.merchantId === merchant.id), "AUTH_INVALID", "merchant shop not found");
    return {
      merchantId: merchant.id,
      shopId: shop.id,
      username: merchant.merchantUsername ?? merchant.id,
      displayName: merchant.name,
      tier: merchant.tier,
      status: merchant.status,
      depositStatus: merchant.depositStatus,
      shopName: shop.name,
      shopStatus: shop.status,
      mustChangePassword: true
    };
  }


  listInviteCodes(actor: AdminActor | MerchantActor) {
    if (actor.role === "merchant") {
      return [...this.store.inviteCodes.values()]
        .filter((code) => code.issuerMerchantId === actor.merchantId)
        .map((code) => this.serializeInviteCode(code, actor));
    }
    assertAdminPermission(actor, "merchant.review");
    return [...this.store.inviteCodes.values()].map((code) => this.serializeInviteCode(code));
  }

  createPlatformInviteCode(actor: AdminActor, input: { code?: string; targetTier?: MerchantTier; maxUses?: number; expiresAt?: string; depositRequiredAmountCents?: bigint }) {
    assertAdminPermission(actor, "merchant.review");
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

  createMerchantInviteCode(actor: MerchantActor, input: { code?: string; maxUses?: number; expiresAt?: string; depositRequiredAmountCents?: bigint } = {}) {
    const merchant = requireEntity(this.store.merchants.get(actor.merchantId), "RESOURCE_NOT_FOUND", "merchant not found");
    const tier = this.merchantTier(merchant.id);
    if (tier === "third_tier") {
      this.audit("merchant", "invite_code.create.rejected_fourth_tier", "merchant", merchant.id, { tier });
      throw new ApiError(400, "FOURTH_TIER_FORBIDDEN", "third-tier merchants cannot create fourth-tier invite codes");
    }
    this.assertMerchantDepositConfirmed(merchant.id, "create invite code");
    const invite = this.createInviteCode({
      code: input.code,
      issuerType: "merchant",
      issuerMerchantId: merchant.id,
      targetTier: tier === "first_tier" ? "second_tier" : "third_tier",
      maxUses: input.maxUses,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdBy: merchant.id,
      depositRequiredAmountCents: input.depositRequiredAmountCents ?? this.depositRequirementForMerchantInvite(merchant.id)
    });
    this.audit("merchant", "invite_code.create.merchant", "invite_code", invite.id, invite);
    return this.serializeInviteCode(invite, actor);
  }


  registerMerchantByInvite(input: {
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
      requireEntity(invite.issuerMerchantId ? this.store.merchants.get(invite.issuerMerchantId) : undefined, "INVITE_CODE_INVALID", "upstream merchant not found");
    }
    const merchantId = nextId(this.store, "merchant");
    const shopId = nextId(this.store, "shop");
    const userId = nextId(this.store, "merchant-user");
    const initialPassword = `TS${Date.now().toString().slice(-6)}`;
    const merchant: DemoMerchant = {
      id: merchantId,
      userId,
      name: input.name,
      contactPhone: input.contactPhone,
      tier: invite.targetTier,
      parentMerchantId: invite.issuerMerchantId,
      status: "pending_review",
      riskStatus: "normal",
      depositStatus: "pending_payment",
      initialPasswordSet: true,
      merchantUsername: merchantId,
      passwordHash: `sha256:${hashSecret(initialPassword)}`
    };
    const shop: DemoShop = {
      id: shopId,
      merchantId,
      ownerType: "merchant",
      name: input.shopName ?? `${input.name} 小店`,
      status: "not_opened",
      riskStatus: "normal",
      customerServiceWechat: input.customerServiceWechat
    };
    const application: MerchantApplication = {
      applicationNo: nextId(this.store, "merchant-app"),
      merchantId,
      userId,
      status: "pending_review",
      contactPhone: input.contactPhone ?? "",
      customerServiceWechat: input.customerServiceWechat ?? "",
      inviteCodeId: invite.id,
      targetTier: invite.targetTier,
      parentMerchantId: invite.issuerMerchantId
    };
    this.store.merchants.set(merchantId, merchant);
    this.store.shops.set(shopId, shop);
    this.store.merchantApplications.set(application.applicationNo, application);
    const requiredAmount = invite.depositRequiredAmountCents;
    if (requiredAmount === undefined || requiredAmount <= 0n) {
      throw new ApiError(400, "DEPOSIT_REQUIREMENT_MISSING", "invite code is missing deposit requirement");
    }
    this.store.depositAccounts.set(merchantId, {
      merchantId,
      requiredAmountCents: requiredAmount,
      availableAmountCents: 0n,
      frozenAmountCents: 0n,
      deductedAmountCents: 0n,
      status: "pending_payment"
    });
    this.createPendingRelationForInvite(invite, merchantId);
    invite.usedCount += 1;
    if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) invite.status = "used_up";
    this.audit("system", "merchant.register_by_invite", "merchant", merchantId, { inviteCodeId: invite.id, targetTier: invite.targetTier });
    return {
      merchant,
      shop,
      application,
      inviteCode: this.serializeInviteCode(invite),
      credential: {
        account: merchant.merchantUsername,
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

  listUserCoupons(actor: UserActor, input: { shopId?: string; merchantProductListingId?: string } = {}) {
    return [...this.store.userCoupons.values()]
      .filter((coupon) => coupon.userId === actor.userId)
      .map((coupon) => this.serializeUserCoupon(coupon, input))
      .filter((coupon) => coupon.visible);
  }

  getShop(shopIdentifier: string) {
    const shop = this.resolveShop(shopIdentifier);
    return requireEntity(shop, "RESOURCE_NOT_FOUND", "shop not found");
  }

  getPublicShop(shopIdentifier: string) {
    const shop = this.getShop(shopIdentifier);
    const publicPath = publicShopPath(shop);
    return {
      id: shop.id,
      merchantId: shop.merchantId,
      ownerType: shop.ownerType ?? "merchant",
      shopNo: shop.shopNo,
      sharePath: shop.sharePath,
      publicPath,
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

  listShopProducts(shopIdentifier: string) {
    const shop = this.getShop(shopIdentifier);
    if ((shop.ownerType ?? "merchant") === "platform") {
      return [...this.store.platformShopProducts.values()]
        .filter((shopProduct) => shopProduct.shopId === shop.id && shopProduct.status === "listed")
        .map((shopProduct) => this.serializePublicShopProduct(shopProduct));
    }
    return [...this.store.merchantProductListings.values()]
      .filter((merchantProductListing) => merchantProductListing.shopId === shop.id && merchantProductListing.status === "listed")
      .map((merchantProductListing) => this.serializePublicMerchantProduct(merchantProductListing));
  }

  getMerchantProduct(merchantProductListingId: string) {
    const platformShopProduct = this.store.platformShopProducts.get(merchantProductListingId);
    if (platformShopProduct) return this.serializePublicShopProduct(platformShopProduct);
    return this.serializePublicMerchantProduct(
      requireEntity(this.store.merchantProductListings.get(merchantProductListingId), "RESOURCE_NOT_FOUND", "product not found")
    );
  }


  quoteOrder(actor: UserActor, input: { shopId: string; merchantProductListingId: string; quantity?: number; couponId?: string }) {
    try {
      const snapshot = this.buildSnapshot({
        orderNo: "quote-only",
        userId: actor.userId,
        shopId: input.shopId,
        merchantProductListingId: input.merchantProductListingId,
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
    merchantProductListingId: string;
    quantity?: number;
    buyerEmail?: string;
    buyerPhone?: string;
    extractionCode?: string;
    couponId?: string;
    paymentMethodId?: string;
    clientPaidAmountCents?: bigint;
  }) {
    try {
      this.releaseExpiredRightsCodeLocks();
      const orderNo = nextId(this.store, "order");
      const snapshot = this.buildSnapshot({
        orderNo,
        userId: actor.userId,
        shopId: input.shopId,
        merchantProductListingId: input.merchantProductListingId,
        quantity: input.quantity,
        entrySource: "user_api",
        serviceFeeBps: this.activeServiceFeeBps()
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
      if (requiresExtractionCode(snapshot) && !/^1[3-9]\d{9}$/.test(input.buyerPhone ?? "")) {
        throw new ApiError(400, "BUYER_PHONE_REQUIRED", "code_pool products require a valid mainland China mobile phone");
      }
      const selectedPaymentMethod = input.paymentMethodId === "balance"
        ? this.balancePaymentMethod()
        : input.paymentMethodId ? this.store.paymentMethods.get(input.paymentMethodId) : undefined;
      const order: DemoOrder = {
        orderNo,
        userId: actor.userId,
        merchantId: snapshot.merchantId,
        shopId: snapshot.shopId,
        merchantProductListingId: snapshot.merchantProductListingId,
        salesChannelType: "salesChannelType" in snapshot ? snapshot.salesChannelType : "single_merchant",
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
        buyerPhone: input.buyerPhone,
        extractionCodeSet: Boolean(input.extractionCode),
        extractionCodeHash: input.extractionCode ? hashSecret(input.extractionCode) : undefined,
        extractionAttemptCount: 0,
        extractionLockedUntil: null,
        couponId: coupon.userCoupon?.id,
        couponDiscountCents: coupon.discountCents,
        buyerPaidAmountCents: coupon.buyerPaidAmountCents,
        collectionPaymentConfigId: undefined,
        collectionPaymentSnapshot: undefined,
        preferredPaymentMethodId: selectedPaymentMethod?.id,
        refundedAmountCents: 0n,
        snapshot
      };
      this.reserveRightsCodesForOrder(order);
      this.store.orders.set(orderNo, order);
      if (coupon.userCoupon) {
        coupon.userCoupon.status = "used";
        coupon.userCoupon.orderNo = orderNo;
        coupon.userCoupon.usedAt = new Date();
      }
      this.audit("system", "order.create", "order", orderNo, { merchantId: order.merchantId, shopId: order.shopId });
      this.ledger("ORDER_CREATED", { orderNo: order.orderNo, merchantId: order.merchantId }, order.snapshot.amountSnapshot.paidAmountCents, {
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

  async createPaymentOrder(actor: UserActor, orderNo: string, input: { paymentMethodId?: string }) {
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertUserOrderScope(actor, order);
    if (order.paymentStatus === "paid") {
      return { status: "already_paid" as const, orderNo, order: this.serializePublicOrder(order, { includeDeliveryCodes: false }) };
    }
    if (order.refundStatus !== "none" || order.status === "refunded") {
      throw new ApiError(400, "PAYMENT_ORDER_NOT_ALLOWED", "refunded orders cannot create payment");
    }
    const method = this.resolvePaymentMethodForOrder(order, input.paymentMethodId ?? order.preferredPaymentMethodId);
    const amountCents = this.applyPaymentFeeSnapshot(order, method);
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
      status: isManualPaymentProvider(method.provider) ? "pending_manual_confirmation" : "created",
      expiresAt,
      createdAt: new Date()
    };
    if (method.provider === "balance") {
      return this.captureBalancePayment(actor, order, method, paymentNo);
    }
    if (isManualPaymentProvider(method.provider)) {
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
        message: `${paymentProviderDisplay(method.provider)}仅支持人工确认，请按订单金额付款后等待商户确认收款。`
      };
    }
    order.paymentStatus = "paying";
    const providerTradeNo = method.provider === "epay" ? order.orderNo : `tp_${order.orderNo}_${Date.now()}`;
    order.paymentSnapshot.providerPaymentNo = providerTradeNo;
    order.paymentSnapshot.status = "paying";
    const signaturePayload = this.paymentSignaturePayload(method.provider, order.orderNo, amountCents, providerTradeNo, method.merchantNo);
    const epayParams = method.provider === "epay" ? await this.buildEpayPaymentParams(method, order, amountCents) : undefined;
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
        qrCodeUrl: epayParams?.paymentUrl ?? `tosell-pay://${method.provider}/${encodeURIComponent(providerTradeNo)}`,
        paymentUrl: epayParams?.paymentUrl,
        gatewayUrl: epayParams?.gatewayUrl,
        method: epayParams?.method,
        apiMode: epayParams?.apiMode,
        mapiStatus: epayParams?.mapiStatus,
        mapiMessage: epayParams?.mapiMessage,
        directAppUrl: epayParams?.directAppUrl,
        cashierUrl: epayParams?.cashierUrl,
        submitPaymentUrl: epayParams?.submitPaymentUrl,
        submitParams: epayParams?.submitParams,
        returnUrl: epayParams?.returnUrl ?? method.returnUrl,
        notifyUrl: epayParams?.notifyUrl ?? this.providerCallbackUrl(method.provider),
        signaturePayload: method.provider === "epay" ? undefined : signaturePayload
      },
      message: "支付状态只以服务端回调或后台查单结果为准，前端返回页不能确认支付成功。"
    };
  }

  getUserWallet(actor: UserActor) {
    const wallet = this.ensureUserWallet(actor.userId);
    return this.serializeWallet(wallet);
  }

  createWalletRecharge(actor: UserActor, input: { amountCents: bigint; paymentMethodId?: string }) {
    if (input.amountCents <= 0n) throw new ApiError(400, "WALLET_RECHARGE_AMOUNT_INVALID", "recharge amount must be positive");
    const wallet = this.ensureUserWallet(actor.userId);
    const method = this.resolvePaymentMethodForRecharge(input.paymentMethodId);
    if (!method || method.provider === "balance") throw new ApiError(400, "WALLET_RECHARGE_METHOD_UNAVAILABLE", "wallet recharge needs an external payment method");
    const feeBps = this.paymentFeeBpsForProvider(method.provider);
    const feeCents = calculateServiceFeeCents(input.amountCents, BigInt(feeBps));
    const recharge: WalletRecharge = {
      rechargeNo: nextId(this.store, "recharge"),
      userId: actor.userId,
      walletId: wallet.id,
      paymentMethodId: method.id,
      provider: method.provider,
      confirmationMode: method.confirmationMode,
      rechargeCents: input.amountCents,
      feeBps,
      feeCents,
      payableCents: input.amountCents + feeCents,
      status: "pending_payment",
      createdAt: new Date(),
      updatedAt: new Date(),
      idempotencyKey: `wallet-recharge:${actor.userId}:${Date.now()}`
    };
    this.store.walletRecharges.set(recharge.rechargeNo, recharge);
    this.audit("user", "wallet.recharge.create", "wallet_recharge", recharge.rechargeNo, {
      userId: actor.userId,
      amountCents: input.amountCents,
      feeCents
    });
    return { ...recharge, wallet: this.serializeWallet(wallet), paymentMethod: this.serializePaymentMethod(method) };
  }

  confirmWalletRecharge(actor: AdminActor, rechargeNo: string, input: { providerTradeNo?: string; note?: string }) {
    assertAdminPermission(actor, "settlement.confirm");
    const recharge = requireEntity(this.store.walletRecharges.get(rechargeNo), "RESOURCE_NOT_FOUND", "wallet recharge not found");
    const wallet = requireEntity(this.store.userWallets.get(recharge.userId), "RESOURCE_NOT_FOUND", "wallet not found");
    if (recharge.status === "paid") return { status: "already_paid" as const, recharge, wallet: this.serializeWallet(wallet) };
    const before = wallet.availableBalanceCents;
    wallet.availableBalanceCents += recharge.rechargeCents;
    wallet.totalRechargeCents += recharge.rechargeCents;
    wallet.version += 1;
    wallet.updatedAt = new Date();
    recharge.status = "paid";
    recharge.paidAt = new Date();
    recharge.updatedAt = new Date();
    this.recordWalletTransaction({
      userId: recharge.userId,
      wallet,
      type: "recharge",
      direction: "credit",
      amountCents: recharge.rechargeCents,
      balanceBeforeCents: before,
      balanceAfterCents: wallet.availableBalanceCents,
      sourceType: "wallet_recharge",
      sourceId: recharge.rechargeNo,
      rechargeNo: recharge.rechargeNo,
      note: input.note ?? input.providerTradeNo
    });
    this.ledger("WALLET_RECHARGE_PAID", {}, recharge.rechargeCents, {
      rechargeNo: recharge.rechargeNo,
      userId: recharge.userId,
      operatorId: actor.adminId
    });
    this.audit(actor.role, "wallet.recharge.confirm", "wallet_recharge", recharge.rechargeNo, {
      providerTradeNo: input.providerTradeNo
    });
    return { status: "processed" as const, recharge, wallet: this.serializeWallet(wallet) };
  }

  listWallets(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return [...this.store.userWallets.values()].map((wallet) => this.serializeWallet(wallet));
  }

  listWalletTransactions(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return this.store.walletTransactions;
  }

  listWalletRecharges(actor: AdminActor) {
    assertAdminPermission(actor, "settlement.confirm");
    return [...this.store.walletRecharges.values()].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  private captureBalancePayment(actor: UserActor, order: DemoOrder, method: PaymentMethodConfig, paymentNo: string) {
    const wallet = this.ensureUserWallet(actor.userId);
    const amountCents = payableAmount(order);
    if (wallet.availableBalanceCents < amountCents) {
      throw new ApiError(400, "WALLET_BALANCE_INSUFFICIENT", "wallet balance is not enough for this order");
    }
    const before = wallet.availableBalanceCents;
    wallet.availableBalanceCents -= amountCents;
    wallet.totalSpendCents += amountCents;
    wallet.version += 1;
    wallet.updatedAt = new Date();
    const hold: WalletPaymentHold = {
      holdNo: nextId(this.store, "wallet-hold"),
      userId: actor.userId,
      walletId: wallet.id,
      orderNo: order.orderNo,
      paymentNo,
      amountCents,
      status: "captured",
      capturedAt: new Date(),
      idempotencyKey: `wallet-payment:${order.orderNo}`
    };
    this.store.walletHolds.set(hold.holdNo, hold);
    this.recordWalletTransaction({
      userId: actor.userId,
      wallet,
      type: "payment_capture",
      direction: "debit",
      amountCents,
      balanceBeforeCents: before,
      balanceAfterCents: wallet.availableBalanceCents,
      sourceType: "order",
      sourceId: order.orderNo,
      orderNo: order.orderNo,
      paymentNo,
      holdNo: hold.holdNo,
      note: "余额支付"
    });
    this.applyPaidOrder(order, amountCents, "balance", {
      provider: "balance",
      paymentMethodId: method.id,
      walletId: wallet.id
    });
    order.paymentSnapshot = {
      ...(order.paymentSnapshot ?? {}),
      paymentNo,
      paymentMethodId: method.id,
      provider: "balance",
      confirmationMode: "automatic",
      amountCents,
      currency: "CNY",
      orderNo: order.orderNo,
      status: "paid",
      confirmationSource: "balance",
      paidAt: order.paidAt ?? new Date()
    };
    this.audit("user", "wallet.payment.capture", "order", order.orderNo, {
      paymentMethodId: method.id,
      provider: method.provider,
      amountCents,
      walletId: wallet.id,
      holdNo: hold.holdNo
    });
    return {
      status: "paid" as const,
      orderNo: order.orderNo,
      provider: "balance" as const,
      amountCents,
      wallet: this.serializeWallet(wallet),
      order: this.serializePublicOrder(order, { includeDeliveryCodes: false }),
      message: "余额支付成功，订单已进入发货流程。"
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
      merchantId: order.merchantId,
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

  submitMerchantApplication(actor: MerchantActor, input: { contactPhone: string; customerServiceWechat: string; inviteCode?: string }) {
    const merchant = requireEntity(this.store.merchants.get(actor.merchantId), "RESOURCE_NOT_FOUND", "merchant not found");
    merchant.status = "pending_review";
    merchant.contactPhone = input.contactPhone;
    const application: MerchantApplication = {
      applicationNo: nextId(this.store, "merchant-app"),
      merchantId: merchant.id,
      userId: merchant.userId,
      status: "pending_review",
      contactPhone: input.contactPhone,
      customerServiceWechat: input.customerServiceWechat,
      inviteCode: input.inviteCode
    };
    this.store.merchantApplications.set(application.applicationNo, application);
    this.audit("merchant", "merchant.application.submit", "merchant", merchant.id, application);
    return application;
  }


  getMerchantShop(actor: MerchantActor) {
    const shop = requireEntity(this.store.shops.get(actor.shopId), "RESOURCE_NOT_FOUND", "shop not found");
    assertMerchantScope(actor, { merchantId: required(shop.merchantId, "merchantId"), shopId: shop.id });
    return shop;
  }


  updateMerchantShop(actor: MerchantActor, input: {
    name?: string;
    announcement?: string;
    customerServiceWechat?: string;
    customerServiceQrUrl?: string;
    customerServiceQq?: string;
    customerServiceQqQrUrl?: string;
    customerServiceNote?: string;
  }) {
    const shop = this.getMerchantShop(actor);
    Object.assign(shop, input);
    this.audit("merchant", "shop.update", "shop", shop.id, input);
    return shop;
  }

  updateMerchantShopCollection(actor: MerchantActor, input: { collectionAccountName?: string; collectionQrUrl?: string; collectionNote?: string }) {
    const shop = this.getMerchantShop(actor);
    shop.collectionAccountName = input.collectionAccountName ?? shop.collectionAccountName;
    shop.collectionQrUrl = input.collectionQrUrl ?? shop.collectionQrUrl;
    shop.collectionNote = input.collectionNote ?? shop.collectionNote;
    this.audit("merchant", "shop.collection.update", "shop", shop.id, input);
    return shop;
  }


  updateShopDecor(actor: MerchantActor, input: {
    themeColor?: string;
    bannerUrl?: string;
    shareTitle?: string;
    productGroups?: Array<{ name: string; merchantProductListingIds: string[] }>;
  }) {
    const shop = this.getMerchantShop(actor);
    if (input.themeColor && !/^#[0-9a-fA-F]{6}$/.test(input.themeColor)) {
      throw new ApiError(400, "SHOP_DECOR_INVALID", "themeColor must be a hex color");
    }
    if (input.productGroups) {
      for (const group of input.productGroups) {
        for (const merchantProductListingId of group.merchantProductListingIds) {
          const merchantProductListing = requireEntity(this.store.merchantProductListings.get(merchantProductListingId), "RESOURCE_NOT_FOUND", "merchant product not found");
          assertMerchantScope(actor, merchantProductListing);
        }
      }
    }
    Object.assign(shop, input);
    this.notify(actor.merchantId, "shop.decor.updated", "店铺装修已更新", "新的店铺主题、分享标题或商品分组已经保存。");
    this.audit("merchant", "shop.decor.update", "shop", shop.id, input);
    return shop;
  }

  listPlatformProducts(actor?: MerchantActor) {
    if (actor) {
      this.getMerchantShop(actor);
      this.assertMerchantDepositConfirmed(actor.merchantId, "select platform products");
      if (this.findActiveChannelRelationForSellingMerchant(actor.merchantId) || this.isSecondTierSupplier(actor.merchantId)) {
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
    if ((shop.ownerType ?? "merchant") !== "platform") throw new ApiError(400, "SHOP_SCOPE_INVALID", "shop is not platform-owned");
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

  merchantDashboard(actor: MerchantActor) {
    const orders = this.listMerchantScopedOrders(actor);
    const paidOrders = orders.filter((order) => order.paymentStatus === "paid");
    const fulfilledOrders = orders.filter((order) => order.fulfillmentStatus === "success");
    const refundedOrders = orders.filter((order) => order.refundStatus === "refunded");
    const account = this.store.depositAccounts.get(actor.merchantId);
    return {
      orderCount: orders.length,
      paidOrderCount: paidOrders.length,
      fulfilledOrderCount: fulfilledOrders.length,
      refundOrderCount: refundedOrders.length,
      gmvCents: sum(paidOrders.map((order) => order.snapshot.amountSnapshot.paidAmountCents)),
      expectedIncomeCents: sum(paidOrders.map((order) => order.snapshot.amountSnapshot.merchantExpectedIncomeCents)),
      pendingIncomeCents: this.store.pendingIncomeByMerchant.get(actor.merchantId) ?? 0n,
      payableIncomeCents: this.store.payableIncomeByMerchant.get(actor.merchantId) ?? 0n,
      paidIncomeCents: this.store.paidIncomeByMerchant.get(actor.merchantId) ?? 0n,
      refundRateBps: paidOrders.length === 0 ? 0 : Math.round((refundedOrders.length / paidOrders.length) * 10_000),
      depositAvailableCents: account?.availableAmountCents ?? 0n,
      activeProductCount: this.listMerchantProducts(actor).filter((item) => item.status === "listed").length,
      noticeCount: this.listNotifications(actor).filter((item) => !item.readAt).length
    };
  }


  listMerchantProducts(actor: MerchantActor) {
    return [...this.store.merchantProductListings.values()]
      .filter((merchantProductListing) => merchantProductListing.merchantId === actor.merchantId && merchantProductListing.shopId === actor.shopId)
      .map((merchantProductListing) => this.serializeMerchantProductForActor(actor, merchantProductListing));
  }


  getMerchantProductDetail(actor: MerchantActor, merchantProductListingId: string) {
    const merchantProductListing = requireEntity(this.store.merchantProductListings.get(merchantProductListingId), "RESOURCE_NOT_FOUND", "merchant product not found");
    assertMerchantScope(actor, merchantProductListing);
    return this.serializeMerchantProductDetailForActor(actor, merchantProductListing);
  }


  updateMerchantProductDetail(actor: MerchantActor, merchantProductListingId: string, input: MerchantProductListingDetailUpdateInput) {
    const merchantProductListing = requireEntity(this.store.merchantProductListings.get(merchantProductListingId), "RESOURCE_NOT_FOUND", "merchant product not found");
    assertMerchantScope(actor, merchantProductListing);
    if (input.salePriceCents !== undefined) this.setMerchantProductPrice(actor, merchantProductListingId, input.salePriceCents);
    if (input.status !== undefined) merchantProductListing.status = input.status;
    this.applyMerchantProductListingDisplayOverrides(merchantProductListing, input);
    this.audit("merchant", "merchant_product_listing.detail_update", "merchant_product_listing", merchantProductListing.id, input);
    return this.serializeMerchantProductDetailForActor(actor, merchantProductListing);
  }


  listMerchantOrders(actor: MerchantActor) {
    return this.listMerchantScopedOrders(actor).map((order) => this.serializeMerchantOrderForActor(actor, order));
  }


  getMerchantOrder(actor: MerchantActor, orderNo: string) {
    const order = this.listMerchantScopedOrders(actor).find((item) => item.orderNo === orderNo);
    if (!order) throw new ApiError(404, "RESOURCE_NOT_FOUND", "order not found");
    return this.serializeMerchantOrderForActor(actor, order);
  }


  private listMerchantScopedOrders(actor: MerchantActor) {
    return [...this.store.orders.values()].filter((order) => {
      if (order.merchantId === actor.merchantId && order.shopId === actor.shopId) return true;
      const channel = getChannelSnapshot(order.snapshot);
      return (channel?.firstTierMerchantId === actor.merchantId && channel.firstTierShopId === actor.shopId)
        || (channel?.secondTierMerchantId === actor.merchantId && channel.secondTierShopId === actor.shopId);
    });
  }

  listMerchantSettlements(actor: MerchantActor) {
    return this.store.settlementSheets.filter((sheet) => sheet.merchantId === actor.merchantId);
  }


  listMerchantClawbacks(actor: MerchantActor) {
    return this.store.clawbacks.filter((clawback) => clawback.merchantId === actor.merchantId);
  }


  listMerchantDepositTransactions(actor: MerchantActor) {
    return this.store.depositTransactions.filter((transaction) => transaction.merchantId === actor.merchantId);
  }


  setMerchantProductPrice(actor: MerchantActor, merchantProductListingId: string, salePriceCents: bigint) {
    this.assertMerchantDepositConfirmed(actor.merchantId, "change product price");
    const merchantProductListing = requireEntity(this.store.merchantProductListings.get(merchantProductListingId), "RESOURCE_NOT_FOUND", "merchant product not found");
    assertMerchantScope(actor, merchantProductListing);
    try {
      if (merchantProductListing.productType === "platform") {
        const pricing = this.platformSelectionPricingForActor(actor, required(merchantProductListing.platformProductId, "platformProductId"));
        quotePlatformProduct({
          salePriceCents,
          supplyPriceCents: pricing.supplyPriceCents,
          minSalePriceCents: pricing.minSalePriceCents
        });
      } else {
        const ownProduct = requireEntity(this.store.ownProducts.get(required(merchantProductListing.ownProductReviewId, "ownProductReviewId")), "RESOURCE_NOT_FOUND", "own product not found");
        quoteMerchantOwnedProduct({ salePriceCents, minSalePriceCents: ownProduct.minSalePriceCents });
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "PRICE_RULE_FAILED", getErrorMessage(error));
    }
    merchantProductListing.salePriceCents = salePriceCents;
    this.audit("merchant", "merchant_product_listing.price_update", "merchant_product_listing", merchantProductListing.id, { salePriceCents });
    return merchantProductListing;
  }


  listOwnProductReviews(actor: MerchantActor) {
    return [...this.store.ownProducts.values()]
      .filter((product) => product.merchantId === actor.merchantId && product.shopId === actor.shopId)
      .map((product) => this.serializeOwnProductDetail(product, "merchant"));
  }

  getOwnProductDetail(actor: MerchantActor, ownProductId: string) {
    const product = requireEntity(this.store.ownProducts.get(ownProductId), "RESOURCE_NOT_FOUND", "own product not found");
    assertMerchantScope(actor, product);
    return this.serializeOwnProductDetail(product, "merchant");
  }

  updateOwnProductDetail(actor: MerchantActor, ownProductId: string, input: {
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
    assertMerchantScope(actor, product);
    if (product.reviewStatus !== "pending_review" && (input.name || input.category || input.fulfillmentRule)) {
      throw new ApiError(400, "OWN_PRODUCT_EDIT_LOCKED", "approved or rejected own product core fields cannot be changed");
    }
    const nextFulfillmentMode = input.fulfillmentRule === undefined ? undefined : fulfillmentRuleMode(input.fulfillmentRule);
    if (nextFulfillmentMode && nextFulfillmentMode !== fulfillmentRuleMode(product.fulfillmentRule)) {
      this.assertSafeOwnFulfillmentModeChange(product.id, nextFulfillmentMode);
    }
    const nextSalePrice = input.salePriceCents ?? product.salePriceCents;
    const nextMinSalePrice = input.minSalePriceCents ?? product.minSalePriceCents;
    quoteMerchantOwnedProduct({ salePriceCents: nextSalePrice, minSalePriceCents: nextMinSalePrice });
    assignDefined(product, input);
    product.updatedAt = new Date();
    this.audit("merchant", "own_product.update", "own_product", product.id, input);
    return this.serializeOwnProductDetail(product, "merchant");
  }

  submitOwnProduct(actor: MerchantActor, input: {
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
    this.assertMerchantDepositConfirmed(actor.merchantId, "submit own product");
    const shop = this.getMerchantShop(actor);
    const minSalePriceCents = input.minSalePriceCents ?? input.salePriceCents;
    try {
      quoteMerchantOwnedProduct({ salePriceCents: input.salePriceCents, minSalePriceCents });
    } catch (error) {
      throw new ApiError(400, "PRICE_RULE_FAILED", getErrorMessage(error));
    }
    const now = new Date();
    const review: DemoOwnProduct = {
      id: nextId(this.store, "own"),
      merchantId: actor.merchantId,
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
      minSalePriceCents,
      fulfillmentRule: input.fulfillmentRule ?? { mode: "manual" },
      afterSaleRule: input.afterSaleRule ?? { platformReviewRequired: true },
      reviewStatus: "pending_review",
      status: "pending_review",
      createdAt: now,
      updatedAt: now
    };
    this.store.ownProducts.set(review.id, review);
    this.audit("merchant", "own_product.submit", "own_product", review.id, review);
    return review;
  }

  selectPlatformProduct(actor: MerchantActor, input: MerchantProductListingSelectionInput) {
    this.getMerchantShop(actor);
    this.assertMerchantDepositConfirmed(actor.merchantId, "select platform product");
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
    const existing = [...this.store.merchantProductListings.values()]
      .find((merchantProductListing) => merchantProductListing.shopId === actor.shopId && merchantProductListing.platformProductId === pricing.product.id);
    const merchantProductListing: DemoMerchantProductListing = existing ?? {
      id: nextId(this.store, "ap"),
      merchantId: actor.merchantId,
      shopId: actor.shopId,
      productType: "platform",
      platformProductId: pricing.product.id,
      ownProductReviewId: null,
      salePriceCents: input.salePriceCents,
      status: "listed"
    };
    merchantProductListing.salePriceCents = input.salePriceCents;
    merchantProductListing.status = "listed";
    this.applyMerchantProductListingDisplayOverrides(merchantProductListing, input);
    this.store.merchantProductListings.set(merchantProductListing.id, merchantProductListing);
    this.audit("merchant", "merchant_product_listing.select_platform", "merchant_product_listing", merchantProductListing.id, merchantProductListing);
    return merchantProductListing;
  }

  upsertMerchantChannelProductOffer(actor: MerchantActor, input: { downstreamMerchantId: string; platformProductId: string; resellSupplyPriceCents: bigint; status?: string }) {
    this.assertMerchantDepositConfirmed(actor.merchantId, "configure transfer price");
    const relation = this.findDirectDownstreamRelation(actor.merchantId, input.downstreamMerchantId);
    if (!relation) {
      if (this.merchantTier(actor.merchantId) === "third_tier") {
        throw new ApiError(403, "FOURTH_TIER_FORBIDDEN", "third-tier merchants cannot configure downstream transfer price");
      }
      throw new ApiError(403, "FORBIDDEN_MERCHANT_SCOPE", "downstream merchant is not directly related to current merchant");
    }
    if (relation.status !== "active") throw new ApiError(400, "CHANNEL_RULE_FAILED", "channel relation is not active");
    return this.upsertChannelOfferForRelation("merchant", relation, input);
  }


  batchSelectPlatformProducts(actor: MerchantActor, input: { items: MerchantProductListingSelectionInput[] }) {
    if (input.items.length === 0) throw new ApiError(400, "BATCH_EMPTY", "items are required");
    if (input.items.length > 50) throw new ApiError(400, "BATCH_TOO_LARGE", "batch size cannot exceed 50");
    this.assertMerchantDepositConfirmed(actor.merchantId, "batch select platform products");
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
    this.notify(actor.merchantId, "product.batch_listed", "批量选品已完成", `已处理 ${results.length} 个商品。`);
    this.audit("merchant", "merchant_product_listing.batch_select_platform", "merchant_product_listing", actor.shopId, { count: results.length });
    return { count: results.length, items: results };
  }

  reviewMerchant(actor: AdminActor, merchantId: string, input: { approved: boolean; reason?: string }) {
    assertAdminPermission(actor, "merchant.review");
    const merchant = requireEntity(this.store.merchants.get(merchantId), "RESOURCE_NOT_FOUND", "merchant not found");
    merchant.status = input.approved ? "pending_deposit" : "rejected";
    let credential: { account: string; initialPassword: string; mustResetPassword: boolean } | undefined;
    if (input.approved && !merchant.initialPasswordSet) {
      const initialPassword = `TS${Date.now().toString().slice(-6)}`;
      merchant.initialPasswordSet = true;
      merchant.merchantUsername = merchant.id;
      merchant.passwordHash = `sha256:${hashSecret(initialPassword)}`;
      credential = {
        account: merchant.merchantUsername,
        initialPassword,
        mustResetPassword: true
      };
    }
    for (const relation of this.store.channelRelations) {
      if (relation.status === "pending_review" && (relation.secondTierMerchantId === merchantId || relation.thirdTierMerchantId === merchantId)) {
        relation.status = input.approved ? "pending_deposit" : "closed";
        relation.reason = input.reason ?? relation.reason;
      }
    }
    this.audit(actor.role, "merchant.review", "merchant", merchantId, input);
    return credential ? { ...merchant, credential } : merchant;
  }


  listMerchantApplications(actor: AdminActor) {
    assertAdminPermission(actor, "merchant.review");
    return [...this.store.merchantApplications.values()];
  }


  createMerchantByAdmin(actor: AdminActor, input: {
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
    assertAdminPermission(actor, "merchant.review");
    if (input.targetTier && input.targetTier !== "first_tier") {
      this.audit(actor.role, "merchant.admin_create_rejected_non_first_tier", "merchant", input.targetTier, {
        targetTier: input.targetTier,
        operatorId: actor.adminId
      });
      throw new ApiError(400, "ADMIN_CREATE_FIRST_TIER_ONLY", "admin manual creation can only create first-tier merchants");
    }
    const merchantId = nextId(this.store, "merchant");
    const shopId = nextId(this.store, "shop");
    const userId = nextId(this.store, "merchant-user");
    const initialPassword = input.initialPassword ?? `TS${Date.now().toString().slice(-6)}`;
    const requiredAmount = input.depositRequiredAmountCents ?? input.depositAmountCents;
    if (requiredAmount === undefined || requiredAmount <= 0n) {
      throw new ApiError(400, "DEPOSIT_REQUIREMENT_MISSING", "deposit required amount is required");
    }
    const paidAmount = input.depositPaid ? (input.depositAmountCents ?? requiredAmount) : 0n;
    const paid = paidAmount >= requiredAmount;
    const merchant: DemoMerchant = {
      id: merchantId,
      userId,
      name: input.name,
      contactPhone: input.contactPhone,
      tier: "first_tier",
      status: paid ? "active" : "pending_deposit",
      riskStatus: "normal",
      depositStatus: paid ? "paid" : "pending_payment",
      createdByAdminId: actor.adminId,
      initialPasswordSet: true,
      merchantUsername: merchantId,
      passwordHash: `sha256:${hashSecret(initialPassword)}`
    };
    const shop: DemoShop = {
      id: shopId,
      merchantId,
      ownerType: "merchant",
      name: input.shopName ?? `${input.name} 小店`,
      status: paid ? "open" : "not_opened",
      riskStatus: "normal",
      announcement: "精选虚拟权益，付款后按商品规则发放。",
      customerServiceWechat: input.customerServiceWechat,
      themeColor: "#ff9900",
      shareTitle: `${input.name} 官方小店`,
      createdByAdminId: actor.adminId
    };
    this.store.merchants.set(merchantId, merchant);
    this.store.shops.set(shopId, shop);
    this.store.depositAccounts.set(merchantId, {
      merchantId,
      requiredAmountCents: requiredAmount,
      availableAmountCents: paidAmount,
      frozenAmountCents: 0n,
      deductedAmountCents: 0n,
      status: paid ? "paid" : "pending_payment"
    });
    if (paidAmount > 0n) {
      this.addDepositTransaction(merchantId, {
        type: "pay",
        amountCents: paidAmount,
        balanceBeforeCents: 0n,
        balanceAfterCents: paidAmount,
        reasonCode: "admin_manual_create",
        relatedType: "merchant",
        relatedId: merchantId,
        idempotencyKey: `admin-create-merchant:${merchantId}:deposit`,
        proofUrl: "admin://manual-first-tier",
        operatorId: actor.adminId,
        remark: "后台手工开一级商户并确认保证金"
      });
    }
    this.audit(actor.role, "merchant.admin_create_first_tier", "merchant", merchantId, {
      merchantId,
      shopId,
      depositPaid: paid,
      operatorId: actor.adminId
    });
    return {
      merchant,
      shop,
      credential: {
        account: merchantId,
        initialPassword,
        mustResetPassword: true
      }
    };
  }

  confirmDeposit(actor: AdminActor, merchantId: string, input: { amountCents: bigint; requiredAmountCents?: bigint; voucherUrl?: string; remark?: string }) {
    assertAdminPermission(actor, "deposit.manage");
    const merchant = requireEntity(this.store.merchants.get(merchantId), "RESOURCE_NOT_FOUND", "merchant not found");
    const account = requireEntity(this.store.depositAccounts.get(merchantId), "RESOURCE_NOT_FOUND", "deposit account not found");
    const idempotencyKey = `deposit:pay:manual:${merchantId}:${input.voucherUrl ?? input.amountCents.toString()}`;
    const result = this.registry.runOnce(idempotencyKey, () => {
      account.requiredAmountCents = input.requiredAmountCents ?? account.requiredAmountCents;
      const before = account.availableAmountCents;
      account.availableAmountCents += input.amountCents;
      account.status = account.availableAmountCents < account.requiredAmountCents ? "insufficient" : "paid";
      merchant.depositStatus = account.status;
      if (merchant.status === "pending_deposit" && account.status === "paid") {
        merchant.status = "active";
        const shop = [...this.store.shops.values()].find((candidate) => candidate.merchantId === merchant.id);
        if (shop) shop.status = "open";
        this.activateEligibleInviteRelations(merchant.id);
      }
      const transaction = this.addDepositTransaction(merchantId, {
        type: "pay",
        amountCents: input.amountCents,
        balanceBeforeCents: before,
        balanceAfterCents: account.availableAmountCents,
        reasonCode: "manual_confirm",
        relatedType: "deposit",
        relatedId: merchantId,
        idempotencyKey,
        proofUrl: input.voucherUrl,
        operatorId: actor.adminId,
        remark: input.remark
      });
      this.ledger("DEPOSIT_CONFIRMED", { merchantId }, input.amountCents, { transactionNo: transaction.transactionNo });
      this.audit(actor.role, "deposit.confirm", "merchant", merchantId, transaction);
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
    merchantId?: string;
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
      .filter((product) => !filters.merchantId || product.merchantId === filters.merchantId)
      .filter((product) => !filters.shopId || product.shopId === filters.shopId)
      .sort((left, right) => {
        if (left.reviewStatus === right.reviewStatus) return left.id.localeCompare(right.id);
        if (left.reviewStatus === "pending_review") return -1;
        if (right.reviewStatus === "pending_review") return 1;
        return left.reviewStatus.localeCompare(right.reviewStatus);
      })
      .map((product) => {
        const merchant = this.store.merchants.get(product.merchantId);
        const shop = this.store.shops.get(product.shopId);
        return {
          id: product.id,
          ownProductId: product.id,
          merchantId: product.merchantId,
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
          merchant: merchant ? { id: merchant.id, name: merchant.name, tier: merchant.tier, status: merchant.status } : undefined,
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
    let merchantProductListing: DemoMerchantProductListing | undefined;
    if (input.approved) {
      merchantProductListing = {
        id: nextId(this.store, "ap"),
        merchantId: ownProduct.merchantId,
        shopId: ownProduct.shopId,
        productType: "merchant_owned",
        platformProductId: null,
        ownProductReviewId: ownProduct.id,
        salePriceCents: ownProduct.salePriceCents,
        status: "listed"
      };
      ownProduct.status = "listed";
      this.store.merchantProductListings.set(merchantProductListing.id, merchantProductListing);
    }
    this.audit(actor.role, "own_product.review", "own_product", ownProduct.id, input);
    return { ownProduct, merchantProductListing };
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
      transactions: this.store.depositTransactions.filter((transaction) => transaction.merchantId === account.merchantId)
    }));
  }

  listAdminChannels(actor: AdminActor) {
    assertAdminPermission(actor, "merchant.review");
    return {
      authorizations: this.store.channelAuthorizations,
      relations: this.store.channelRelations,
      offers: this.store.channelProductOffers
    };
  }

  reviewChannelAuthorization(actor: AdminActor, merchantId: string, input: { approved: boolean; reason?: string }) {
    assertAdminPermission(actor, "merchant.review");
    const merchant = requireEntity(this.store.merchants.get(merchantId), "RESOURCE_NOT_FOUND", "merchant not found");
    const existing = this.store.channelAuthorizations.find((item) => item.firstTierMerchantId === merchant.id);
    const authorization = existing ?? {
      id: nextId(this.store, "channel-auth"),
      firstTierMerchantId: merchant.id,
      status: "pending_review",
      reason: null,
      reviewedAt: null
    };
    authorization.status = input.approved ? "active" : "rejected";
    authorization.reason = input.reason ?? null;
    authorization.reviewedAt = new Date();
    if (!existing) this.store.channelAuthorizations.push(authorization);
    this.audit(actor.role, "channel.authorization.review", "merchant", merchant.id, authorization);
    return authorization;
  }

  createChannelRelation(actor: AdminActor, input: { firstTierMerchantId: string; secondTierMerchantId: string; thirdTierMerchantId?: string; reason?: string }) {
    assertAdminPermission(actor, "merchant.review");
    if (input.firstTierMerchantId === input.secondTierMerchantId || input.thirdTierMerchantId === input.firstTierMerchantId || input.thirdTierMerchantId === input.secondTierMerchantId) {
      throw new ApiError(400, "MERCHANT_SUPPLY_RULE_FAILED", "upstream and downstream merchants cannot be the same merchant");
    }
    const firstTier = requireEntity(this.store.merchants.get(input.firstTierMerchantId), "RESOURCE_NOT_FOUND", "first tier merchant not found");
    const secondTier = requireEntity(this.store.merchants.get(input.secondTierMerchantId), "RESOURCE_NOT_FOUND", "second tier merchant not found");
    const thirdTier = input.thirdTierMerchantId ? requireEntity(this.store.merchants.get(input.thirdTierMerchantId), "RESOURCE_NOT_FOUND", "third tier merchant not found") : undefined;
    const authorization = this.store.channelAuthorizations.find((item) => item.firstTierMerchantId === firstTier.id && item.status === "active");
    if (!authorization) throw new ApiError(400, "MERCHANT_SUPPLY_RULE_FAILED", "first tier merchant is not authorized for downstream supply");
    if (this.store.channelRelations.some((item) => item.status === "active" && (item.secondTierMerchantId === firstTier.id || item.thirdTierMerchantId === firstTier.id))) {
      throw new ApiError(400, "MERCHANT_SUPPLY_RULE_FAILED", "fourth-tier merchant creation is forbidden");
    }
    if (firstTier.status !== "active" || secondTier.status !== "active" || (thirdTier && thirdTier.status !== "active")) {
      throw new ApiError(400, "MERCHANT_SUPPLY_RULE_FAILED", "merchant supply participants must be active");
    }
    this.assertMerchantDepositConfirmed(firstTier.id, "create channel relation");
    this.assertMerchantDepositConfirmed(secondTier.id, "create channel relation");
    if (thirdTier) this.assertMerchantDepositConfirmed(thirdTier.id, "create channel relation");
    const activeUniqueKey = thirdTier ? `third-tier:${thirdTier.id}` : `second-tier:${secondTier.id}`;
    const existing = this.store.channelRelations.find((item) => item.activeUniqueKey === activeUniqueKey && item.status === "active");
    if (existing) {
      this.audit(actor.role, "channel.relation.create", "channel_relation", existing.id, existing);
      return existing;
    }
    const relation = {
      id: nextId(this.store, "channel-rel"),
      firstTierMerchantId: firstTier.id,
      secondTierMerchantId: secondTier.id,
      thirdTierMerchantId: thirdTier?.id,
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
    this.assertMerchantDepositConfirmed(relation.firstTierMerchantId, "configure channel offer");
    this.assertMerchantDepositConfirmed(relation.secondTierMerchantId, "configure channel offer");
    if (relation.thirdTierMerchantId) this.assertMerchantDepositConfirmed(relation.thirdTierMerchantId, "configure channel offer");
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

  listMerchantRightsCodes(actor: MerchantActor, filters: { merchantProductListingId?: string; status?: RightsCode["status"] } = {}) {
    const products = [...this.store.merchantProductListings.values()]
      .filter((product) => product.merchantId === actor.merchantId && product.shopId === actor.shopId && product.productType === "merchant_owned");
    const allowedIds = new Set(products.map((product) => product.id));
    return this.store.rightsCodes
      .filter((code) => allowedIds.has(code.merchantProductListingId ?? code.productId))
      .filter((code) => !filters.merchantProductListingId || code.productId === filters.merchantProductListingId || code.merchantProductListingId === filters.merchantProductListingId)
      .filter((code) => !filters.status || code.status === filters.status)
      .map((code) => this.redactRightsCode(code));
  }


  precheckMerchantRightsCodes(actor: MerchantActor, input: { merchantProductListingId: string; codes: string[] }) {
    this.assertMerchantDepositConfirmed(actor.merchantId, "import own rights codes");
    const merchantProductListing = requireEntity(this.store.merchantProductListings.get(input.merchantProductListingId), "RESOURCE_NOT_FOUND", "merchant product not found");
    assertMerchantScope(actor, merchantProductListing);
    if (merchantProductListing.productType !== "merchant_owned") {
      throw new ApiError(400, "RIGHTS_CODE_PRODUCT_SCOPE_INVALID", "merchant can only import card codes for own reviewed products");
    }
    const ownProduct = requireEntity(this.store.ownProducts.get(required(merchantProductListing.ownProductReviewId, "ownProductReviewId")), "RESOURCE_NOT_FOUND", "own product not found");
    if (fulfillmentRuleMode(ownProduct.fulfillmentRule) !== "code_pool") {
      throw new ApiError(400, "RIGHTS_CODE_PRODUCT_MODE_INVALID", "own product must use automatic card-code fulfillment");
    }
    const precheck = this.analyzeRightsCodeImport(input.codes, (code) =>
      this.store.rightsCodes.some((item) => (item.merchantProductListingId ?? item.productId) === merchantProductListing.id && item.code === code)
    );
    return this.redactRightsCodeImportPrecheck(precheck);
  }


  addMerchantRightsCodes(actor: MerchantActor, input: { merchantProductListingId: string; codes: string[]; batchNo?: string }) {
    this.assertMerchantDepositConfirmed(actor.merchantId, "import own rights codes");
    const merchantProductListing = requireEntity(this.store.merchantProductListings.get(input.merchantProductListingId), "RESOURCE_NOT_FOUND", "merchant product not found");
    assertMerchantScope(actor, merchantProductListing);
    if (merchantProductListing.productType !== "merchant_owned") {
      throw new ApiError(400, "RIGHTS_CODE_PRODUCT_SCOPE_INVALID", "merchant can only import card codes for own reviewed products");
    }
    const ownProduct = requireEntity(this.store.ownProducts.get(required(merchantProductListing.ownProductReviewId, "ownProductReviewId")), "RESOURCE_NOT_FOUND", "own product not found");
    const rule = ownProduct.fulfillmentRule;
    if (!isRecord(rule) || rule.mode !== "code_pool") {
      throw new ApiError(400, "RIGHTS_CODE_PRODUCT_MODE_INVALID", "own product must use automatic card-code fulfillment");
    }
    ownProduct.fulfillmentRule = { ...rule, mode: "code_pool", extractCodeRequired: true };
    const precheck = this.analyzeRightsCodeImport(input.codes, (code) =>
      this.store.rightsCodes.some((item) => (item.merchantProductListingId ?? item.productId) === merchantProductListing.id && item.code === code)
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
        productId: merchantProductListing.id,
        merchantProductListingId: merchantProductListing.id,
        merchantProductId: merchantProductListing.id,
        code,
        batchNo: input.batchNo ?? "merchant",
        status: "available",
        createdAt: new Date()
      };
      this.store.rightsCodes.push(item);
      created.push(item);
    }
    this.audit("merchant", "rights_code.merchant_import", "merchant_product_listing", merchantProductListing.id, {
      count: created.length,
      batchNo: input.batchNo ?? "merchant",
      codeIds: created.map((code) => code.codeId)
    });
    return {
      count: created.length,
      createdCount: created.length,
      skippedCount: precheck.summary.skipped,
      failedCount: precheck.summary.failed,
      merchantProductListing,
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

  fulfillMerchantOrder(actor: MerchantActor, orderNo: string, input: { status: "success" | "failed"; attemptNo: number; evidence?: string; failReason?: string }) {
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertMerchantScope(actor, { merchantId: order.merchantId, shopId: order.shopId });
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
    this.audit("merchant", "fulfillment.update", "order", orderNo, input);
    return { ...result, order };
  }


  listMerchantAfterSales(actor: MerchantActor) {
    return [...this.store.afterSales.values()].filter((afterSale) => {
      const order = this.store.orders.get(afterSale.orderNo);
      return order?.merchantId === actor.merchantId && order.shopId === actor.shopId;
    });
  }


  updateMerchantAfterSaleAssist(actor: MerchantActor, afterSaleNo: string, input: { note: string; evidenceUrl?: string }) {
    const afterSale = requireEntity(this.store.afterSales.get(afterSaleNo), "RESOURCE_NOT_FOUND", "after sale not found");
    const order = requireEntity(this.store.orders.get(afterSale.orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertMerchantScope(actor, { merchantId: order.merchantId, shopId: order.shopId });
    this.audit("merchant", "after_sale.merchant_assist", "after_sale", afterSale.afterSaleNo, input);
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
    merchantBearCents?: bigint;
    serviceFeeBearer?: "platform" | "merchant" | "mixed" | "none";
  }) {
    assertAdminPermission(actor, "after_sale.arbitrate");
    const afterSale = requireEntity(this.store.afterSales.get(afterSaleNo), "RESOURCE_NOT_FOUND", "after sale not found");
    const order = requireEntity(this.store.orders.get(afterSale.orderNo), "RESOURCE_NOT_FOUND", "order not found");
    let allocation: ReturnType<typeof allocateRefund>;
    try {
      allocation = allocateRefund({
        paidAmountCents: order.snapshot.amountSnapshot.paidAmountCents,
        supplyAmountCents: order.snapshot.amountSnapshot.supplyAmountCents,
        merchantIncomeCents: order.snapshot.amountSnapshot.merchantExpectedIncomeCents,
        alreadyRefundedCents: order.refundedAmountCents,
        refundAmountCents: input.refundAmountCents,
        responsibility: input.responsibility,
        platformBearCents: input.platformBearCents,
        merchantBearCents: input.merchantBearCents,
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
      merchantClawbackCents: allocation.merchantTotalCostCents,
      wasSettled: wasSettlementGenerated,
      status: "pending"
    };
    this.store.refunds.set(refund.refundNo, refund);
    this.voidCouponForRefundedOrder(order);
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
        this.store.pendingIncomeByMerchant.set(order.merchantId, (this.store.pendingIncomeByMerchant.get(order.merchantId) ?? 0n) + order.snapshot.amountSnapshot.merchantExpectedIncomeCents);
        this.addChannelPendingIncome(order);
      }
      this.ledger("OFFLINE_PAYMENT_CONFIRMED", { orderNo: order.orderNo, merchantId: order.merchantId }, expectedAmount, {
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
            this.store.pendingIncomeByMerchant.set(order.merchantId, (this.store.pendingIncomeByMerchant.get(order.merchantId) ?? 0n) + order.snapshot.amountSnapshot.merchantExpectedIncomeCents);
            this.addChannelPendingIncome(order);
          }
          this.ledger("PAYMENT_SUCCEEDED", { orderNo: order.orderNo, merchantId: order.merchantId }, order.snapshot.amountSnapshot.paidAmountCents, { channel: input.channel });
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

  epayProviderCallback(rawPayload: Record<string, unknown>) {
    const input = normalizeEpayCallbackPayload(rawPayload);
    const order = input.orderNo ? this.store.orders.get(input.orderNo) : undefined;
    const method = this.findPaymentMethodForCallback("epay", { merchantNo: input.merchantNo }, order);
    const logBase = {
      id: nextId(this.store, "pay-callback"),
      provider: "epay" as const,
      orderNo: input.orderNo,
      providerTradeNo: input.providerTradeNo,
      amountCents: input.amountCents,
      merchantNoMasked: maskSecret(input.merchantNo),
      rawPayloadMasked: this.maskPaymentPayload(rawPayload),
      receivedAt: new Date()
    };
    if (!method || !this.verifyEpaySignature(method, rawPayload)) {
      const exception = this.recordPaymentException({
        ...logBase,
        orderNo: input.orderNo,
        reasonCode: "SIGNATURE_INVALID",
        reason: "epay callback signature verification failed",
        handled: false
      });
      this.store.paymentCallbackLogs.push({ ...logBase, verified: false, status: "rejected", exceptionId: exception.id });
      throw new ApiError(400, "PAYMENT_CALLBACK_SIGNATURE_INVALID", "epay callback signature verification failed");
    }
    const orderEntity = order ?? this.store.orders.get(input.orderNo ?? "");
    if (!orderEntity) {
      const exception = this.recordPaymentException({
        ...logBase,
        reasonCode: "ORDER_NOT_FOUND",
        reason: "epay callback order not found",
        handled: false
      });
      this.store.paymentCallbackLogs.push({ ...logBase, verified: true, status: "exception", exceptionId: exception.id });
      throw new ApiError(404, "PAYMENT_CALLBACK_ORDER_NOT_FOUND", "epay callback order not found");
    }
    const result = this.applyVerifiedPaymentResult({
      order: orderEntity,
      method,
      providerTradeNo: input.providerTradeNo,
      amountCents: input.amountCents,
      merchantNo: input.merchantNo,
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
    this.ledger("REFUND_SUCCEEDED", { orderNo: order.orderNo, merchantId: order.merchantId }, refund.amountCents, {
      refundNo: refund.refundNo,
      source: input.source,
      channelRefundNo: input.channelRefundNo,
      voucherUrl: input.voucherUrl
    });

    if (order.salesChannelType === "platform_self_operated") {
      refund.pendingIncomeDeductedCents = 0n;
    } else if (refund.wasSettled) {
      this.createClawback(order, refund.merchantClawbackCents, "refund", refund.refundNo);
    } else {
      const pending = this.store.pendingIncomeByMerchant.get(order.merchantId) ?? 0n;
      const deduction = pending > refund.merchantClawbackCents ? refund.merchantClawbackCents : pending;
      this.store.pendingIncomeByMerchant.set(order.merchantId, pending - deduction);
      refund.pendingIncomeDeductedCents = deduction;
    }
    this.voidCouponForRefundedOrder(order);
    return { refund, order, afterSale };
  }

  private voidCouponForRefundedOrder(order: DemoOrder) {
    const coupon = order.couponId
      ? this.store.userCoupons.get(order.couponId)
      : [...this.store.userCoupons.values()].find((item) => item.orderNo === order.orderNo);
    if (!coupon) return;
    coupon.status = "voided_after_refund";
    coupon.orderNo = order.orderNo;
    coupon.usedAt ??= new Date();
    order.couponId = coupon.id;
  }

  generateSettlement(actor: AdminActor, input: { merchantId: string; now?: Date; batchNo: string }) {
    assertAdminPermission(actor, "settlement.generate");
    const idempotencyKey = `settlement:${input.merchantId}:all:${input.batchNo}`;
    const duplicate = this.store.settlementSheets.find((sheet) => sheet.idempotencyKey === idempotencyKey);
    if (duplicate) return { status: "duplicate" as const, sheet: duplicate };
    const now = input.now ?? new Date();
    const orders = [...this.store.orders.values()]
      .filter((order) => order.salesChannelType !== "platform_self_operated")
      .flatMap((order) => {
        const channel = getChannelSnapshot(order.snapshot);
        const drafts: Array<SettlementCandidateDraft & { settlementRole: string }> = [];
        if (channel?.firstTierMerchantId === input.merchantId) {
          drafts.push({
            orderId: order.orderNo,
            settlementRole: "first_tier",
            merchantId: channel.firstTierMerchantId,
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
            merchantIncomeCents: channel.firstTierIncomeCents
          });
        }
        if (channel?.thirdTierMerchantId && channel.secondTierMerchantId === input.merchantId) {
          drafts.push({
            orderId: order.orderNo,
            settlementRole: "second_tier",
            merchantId: channel.secondTierMerchantId,
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
            merchantIncomeCents: channel.secondTierIncomeCents
          });
        }
        if (order.merchantId === input.merchantId) drafts.push({
          orderId: order.orderNo,
          settlementRole: channel?.thirdTierMerchantId ? "third_tier" : channel ? "second_tier" : "single_merchant",
          merchantId: order.merchantId,
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
          merchantIncomeCents: order.snapshot.amountSnapshot.merchantExpectedIncomeCents
        });
        return drafts;
      });
    const candidates = orders.filter((order) => !this.store.settlementItemKeys.has(`${order.orderId}:${order.settlementRole}:${order.merchantId}`));
    const items = buildSettlementItems(candidates, [], input.merchantId).map((item) => {
      const source = candidates.find((candidate) => candidate.orderId === item.orderId && candidate.merchantId === item.merchantId);
      return { ...item, settlementRole: source?.settlementRole ?? "single_merchant" };
    });
    const sheet: SettlementSheet = {
      settlementNo: nextId(this.store, "settlement"),
      merchantId: input.merchantId,
      idempotencyKey,
      status: "confirmed",
      items,
      totalOrderCount: items.length,
      totalPaidCents: sum(items.map((item) => item.paidAmountCents)),
      totalServiceFeeCents: sum(items.map((item) => item.serviceFeeCents)),
      totalMerchantIncomeCents: sum(items.map((item) => item.merchantIncomeCents))
    };
    for (const item of items) {
      this.store.settlementItemKeys.add(`${item.orderId}:${item.settlementRole}:${item.merchantId}`);
      const order = this.store.orders.get(item.orderId);
      if (order) {
        const channel = getChannelSnapshot(order.snapshot);
        if (!channel || (!channel.thirdTierMerchantId && item.settlementRole === "second_tier") || (channel.thirdTierMerchantId && item.settlementRole === "third_tier")) {
          order.settlementStatus = "settling";
        }
      }
    }
    const pending = this.store.pendingIncomeByMerchant.get(input.merchantId) ?? 0n;
    this.store.pendingIncomeByMerchant.set(input.merchantId, pending > sheet.totalMerchantIncomeCents ? pending - sheet.totalMerchantIncomeCents : 0n);
    this.store.payableIncomeByMerchant.set(input.merchantId, (this.store.payableIncomeByMerchant.get(input.merchantId) ?? 0n) + sheet.totalMerchantIncomeCents);
    this.store.settlementSheets.push(sheet);
    this.audit(actor.role, "settlement.generate", "settlement", sheet.settlementNo, { count: items.length });
    this.ledger("SETTLEMENT_GENERATED", { merchantId: input.merchantId }, sheet.totalMerchantIncomeCents, { settlementNo: sheet.settlementNo });
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
    const payable = this.store.payableIncomeByMerchant.get(sheet.merchantId) ?? 0n;
    this.store.payableIncomeByMerchant.set(sheet.merchantId, payable > sheet.totalMerchantIncomeCents ? payable - sheet.totalMerchantIncomeCents : 0n);
    this.store.paidIncomeByMerchant.set(sheet.merchantId, (this.store.paidIncomeByMerchant.get(sheet.merchantId) ?? 0n) + sheet.totalMerchantIncomeCents);
    const payout = {
      payoutNo: nextId(this.store, "payout"),
      settlementNo,
      merchantId: sheet.merchantId,
      amountCents: sheet.totalMerchantIncomeCents,
      status: "paid",
      voucherUrl: input.voucherUrl,
      payoutMethod: input.payoutMethod ?? "manual"
    };
    this.store.manualPayouts.push(payout);
    this.audit(actor.role, "manual_payout.confirm", "settlement", settlementNo, payout);
    this.ledger("PAYOUT_CONFIRMED", { merchantId: sheet.merchantId }, sheet.totalMerchantIncomeCents, { settlementNo });
    return { status: "processed" as const, sheet, payout };
  }

  deductDeposit(actor: AdminActor, merchantId: string, input: { amountCents: bigint; sourceType: string; sourceId: string; reasonCode: string }) {
    assertAdminPermission(actor, "deposit.manage");
    const account = requireEntity(this.store.depositAccounts.get(merchantId), "RESOURCE_NOT_FOUND", "deposit account not found");
    const result = deductDeposit({ registry: this.registry, account, ...input });
    if (result.status === "processed") {
      const merchant = this.store.merchants.get(merchantId);
      if (merchant && result.restricted) merchant.depositStatus = "insufficient";
      this.addDepositTransaction(merchantId, {
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
    this.audit(actor.role, "deposit.deduct", "merchant", merchantId, result);
    this.ledger("DEPOSIT_DEDUCTED", { merchantId }, result.status === "processed" ? result.deductedAmountCents : 0n, { sourceType: input.sourceType, sourceId: input.sourceId });
    return result;
  }

  createRiskFreeze(actor: AdminActor, input: {
    targetType: "order" | "shop" | "merchant" | "product" | "settlement";
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
    if (input.targetType === "merchant") {
      const merchant = requireEntity(this.store.merchants.get(input.targetId), "RESOURCE_NOT_FOUND", "merchant not found");
      merchant.riskStatus = input.freezeType;
      if (input.freezeType === "disabled") merchant.status = "disabled";
      if (input.freezeType === "shop_frozen") merchant.status = "frozen";
    }
    if (input.targetType === "product") {
      const product = this.store.platformProducts.get(input.targetId);
      const merchantProductListing = this.store.merchantProductListings.get(input.targetId);
      if (product) product.status = "risk_removed";
      if (merchantProductListing) merchantProductListing.status = "risk_removed";
      if (!product && !merchantProductListing) throw new ApiError(404, "RESOURCE_NOT_FOUND", "product not found");
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
      totalMerchantIncomeCents: sum(orders.filter((order) => order.paymentStatus === "paid").map((order) => order.snapshot.amountSnapshot.merchantExpectedIncomeCents)),
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
        ownerType: shop.ownerType ?? "merchant",
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
    const lowDepositMerchants = [...this.store.depositAccounts.values()]
      .filter((account) => account.availableAmountCents < account.requiredAmountCents / 5n)
      .map((account) => ({ merchantId: account.merchantId, availableAmountCents: account.availableAmountCents, requiredAmountCents: account.requiredAmountCents }));
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
      lowDepositMerchants,
      lowStockProducts,
      pendingAfterSaleCount: [...this.store.afterSales.values()].filter((item) => item.status === "pending").length
    };
  }

  listNotifications(actor: MerchantActor) {
    return this.store.notifications.filter((item) => item.merchantId === actor.merchantId);
  }

  markNotificationRead(actor: MerchantActor, notificationId: string) {
    const notification = requireEntity(
      this.store.notifications.find((item) => item.id === notificationId && item.merchantId === actor.merchantId),
      "RESOURCE_NOT_FOUND",
      "notification not found"
    );
    notification.readAt = notification.readAt ?? new Date();
    return notification;
  }

  paymentOnboardingGuide() {
    return {
      status: "not_configured",
      reason: "微信/支付宝商户收款能力尚未开通；生产环境只展示已审核启用的商户收款方式。",
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
      productionRule: "生产环境必须拒绝未验签的支付/退款回调，并只允许已审核启用的商户收款方式。"
    };
  }

  paymentConfigStatus(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    const methodProviders: PaymentProviderType[] = ["alipay_merchant", "wechat_merchant", "epay", "personal_alipay", "wechat_personal", "balance"];
    const methodRows = methodProviders.map((provider) => {
      const methods = [...this.store.paymentMethods.values()].filter((method) => method.provider === provider);
      const enabled = provider === "balance" || methods.some((method) => method.enabled && method.status === "enabled");
      return {
        channel: provider,
        provider,
        enabled,
        feeBps: this.paymentFeeBpsForProvider(provider),
        fixedFeeCents: 0n,
        statusNote: enabled ? "configured" : "not_configured",
        updatedAt: methods[0]?.updatedAt ?? new Date(0),
        defaultMethod: methods.some((method) => method.isDefault),
        confirmationMode: provider === "balance" ? "automatic" : isManualPaymentProvider(provider) ? "manual" : "automatic",
        methodCount: provider === "balance" ? 1 : methods.length,
        label: paymentProviderDisplay(provider)
      };
    });
    const legacyRows = this.store.paymentChannelConfigs
      .filter((config) => config.channel !== "mock" || mockPaymentEnabled())
      .map((config) => ({
        ...config,
        provider: paymentChannelProvider(config.channel),
        label: paymentChannelDisplay(config.channel)
      }));
    return [...legacyRows, ...methodRows];
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
      channels: this.store.paymentChannelConfigs.filter((config) => config.channel !== "mock" || mockPaymentEnabled())
    };
  }

  getPlatformServiceFeeConfig(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return this.store.serviceFeeConfig;
  }

  updatePlatformServiceFeeConfig(actor: AdminActor, input: { enabled?: boolean; feeBps?: number }) {
    assertAdminPermission(actor, "payment_config.manage");
    this.store.serviceFeeConfig = {
      ...this.store.serviceFeeConfig,
      enabled: input.enabled ?? this.store.serviceFeeConfig.enabled,
      feeBps: input.feeBps ?? this.store.serviceFeeConfig.feeBps,
      updatedBy: actor.adminId,
      updatedAt: new Date()
    };
    this.audit(actor.role, "platform_service_fee.update", "platform_service_fee", "active", this.store.serviceFeeConfig);
    return this.store.serviceFeeConfig;
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

  listMerchantPaymentMethods(actor: MerchantActor) {
    this.getMerchantShop(actor);
    return [...this.store.paymentMethods.values()]
      .filter((method) => method.ownerType === "merchant" && method.merchantId === actor.merchantId && method.shopId === actor.shopId)
      .map((method) => this.serializePaymentMethod(method));
  }


  upsertMerchantPaymentMethod(actor: MerchantActor, input: PaymentMethodUpsertInput) {
    this.getMerchantShop(actor);
    const method = this.upsertPaymentMethod("merchant", actor.merchantId, {
      ...input,
      merchantId: actor.merchantId,
      shopId: actor.shopId
    });
    this.audit("merchant", "payment_method.upsert", "payment_method", method.id, this.serializePaymentMethod(method));
    return this.serializePaymentMethod(method);
  }


  setMerchantPaymentMethodDefault(actor: MerchantActor, methodId: string) {
    this.getMerchantShop(actor);
    const method = requireEntity(this.store.paymentMethods.get(methodId), "RESOURCE_NOT_FOUND", "payment method not found");
    assertMerchantScope(actor, { merchantId: required(method.merchantId, "merchantId"), shopId: method.shopId });
    this.setPaymentMethodDefault(method);
    this.audit("merchant", "payment_method.default", "payment_method", method.id, this.serializePaymentMethod(method));
    return this.serializePaymentMethod(method);
  }


  deleteMerchantPaymentMethod(actor: MerchantActor, methodId: string) {
    this.getMerchantShop(actor);
    const method = requireEntity(this.store.paymentMethods.get(methodId), "RESOURCE_NOT_FOUND", "payment method not found");
    assertMerchantScope(actor, { merchantId: required(method.merchantId, "merchantId"), shopId: method.shopId });
    method.status = "disabled";
    method.enabled = false;
    method.updatedAt = new Date();
    this.audit("merchant", "payment_method.disable", "payment_method", method.id, this.serializePaymentMethod(method));
    return this.serializePaymentMethod(method);
  }


  testMerchantPaymentMethod(actor: MerchantActor, methodId: string) {
    this.getMerchantShop(actor);
    const method = requireEntity(this.store.paymentMethods.get(methodId), "RESOURCE_NOT_FOUND", "payment method not found");
    assertMerchantScope(actor, { merchantId: required(method.merchantId, "merchantId"), shopId: method.shopId });
    const result = this.testPaymentMethod(method);
    this.audit("merchant", "payment_method.test", "payment_method", method.id, result);
    return result;
  }


  listServiceQrCodes(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return [...this.store.shops.values()].map((shop) => ({
      shopId: shop.id,
      ownerType: shop.ownerType ?? "merchant",
      merchantId: shop.merchantId,
      name: shop.name,
      customerServiceWechat: shop.customerServiceWechat,
      customerServiceQrUrl: shop.customerServiceQrUrl,
      customerServiceQq: shop.customerServiceQq,
      customerServiceQqQrUrl: shop.customerServiceQqQrUrl,
      customerServiceNote: shop.customerServiceNote,
      status: shop.status
    }));
  }

  listPublicPaymentMethods(shopIdentifier: string) {
    const shop = this.getShop(shopIdentifier);
    const shopOwnsPaymentMethods = (shop.ownerType ?? "merchant") === "platform";
    const paymentMethods = [...this.store.paymentMethods.values()]
      .filter((method) => method.enabled && method.status === "enabled")
      .filter((method) => method.provider !== "balance")
      .filter((method) => this.paymentMethodIsPublicComplete(method))
      .filter((method) => this.paymentMethodMatchesShopScope(method, shop, shopOwnsPaymentMethods))
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || paymentProviderSort(left.provider) - paymentProviderSort(right.provider))
      .map((method, index) => this.serializePublicPaymentMethodAsChannel(method, index));
    return [
      this.serializePublicPaymentMethodAsChannel(this.balancePaymentMethod(), -1),
      ...paymentMethods
    ];
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

  listMerchantPaymentVouchers(actor: MerchantActor) {
    this.getMerchantShop(actor);
    return [...this.store.paymentVouchers.values()]
      .filter((voucher) => voucher.shopId === actor.shopId)
      .filter((voucher) => {
        const order = this.store.orders.get(voucher.orderNo);
        return order?.merchantId === actor.merchantId && order.shopId === actor.shopId;
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

  confirmMerchantOfflinePayment(actor: MerchantActor, orderNo: string, input: { amountCents: bigint; voucherUrl?: string; note?: string }) {
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertMerchantScope(actor, { merchantId: order.merchantId, shopId: order.shopId });
    return this.confirmCollectedPayment({
      actor: "merchant",
      operatorId: actor.merchantId,
      order,
      amountCents: input.amountCents,
      voucherUrl: input.voucherUrl,
      note: input.note,
      auditRole: "merchant"
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
    coupon.status = input.status === "disabled" ? "inactive" : input.status;
    this.audit(actor.role, "coupon_template.status", "coupon_template", couponId, input);
    return coupon;
  }

  grantCouponTemplate(actor: AdminActor, couponId: string, input: { target: "all_users" | "single_user"; userId?: string; phone?: string }) {
    assertAdminPermission(actor, "product.manage");
    const template = requireEntity(this.store.couponTemplates.get(couponId), "RESOURCE_NOT_FOUND", "coupon template not found");
    if (template.status !== "active") throw new ApiError(400, "COUPON_INACTIVE", "coupon template must be active before grant");
    const userIds = input.target === "all_users"
      ? this.knownUserIds()
      : [this.resolveCouponGrantUserId(input)];
    const uniqueUserIds = Array.from(new Set(userIds.filter(Boolean)));
    const grantedCoupons: UserCoupon[] = [];
    let skipped = 0;
    for (const userId of uniqueUserIds) {
      const duplicated = [...this.store.userCoupons.values()].some((coupon) =>
        coupon.userId === userId
        && coupon.templateId === template.id
        && coupon.status === "available"
      );
      if (duplicated) {
        skipped += 1;
        continue;
      }
      const coupon: UserCoupon = {
        id: nextId(this.store, "coupon-user"),
        templateId: template.id,
        userId,
        status: "available",
        grantReason: input.target === "all_users" ? "admin_all" : "admin_user",
        grantedAt: new Date(),
        usedAt: null,
        orderNo: null
      };
      this.store.userCoupons.set(coupon.id, coupon);
      grantedCoupons.push(coupon);
    }
    this.audit(actor.role, "coupon.grant.admin", "coupon_template", couponId, {
      target: input.target,
      requestedUserId: input.userId,
      requestedPhone: input.phone,
      grantedCount: grantedCoupons.length,
      skippedCount: skipped,
      couponIds: grantedCoupons.map((coupon) => coupon.id)
    });
    return {
      couponTemplate: template,
      grantedCount: grantedCoupons.length,
      skippedCount: skipped,
      coupons: grantedCoupons
    };
  }

  updateShopCollection(actor: AdminActor, shopId: string, input: { collectionAccountName?: string; collectionQrUrl?: string; collectionNote?: string }) {
    assertAdminPermission(actor, "merchant.review");
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
    assertAdminPermission(actor, "merchant.review");
    const shop = this.getShop(shopId);
    shop.customerServiceWechat = input.customerServiceWechat ?? shop.customerServiceWechat;
    shop.customerServiceQrUrl = input.customerServiceQrUrl ?? shop.customerServiceQrUrl;
    shop.customerServiceQq = input.customerServiceQq ?? shop.customerServiceQq;
    shop.customerServiceQqQrUrl = input.customerServiceQqQrUrl ?? shop.customerServiceQqQrUrl;
    shop.customerServiceNote = input.customerServiceNote ?? shop.customerServiceNote;
    this.audit(actor.role, "shop.service_qrcode.update", "shop", shop.id, input);
    return shop;
  }

  private upsertPaymentMethod(ownerType: "platform" | "merchant", operatorId: string, input: PaymentMethodUpsertInput) {
    this.assertPaymentMethodInput(ownerType, input);
    const existing = input.id ? this.store.paymentMethods.get(input.id) : undefined;
    if (existing) {
      if (ownerType === "merchant" && (existing.merchantId !== input.merchantId || existing.shopId !== input.shopId)) {
        throw new ApiError(403, "PAYMENT_METHOD_SCOPE_FORBIDDEN", "cannot update another merchant payment method");
      }
      existing.provider = input.provider ?? existing.provider;
      existing.displayName = input.displayName ?? existing.displayName;
      existing.productType = input.productType ?? existing.productType;
      existing.merchantNo = input.merchantNo ?? existing.merchantNo;
      existing.appId = input.appId ?? existing.appId;
      existing.serviceProviderId = input.serviceProviderId ?? existing.serviceProviderId;
      existing.gatewayUrl = input.gatewayUrl ?? existing.gatewayUrl;
      existing.apiMode = input.apiMode ?? existing.apiMode;
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
    const provider = required(input.provider, "provider");
    const method: PaymentMethodConfig = {
      id: nextId(this.store, "payment-method"),
      ownerType,
      merchantId: ownerType === "merchant" ? required(input.merchantId, "merchantId") : input.merchantId,
      shopId: ownerType === "merchant" ? required(input.shopId, "shopId") : input.shopId,
      provider,
      confirmationMode: isManualPaymentProvider(provider) ? "manual" : "automatic",
      displayName: required(input.displayName, "displayName"),
      productType: input.productType,
      merchantNo: input.merchantNo,
      appId: input.appId,
      serviceProviderId: input.serviceProviderId,
      gatewayUrl: input.gatewayUrl,
      apiMode: input.apiMode,
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

  private ensureUserWallet(userId: string): UserWalletState {
    const existing = this.store.userWallets.get(userId);
    if (existing) return existing;
    const wallet: UserWalletState = {
      id: nextId(this.store, "wallet"),
      userId,
      walletNo: `wallet-${userId}`,
      availableBalanceCents: 0n,
      frozenBalanceCents: 0n,
      totalRechargeCents: 0n,
      totalSpendCents: 0n,
      status: "active",
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.store.userWallets.set(userId, wallet);
    return wallet;
  }

  private serializeWallet(wallet: UserWalletState) {
    return {
      walletNo: wallet.walletNo,
      userId: wallet.userId,
      availableBalanceCents: wallet.availableBalanceCents,
      frozenBalanceCents: wallet.frozenBalanceCents,
      totalRechargeCents: wallet.totalRechargeCents,
      totalSpendCents: wallet.totalSpendCents,
      status: wallet.status,
      version: wallet.version
    };
  }

  private recordWalletTransaction(input: {
    userId: string;
    wallet: UserWalletState;
    type: WalletTransactionState["type"];
    direction: "credit" | "debit";
    amountCents: bigint;
    balanceBeforeCents: bigint;
    balanceAfterCents: bigint;
    sourceType: string;
    sourceId: string;
    orderNo?: string;
    paymentNo?: string;
    rechargeNo?: string;
    holdNo?: string;
    note?: string;
  }) {
    const transaction: WalletTransactionState = {
      transactionNo: nextId(this.store, "wallet-tx"),
      userId: input.userId,
      walletId: input.wallet.id,
      type: input.type,
      direction: input.direction,
      amountCents: input.amountCents,
      balanceBeforeCents: input.balanceBeforeCents,
      balanceAfterCents: input.balanceAfterCents,
      frozenBeforeCents: input.wallet.frozenBalanceCents,
      frozenAfterCents: input.wallet.frozenBalanceCents,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      orderNo: input.orderNo,
      paymentNo: input.paymentNo,
      rechargeNo: input.rechargeNo,
      holdNo: input.holdNo,
      note: input.note,
      idempotencyKey: `wallet-tx:${input.sourceType}:${input.sourceId}:${input.type}`,
      createdAt: new Date()
    };
    this.store.walletTransactions.push(transaction);
    return transaction;
  }

  private defaultExternalRechargeMethod() {
    return [...this.store.paymentMethods.values()].find((method) =>
      method.enabled && method.status === "enabled" && method.provider !== "balance"
    );
  }

  private paymentFeeBpsForProvider(provider: PaymentProviderType) {
    if (provider === "balance") return 0;
    const channel = paymentChannelForProvider(provider);
    return this.store.paymentChannelConfigs.find((item) => item.channel === channel)?.feeBps ?? 100;
  }

  private applyPaymentFeeSnapshot(order: DemoOrder, method: PaymentMethodConfig) {
    const baseAmountCents = order.buyerPaidAmountCents ?? order.snapshot.amountSnapshot.paidAmountCents;
    const feeBps = this.paymentFeeBpsForProvider(method.provider);
    const feeCents = calculateServiceFeeCents(baseAmountCents, BigInt(feeBps));
    const amount = order.snapshot.amountSnapshot as DemoAmountSnapshot;
    amount.paymentFeeBps = BigInt(feeBps);
    amount.paymentFeeCents = feeCents;
    amount.balancePaidCents = method.provider === "balance" ? baseAmountCents : 0n;
    amount.externalPaidCents = method.provider === "balance" ? 0n : baseAmountCents + feeCents;
    order.buyerPaidAmountCents = baseAmountCents + feeCents;
    return order.buyerPaidAmountCents;
  }

  private assertPaymentMethodInput(ownerType: "platform" | "merchant", input: PaymentMethodUpsertInput) {
    if (ownerType === "merchant" && (!input.merchantId || !input.shopId)) throw new ApiError(400, "PAYMENT_METHOD_SCOPE_REQUIRED", "merchant payment method requires merchant and shop scope");
    if (!input.provider && !input.id) throw new ApiError(400, "PAYMENT_METHOD_PROVIDER_REQUIRED", "payment provider is required");
    const updatingExisting = Boolean(input.id);
    if (input.provider && isManualPaymentProvider(input.provider)) {
      if (!updatingExisting && (!input.accountName || !input.qrUrl)) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "personal payment requires account name and QR code");
      return;
    }
    if (input.provider === "balance") return;
    if (input.provider && ["alipay_merchant", "wechat_merchant", "epay"].includes(input.provider)) {
      if (!updatingExisting && !input.merchantNo) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "merchant number is required");
      if (!updatingExisting && input.provider !== "epay" && !input.appId) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "app id is required");
      if (!updatingExisting && input.provider === "epay" && !input.gatewayUrl) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "epay gateway url is required");
      if (!input.signingSecret && !updatingExisting) throw new ApiError(400, "PAYMENT_METHOD_SECRET_REQUIRED", "signing secret is required");
    }
  }

  private applyPaymentMethodSecrets(method: PaymentMethodConfig, input: PaymentMethodUpsertInput) {
    if (input.signingSecret) {
      method.signingSecret = input.signingSecret;
      method.signingSecretHash = hashSecret(input.signingSecret);
      method.signingSecretPreview = previewSecret(input.signingSecret);
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
      if (candidate.ownerType === method.ownerType && candidate.merchantId === method.merchantId && candidate.shopId === method.shopId) candidate.isDefault = false;
    }
    method.isDefault = true;
    method.enabled = true;
    method.status = "enabled";
    method.updatedAt = new Date();
  }

  private serializePaymentMethod(method: PaymentMethodConfig) {
    return {
      id: method.id,
      ownerType: method.ownerType === "merchant" ? "merchant" : method.ownerType,
      merchantId: method.merchantId,
      shopId: method.shopId,
      provider: method.provider,
      confirmationMode: method.confirmationMode,
      displayName: method.displayName,
      productType: method.productType,
      merchantNoMasked: maskSecret(method.merchantNo),
      appIdMasked: maskSecret(method.appId),
      serviceProviderMasked: maskSecret(method.serviceProviderId),
      gatewayUrl: method.gatewayUrl,
      apiMode: method.apiMode ?? defaultPaymentApiMode(method.provider),
      accountName: isManualPaymentProvider(method.provider) ? method.accountName : maskSecret(method.accountName),
      qrUrl: isManualPaymentProvider(method.provider) ? method.qrUrl : undefined,
      paymentUrl: isManualPaymentProvider(method.provider) ? method.paymentUrl : undefined,
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

  private serializePublicPaymentMethodAsChannel(method: PaymentMethodConfig, index: number) {
    const feeBps = this.paymentFeeBpsForProvider(method.provider);
    return {
      id: method.id,
      paymentMethodId: method.id,
      shopId: method.shopId,
      ownerType: method.ownerType,
      provider: method.provider,
      confirmationMode: method.confirmationMode,
      channelType: paymentDisplayTypeForProvider(method.provider),
      displayName: paymentProviderDisplay(method.provider),
      accountName: undefined,
      qrUrl: isManualPaymentProvider(method.provider) ? method.qrUrl : undefined,
      paymentUrl: isManualPaymentProvider(method.provider) ? method.paymentUrl : undefined,
      isDefault: method.isDefault,
      sortOrder: index,
      paymentFeeBps: feeBps,
      paymentFeeLabel: feeBps === 0 ? "0%" : `${(feeBps / 100).toFixed(0)}%`,
      publicLabel: paymentProviderPublicLabel(method.provider, feeBps),
      note: isManualPaymentProvider(method.provider) ? "个人收款需商户人工确认" : method.provider === "balance" ? "余额支付无手续费" : "官方支付以回调或查单为准"
    };
  }

  private testPaymentMethod(method: PaymentMethodConfig) {
    const ok = isManualPaymentProvider(method.provider)
      ? Boolean(method.accountName && method.qrUrl)
      : method.provider === "balance"
        ? true
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
    if (paymentMethodId === "balance") return this.balancePaymentMethod();
    const shop = this.getShop(order.shopId);
    const shopOwnsPaymentMethods = (shop.ownerType ?? "merchant") === "platform";
    const methods = [...this.store.paymentMethods.values()]
      .filter((method) => method.enabled && method.status === "enabled")
      .filter((method) => this.paymentMethodIsPublicComplete(method))
      .filter((method) => this.paymentMethodMatchesOrderScope(method, order, shopOwnsPaymentMethods));
    const method = paymentMethodId
      ? methods.find((candidate) => candidate.id === paymentMethodId)
      : methods.find((candidate) => candidate.isDefault);
    return requireEntity(method, "PAYMENT_METHOD_UNAVAILABLE", "no enabled payment method is available for this order");
  }

  private paymentMethodMatchesOrderScope(method: PaymentMethodConfig, order: DemoOrder, shopOwnsPaymentMethods: boolean) {
    if (shopOwnsPaymentMethods) return method.ownerType === "platform";
    return method.ownerType === "merchant" && method.merchantId === order.merchantId && method.shopId === order.shopId;
  }

  private paymentMethodMatchesShopScope(method: PaymentMethodConfig, shop: DemoShop, shopOwnsPaymentMethods: boolean) {
    if (shopOwnsPaymentMethods) return method.ownerType === "platform";
    return method.ownerType === "merchant" && method.merchantId === shop.merchantId && method.shopId === shop.id;
  }

  private resolvePaymentMethodForRecharge(paymentMethodId?: string) {
    if (paymentMethodId === "balance") throw new ApiError(400, "WALLET_RECHARGE_METHOD_INVALID", "balance cannot be used to recharge balance");
    const methods = [...this.store.paymentMethods.values()]
      .filter((method) => method.enabled && method.status === "enabled" && method.provider !== "balance")
      .filter((method) => this.paymentMethodIsPublicComplete(method));
    const method = paymentMethodId
      ? methods.find((candidate) => candidate.id === paymentMethodId)
      : methods.find((candidate) => candidate.isDefault);
    return requireEntity(method, "PAYMENT_METHOD_UNAVAILABLE", "no enabled payment method is available for recharge");
  }

  private balancePaymentMethod(): PaymentMethodConfig {
    return {
      id: "balance",
      ownerType: "platform",
      provider: "balance",
      confirmationMode: "automatic",
      displayName: "余额支付",
      enabled: true,
      status: "enabled",
      isDefault: false,
      secretConfigured: true,
      createdAt: new Date(0),
      updatedAt: new Date(0)
    };
  }

  private paymentMethodIsPublicComplete(method: PaymentMethodConfig) {
    if (method.provider === "balance") return true;
    if (isManualPaymentProvider(method.provider)) return Boolean(method.qrUrl);
    if (method.provider === "epay") return Boolean(method.gatewayUrl && method.merchantNo && method.secretConfigured);
    return Boolean(method.merchantNo && method.appId && method.secretConfigured);
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
    const secret = method.signingSecretHash ? `sha256:${method.signingSecretHash}` : method.signingSecret ?? method.signingSecretEncrypted ?? "";
    return createHmac("sha256", secret).update(this.paymentSignaturePayload(method.provider, orderNo, amountCents, providerTradeNo, method.merchantNo)).digest("hex");
  }

  private verifyPaymentSignature(method: PaymentMethodConfig, orderNo: string, amountCents: bigint, providerTradeNo: string, signature: string) {
    if (!signature || !method.secretConfigured) return false;
    return this.signPaymentPayload(method, orderNo, amountCents, providerTradeNo) === signature;
  }

  private async buildEpayPaymentParams(method: PaymentMethodConfig, order: DemoOrder, amountCents: bigint) {
    const gatewayUrl = required(method.gatewayUrl, "epay gatewayUrl");
    const merchantNo = required(method.merchantNo, "epay merchantNo");
    const signingSecret = required(method.signingSecret, "epay signingSecret");
    const notifyUrl = absoluteCallbackUrl(this.providerCallbackUrl("epay"));
    const returnUrl = method.returnUrl ?? publicSiteUrl();
    const endpoints = epayGatewayEndpoints(gatewayUrl);
    const submitParams: Record<string, string> = {
      pid: merchantNo,
      type: method.productType || "alipay",
      out_trade_no: order.orderNo,
      notify_url: notifyUrl,
      return_url: returnUrl,
      name: orderProductNameForPayment(order),
      money: centsString(amountCents),
      sign_type: "MD5"
    };
    submitParams.sign = signEpayParams(submitParams, signingSecret);
    const submitPaymentUrl = appendQuery(endpoints.submitUrl, submitParams);
    const mapi = method.apiMode === "submit" ? undefined : await requestEpayMapi(endpoints.mapiUrl, submitParams);
    const directAppUrl = mapi?.directAppUrl;
    const cashierUrl = mapi?.cashierUrl;
    const qrCodeUrl = mapi?.qrCodeUrl;
    const paymentUrl = directAppUrl ?? cashierUrl ?? submitPaymentUrl;
    return {
      method: directAppUrl ? "APP" : mapi?.ok ? "MAPI" : "GET",
      gatewayUrl: endpoints.submitUrl,
      mapiUrl: endpoints.mapiUrl,
      paymentUrl,
      submitPaymentUrl,
      directAppUrl,
      cashierUrl,
      qrCodeUrl: qrCodeUrl ?? paymentUrl,
      submitParams,
      apiMode: method.apiMode ?? "mapi_first",
      mapiStatus: mapi?.ok ? "resolved" : mapi ? "fallback" : "skipped",
      mapiMessage: mapi?.message,
      notifyUrl,
      returnUrl
    };
  }

  private verifyEpaySignature(method: PaymentMethodConfig, rawPayload: Record<string, unknown>) {
    const signingSecret = method.signingSecret;
    const signature = stringValue(rawPayload.sign);
    if (!signingSecret || !signature) return false;
    return safeEqualHex(signEpayParams(rawPayload, signingSecret), signature);
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
      this.store.pendingIncomeByMerchant.set(order.merchantId, (this.store.pendingIncomeByMerchant.get(order.merchantId) ?? 0n) + order.snapshot.amountSnapshot.merchantExpectedIncomeCents);
      this.addChannelPendingIncome(order);
    }
    this.ledger(source === "manual" ? "MANUAL_PAYMENT_CONFIRMED" : "PAYMENT_SUCCEEDED", { orderNo: order.orderNo, merchantId: order.merchantId }, amountCents, metadata);
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

  private buildSnapshot(input: { orderNo: string; userId: string; shopId: string; merchantProductListingId: string; quantity?: number; entrySource?: string; serviceFeeBps?: bigint }): DemoOrderSnapshot {
    const shop = requireEntity(this.store.shops.get(input.shopId), "RESOURCE_NOT_FOUND", "shop not found");
    if ((shop.ownerType ?? "merchant") === "platform") {
      return this.buildPlatformSelfOperatedSnapshot(input, shop);
    }
    const merchant = requireEntity(this.store.merchants.get(required(shop.merchantId, "merchantId")), "RESOURCE_NOT_FOUND", "merchant not found");
    const account = requireEntity(this.store.depositAccounts.get(merchant.id), "RESOURCE_NOT_FOUND", "deposit account not found");
    if (shouldRestrictForDeposit(account)) throw new ApiError(400, "DEPOSIT_INSUFFICIENT", "merchant deposit is insufficient");
    const merchantProductListing = requireEntity(this.store.merchantProductListings.get(input.merchantProductListingId), "RESOURCE_NOT_FOUND", "merchant product not found");
    if (merchantProductListing.shopId !== shop.id) throw new ApiError(400, "RESOURCE_SCOPE_MISMATCH", "merchant product does not belong to shop");
    const platformProduct = merchantProductListing.platformProductId ? this.store.platformProducts.get(merchantProductListing.platformProductId) : undefined;
    const displayPlatformProduct = merchantProductListing.platformProductId
      ? this.productWithMerchantDisplayOverrides(merchantProductListing, platformProduct) as DemoPlatformProduct | undefined
      : undefined;
    const ownProduct = merchantProductListing.ownProductReviewId ? this.store.ownProducts.get(merchantProductListing.ownProductReviewId) : undefined;
    const relation = this.findActiveChannelRelationForSellingMerchant(merchant.id);
    if (relation && merchantProductListing.productType === "platform" && platformProduct) {
      return this.buildChannelSnapshot(input, shop, merchant, merchantProductListing, platformProduct, relation, displayPlatformProduct);
    }
    return this.withServiceFeeSnapshot(buildOrderSnapshot({
      orderNo: input.orderNo,
      userId: input.userId,
      merchant,
      shop,
      merchantProductListing,
      platformProduct: displayPlatformProduct,
      ownProduct,
      quantity: input.quantity,
      entrySource: input.entrySource,
      serviceFeeBps: input.serviceFeeBps
    }));
  }

  private withServiceFeeSnapshot<T extends DemoOrderSnapshot>(snapshot: T): T {
    const config = this.activeServiceFeeConfig();
    const amount = snapshot.amountSnapshot as DemoAmountSnapshot;
    const finalSalePriceCents = "finalSalePriceCents" in amount && typeof amount.finalSalePriceCents === "bigint"
      ? amount.finalSalePriceCents
      : amount.paidAmountCents;
    const basisAmountCents = config.basisType === "paid_amount"
      ? amount.paidAmountCents
      : finalSalePriceCents;
    amount.serviceFeeEnabled = config.enabled;
    amount.serviceFeeBasisAmountCents = basisAmountCents;
    amount.serviceFeeConfigSnapshot = {
      id: config.id,
      enabled: config.enabled,
      feeBps: config.feeBps,
      basisType: config.basisType,
      status: config.status,
      updatedAt: config.updatedAt,
      updatedBy: config.updatedBy
    };
    return snapshot;
  }

  private buildChannelSnapshot(
    input: { orderNo: string; userId: string; shopId: string; merchantProductListingId: string; quantity?: number; entrySource?: string; serviceFeeBps?: bigint },
    shop: DemoShop,
    sellingMerchant: DemoMerchant,
    merchantProductListing: DemoMerchantProductListing,
    platformProduct: DemoPlatformProduct,
    relation: ChannelRelation,
    displayProduct: DemoPlatformProduct | undefined
  ): DemoOrderSnapshot {
    const firstTier = requireEntity(this.store.merchants.get(relation.firstTierMerchantId), "RESOURCE_NOT_FOUND", "first tier merchant not found");
    const secondTier = requireEntity(this.store.merchants.get(relation.secondTierMerchantId), "RESOURCE_NOT_FOUND", "second tier merchant not found");
    const thirdTier = relation.thirdTierMerchantId ? requireEntity(this.store.merchants.get(relation.thirdTierMerchantId), "RESOURCE_NOT_FOUND", "third tier merchant not found") : undefined;
    const firstTierShop = requireEntity(this.findShopByMerchantId(firstTier.id), "RESOURCE_NOT_FOUND", "first tier shop not found");
    const secondTierShop = requireEntity(this.findShopByMerchantId(secondTier.id), "RESOURCE_NOT_FOUND", "second tier shop not found");
    const firstTierAccount = requireEntity(this.store.depositAccounts.get(firstTier.id), "RESOURCE_NOT_FOUND", "first tier deposit account not found");
    const secondTierAccount = requireEntity(this.store.depositAccounts.get(secondTier.id), "RESOURCE_NOT_FOUND", "second tier deposit account not found");
    if (sellingMerchant.id !== (thirdTier?.id ?? secondTier.id)) throw new ApiError(400, "MERCHANT_SUPPLY_RULE_FAILED", "selling merchant does not match merchant supply relation");
    if (sellingMerchant.status !== "active" || secondTier.status !== "active" || firstTier.status !== "active" || (thirdTier && thirdTier.status !== "active")) throw new ApiError(400, "MERCHANT_NOT_ACTIVE", "merchant supply participants must be active");
    if (shop.status !== "open" || firstTierShop.status !== "open" || secondTierShop.status !== "open") throw new ApiError(400, "SHOP_NOT_OPEN", "merchant supply shops must be open");
    if (merchantProductListing.status !== "listed") throw new ApiError(400, "PRODUCT_NOT_LISTED", "merchant product is not listed");
    if (platformProduct.status !== "active") throw new ApiError(400, "PRODUCT_NOT_ACTIVE", "platform product is not active");
    if (sellingMerchant.riskStatus !== "normal" || secondTier.riskStatus !== "normal" || firstTier.riskStatus !== "normal" || shop.riskStatus !== "normal") {
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
    const secondTierOffer = relation.thirdTierMerchantId
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
      salePriceCents: merchantProductListing.salePriceCents,
      supplyPriceCents: sellerSupplyUnitPriceCents,
      minSalePriceCents: platformProduct.minSalePriceCents,
      quantity,
      serviceFeeBps: input.serviceFeeBps
    });
    const platformSupplyPriceCents = platformProduct.supplyPriceCents * BigInt(quantity);
    const firstTierSupplyPriceCents = firstTierOffer.resellSupplyPriceCents * BigInt(quantity);
    const secondTierSupplyPriceCents = secondTierOffer ? secondTierOffer.resellSupplyPriceCents * BigInt(quantity) : null;
    const firstTierIncomeCents = firstTierSupplyPriceCents - platformSupplyPriceCents;
    const secondTierIncomeCents = secondTierSupplyPriceCents ? secondTierSupplyPriceCents - firstTierSupplyPriceCents : quote.merchantExpectedIncomeCents;
    const thirdTierIncomeCents = secondTierSupplyPriceCents ? quote.merchantExpectedIncomeCents : 0n;

    return this.withServiceFeeSnapshot({
      orderNo: input.orderNo,
      userId: input.userId,
      merchantId: sellingMerchant.id,
      shopId: shop.id,
      merchantProductListingId: merchantProductListing.id,
      salesChannelType: secondTierOffer ? "three_tier" : "two_tier",
      productType: "platform",
      productNameSnapshot: displayProduct?.name ?? platformProduct.name,
      quantity,
      quote,
      amountSnapshot: {
        serviceFeeBps: quote.serviceFeeBps,
        paidAmountCents: quote.paidAmountCents,
        supplyAmountCents: quote.supplyAmountCents,
        serviceFeeCents: quote.serviceFeeCents,
        merchantExpectedIncomeCents: quote.merchantExpectedIncomeCents,
        platformSupplyPriceCents,
        resellSupplyPriceCents: firstTierSupplyPriceCents,
        firstTierSupplyPriceCents,
        secondTierSupplyPriceCents,
        finalSalePriceCents: quote.paidAmountCents,
        firstTierIncomeCents,
        secondTierIncomeCents,
        thirdTierIncomeCents
      },
      productSnapshot: {
        id: platformProduct.id,
        type: "platform",
        name: displayProduct?.name ?? platformProduct.name,
        sourceName: platformProduct.name,
        imageUrl: displayProduct?.imageUrl,
        description: displayProduct?.description
      },
      shopSnapshot: {
        id: shop.id,
        name: shop.name,
        customerServiceWechat: shop.customerServiceWechat,
        customerServiceQrUrl: shop.customerServiceQrUrl,
        customerServiceQq: shop.customerServiceQq,
        customerServiceQqQrUrl: shop.customerServiceQqQrUrl,
        customerServiceNote: shop.customerServiceNote,
        merchantStatus: sellingMerchant.status,
        shopStatus: shop.status,
        entrySource: input.entrySource
      },
      pricingSnapshot: {
        salePriceCents: merchantProductListing.salePriceCents,
        minSalePriceCents: platformProduct.minSalePriceCents,
        suggestedSalePriceCents: platformProduct.suggestedSalePriceCents
      },
      channelSnapshot: {
        relationId: relation.id,
        firstTierMerchantId: firstTier.id,
        firstTierShopId: firstTierShop.id,
        secondTierMerchantId: secondTier.id,
        secondTierShopId: secondTierShop.id,
        thirdTierMerchantId: thirdTier?.id,
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
    } as DemoOrderSnapshot);
  }

  private buildPlatformSelfOperatedSnapshot(
    input: { orderNo: string; userId: string; shopId: string; merchantProductListingId: string; quantity?: number; entrySource?: string; serviceFeeBps?: bigint },
    shop: DemoShop
  ): PlatformSelfOperatedSnapshot {
    if (shop.status !== "open") throw new ApiError(400, "SHOP_NOT_OPEN", "platform shop is not open");
    if (shop.riskStatus !== "normal") throw new ApiError(400, "RISK_BLOCKED", "risk freeze blocks order creation");
    const shopProduct = requireEntity(this.store.platformShopProducts.get(input.merchantProductListingId), "RESOURCE_NOT_FOUND", "platform shop product not found");
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
    const serviceFeeBps = input.serviceFeeBps ?? 50n;
    const paymentChannelFeeCents = calculateServiceFeeCents(paidAmountCents, serviceFeeBps);
    const grossMarginCents = paidAmountCents - fulfillmentCostCents - paymentChannelFeeCents;
    if (grossMarginCents < 0n) throw new ApiError(400, "PRICE_RULE_FAILED", "platform self-operated margin cannot be negative");

    return this.withServiceFeeSnapshot({
      orderNo: input.orderNo,
      userId: input.userId,
      merchantId: PLATFORM_MERCHANT_ID,
      shopId: shop.id,
      merchantProductListingId: shopProduct.id,
      salesChannelType: "platform_self_operated",
      productType: "platform",
      productNameSnapshot: product.name,
      quantity,
      quote: {
        serviceFeeBps,
        paidAmountCents,
        supplyAmountCents: fulfillmentCostCents,
        serviceFeeCents: paymentChannelFeeCents,
        merchantExpectedIncomeCents: 0n
      },
      amountSnapshot: {
        serviceFeeBps,
        paidAmountCents,
        supplyAmountCents: fulfillmentCostCents,
        serviceFeeCents: paymentChannelFeeCents,
        merchantExpectedIncomeCents: 0n,
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
    });
  }

  private applyMerchantProductListingDisplayOverrides(merchantProductListing: DemoMerchantProductListing, input: MerchantProductListingDisplayOverrideInput) {
    if ("displayName" in input) merchantProductListing.displayName = optionalTrimmedText(input.displayName);
    if ("displaySubtitle" in input) merchantProductListing.displaySubtitle = optionalTrimmedText(input.displaySubtitle);
    if ("displayDescription" in input) merchantProductListing.displayDescription = optionalTrimmedText(input.displayDescription);
    if ("displayUsageGuide" in input) merchantProductListing.displayUsageGuide = optionalTrimmedText(input.displayUsageGuide);
    if ("displayImageUrl" in input) merchantProductListing.displayImageUrl = optionalTrimmedText(input.displayImageUrl);
    if ("displayCategory" in input) merchantProductListing.displayCategory = optionalTrimmedText(input.displayCategory);
    if ("displayTags" in input) merchantProductListing.displayTags = normalizeOptionalStringArray(input.displayTags);
    if ("displaySpecs" in input) merchantProductListing.displaySpecs = normalizeOptionalStringArray(input.displaySpecs);
    if ("displayDetailSections" in input) merchantProductListing.displayDetailSections = normalizeOptionalDetailSections(input.displayDetailSections);
  }

  private productWithMerchantDisplayOverrides(merchantProductListing: DemoMerchantProductListing, product?: DemoPlatformProduct | DemoOwnProduct) {
    if (!product || merchantProductListing.productType !== "platform") return product;
    return {
      ...product,
      sourceName: product.name,
      sourceCategory: product.category,
      sourceImageUrl: product.imageUrl,
      sourceDescription: product.description,
      name: merchantProductListing.displayName ?? product.name,
      category: merchantProductListing.displayCategory ?? product.category,
      tags: merchantProductListing.displayTags ?? product.tags,
      subtitle: merchantProductListing.displaySubtitle ?? product.subtitle,
      description: merchantProductListing.displayDescription ?? product.description,
      usageGuide: merchantProductListing.displayUsageGuide ?? product.usageGuide,
      imageUrl: merchantProductListing.displayImageUrl ?? product.imageUrl,
      specs: merchantProductListing.displaySpecs ?? product.specs,
      detailSections: merchantProductListing.displayDetailSections ?? product.detailSections
    };
  }

  private serializeMerchantProduct(merchantProductListing: DemoMerchantProductListing) {
    const sourceProduct = merchantProductListing.platformProductId
      ? this.store.platformProducts.get(merchantProductListing.platformProductId)
      : this.store.ownProducts.get(required(merchantProductListing.ownProductReviewId, "ownProductReviewId"));
    const product = this.productWithMerchantDisplayOverrides(merchantProductListing, sourceProduct);
    return { ...merchantProductListing, product, sourceProductName: sourceProduct?.name };
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
      shop: shop ? { id: shop.id, name: shop.name, status: shop.status, ownerType: shop.ownerType ?? "merchant" } : undefined,
      product: this.serializePlatformProductDetail(product, "admin", actor),
      fieldPermissions: {
        editable: ["salePriceCents", "fulfillmentCostCents", "status"],
        readonly: ["platformProductId", "product"]
      }
    };
  }

  private serializeMerchantProductForActor(actor: MerchantActor, merchantProductListing: DemoMerchantProductListing) {
    const base = this.serializeMerchantProduct(merchantProductListing) as Record<string, unknown> & { product?: Record<string, unknown> };
    if (!base.product || merchantProductListing.productType !== "platform") return base;
    const visibility = this.priceVisibilityForMerchant(actor.merchantId, merchantProductListing.platformProductId);
    const product = { ...base.product };
    delete product.supplyPriceCents;
    if (visibility.canSeePlatformSupplyPrice) product.platformSupplyPriceCents = visibility.platformSupplyPriceCents;
    if (visibility.visibleUpstreamSupplyPriceCents !== undefined) product.visibleUpstreamSupplyPriceCents = visibility.visibleUpstreamSupplyPriceCents;
    if (visibility.ownTransferSupplyPriceCents !== undefined) product.ownTransferSupplyPriceCents = visibility.ownTransferSupplyPriceCents;
    return { ...base, product };
  }

  private serializeMerchantProductDetailForActor(actor: MerchantActor, merchantProductListing: DemoMerchantProductListing) {
    const base = this.serializeMerchantProductForActor(actor, merchantProductListing) as Record<string, unknown> & { product?: Record<string, unknown> };
    const inventoryProductId = merchantProductListing.productType === "merchant_owned" ? merchantProductListing.id : merchantProductListing.platformProductId;
    return {
      ...base,
      rightsCodePool: inventoryProductId ? this.rightsCodePoolSummary(inventoryProductId, {
        canImport: merchantProductListing.productType === "merchant_owned",
        canExportMasked: merchantProductListing.productType === "merchant_owned",
        canViewPlaintext: false,
        canExportPlaintext: false
      }) : undefined,
      fieldPermissions: {
        editable: ["salePriceCents", "status"],
        readonly: ["product", "fulfillmentMode", "afterSaleRule", "rightsCodePool"]
      },
      canViewPlainRightsCodes: merchantProductListing.productType === "merchant_owned",
      priceVisibility: merchantProductListing.productType === "platform" ? this.priceVisibilityForMerchant(actor.merchantId, merchantProductListing.platformProductId) : undefined
    };
  }

  private serializeOwnProductDetail(product: DemoOwnProduct, audience: "admin" | "merchant") {
    const merchant = this.store.merchants.get(product.merchantId);
    const shop = this.store.shops.get(product.shopId);
    const merchantProductListing = [...this.store.merchantProductListings.values()].find((item) => item.ownProductReviewId === product.id);
    const editable = audience === "admin"
      ? ["reviewStatus", "status"]
      : product.reviewStatus === "pending_review"
        ? ["name", "category", "tags", "subtitle", "description", "usageGuide", "imageUrl", "specs", "detailSections", "salePriceCents", "minSalePriceCents", "fulfillmentMode", "afterSaleRule"]
        : ["salePriceCents", "status"];
    return {
      ...product,
      minSalePriceCents: product.minSalePriceCents ?? product.salePriceCents,
      ownProductId: product.id,
      merchantId: product.merchantId,
      merchantProductListingId: merchantProductListing?.id,
      merchant: merchant ? { id: merchant.id, name: merchant.name, tier: merchant.tier, status: merchant.status } : undefined,
      shop: shop ? { id: shop.id, name: shop.name, status: shop.status } : undefined,
      fulfillmentMode: fulfillmentRuleMode(product.fulfillmentRule),
      manualFulfillmentInstruction: manualFulfillmentInstruction(product.fulfillmentRule),
      rightsCodePool: merchantProductListing ? this.rightsCodePoolSummary(merchantProductListing.id, {
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
      fieldPermissions: { editable, readonly: audience === "admin" ? ["merchant", "shop", "rightsCodePool"] : ["reviewStatus", "merchant", "shop"] },
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
    const codes = this.store.rightsCodes.filter((code) => code.productId === productId || code.merchantProductListingId === productId);
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
    const merchantProductListing = [...this.store.merchantProductListings.values()].find((product) => product.ownProductReviewId === ownProductId);
    if (!merchantProductListing || nextMode === "code_pool") return;
    const hasCodes = this.store.rightsCodes.some((code) => (code.merchantProductListingId ?? code.productId) === merchantProductListing.id);
    const hasActiveOrders = [...this.store.orders.values()].some((order) =>
      order.merchantProductListingId === merchantProductListing.id
      && !["refunded", "closed"].includes(order.status)
      && order.fulfillmentStatus !== "not_started"
    );
    if (hasCodes || hasActiveOrders) {
      throw new ApiError(400, "FULFILLMENT_MODE_CHANGE_UNSAFE", "cannot switch to manual after code_pool orders or issued codes exist");
    }
  }

  private serializeMerchantOrderForActor(actor: MerchantActor, order: DemoOrder) {
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
      collectionPaymentMethod: order.collectionPaymentSnapshot ? {
        id: order.collectionPaymentSnapshot.id,
        paymentType: order.collectionPaymentSnapshot.channelType,
        displayName: order.collectionPaymentSnapshot.displayName
      } : undefined
    };
    if (!channel) {
      result.visibleSupplyPriceCents = order.snapshot.amountSnapshot.supplyAmountCents;
      result.visibleIncomeCents = order.snapshot.amountSnapshot.merchantExpectedIncomeCents;
      return result;
    }
    if (actor.merchantId === channel.firstTierMerchantId) {
      result.platformSupplyPriceCents = channel.platformSupplyPriceCents;
      result.firstTierSupplyPriceCents = channel.firstTierSupplyPriceCents;
      result.visibleIncomeCents = channel.firstTierIncomeCents;
    } else if (actor.merchantId === channel.secondTierMerchantId) {
      result.firstTierSupplyPriceCents = channel.firstTierSupplyPriceCents;
      result.secondTierSupplyPriceCents = channel.secondTierSupplyPriceCents;
      result.visibleIncomeCents = channel.secondTierIncomeCents;
    } else if (actor.merchantId === channel.thirdTierMerchantId) {
      result.secondTierSupplyPriceCents = channel.secondTierSupplyPriceCents;
      result.visibleIncomeCents = channel.thirdTierIncomeCents;
    }
    return result;
  }

  private serializePublicMerchantProduct(merchantProductListing: DemoMerchantProductListing) {
    const sourceProduct = merchantProductListing.platformProductId
      ? this.store.platformProducts.get(merchantProductListing.platformProductId)
      : this.store.ownProducts.get(required(merchantProductListing.ownProductReviewId, "ownProductReviewId"));
    const product = this.productWithMerchantDisplayOverrides(merchantProductListing, sourceProduct);
    return {
      id: merchantProductListing.id,
      shopId: merchantProductListing.shopId,
      productType: merchantProductListing.productType,
      salePriceCents: merchantProductListing.salePriceCents,
      status: merchantProductListing.status,
      groupName: merchantProductListing.groupName,
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
        ...(merchantProductListing.platformProductId ? {
          platformProductId: merchantProductListing.platformProductId,
          displayBadge: (sourceProduct as DemoPlatformProduct).displayBadge,
          isRecommended: (sourceProduct as DemoPlatformProduct).isRecommended,
          displaySort: (sourceProduct as DemoPlatformProduct).displaySort
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
      merchantProductListingId: order.merchantProductListingId,
      salesChannelType: order.salesChannelType,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      refundStatus: order.refundStatus,
      buyerEmail: options.includeBuyerContact ? order.buyerEmail : undefined,
      buyerPhone: options.includeBuyerContact ? order.buyerPhone : undefined,
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
      collectionPaymentMethod: order.collectionPaymentSnapshot,
      paymentSnapshot: order.paymentSnapshot,
      snapshot: {
        productType: order.snapshot.productType
      }
    };
  }

  private serializeDelivery(order: DemoOrder, options: { includeDeliveryCodes?: boolean; includeBuyerContact?: boolean }) {
    const mode = fulfillmentMode(order.snapshot);
    const emailDelivery = this.latestEmailDeliveryForOrder(order.orderNo);
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
      buyerPhone: options.includeBuyerContact ? order.buyerPhone : undefined,
      purchasePasswordSet: order.extractionCodeSet,
      extractable: Boolean(order.extractionCodeSet) && order.paymentStatus === "paid" && order.fulfillmentStatus === "success" && order.refundStatus === "none",
      extractionToken: Boolean(order.extractionCodeSet) ? this.extractionTokenForOrder(order) : undefined,
      emailDelivery: options.includeBuyerContact && order.buyerEmail ? emailDelivery ? {
        id: emailDelivery.id,
        status: emailDelivery.status,
        reason: emailDelivery.reason,
        codeCount: emailDelivery.codeCount,
        source: emailDelivery.source,
        createdAt: emailDelivery.createdAt
      } : {
        status: "pending",
        reason: order.paymentStatus === "paid" ? "EMAIL_DELIVERY_PENDING" : "WAITING_PAYMENT_CONFIRMATION",
        codeCount: 0
      } : undefined,
      codes: !order.extractionCodeSet && options.includeBuyerContact && order.paymentStatus === "paid" && order.fulfillmentStatus === "success" && order.refundStatus === "none" ? codes : [],
      message: codes.length > 0 ? "卡密已自动发放，请使用购买时设置的购买密码查看。" : "付款后系统会自动发放卡密。"
    };
  }

  private latestEmailDeliveryForOrder(orderNo: string) {
    return this.store.emailDeliveries
      .filter((delivery) => delivery.orderNo === orderNo)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0];
  }

  private serializeUserCoupon(coupon: UserCoupon, input: { shopId?: string; merchantProductListingId?: string }) {
    const template = this.store.couponTemplates.get(coupon.templateId);
    const visible = Boolean(template) && coupon.status !== "voided";
    return {
      ...coupon,
      template,
      visible,
      applicable: template && input.merchantProductListingId
        ? this.couponAppliesToProduct(template, input.merchantProductListingId)
        : true
    };
  }

  private knownUserIds() {
    const userIds = new Set<string>();
    for (const merchant of this.store.merchants.values()) userIds.add(merchant.userId);
    for (const application of this.store.merchantApplications.values()) userIds.add(application.userId);
    for (const order of this.store.orders.values()) userIds.add(order.userId);
    for (const coupon of this.store.userCoupons.values()) userIds.add(coupon.userId);
    for (const wallet of this.store.userWallets.values()) userIds.add(wallet.userId);
    return Array.from(userIds);
  }

  private resolveCouponGrantUserId(input: { userId?: string; phone?: string }) {
    const userId = input.userId?.trim();
    if (userId) return userId;
    const phone = input.phone?.replace(/[^\d+]/g, "");
    if (phone) return `h5-phone-${phone}`;
    throw new ApiError(400, "COUPON_GRANT_TARGET_REQUIRED", "userId or phone is required");
  }

  private listVisibleUpstreamProducts(actor: MerchantActor) {
    const visibleProductIds = new Set<string>();
    for (const relation of this.store.channelRelations) {
      if (relation.status !== "active") continue;
      if (relation.secondTierMerchantId === actor.merchantId || relation.thirdTierMerchantId === actor.merchantId) {
        for (const offer of this.store.channelProductOffers.filter((item) => item.channelRelationId === relation.id && item.status === "listed")) {
          visibleProductIds.add(offer.platformProductId);
        }
      }
    }
    return [...visibleProductIds]
      .map((productId) => this.store.platformProducts.get(productId))
      .filter((product): product is DemoPlatformProduct => Boolean(product))
      .map((product) => {
        const visibility = this.priceVisibilityForMerchant(actor.merchantId, product.id);
        const upstreamMerchantProduct = this.upstreamMerchantProductForActor(actor.merchantId, product.id);
        const displayProduct = this.productWithMerchantDisplayOverrides(upstreamMerchantProduct ?? {
          id: "",
          merchantId: "",
          shopId: "",
          productType: "platform",
          platformProductId: product.id,
          ownProductReviewId: null,
          salePriceCents: product.suggestedSalePriceCents,
          status: "listed"
        }, product) as DemoPlatformProduct;
        const suggestedSalePriceCents = maxBigInt([
          product.suggestedSalePriceCents,
          upstreamMerchantProduct?.salePriceCents,
          visibility.visibleUpstreamSupplyPriceCents
        ]);
        const minSalePriceCents = maxBigInt([
          product.minSalePriceCents,
          visibility.visibleUpstreamSupplyPriceCents
        ]);
        return {
          id: product.id,
          name: displayProduct.name,
          category: displayProduct.category,
          tags: displayProduct.tags,
          subtitle: displayProduct.subtitle,
          description: displayProduct.description,
          usageGuide: displayProduct.usageGuide,
          imageUrl: displayProduct.imageUrl,
          specs: displayProduct.specs,
          detailSections: displayProduct.detailSections,
          sourceName: product.name,
          upstreamMerchantProductId: upstreamMerchantProduct?.id,
          stockCount: product.stockCount,
          soldCount: product.soldCount,
          minSalePriceCents,
          suggestedSalePriceCents,
          fulfillmentRule: product.fulfillmentRule,
          afterSaleRule: product.afterSaleRule,
          status: product.status,
          visibleUpstreamSupplyPriceCents: visibility.visibleUpstreamSupplyPriceCents,
          ownTransferSupplyPriceCents: visibility.ownTransferSupplyPriceCents
        };
      });
  }

  private platformSelectionPricingForActor(actor: MerchantActor, platformProductId: string) {
    const product = requireEntity(this.store.platformProducts.get(platformProductId), "RESOURCE_NOT_FOUND", "platform product not found");
    const tier = this.merchantTier(actor.merchantId);
    if (tier === "first_tier") {
      return {
        product,
        supplyPriceCents: product.supplyPriceCents,
        minSalePriceCents: product.minSalePriceCents
      };
    }
    const visibility = this.priceVisibilityForMerchant(actor.merchantId, platformProductId);
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

  private priceVisibilityForMerchant(merchantId: string, platformProductId?: string | null) {
    if (!platformProductId) return {};
    const product = this.store.platformProducts.get(platformProductId);
    const firstTierRelation = this.store.channelRelations.find((relation) => relation.status === "active" && relation.firstTierMerchantId === merchantId && !relation.thirdTierMerchantId);
    if (firstTierRelation && product) {
      const firstOffer = this.store.channelProductOffers.find((offer) => offer.channelRelationId === firstTierRelation.id && offer.platformProductId === platformProductId && offer.status === "listed");
      return {
        canSeePlatformSupplyPrice: true,
        platformSupplyPriceCents: product.supplyPriceCents,
        ownTransferSupplyPriceCents: firstOffer?.resellSupplyPriceCents
      };
    }
    const secondTierRelation = this.store.channelRelations.find((relation) => relation.status === "active" && relation.secondTierMerchantId === merchantId && !relation.thirdTierMerchantId);
    const thirdTierRelation = this.store.channelRelations.find((relation) => relation.status === "active" && relation.thirdTierMerchantId === merchantId);
    if (secondTierRelation) {
      const firstOffer = this.store.channelProductOffers.find((offer) => offer.channelRelationId === secondTierRelation.id && offer.platformProductId === platformProductId && offer.status === "listed");
      const secondOffer = this.store.channelProductOffers.find((offer) => {
        const relation = this.store.channelRelations.find((candidate) => candidate.id === offer.channelRelationId);
        return relation?.secondTierMerchantId === merchantId && relation.thirdTierMerchantId && offer.platformProductId === platformProductId && offer.status === "listed";
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

  private upstreamMerchantProductForActor(merchantId: string, platformProductId: string) {
    const relation = this.findActiveChannelRelationForSellingMerchant(merchantId);
    if (!relation) return undefined;
    const upstreamMerchantId = relation.thirdTierMerchantId === merchantId ? relation.secondTierMerchantId : relation.firstTierMerchantId;
    return [...this.store.merchantProductListings.values()].find((product) =>
      product.merchantId === upstreamMerchantId
      && product.platformProductId === platformProductId
      && product.status === "listed"
    );
  }

  private findDirectDownstreamRelation(upstreamMerchantId: string, downstreamMerchantId: string) {
    return this.store.channelRelations.find((relation) =>
      relation.status === "active"
      && (
        (!relation.thirdTierMerchantId && relation.firstTierMerchantId === upstreamMerchantId && relation.secondTierMerchantId === downstreamMerchantId)
        || (relation.thirdTierMerchantId === downstreamMerchantId && relation.secondTierMerchantId === upstreamMerchantId)
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

  private couponAppliesToProduct(template: CouponTemplate, merchantProductListingId: string) {
    if (template.productIds.length === 0) return true;
    const merchantProductListing = this.store.merchantProductListings.get(merchantProductListingId);
    const shopProduct = this.store.platformShopProducts.get(merchantProductListingId);
    const productId = merchantProductListing?.platformProductId ?? shopProduct?.platformProductId;
    return Boolean(productId && template.productIds.includes(productId));
  }

  private createClawback(order: DemoOrder, amountCents: bigint, sourceType: string, sourceId: string) {
    const balances = {
      pendingIncomeCents: this.store.pendingIncomeByMerchant.get(order.merchantId) ?? 0n,
      payableIncomeCents: this.store.payableIncomeByMerchant.get(order.merchantId) ?? 0n,
      depositAvailableCents: this.store.depositAccounts.get(order.merchantId)?.availableAmountCents ?? 0n
    };
    const result = applyClawback(amountCents, balances);
    this.store.pendingIncomeByMerchant.set(order.merchantId, result.balances.pendingIncomeCents);
    this.store.payableIncomeByMerchant.set(order.merchantId, result.balances.payableIncomeCents);
    this.applyPayableClawbackToOpenSettlement(order, result.deductions);
    const deposit = this.store.depositAccounts.get(order.merchantId);
    if (deposit) {
      deposit.availableAmountCents = result.balances.depositAvailableCents;
      deposit.status = shouldRestrictForDeposit(deposit) ? "insufficient" : deposit.status;
      const merchant = this.store.merchants.get(order.merchantId);
      if (merchant && shouldRestrictForDeposit(deposit)) merchant.depositStatus = "insufficient";
    }
    const clawback = {
      clawbackNo: nextId(this.store, "clawback"),
      merchantId: order.merchantId,
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
    this.releaseExpiredRightsCodeLocks();
    const merchantProductListing = this.store.merchantProductListings.get(order.merchantProductListingId);
    const shopProduct = this.store.platformShopProducts.get(order.merchantProductListingId);
    const productId = merchantProductListing?.platformProductId ?? shopProduct?.platformProductId;
    const product = productId ? this.store.platformProducts.get(productId) : undefined;
    const ownProduct = merchantProductListing?.ownProductReviewId ? this.store.ownProducts.get(merchantProductListing.ownProductReviewId) : undefined;
    const fulfillmentOwner = product ?? ownProduct;
    const inventoryProductId = product?.id ?? (ownProduct && merchantProductListing ? merchantProductListing.id : undefined);
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
    const lockedForOrder = this.store.rightsCodes
      .filter((item) => item.productId === inventoryProductId && item.status === "locked" && item.orderNo === order.orderNo);
    const additionalNeeded = Math.max(0, remainingQuantity - lockedForOrder.length);
    const additionalCodes = this.store.rightsCodes
      .filter((item) => item.productId === inventoryProductId && item.status === "available")
      .slice(0, additionalNeeded);
    const codes = [...lockedForOrder, ...additionalCodes]
      .slice(0, remainingQuantity);
    if (codes.length < remainingQuantity) {
      order.fulfillmentStatus = "failed";
      order.status = "fulfillment_failed";
      order.settlementStatus = "frozen";
      if (order.salesChannelType !== "platform_self_operated") {
        this.notify(order.merchantId, "stock.empty", "权益码库存不足", `${fulfillmentOwner.name} 库存不足，订单 ${order.orderNo} 已冻结结算。`);
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
      this.notify(order.merchantId, "order.auto_fulfilled", "订单已自动履约", `${order.orderNo} 已从权益码池自动发放。`);
    }
    this.recordEmailDelivery(order, codes);
    this.audit("system", "fulfillment.auto_code_pool", "order", order.orderNo, { codeIds: codes.map((code) => code.codeId) });
  }

  private reserveRightsCodesForOrder(order: DemoOrder) {
    const inventory = this.resolveRightsCodeInventoryForOrder(order);
    if (!inventory) return;
    const { inventoryProductId, fulfillmentOwner } = inventory;
    const alreadyLocked = this.store.rightsCodes.filter((code) =>
      code.productId === inventoryProductId && code.status === "locked" && code.orderNo === order.orderNo
    );
    const needed = order.snapshot.quantity - alreadyLocked.length;
    if (needed <= 0) return;
    const codes = this.store.rightsCodes
      .filter((code) => code.productId === inventoryProductId && code.status === "available")
      .slice(0, needed);
    if (codes.length < needed) {
      throw new ApiError(400, "RIGHTS_CODE_STOCK_INSUFFICIENT", `${fulfillmentOwner.name} 库存不足，暂时无法下单`);
    }
    const now = new Date();
    for (const [index, code] of codes.entries()) {
      code.status = "locked";
      code.orderNo = order.orderNo;
      code.issueKey = `lock:${order.orderNo}:${alreadyLocked.length + index + 1}`;
      code.issuedAt = now;
    }
  }

  private releaseExpiredRightsCodeLocks(now = new Date()) {
    const lockTtlMs = 15 * 60 * 1000;
    for (const code of this.store.rightsCodes) {
      if (code.status !== "locked" || !code.orderNo) continue;
      const order = this.store.orders.get(code.orderNo);
      const lockedAt = code.issuedAt ?? code.createdAt;
      const expired = now.getTime() - lockedAt.getTime() > lockTtlMs;
      if (order?.paymentStatus === "paid" || !expired) continue;
      code.status = "available";
      code.orderNo = undefined;
      code.issueKey = undefined;
      code.issuedAt = undefined;
    }
  }

  private resolveRightsCodeInventoryForOrder(order: DemoOrder) {
    const merchantProductListing = this.store.merchantProductListings.get(order.merchantProductListingId);
    const shopProduct = this.store.platformShopProducts.get(order.merchantProductListingId);
    const productId = merchantProductListing?.platformProductId ?? shopProduct?.platformProductId;
    const product = productId ? this.store.platformProducts.get(productId) : undefined;
    const ownProduct = merchantProductListing?.ownProductReviewId ? this.store.ownProducts.get(merchantProductListing.ownProductReviewId) : undefined;
    const fulfillmentOwner = product ?? ownProduct;
    const inventoryProductId = product?.id ?? (ownProduct && merchantProductListing ? merchantProductListing.id : undefined);
    const rule = fulfillmentOwner?.fulfillmentRule;
    if (!isRecord(rule) || rule.mode !== "code_pool" || !fulfillmentOwner || !inventoryProductId) return undefined;
    return { fulfillmentOwner, inventoryProductId };
  }

  private confirmCollectedPayment(input: {
    actor: "merchant" | "admin";
    operatorId: string;
    auditRole: string;
    order: DemoOrder;
    amountCents: bigint;
    voucherUrl?: string;
    note?: string;
  }) {
    const expectedAmount = payableAmount(input.order);
    if (input.order.paymentSnapshot?.provider && !isManualPaymentProvider(input.order.paymentSnapshot.provider)) {
      throw new ApiError(400, "MANUAL_CONFIRM_NOT_ALLOWED", "only personal payment orders can be manually confirmed");
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
      sheet.totalMerchantIncomeCents -= deducted;
      payableDeductionCents -= deducted;
      if (payableDeductionCents === 0n) return;
    }
  }

  private addChannelPendingIncome(order: DemoOrder) {
    const channel = getChannelSnapshot(order.snapshot);
    if (!channel) return;
    this.store.pendingIncomeByMerchant.set(
      channel.firstTierMerchantId,
      (this.store.pendingIncomeByMerchant.get(channel.firstTierMerchantId) ?? 0n) + channel.firstTierIncomeCents
    );
    if (channel.thirdTierMerchantId && channel.secondTierIncomeCents > 0n) {
      this.store.pendingIncomeByMerchant.set(
        channel.secondTierMerchantId,
        (this.store.pendingIncomeByMerchant.get(channel.secondTierMerchantId) ?? 0n) + channel.secondTierIncomeCents
      );
    }
  }

  private createInviteCode(input: {
    code?: string;
    issuerType: "platform" | "merchant";
    issuerMerchantId?: string;
    targetTier: MerchantTier;
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
    if (input.issuerType === "merchant") {
      const issuer = requireEntity(input.issuerMerchantId ? this.store.merchants.get(input.issuerMerchantId) : undefined, "RESOURCE_NOT_FOUND", "issuer merchant not found");
      const issuerTier = this.merchantTier(issuer.id);
      if (issuerTier === "first_tier" && input.targetTier !== "second_tier") throw new ApiError(400, "INVITE_RULE_FAILED", "first-tier invite must target second tier");
      if (issuerTier === "second_tier" && input.targetTier !== "third_tier") throw new ApiError(400, "INVITE_RULE_FAILED", "second-tier invite must target third tier");
      if (issuerTier === "third_tier") throw new ApiError(400, "FOURTH_TIER_FORBIDDEN", "third-tier merchants cannot create fourth-tier invite codes");
    }
    const invite: InviteCode = {
      id: nextId(this.store, "invite-code"),
      code,
      codeHash,
      issuerType: input.issuerType,
      issuerMerchantId: input.issuerMerchantId,
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
      const issuer = requireEntity(invite.issuerMerchantId ? this.store.merchants.get(invite.issuerMerchantId) : undefined, "INVITE_CODE_INVALID", "issuer not found");
      if (this.merchantTier(issuer.id) !== "second_tier") throw new ApiError(400, "FOURTH_TIER_FORBIDDEN", "invalid third-tier invite issuer");
    }
  }

  private findInviteByCode(code: string) {
    const codeHash = hashSecret(code);
    return [...this.store.inviteCodes.values()].find((candidate) => (
      candidate.code === code || candidate.codeHash === codeHash
    ));
  }

  private depositRequirementForMerchantInvite(merchantId: string) {
    const account = requireEntity(this.store.depositAccounts.get(merchantId), "RESOURCE_NOT_FOUND", "deposit account not found");
    if (account.requiredAmountCents <= 0n) {
      throw new ApiError(400, "DEPOSIT_REQUIREMENT_MISSING", "issuer deposit requirement is missing");
    }
    return account.requiredAmountCents;
  }

  private createPendingRelationForInvite(invite: InviteCode, childMerchantId: string) {
    if (invite.targetTier === "first_tier") return;
    const parentMerchantId = required(invite.issuerMerchantId, "issuerMerchantId");
    if (invite.targetTier === "second_tier") {
      this.store.channelRelations.push({
        id: nextId(this.store, "channel-rel"),
        firstTierMerchantId: parentMerchantId,
        secondTierMerchantId: childMerchantId,
        status: "pending_review",
        reason: "invite_registration",
        reviewedAt: null,
        activeUniqueKey: `second-tier:${childMerchantId}`
      });
      return;
    }
    const upstream = requireEntity(
      this.store.channelRelations.find((relation) => relation.status === "active" && !relation.thirdTierMerchantId && relation.secondTierMerchantId === parentMerchantId),
      "CHANNEL_RULE_FAILED",
      "second-tier issuer must have an active first-tier relation before inviting third tier"
    );
    this.store.channelRelations.push({
      id: nextId(this.store, "channel-rel"),
      firstTierMerchantId: upstream.firstTierMerchantId,
      secondTierMerchantId: parentMerchantId,
      thirdTierMerchantId: childMerchantId,
      status: "pending_review",
      reason: "invite_registration",
      reviewedAt: null,
      activeUniqueKey: `third-tier:${childMerchantId}`
    });
  }

  private activateEligibleInviteRelations(merchantId: string) {
    for (const relation of this.store.channelRelations) {
      if (relation.status !== "pending_deposit") continue;
      if (relation.secondTierMerchantId !== merchantId && relation.thirdTierMerchantId !== merchantId) continue;
      const second = this.store.merchants.get(relation.secondTierMerchantId);
      const third = relation.thirdTierMerchantId ? this.store.merchants.get(relation.thirdTierMerchantId) : undefined;
      if (second?.status === "active" && (!relation.thirdTierMerchantId || third?.status === "active")) {
        relation.status = "active";
        relation.reviewedAt = new Date();
      }
    }
  }

  private merchantTier(merchantId: string): MerchantTier {
    const merchant = requireEntity(this.store.merchants.get(merchantId), "RESOURCE_NOT_FOUND", "merchant not found");
    if (merchant.tier) return merchant.tier;
    if (this.store.channelRelations.some((relation) => relation.status === "active" && relation.thirdTierMerchantId === merchantId)) return "third_tier";
    if (this.store.channelRelations.some((relation) => relation.status === "active" && relation.secondTierMerchantId === merchantId)) return "second_tier";
    return "first_tier";
  }

  private serializeInviteCode(invite: InviteCode, actor?: MerchantActor) {
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
        merchantId: invite.issuerMerchantId
      },
      currentMerchantScope: actor ? {
        merchantId: actor.merchantId,
        shopId: actor.shopId,
        ownsInvite: invite.issuerMerchantId === actor.merchantId
      } : undefined,
      createdAt: invite.createdAt
    };
  }

  private findActiveChannelRelationForSellingMerchant(merchantId: string) {
    return this.store.channelRelations.find((relation) => (relation.thirdTierMerchantId === merchantId || (!relation.thirdTierMerchantId && relation.secondTierMerchantId === merchantId)) && relation.status === "active");
  }

  private findFirstSecondRelationFor(relation: ChannelRelation) {
    if (!relation.thirdTierMerchantId) return relation;
    return this.store.channelRelations.find((candidate) => candidate.status === "active" && !candidate.thirdTierMerchantId && candidate.firstTierMerchantId === relation.firstTierMerchantId && candidate.secondTierMerchantId === relation.secondTierMerchantId);
  }

  private firstSecondRelationFor(relation: ChannelRelation) {
    return requireEntity(this.findFirstSecondRelationFor(relation), "RESOURCE_NOT_FOUND", "first-to-second channel relation not found");
  }

  private upstreamSupplyPriceForRelation(relation: ChannelRelation, platformProductId: string) {
    if (!relation.thirdTierMerchantId) {
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

  private findShopByMerchantId(merchantId: string) {
    return [...this.store.shops.values()].find((candidate) => candidate.merchantId === merchantId);
  }

  private addDepositTransaction(merchantId: string, input: Omit<DepositTransaction, "transactionNo" | "merchantId">) {
    const transaction: DepositTransaction = {
      transactionNo: nextId(this.store, "deposit-tx"),
      merchantId,
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

  private ledger(entryType: string, target: { orderNo?: string; merchantId?: string }, amountCents: bigint, metadata: unknown) {
    this.store.ledgerEntries.push({
      ledgerNo: nextId(this.store, "ledger"),
      entryType,
      orderNo: target.orderNo,
      merchantId: target.merchantId,
      amountCents,
      metadata,
      createdAt: new Date()
    });
  }

  private notify(merchantId: string, type: string, title: string, content: string) {
    const notification: NotificationItem = {
      id: nextId(this.store, "notice"),
      merchantId,
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

  private isSecondTierSupplier(merchantId: string) {
    return this.store.channelRelations.some((relation) => relation.status === "active" && relation.secondTierMerchantId === merchantId && relation.thirdTierMerchantId);
  }

  private resolveShop(shopIdentifier: string): DemoShop | undefined {
    const normalized = normalizeShopIdentifier(shopIdentifier);
    if (!normalized || ["default", "platform", "home"].includes(normalized)) return this.defaultPublicShop();

    const direct = this.store.shops.get(normalized);
    if (direct) return direct;

    for (const shop of this.store.shops.values()) {
      const aliases = new Set([
        shop.id,
        shop.shopNo,
        shop.sharePath,
        publicShopPath(shop),
        stripShopPath(shop.sharePath),
        stripShopPath(publicShopPath(shop))
      ].filter(Boolean) as string[]);
      if (aliases.has(normalized)) return shop;
    }
    return undefined;
  }

  private defaultPublicShop(): DemoShop | undefined {
    const configured = process.env.DEFAULT_PLATFORM_SHOP_ID || process.env.VITE_PLATFORM_SHOP_ID;
    if (configured) {
      const shop = this.resolveShop(configured);
      if (shop) return shop;
    }
    return [...this.store.shops.values()].find((shop) => (shop.ownerType ?? "merchant") === "platform" && shop.status === "open")
      ?? (process.env.VITE_DEFAULT_SHOP_ID ? this.resolveShop(process.env.VITE_DEFAULT_SHOP_ID) : undefined)
      ?? [...this.store.shops.values()].find((shop) => shop.status === "open")
      ?? [...this.store.shops.values()][0];
  }

  private assertMerchantDepositConfirmed(merchantId: string, action: string) {
    const account = requireEntity(this.store.depositAccounts.get(merchantId), "RESOURCE_NOT_FOUND", "deposit account not found");
    if (shouldRestrictForDeposit(account)) {
      throw new ApiError(403, "DEPOSIT_INSUFFICIENT", `merchant deposit is required before ${action}`);
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
    let connectionError: unknown;
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
      connectionError = error;
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

    if (connectionError) throw connectionError;
    throw new ApiError(401, "AUTH_INVALID", "invalid admin credentials");
  }

  async verifyMerchant(input: { account: string; password: string }): Promise<MerchantLoginResult> {
    const rows = await this.prisma.$queryRaw<Array<{
      username: string;
      password_hash: string | null;
      status: string;
      must_change_password: boolean;
      merchant_id: string | null;
      shop_id: string | null;
      display_name: string | null;
      tier: MerchantTier | null;
      merchant_status: string | null;
      deposit_status: string | null;
      shop_name: string | null;
      shop_status: string | null;
    }>>`
	      SELECT ma.username, ma.password_hash, ma.status, ma.must_change_password,
		             m.id AS merchant_id, s.id AS shop_id, m.name AS display_name,
                 m.tier AS tier,
		             m.status AS merchant_status, m.deposit_status, s.name AS shop_name, s.status AS shop_status
		        FROM merchant_accounts ma
		        JOIN merchants m ON m.id = ma.merchant_id
	        JOIN shops s ON s.merchant_id = m.id
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
    if (!account.merchant_id || !account.shop_id) {
      throw new ApiError(401, "AUTH_INVALID", "merchant account is not linked to an active shop");
    }
    if (account.merchant_status !== "active" && account.merchant_status !== "pending_deposit") {
      throw new ApiError(403, "AUTH_DISABLED", "merchant account is not active");
    }
    return {
      merchantId: account.merchant_id,
      shopId: account.shop_id,
      username: account.username,
      displayName: account.display_name ?? account.username,
      tier: account.tier ?? undefined,
      status: account.merchant_status ?? "pending_review",
      depositStatus: account.deposit_status ?? "pending_payment",
      shopName: account.shop_name ?? account.username,
      shopStatus: account.shop_status ?? "not_opened",
      mustChangePassword: account.must_change_password
    };
  }

  async getPublicShop(shopIdentifier: string) {
    const shop = await this.findPublicShop(shopIdentifier);
    if (!shop) throw new ApiError(404, "RESOURCE_NOT_FOUND", "shop not found");
    return this.serializePublicShopRow(shop);
  }

  async getMerchantShop(actor: MerchantActor) {
    const shop = await this.findPublicShop(actor.shopId);
    if (!shop) throw new ApiError(404, "RESOURCE_NOT_FOUND", "shop not found");
    assertMerchantScope(actor, { merchantId: required(shop.merchantId, "merchantId"), shopId: shop.id });
    return shop;
  }

  async createMerchantByAdmin(actor: AdminActor, input: Parameters<BackendServices["createMerchantByAdmin"]>[1]) {
    assertAdminPermission(actor, "merchant.review");
    if (input.targetTier && input.targetTier !== "first_tier") {
      throw new ApiError(400, "ADMIN_CREATE_FIRST_TIER_ONLY", "admin manual creation can only create first-tier merchants");
    }
    const requiredAmount = input.depositRequiredAmountCents ?? input.depositAmountCents;
    if (requiredAmount === undefined || requiredAmount <= 0n) {
      throw new ApiError(400, "DEPOSIT_REQUIREMENT_MISSING", "deposit required amount is required");
    }
    const paidAmount = input.depositPaid ? (input.depositAmountCents ?? requiredAmount) : 0n;
    const paid = paidAmount >= requiredAmount;
    const now = new Date();
    const seed = `${now.getTime()}-${randomUUID().slice(0, 8)}`;
    const merchantId = `merchant-${seed}`;
    const shopId = `shop-${seed}`;
    const userId = `merchant-user-${seed}`;
    const initialPassword = input.initialPassword ?? `TS${Date.now().toString().slice(-6)}`;
    const merchant: DemoMerchant = {
      id: merchantId,
      userId,
      name: input.name,
      contactPhone: input.contactPhone,
      tier: "first_tier",
      status: paid ? "active" : "pending_deposit",
      riskStatus: "normal",
      depositStatus: paid ? "paid" : "pending_payment",
      createdByAdminId: actor.adminId,
      initialPasswordSet: true,
      merchantUsername: merchantId,
      passwordHash: `sha256:${hashSecret(initialPassword)}`
    };
    const shop: DemoShop = {
      id: shopId,
      merchantId,
      ownerType: "merchant",
      name: input.shopName ?? `${input.name} 小店`,
      status: paid ? "open" : "not_opened",
      riskStatus: "normal",
      announcement: "精选虚拟权益，付款后按商品规则发放。",
      customerServiceWechat: input.customerServiceWechat,
      themeColor: "#ff9900",
      shareTitle: `${input.name} 官方小店`,
      createdByAdminId: actor.adminId
    };
    const depositAccount = {
      merchantId,
      requiredAmountCents: requiredAmount,
      availableAmountCents: paidAmount,
      frozenAmountCents: 0n,
      deductedAmountCents: 0n,
      status: paid ? "paid" : "pending_payment"
    };
    const auditKey = `audit:merchant.admin_create_first_tier:${merchantId}`;
    await this.persistInShortTransaction(async (tx) => {
      await this.persistUserId(tx, userId);
      await this.persistAdminPlaceholder(tx, actor.adminId);
      await this.persistMerchant(tx, merchant);
      await this.persistMerchantAccountForMerchant(tx, merchant);
      await this.persistShop(tx, shop);
      await this.persistDepositAccount(tx, merchantId, depositAccount);
      if (paidAmount > 0n) {
        await this.persistDepositTransaction(tx, {
          transactionNo: `deposit-tx-${seed}`,
          merchantId,
          type: "pay",
          amountCents: paidAmount,
          balanceBeforeCents: 0n,
          balanceAfterCents: paidAmount,
          reasonCode: "admin_manual_create",
          relatedType: "merchant",
          relatedId: merchantId,
          idempotencyKey: `admin-create-merchant:${merchantId}:deposit`,
          proofUrl: "admin://manual-first-tier",
          operatorId: actor.adminId,
          remark: "后台手工开一级商户并确认保证金"
        });
      }
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id,
          after_json, idempotency_key, request_id, ip, created_at
        )
        VALUES (
          ${stableDbId("audit", auditKey)}, CAST('admin' AS "ActorType"), ${actor.adminId},
          'merchant.admin_create_first_tier', 'merchant', ${merchantId},
          ${jsonForDb({ merchantId, shopId, depositPaid: paid, operatorId: actor.adminId })}::jsonb,
          ${auditKey}, ${auditKey}, '127.0.0.1', ${now}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
    });
    return {
      merchant: {
        id: merchant.id,
        userId: merchant.userId,
        name: merchant.name,
        contactPhone: merchant.contactPhone,
        tier: merchant.tier,
        status: merchant.status,
        riskStatus: merchant.riskStatus,
        depositStatus: merchant.depositStatus,
        createdByAdminId: merchant.createdByAdminId
      },
      shop,
      credential: {
        account: merchantId,
        initialPassword,
        mustResetPassword: true
      }
    };
  }

  async listPlatformProducts(actor?: MerchantActor) {
    if (!actor) {
      return this.listDirectFirstTierPlatformProducts();
    }
    const shop = await this.getMerchantShop(actor);
    await this.assertDirectMerchantCanManageProducts(actor.merchantId, shop.id);
    const tierRows = await this.prisma.$queryRaw<Array<{ tier: MerchantTier }>>`
      SELECT tier FROM merchants WHERE id = ${actor.merchantId} LIMIT 1
    `;
    const tier = tierRows[0]?.tier ?? "first_tier";
    return tier === "first_tier"
      ? this.listDirectFirstTierPlatformProducts()
      : this.listDirectUpstreamPlatformProducts(actor.merchantId);
  }

  async listMerchantProducts(actor: MerchantActor) {
    await this.getMerchantShop(actor);
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
        FROM merchant_product_listings
       WHERE merchant_id = ${actor.merchantId}
         AND shop_id = ${actor.shopId}
       ORDER BY updated_at DESC, created_at DESC
    `;
    return Promise.all(rows.map((row) => this.getDirectMerchantProductListing(actor, row.id)));
  }

  async getMerchantProductDetail(actor: MerchantActor, merchantProductListingId: string) {
    return this.getDirectMerchantProductListing(actor, merchantProductListingId);
  }

  async updateMerchantProductDetail(actor: MerchantActor, merchantProductListingId: string, input: MerchantProductListingDetailUpdateInput) {
    await this.getMerchantShop(actor);
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      merchant_id: string;
      shop_id: string;
      platform_product_id: string;
      upstream_listing_id: string | null;
      sale_price_cents: bigint;
      display_name: string | null;
      display_subtitle: string | null;
      display_description: string | null;
      display_usage_guide: string | null;
      display_image_url: string | null;
      display_category: string | null;
      display_tags_json: unknown;
      display_specs_json: unknown;
      display_detail_sections_json: unknown;
      status: string;
      supply_price_cents: bigint;
      min_sale_price_cents: bigint;
      upstream_sale_price_cents: bigint | null;
    }>>`
      SELECT mpl.id, mpl.merchant_id, mpl.shop_id, mpl.platform_product_id, mpl.upstream_listing_id,
             mpl.sale_price_cents, mpl.display_name, mpl.display_subtitle, mpl.display_description,
             mpl.display_usage_guide, mpl.display_image_url, mpl.display_category,
             mpl.display_tags_json, mpl.display_specs_json, mpl.display_detail_sections_json, mpl.status,
             pp.supply_price_cents, pp.min_sale_price_cents, upstream.sale_price_cents AS upstream_sale_price_cents
        FROM merchant_product_listings mpl
        JOIN platform_products pp ON pp.id = mpl.platform_product_id
        LEFT JOIN merchant_product_listings upstream ON upstream.id = mpl.upstream_listing_id
       WHERE mpl.id = ${merchantProductListingId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "merchant product not found");
    assertMerchantScope(actor, { merchantId: row.merchant_id, shopId: row.shop_id });
    const salePriceCents = input.salePriceCents ?? row.sale_price_cents;
    const supplyPriceCents = row.upstream_sale_price_cents ?? row.supply_price_cents;
    const minSalePriceCents = maxBigInt([row.min_sale_price_cents, supplyPriceCents]);
    try {
      quotePlatformProduct({ salePriceCents, supplyPriceCents, minSalePriceCents });
    } catch (error) {
      throw new ApiError(400, "PRICE_RULE_FAILED", getErrorMessage(error));
    }

    const displayTags = "displayTags" in input ? normalizeOptionalStringArray(input.displayTags) : (Array.isArray(row.display_tags_json) ? row.display_tags_json as string[] : undefined);
    const displaySpecs = "displaySpecs" in input ? normalizeOptionalStringArray(input.displaySpecs) : (Array.isArray(row.display_specs_json) ? row.display_specs_json as string[] : undefined);
    const displayDetailSections = "displayDetailSections" in input ? normalizeOptionalDetailSections(input.displayDetailSections) : (Array.isArray(row.display_detail_sections_json) ? row.display_detail_sections_json as ProductDetailSection[] : undefined);
    const status = input.status ? mapProductListingStatus(input.status) : mapProductListingStatus(row.status);
    const now = new Date();
    const auditKey = `audit:merchant_product_listing.detail_update:${row.id}:${now.getTime()}`;
    await this.persistInShortTransaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE merchant_product_listings
           SET sale_price_cents = ${salePriceCents},
               display_name = ${"displayName" in input ? optionalTrimmedText(input.displayName) ?? null : row.display_name},
               display_subtitle = ${"displaySubtitle" in input ? optionalTrimmedText(input.displaySubtitle) ?? null : row.display_subtitle},
               display_description = ${"displayDescription" in input ? optionalTrimmedText(input.displayDescription) ?? null : row.display_description},
               display_usage_guide = ${"displayUsageGuide" in input ? optionalTrimmedText(input.displayUsageGuide) ?? null : row.display_usage_guide},
               display_image_url = ${"displayImageUrl" in input ? optionalTrimmedText(input.displayImageUrl) ?? null : row.display_image_url},
               display_category = ${"displayCategory" in input ? optionalTrimmedText(input.displayCategory) ?? null : row.display_category},
               display_tags_json = ${displayTags ? jsonForDb(displayTags) : null}::jsonb,
               display_specs_json = ${displaySpecs ? jsonForDb(displaySpecs) : null}::jsonb,
               display_detail_sections_json = ${displayDetailSections ? jsonForDb(displayDetailSections) : null}::jsonb,
               status = CAST(${status} AS "ProductListingStatus"),
               listed_at = CASE WHEN ${status} = 'listed' THEN COALESCE(listed_at, ${now}) ELSE listed_at END,
               delisted_at = CASE WHEN ${status} = 'delisted' THEN ${now} ELSE delisted_at END,
               updated_at = ${now}
         WHERE id = ${row.id}
      `;
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id,
          after_json, idempotency_key, request_id, ip, created_at
        )
        VALUES (
          ${stableDbId("audit", auditKey)}, CAST('merchant' AS "ActorType"), ${actor.merchantId},
          'merchant_product_listing.detail_update', 'merchant_product_listing', ${row.id},
          ${jsonForDb({ id: row.id, salePriceCents, status, input })}::jsonb,
          ${auditKey}, ${auditKey}, '127.0.0.1', ${now}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
    });
    return this.getDirectMerchantProductListing(actor, row.id);
  }

  async selectPlatformProduct(actor: MerchantActor, input: MerchantProductListingSelectionInput) {
    await this.getMerchantShop(actor);
    const rows = await this.prisma.$queryRaw<Array<{
      merchant_status: string;
      merchant_tier: MerchantTier;
      merchant_risk_status: string | null;
      deposit_status: string | null;
      shop_status: string;
      shop_risk_status: string | null;
      product_id: string | null;
      product_name: string | null;
      product_status: string | null;
      supply_price_cents: bigint | null;
      min_sale_price_cents: bigint | null;
    }>>`
      SELECT m.status AS merchant_status, m.tier AS merchant_tier, m.risk_status AS merchant_risk_status,
             da.status AS deposit_status, s.status AS shop_status, s.risk_status AS shop_risk_status,
             pp.id AS product_id, pp.name AS product_name, pp.status AS product_status,
             pp.supply_price_cents, pp.min_sale_price_cents
        FROM merchants m
        JOIN shops s ON s.merchant_id = m.id
        LEFT JOIN deposit_accounts da ON da.merchant_id = m.id
        LEFT JOIN platform_products pp ON pp.id = ${input.platformProductId}
       WHERE m.id = ${actor.merchantId}
         AND s.id = ${actor.shopId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "merchant shop not found");
    if (!row.product_id) throw new ApiError(404, "RESOURCE_NOT_FOUND", "platform product not found");
    if (row.merchant_status !== "active" || row.deposit_status !== "paid") {
      throw new ApiError(400, "DEPOSIT_INSUFFICIENT", "merchant deposit is required before select platform product");
    }
    if (row.shop_status !== "open") throw new ApiError(400, "SHOP_NOT_OPEN", "merchant shop is not open");
    if (row.merchant_risk_status !== "normal" || row.shop_risk_status !== "normal") {
      throw new ApiError(400, "RISK_BLOCKED", "risk freeze blocks product listing");
    }
    if (row.product_status !== "active") throw new ApiError(400, "PRODUCT_NOT_LISTED", "platform product is not active");

    const upstream = row.merchant_tier === "first_tier"
      ? undefined
      : await this.findDirectUpstreamProductListing(actor.merchantId, input.platformProductId);
    if (row.merchant_tier !== "first_tier" && !upstream) {
      throw new ApiError(404, "RESOURCE_NOT_FOUND", "platform product is not available to current merchant");
    }
    const supplyPriceCents = upstream?.salePriceCents ?? required(row.supply_price_cents, "supplyPriceCents");
    const minSalePriceCents = maxBigInt([required(row.min_sale_price_cents, "minSalePriceCents"), supplyPriceCents]);
    try {
      quotePlatformProduct({
        salePriceCents: input.salePriceCents,
        supplyPriceCents,
        minSalePriceCents
      });
    } catch (error) {
      throw new ApiError(400, "PRICE_RULE_FAILED", getErrorMessage(error));
    }

    const existingRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
        FROM merchant_product_listings
       WHERE shop_id = ${actor.shopId}
         AND platform_product_id = ${input.platformProductId}
       LIMIT 1
    `;
    const listingId = existingRows[0]?.id ?? `merchant-listing-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const auditKey = `audit:merchant_product_listing.select_platform:${listingId}:${now.getTime()}`;
    await this.persistInShortTransaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO merchant_product_listings (
          id, merchant_id, shop_id, source_type, platform_product_id, upstream_listing_id,
          sale_price_cents, display_name, display_subtitle, display_description,
          display_usage_guide, display_image_url, display_category, display_tags_json,
          display_specs_json, display_detail_sections_json, status, listed_at, created_at, updated_at
        )
        VALUES (
          ${listingId}, ${actor.merchantId}, ${actor.shopId},
          CAST(${upstream ? "upstream_listing" : "platform_product"} AS "MerchantProductListingSourceType"),
          ${input.platformProductId}, ${upstream?.id ?? null},
          ${input.salePriceCents},
          ${optionalTrimmedText(input.displayName) ?? null},
          ${optionalTrimmedText(input.displaySubtitle) ?? null},
          ${optionalTrimmedText(input.displayDescription) ?? null},
          ${optionalTrimmedText(input.displayUsageGuide) ?? null},
          ${optionalTrimmedText(input.displayImageUrl) ?? null},
          ${optionalTrimmedText(input.displayCategory) ?? null},
          ${normalizeOptionalStringArray(input.displayTags) ? jsonForDb(normalizeOptionalStringArray(input.displayTags)) : null}::jsonb,
          ${normalizeOptionalStringArray(input.displaySpecs) ? jsonForDb(normalizeOptionalStringArray(input.displaySpecs)) : null}::jsonb,
          ${normalizeOptionalDetailSections(input.displayDetailSections) ? jsonForDb(normalizeOptionalDetailSections(input.displayDetailSections)) : null}::jsonb,
          CAST('listed' AS "ProductListingStatus"), ${now}, ${now}, ${now}
        )
        ON CONFLICT (shop_id, platform_product_id) DO UPDATE SET
          source_type = EXCLUDED.source_type,
          upstream_listing_id = EXCLUDED.upstream_listing_id,
          sale_price_cents = EXCLUDED.sale_price_cents,
          display_name = EXCLUDED.display_name,
          display_subtitle = EXCLUDED.display_subtitle,
          display_description = EXCLUDED.display_description,
          display_usage_guide = EXCLUDED.display_usage_guide,
          display_image_url = EXCLUDED.display_image_url,
          display_category = EXCLUDED.display_category,
          display_tags_json = EXCLUDED.display_tags_json,
          display_specs_json = EXCLUDED.display_specs_json,
          display_detail_sections_json = EXCLUDED.display_detail_sections_json,
          status = EXCLUDED.status,
          listed_at = EXCLUDED.listed_at,
          updated_at = EXCLUDED.updated_at
      `;
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id,
          after_json, idempotency_key, request_id, ip, created_at
        )
        VALUES (
          ${stableDbId("audit", auditKey)}, CAST('merchant' AS "ActorType"), ${actor.merchantId},
          'merchant_product_listing.select_platform', 'merchant_product_listing', ${listingId},
          ${jsonForDb({ id: listingId, merchantId: actor.merchantId, shopId: actor.shopId, platformProductId: input.platformProductId, upstreamListingId: upstream?.id, salePriceCents: input.salePriceCents, status: "listed" })}::jsonb,
          ${auditKey}, ${auditKey}, '127.0.0.1', ${now}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
    });
    return this.getDirectMerchantProductListing(actor, listingId);
  }

  private async findDirectUpstreamProductListing(merchantId: string, platformProductId: string): Promise<{ id: string; salePriceCents: bigint } | undefined> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; sale_price_cents: bigint }>>`
      SELECT mpl.id, mpl.sale_price_cents
        FROM merchant_applications ma
        JOIN merchant_invite_codes mic ON mic.id = ma.invite_code_id
        JOIN merchant_product_listings mpl ON mpl.merchant_id = mic.issuer_merchant_id
       WHERE ma.merchant_id = ${merchantId}
         AND ma.status = 'approved'
         AND mic.issuer_merchant_id IS NOT NULL
         AND mpl.platform_product_id = ${platformProductId}
         AND mpl.status = 'listed'
       ORDER BY ma.reviewed_at DESC NULLS LAST, ma.created_at DESC, mpl.updated_at DESC
       LIMIT 1
    `;
    const row = rows[0];
    return row ? { id: row.id, salePriceCents: row.sale_price_cents } : undefined;
  }

  private async assertDirectMerchantCanManageProducts(merchantId: string, shopId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      merchant_status: string;
      deposit_status: string | null;
      shop_status: string;
      merchant_risk_status: string | null;
      shop_risk_status: string | null;
    }>>`
      SELECT m.status AS merchant_status, da.status AS deposit_status,
             s.status AS shop_status, m.risk_status AS merchant_risk_status,
             s.risk_status AS shop_risk_status
        FROM merchants m
        JOIN shops s ON s.merchant_id = m.id
        LEFT JOIN deposit_accounts da ON da.merchant_id = m.id
       WHERE m.id = ${merchantId}
         AND s.id = ${shopId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "merchant shop not found");
    if (row.merchant_status !== "active" || row.deposit_status !== "paid") {
      throw new ApiError(400, "DEPOSIT_INSUFFICIENT", "merchant deposit is required before managing products");
    }
    if (row.shop_status !== "open") throw new ApiError(400, "SHOP_NOT_OPEN", "merchant shop is not open");
    if (row.merchant_risk_status !== "normal" || row.shop_risk_status !== "normal") {
      throw new ApiError(400, "RISK_BLOCKED", "risk freeze blocks product management");
    }
  }

  private async listDirectFirstTierPlatformProducts() {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      name: string;
      category_name: string | null;
      tags_json: unknown;
      image_url: string | null;
      specs_json: unknown;
      detail_sections_json: unknown;
      stock_count: number | null;
      public_stock_count: number | null;
      sold_count: number | null;
      display_badge: string | null;
      is_recommended: boolean | null;
      display_sort: number | null;
      detail: string | null;
      rights_desc: string | null;
      supply_price_cents: bigint;
      min_sale_price_cents: bigint;
      suggested_sale_price_cents: bigint;
      fulfillment_rule_json: unknown;
      after_sale_rule_json: unknown;
      status: string;
    }>>`
      SELECT id, name, category_name, tags_json, image_url, specs_json, detail_sections_json,
             stock_count, sold_count, display_badge, is_recommended, display_sort, detail, rights_desc,
             supply_price_cents, min_sale_price_cents, suggested_sale_price_cents,
             fulfillment_rule_json, after_sale_rule_json, status
        FROM platform_products
       WHERE status = 'active'
       ORDER BY COALESCE(display_sort, 0) DESC, created_at ASC
    `;
    return rows.map((row) => this.serializeDirectPlatformProductRow(row, {
      canSeePlatformSupplyPrice: true,
      platformSupplyPriceCents: row.supply_price_cents
    }));
  }

  private async listDirectUpstreamPlatformProducts(merchantId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      name: string;
      category_name: string | null;
      tags_json: unknown;
      image_url: string | null;
      specs_json: unknown;
      detail_sections_json: unknown;
      stock_count: number | null;
      public_stock_count: number | null;
      sold_count: number | null;
      display_badge: string | null;
      is_recommended: boolean | null;
      display_sort: number | null;
      detail: string | null;
      rights_desc: string | null;
      supply_price_cents: bigint;
      min_sale_price_cents: bigint;
      suggested_sale_price_cents: bigint;
      fulfillment_rule_json: unknown;
      after_sale_rule_json: unknown;
      status: string;
      upstream_listing_id: string;
      upstream_sale_price_cents: bigint;
      upstream_display_name: string | null;
      upstream_display_subtitle: string | null;
      upstream_display_description: string | null;
      upstream_display_usage_guide: string | null;
      upstream_display_image_url: string | null;
      upstream_display_category: string | null;
      upstream_display_tags_json: unknown;
      upstream_display_specs_json: unknown;
      upstream_display_detail_sections_json: unknown;
    }>>`
      SELECT pp.id, pp.name, pp.category_name, pp.tags_json, pp.image_url, pp.specs_json,
             pp.detail_sections_json, pp.stock_count, pp.sold_count, pp.display_badge,
             pp.is_recommended, pp.display_sort, pp.detail, pp.rights_desc, pp.supply_price_cents,
             pp.min_sale_price_cents, pp.suggested_sale_price_cents, pp.fulfillment_rule_json,
             pp.after_sale_rule_json, pp.status,
             upstream.id AS upstream_listing_id, upstream.sale_price_cents AS upstream_sale_price_cents,
             upstream.display_name AS upstream_display_name,
             upstream.display_subtitle AS upstream_display_subtitle,
             upstream.display_description AS upstream_display_description,
             upstream.display_usage_guide AS upstream_display_usage_guide,
             upstream.display_image_url AS upstream_display_image_url,
             upstream.display_category AS upstream_display_category,
             upstream.display_tags_json AS upstream_display_tags_json,
             upstream.display_specs_json AS upstream_display_specs_json,
             upstream.display_detail_sections_json AS upstream_display_detail_sections_json
        FROM merchant_applications ma
        JOIN merchant_invite_codes mic ON mic.id = ma.invite_code_id
        JOIN merchant_product_listings upstream ON upstream.merchant_id = mic.issuer_merchant_id
        JOIN platform_products pp ON pp.id = upstream.platform_product_id
       WHERE ma.merchant_id = ${merchantId}
         AND ma.status = 'approved'
         AND mic.issuer_merchant_id IS NOT NULL
         AND upstream.status = 'listed'
         AND pp.status = 'active'
       ORDER BY COALESCE(pp.display_sort, 0) DESC, upstream.updated_at DESC
    `;
    return rows.map((row) => this.serializeDirectPlatformProductRow({
      ...row,
      name: row.upstream_display_name ?? row.name,
      category_name: row.upstream_display_category ?? row.category_name,
      tags_json: Array.isArray(row.upstream_display_tags_json) ? row.upstream_display_tags_json : row.tags_json,
      image_url: row.upstream_display_image_url ?? row.image_url,
      specs_json: Array.isArray(row.upstream_display_specs_json) ? row.upstream_display_specs_json : row.specs_json,
      detail_sections_json: Array.isArray(row.upstream_display_detail_sections_json) ? row.upstream_display_detail_sections_json : row.detail_sections_json,
      detail: row.upstream_display_description ?? row.detail,
      rights_desc: row.upstream_display_subtitle ?? row.rights_desc
    }, {
      canSeePlatformSupplyPrice: false,
      sourceName: row.name,
      upstreamMerchantProductId: row.upstream_listing_id,
      visibleUpstreamSupplyPriceCents: row.upstream_sale_price_cents,
      minSalePriceCents: maxBigInt([row.min_sale_price_cents, row.upstream_sale_price_cents]),
      suggestedSalePriceCents: maxBigInt([row.suggested_sale_price_cents, row.upstream_sale_price_cents])
    }));
  }

  private serializeDirectPlatformProductRow(row: {
    id: string;
    name: string;
    category_name: string | null;
    tags_json: unknown;
    image_url: string | null;
    specs_json: unknown;
    detail_sections_json: unknown;
    stock_count: number | null;
    sold_count: number | null;
    display_badge: string | null;
    is_recommended: boolean | null;
    display_sort: number | null;
    detail: string | null;
    rights_desc: string | null;
    supply_price_cents: bigint;
    min_sale_price_cents: bigint;
    suggested_sale_price_cents: bigint;
    fulfillment_rule_json: unknown;
    after_sale_rule_json: unknown;
    status: string;
  }, visibility: {
    canSeePlatformSupplyPrice: boolean;
    platformSupplyPriceCents?: bigint;
    sourceName?: string;
    upstreamMerchantProductId?: string;
    visibleUpstreamSupplyPriceCents?: bigint;
    minSalePriceCents?: bigint;
    suggestedSalePriceCents?: bigint;
  }) {
    return {
      id: row.id,
      name: row.name,
      category: row.category_name ?? undefined,
      tags: Array.isArray(row.tags_json) ? row.tags_json : undefined,
      subtitle: row.rights_desc ?? undefined,
      description: row.detail ?? undefined,
      imageUrl: row.image_url ?? undefined,
      specs: Array.isArray(row.specs_json) ? row.specs_json : undefined,
      detailSections: Array.isArray(row.detail_sections_json) ? row.detail_sections_json : undefined,
      stockCount: row.stock_count ?? undefined,
      soldCount: row.sold_count ?? undefined,
      displayBadge: row.display_badge ?? undefined,
      isRecommended: row.is_recommended ?? undefined,
      displaySort: row.display_sort ?? undefined,
      supplyPriceCents: visibility.canSeePlatformSupplyPrice ? row.supply_price_cents : undefined,
      platformSupplyPriceCents: visibility.platformSupplyPriceCents,
      minSalePriceCents: visibility.minSalePriceCents ?? row.min_sale_price_cents,
      suggestedSalePriceCents: visibility.suggestedSalePriceCents ?? row.suggested_sale_price_cents,
      fulfillmentRule: row.fulfillment_rule_json,
      afterSaleRule: row.after_sale_rule_json,
      status: row.status,
      sourceName: visibility.sourceName,
      upstreamMerchantProductId: visibility.upstreamMerchantProductId,
      visibleUpstreamSupplyPriceCents: visibility.visibleUpstreamSupplyPriceCents
    };
  }

  private async getDirectMerchantProductListing(actor: MerchantActor, listingId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      merchant_id: string;
      shop_id: string;
      source_type: string;
      platform_product_id: string;
      upstream_listing_id: string | null;
      sale_price_cents: bigint;
      display_name: string | null;
      display_subtitle: string | null;
      display_description: string | null;
      display_usage_guide: string | null;
      display_image_url: string | null;
      display_category: string | null;
      display_tags_json: unknown;
      display_specs_json: unknown;
      display_detail_sections_json: unknown;
      status: string;
      pp_name: string;
      category_name: string | null;
      tags_json: unknown;
      image_url: string | null;
      specs_json: unknown;
      detail_sections_json: unknown;
      stock_count: number | null;
      public_stock_count: number | null;
      sold_count: number | null;
      display_badge: string | null;
      is_recommended: boolean | null;
      display_sort: number | null;
      detail: string | null;
      rights_desc: string | null;
      fulfillment_rule_json: unknown;
      after_sale_rule_json: unknown;
      product_status: string;
      supply_price_cents: bigint;
      min_sale_price_cents: bigint;
      suggested_sale_price_cents: bigint;
      upstream_sale_price_cents: bigint | null;
    }>>`
      SELECT mpl.id, mpl.merchant_id, mpl.shop_id, mpl.source_type, mpl.platform_product_id,
             mpl.upstream_listing_id, mpl.sale_price_cents, mpl.display_name, mpl.display_subtitle,
             mpl.display_description, mpl.display_usage_guide, mpl.display_image_url, mpl.display_category,
             mpl.display_tags_json, mpl.display_specs_json, mpl.display_detail_sections_json, mpl.status,
             pp.name AS pp_name, pp.category_name, pp.tags_json, pp.image_url, pp.specs_json,
             pp.detail_sections_json, pp.stock_count, pp.sold_count, pp.display_badge, pp.is_recommended,
             pp.display_sort, pp.detail, pp.rights_desc, pp.fulfillment_rule_json,
             pp.after_sale_rule_json, pp.status AS product_status, pp.supply_price_cents,
             pp.min_sale_price_cents, pp.suggested_sale_price_cents,
             upstream.sale_price_cents AS upstream_sale_price_cents
        FROM merchant_product_listings mpl
        JOIN platform_products pp ON pp.id = mpl.platform_product_id
        LEFT JOIN merchant_product_listings upstream ON upstream.id = mpl.upstream_listing_id
       WHERE mpl.id = ${listingId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "merchant product not found");
    assertMerchantScope(actor, { merchantId: row.merchant_id, shopId: row.shop_id });
    const directPlatformSource = !row.upstream_listing_id;
    const visibleUpstreamSupplyPriceCents = row.upstream_sale_price_cents ?? undefined;
    const minSalePriceCents = maxBigInt([
      row.min_sale_price_cents,
      visibleUpstreamSupplyPriceCents ?? row.supply_price_cents
    ]);
    const suggestedSalePriceCents = maxBigInt([
      row.suggested_sale_price_cents,
      visibleUpstreamSupplyPriceCents ?? row.supply_price_cents
    ]);
    return {
      id: row.id,
      merchantId: row.merchant_id,
      shopId: row.shop_id,
      productType: "platform",
      sourceType: row.source_type,
      platformProductId: row.platform_product_id,
      upstreamListingId: row.upstream_listing_id ?? undefined,
      salePriceCents: row.sale_price_cents,
      displayName: row.display_name ?? undefined,
      displaySubtitle: row.display_subtitle ?? undefined,
      displayDescription: row.display_description ?? undefined,
      displayUsageGuide: row.display_usage_guide ?? undefined,
      displayImageUrl: row.display_image_url ?? undefined,
      displayCategory: row.display_category ?? undefined,
      displayTags: Array.isArray(row.display_tags_json) ? row.display_tags_json : undefined,
      displaySpecs: Array.isArray(row.display_specs_json) ? row.display_specs_json : undefined,
      displayDetailSections: Array.isArray(row.display_detail_sections_json) ? row.display_detail_sections_json : undefined,
      status: row.status,
      sourceProductName: row.pp_name,
      product: {
        id: row.platform_product_id,
        name: row.display_name ?? row.pp_name,
        category: row.display_category ?? row.category_name ?? undefined,
        tags: Array.isArray(row.display_tags_json) ? row.display_tags_json : Array.isArray(row.tags_json) ? row.tags_json : undefined,
        subtitle: row.display_subtitle ?? row.rights_desc ?? undefined,
        description: row.display_description ?? row.detail ?? undefined,
        usageGuide: row.display_usage_guide ?? undefined,
        imageUrl: row.display_image_url ?? row.image_url ?? undefined,
        specs: Array.isArray(row.display_specs_json) ? row.display_specs_json : Array.isArray(row.specs_json) ? row.specs_json : undefined,
        detailSections: Array.isArray(row.display_detail_sections_json) ? row.display_detail_sections_json : Array.isArray(row.detail_sections_json) ? row.detail_sections_json : undefined,
        stockCount: row.stock_count ?? undefined,
        soldCount: row.sold_count ?? undefined,
        platformProductId: row.platform_product_id,
        displayBadge: row.display_badge ?? undefined,
        isRecommended: row.is_recommended ?? undefined,
        displaySort: row.display_sort ?? undefined,
        supplyPriceCents: directPlatformSource ? row.supply_price_cents : undefined,
        platformSupplyPriceCents: directPlatformSource ? row.supply_price_cents : undefined,
        visibleUpstreamSupplyPriceCents,
        minSalePriceCents,
        suggestedSalePriceCents,
        fulfillmentRule: row.fulfillment_rule_json,
        afterSaleRule: row.after_sale_rule_json,
        status: row.product_status
      }
    };
  }

  async upsertMerchantPaymentMethod(actor: MerchantActor, input: PaymentMethodUpsertInput) {
    await this.getMerchantShop(actor);
    const existing = input.id ? await this.findDirectPaymentMethodConfig(input.id) : undefined;
    if (input.id && !existing) throw new ApiError(404, "RESOURCE_NOT_FOUND", "payment method not found");
    if (existing && (existing.ownerType !== "merchant" || existing.merchantId !== actor.merchantId || existing.shopId !== actor.shopId)) {
      throw new ApiError(403, "PAYMENT_METHOD_SCOPE_FORBIDDEN", "cannot update another merchant payment method");
    }
    const updatingExisting = Boolean(existing);
    const provider = input.provider ?? existing?.provider;
    if (!provider) throw new ApiError(400, "PAYMENT_METHOD_PROVIDER_REQUIRED", "payment provider is required");
    this.assertDirectPaymentMethodInput("merchant", { ...input, provider, merchantId: actor.merchantId, shopId: actor.shopId }, updatingExisting);
    const now = new Date();
    const method: PaymentMethodConfig = existing
      ? { ...existing }
      : {
        id: `payment-method-${Date.now()}-${randomUUID().slice(0, 8)}`,
        ownerType: "merchant",
        merchantId: actor.merchantId,
        shopId: actor.shopId,
        provider,
        confirmationMode: isManualPaymentProvider(provider) ? "manual" : "automatic",
        displayName: required(input.displayName, "displayName"),
        enabled: input.enabled ?? false,
        status: input.status ?? (input.enabled ? "enabled" : "pending_test"),
        isDefault: input.isDefault ?? false,
        secretConfigured: false,
        createdAt: now,
        updatedAt: now,
        updatedBy: actor.merchantId
      };
    method.provider = provider;
    method.confirmationMode = isManualPaymentProvider(provider) ? "manual" : method.provider === "balance" ? "automatic" : method.confirmationMode;
    method.displayName = input.displayName ?? method.displayName;
    method.productType = input.productType ?? method.productType;
    method.merchantNo = input.merchantNo ?? method.merchantNo;
    method.appId = input.appId ?? method.appId;
    method.serviceProviderId = input.serviceProviderId ?? method.serviceProviderId;
    method.gatewayUrl = input.gatewayUrl ?? method.gatewayUrl;
    method.apiMode = input.apiMode ?? method.apiMode;
    method.accountName = input.accountName ?? method.accountName;
    method.qrUrl = input.qrUrl ?? method.qrUrl;
    method.paymentUrl = input.paymentUrl ?? method.paymentUrl;
    method.note = input.note ?? method.note;
    method.returnUrl = input.returnUrl ?? method.returnUrl;
    method.enabled = input.enabled ?? method.enabled;
    method.status = input.status ?? (method.enabled ? "enabled" : method.status);
    method.isDefault = input.isDefault ?? method.isDefault;
    method.updatedAt = now;
    method.updatedBy = actor.merchantId;
    this.applyDirectPaymentMethodSecrets(method, input);
    await this.persistInShortTransaction(async (tx) => {
      if (method.isDefault) {
        await tx.$executeRaw`
          UPDATE collection_payment_configs
             SET is_default = false, updated_at = now()
           WHERE owner_type = CAST('merchant' AS "CollectionConfigOwnerType")
             AND owner_merchant_id = ${actor.merchantId}
             AND shop_id = ${actor.shopId}
             AND id <> ${method.id}
        `;
      }
      await this.persistPaymentMethodConfig(tx, method);
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id,
          after_json, idempotency_key, request_id, ip, created_at
        )
        VALUES (
          ${stableDbId("audit", `payment_method.upsert:${method.id}:${method.updatedAt.getTime()}`)},
          CAST('merchant' AS "ActorType"), ${actor.merchantId}, 'payment_method.upsert',
          'payment_method', ${method.id},
          ${jsonForDb({ id: method.id, ownerType: method.ownerType, merchantId: method.merchantId, shopId: method.shopId, provider: method.provider, enabled: method.enabled, status: method.status, isDefault: method.isDefault })}::jsonb,
          ${`audit:payment_method.upsert:${method.id}:${method.updatedAt.getTime()}`},
          ${`payment_method.upsert:${method.id}:${method.updatedAt.getTime()}`},
          '127.0.0.1', now()
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
    });
    return this.serializeDirectPaymentMethod(method);
  }

  async listMerchantOrders(actor: MerchantActor) {
    const rows = await this.findDirectMerchantOrderRows(actor);
    return rows.map((row) => this.serializeDirectMerchantOrderRow(actor, row));
  }

  async getMerchantOrder(actor: MerchantActor, orderNo: string) {
    const rows = await this.findDirectMerchantOrderRows(actor, orderNo);
    const row = rows[0];
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "order not found");
    return this.serializeDirectMerchantOrderRow(actor, row);
  }

  async fulfillMerchantOrder(actor: MerchantActor, orderNo: string, input: { status: "success" | "failed"; attemptNo: number; evidence?: string; failReason?: string }) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      order_no: string;
      merchant_id: string | null;
      shop_id: string;
      payment_status: string;
      order_item_id: string | null;
    }>>`
      SELECT o.id, o.order_no, o.merchant_id, o.shop_id, o.payment_status, oi.id AS order_item_id
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.order_no = ${orderNo}
       LIMIT 1
    `;
    const order = rows[0];
    if (!order) throw new ApiError(404, "RESOURCE_NOT_FOUND", "order not found");
    assertMerchantScope(actor, { merchantId: required(order.merchant_id ?? undefined, "merchantId"), shopId: order.shop_id });
    if (order.payment_status !== "paid") throw new ApiError(400, "STATE_NOT_ALLOWED", "only paid orders can be fulfilled");
    const orderItemId = required(order.order_item_id ?? undefined, "orderItemId");
    const now = new Date();
    const fulfillmentStatus = input.status === "success" ? "success" : "failed";
    const orderStatus = input.status === "success" ? "fulfilled" : "fulfillment_failed";
    const fulfillmentId = stableDbId("fulfillment", orderNo);
    await this.persistInShortTransaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO fulfillment_records (
          id, order_id, order_item_id, merchant_id, shop_id, idempotency_key,
          fulfillment_type, status, success_at, fail_reason, created_at, updated_at
        )
        VALUES (
          ${fulfillmentId}, ${order.id}, ${orderItemId}, ${actor.merchantId}, ${actor.shopId},
          ${`fulfillment:${orderNo}`}, CAST('manual' AS "FulfillmentType"),
          CAST(${fulfillmentStatus} AS "FulfillmentStatus"),
          ${input.status === "success" ? now : null}, ${input.failReason ?? null}, now(), now()
        )
        ON CONFLICT (idempotency_key) DO UPDATE SET
          status = EXCLUDED.status,
          success_at = EXCLUDED.success_at,
          fail_reason = EXCLUDED.fail_reason,
          updated_at = now()
      `;
      await tx.$executeRaw`
        INSERT INTO fulfillment_attempts (
          id, fulfillment_id, attempt_no, idempotency_key, operator_id,
          request_json, result_json, status, created_at
        )
        VALUES (
          ${stableDbId("fulfillment_attempt", `${orderNo}:${input.attemptNo}`)},
          ${fulfillmentId}, ${input.attemptNo}, ${`fulfillment-attempt:${orderNo}:${input.attemptNo}`},
          ${actor.merchantId},
          ${jsonForDb({ evidence: input.evidence, failReason: input.failReason })}::jsonb,
          ${jsonForDb(input)}::jsonb,
          CAST(${fulfillmentStatus} AS "FulfillmentStatus"), now()
        )
        ON CONFLICT (fulfillment_id, attempt_no) DO UPDATE SET
          result_json = EXCLUDED.result_json,
          status = EXCLUDED.status
      `;
      await tx.$executeRaw`
        UPDATE orders
           SET fulfillment_status = CAST(${fulfillmentStatus} AS "FulfillmentStatus"),
               status = CAST(${orderStatus} AS "OrderStatus"),
               fulfilled_at = CASE WHEN ${input.status === "success"} THEN ${now} ELSE fulfilled_at END,
               updated_at = now()
         WHERE id = ${order.id}
      `;
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id,
          after_json, idempotency_key, request_id, ip, created_at
        )
        VALUES (
          ${stableDbId("audit", `fulfillment.update:${orderNo}:${input.attemptNo}`)},
          CAST('merchant' AS "ActorType"), ${actor.merchantId}, 'fulfillment.update',
          'order', ${orderNo}, ${jsonForDb(input)}::jsonb,
          ${`audit:fulfillment.update:${orderNo}:${input.attemptNo}`},
          ${`fulfillment.update:${orderNo}:${input.attemptNo}`}, '127.0.0.1', now()
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
    });
    const refreshed = await this.getMerchantOrder(actor, orderNo);
    return {
      fulfillmentStatus,
      orderStatus,
      order: refreshed
    };
  }

  private async findDirectMerchantOrderRows(actor: MerchantActor, orderNo?: string) {
    return this.prisma.$queryRaw<Array<{
      order_no: string;
      shop_id: string;
      merchant_id: string | null;
      sales_channel_type: string;
      first_tier_merchant_id: string | null;
      second_tier_merchant_id: string | null;
      third_tier_merchant_id: string | null;
      status: string;
      payment_status: string;
      fulfillment_status: string;
      refund_status: string;
      paid_amount_cents: bigint;
      coupon_discount_cents: bigint;
      collection_snapshot_json: unknown;
      product_name_snapshot: string | null;
      quantity: number | null;
      snapshot_paid_amount_cents: bigint | null;
      supply_amount_cents: bigint | null;
      service_fee_cents: bigint | null;
      merchant_expected_income_cents: bigint | null;
      platform_supply_price_cents: bigint | null;
      first_tier_supply_price_cents: bigint | null;
      second_tier_supply_price_cents: bigint | null;
      first_tier_income_cents: bigint | null;
      second_tier_income_cents: bigint | null;
      third_tier_income_cents: bigint | null;
      payment_payable_amount_cents: bigint | null;
      created_at: Date;
    }>>`
      SELECT o.order_no, o.shop_id, o.merchant_id, o.sales_channel_type,
             o.first_tier_merchant_id, o.second_tier_merchant_id, o.third_tier_merchant_id,
             o.status, o.payment_status, o.fulfillment_status, o.refund_status,
             o.paid_amount_cents, o.coupon_discount_cents, o.collection_snapshot_json,
             oi.product_name_snapshot, oi.quantity,
             oas.paid_amount_cents AS snapshot_paid_amount_cents,
             oas.supply_amount_cents, oas.service_fee_cents, oas.merchant_expected_income_cents,
             oas.platform_supply_price_cents, oas.first_tier_supply_price_cents,
             oas.second_tier_supply_price_cents, oas.first_tier_income_cents,
             oas.second_tier_income_cents, oas.third_tier_income_cents,
             ps.payable_amount_cents AS payment_payable_amount_cents,
             o.created_at
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        LEFT JOIN order_amount_snapshots oas ON oas.order_id = o.id
        LEFT JOIN LATERAL (
          SELECT payable_amount_cents
            FROM payment_snapshots
           WHERE order_id = o.id
           ORDER BY created_at DESC
           LIMIT 1
        ) ps ON TRUE
       WHERE (${orderNo ?? null}::text IS NULL OR o.order_no = ${orderNo ?? null})
         AND (
           (o.merchant_id = ${actor.merchantId} AND o.shop_id = ${actor.shopId})
           OR o.first_tier_merchant_id = ${actor.merchantId}
           OR o.second_tier_merchant_id = ${actor.merchantId}
         )
       ORDER BY o.created_at DESC
       LIMIT ${orderNo ? 1 : 100}
    `;
  }

  private serializeDirectMerchantOrderRow(actor: MerchantActor, row: Awaited<ReturnType<PrismaStateRepository["findDirectMerchantOrderRows"]>>[number]) {
    const buyerPaidAmountCents = row.payment_payable_amount_cents ?? row.paid_amount_cents ?? row.snapshot_paid_amount_cents ?? 0n;
    const settlementBasisAmountCents = row.snapshot_paid_amount_cents ?? row.paid_amount_cents ?? buyerPaidAmountCents;
    const collectionSnapshot = row.collection_snapshot_json as PaymentMethodPublicSnapshot | null;
    const result: Record<string, unknown> = {
      orderNo: row.order_no,
      shopId: row.shop_id,
      salesChannelType: row.sales_channel_type,
      status: row.status,
      paymentStatus: row.payment_status,
      fulfillmentStatus: row.fulfillment_status,
      refundStatus: row.refund_status,
      paidAmountCents: buyerPaidAmountCents,
      buyerPaidAmountCents,
      settlementBasisAmountCents,
      couponDiscountCents: row.coupon_discount_cents ?? 0n,
      productName: row.product_name_snapshot ?? "商品",
      quantity: row.quantity ?? 1,
      collectionPaymentMethod: collectionSnapshot ? {
        id: collectionSnapshot.id,
        paymentType: collectionSnapshot.channelType,
        displayName: collectionSnapshot.displayName
      } : undefined
    };
    const hasChannel = row.first_tier_merchant_id || row.second_tier_merchant_id || row.third_tier_merchant_id;
    if (!hasChannel) {
      result.visibleSupplyPriceCents = row.supply_amount_cents ?? 0n;
      result.visibleIncomeCents = row.merchant_expected_income_cents ?? 0n;
      return result;
    }
    if (actor.merchantId === row.first_tier_merchant_id) {
      result.platformSupplyPriceCents = row.platform_supply_price_cents ?? 0n;
      result.firstTierSupplyPriceCents = row.first_tier_supply_price_cents ?? 0n;
      result.visibleIncomeCents = row.first_tier_income_cents ?? 0n;
    } else if (actor.merchantId === row.second_tier_merchant_id) {
      result.firstTierSupplyPriceCents = row.first_tier_supply_price_cents ?? 0n;
      result.secondTierSupplyPriceCents = row.second_tier_supply_price_cents ?? 0n;
      result.visibleIncomeCents = row.second_tier_income_cents ?? 0n;
    } else if (actor.merchantId === row.third_tier_merchant_id) {
      result.secondTierSupplyPriceCents = row.second_tier_supply_price_cents ?? 0n;
      result.visibleIncomeCents = row.third_tier_income_cents ?? 0n;
    }
    return result;
  }

  private async findDirectPaymentMethodConfig(methodId: string): Promise<PaymentMethodConfig | undefined> {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      owner_type: string;
      owner_merchant_id: string | null;
      shop_id: string | null;
      provider: string;
      confirm_mode: string;
      status: string;
      is_default: boolean;
      display_name: string;
      merchant_no_masked: string | null;
      app_id_masked: string | null;
      service_provider_masked: string | null;
      gateway_url: string | null;
      api_mode: string | null;
      credential_ciphertext: string | null;
      return_url: string | null;
      test_status: string | null;
      last_test_at: Date | null;
      last_callback_at: Date | null;
      qr_url: string | null;
      account_masked: string | null;
      instruction: string | null;
      updated_by_id: string | null;
      created_at: Date;
      updated_at: Date;
    }>>`
      SELECT id, owner_type, owner_merchant_id, shop_id, provider, confirm_mode, status,
             is_default, display_name, merchant_no_masked, app_id_masked, service_provider_masked,
             gateway_url, api_mode, credential_ciphertext, return_url, test_status, last_test_at,
             last_callback_at, qr_url, account_masked, instruction, updated_by_id, created_at, updated_at
        FROM collection_payment_configs
       WHERE id = ${methodId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    const credentialBundle = decryptPaymentCredentialBundle(row.credential_ciphertext);
    return {
      id: row.id,
      ownerType: row.owner_type === "merchant" ? "merchant" : "platform",
      merchantId: row.owner_merchant_id ?? undefined,
      shopId: row.shop_id ?? undefined,
      provider: mapPaymentProviderFromDb(row.provider),
      confirmationMode: mapPaymentConfirmModeFromDb(row.confirm_mode),
      displayName: row.display_name,
      merchantNo: credentialBundle.merchantNo ?? row.merchant_no_masked ?? undefined,
      appId: credentialBundle.appId ?? row.app_id_masked ?? undefined,
      serviceProviderId: credentialBundle.serviceProviderId ?? row.service_provider_masked ?? undefined,
      gatewayUrl: row.gateway_url ?? undefined,
      apiMode: parsePaymentApiMode(row.api_mode),
      accountName: row.account_masked ?? undefined,
      qrUrl: row.qr_url ?? undefined,
      paymentUrl: row.qr_url ?? undefined,
      note: row.instruction ?? undefined,
      returnUrl: row.return_url ?? undefined,
      enabled: row.status === "active",
      status: mapCollectionPaymentConfigStatusFromDb(row.status),
      isDefault: row.is_default,
      signingSecret: credentialBundle.signingSecret,
      secretConfigured: Boolean(credentialBundle.signingSecret || row.credential_ciphertext || isManualPaymentProvider(mapPaymentProviderFromDb(row.provider))),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by_id ?? undefined,
      lastTestAt: row.last_test_at ?? undefined,
      lastTestResult: row.test_status === "passed" || row.test_status === "failed" ? row.test_status : undefined,
      lastCallbackAt: row.last_callback_at ?? undefined
    };
  }

  private assertDirectPaymentMethodInput(ownerType: "platform" | "merchant", input: PaymentMethodUpsertInput, updatingExisting: boolean) {
    if (ownerType === "merchant" && (!input.merchantId || !input.shopId)) throw new ApiError(400, "PAYMENT_METHOD_SCOPE_REQUIRED", "merchant payment method requires merchant and shop scope");
    if (input.provider && isManualPaymentProvider(input.provider)) {
      if (!updatingExisting && (!input.accountName || !input.qrUrl)) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "personal payment requires account name and QR code");
      return;
    }
    if (input.provider === "balance") return;
    if (input.provider && ["alipay_merchant", "wechat_merchant", "epay"].includes(input.provider)) {
      if (!updatingExisting && !input.merchantNo) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "merchant number is required");
      if (!updatingExisting && input.provider !== "epay" && !input.appId) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "app id is required");
      if (!updatingExisting && input.provider === "epay" && !input.gatewayUrl) throw new ApiError(400, "PAYMENT_METHOD_FIELD_REQUIRED", "epay gateway url is required");
      if (!input.signingSecret && !updatingExisting) throw new ApiError(400, "PAYMENT_METHOD_SECRET_REQUIRED", "signing secret is required");
    }
  }

  private applyDirectPaymentMethodSecrets(method: PaymentMethodConfig, input: PaymentMethodUpsertInput) {
    if (input.signingSecret) {
      method.signingSecret = input.signingSecret;
      method.signingSecretHash = hashSecret(input.signingSecret);
      method.signingSecretPreview = previewSecret(input.signingSecret);
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

  private serializeDirectPaymentMethod(method: PaymentMethodConfig) {
    return {
      id: method.id,
      ownerType: method.ownerType,
      merchantId: method.merchantId,
      shopId: method.shopId,
      provider: method.provider,
      confirmationMode: method.confirmationMode,
      displayName: method.displayName,
      productType: method.productType,
      merchantNoMasked: maskSecret(method.merchantNo),
      appIdMasked: maskSecret(method.appId),
      serviceProviderMasked: maskSecret(method.serviceProviderId),
      gatewayUrl: method.gatewayUrl,
      apiMode: method.apiMode ?? defaultPaymentApiMode(method.provider),
      accountName: isManualPaymentProvider(method.provider) ? method.accountName : maskSecret(method.accountName),
      qrUrl: isManualPaymentProvider(method.provider) ? method.qrUrl : undefined,
      paymentUrl: isManualPaymentProvider(method.provider) ? method.paymentUrl : undefined,
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

  async getDirectUserWallet(actor: UserActor) {
    const rows = await this.prisma.$queryRaw<Array<{
      wallet_no: string;
      user_id: string;
      available_balance_cents: bigint;
      frozen_balance_cents: bigint;
      total_recharge_cents: bigint;
      total_spend_cents: bigint;
      status: string;
      version: number;
    }>>`
      SELECT wallet_no, user_id, available_balance_cents, frozen_balance_cents,
             total_recharge_cents, total_spend_cents, status, version
        FROM user_wallets
       WHERE user_id = ${actor.userId}
       LIMIT 1
    `;
    const wallet = rows[0];
    if (wallet) {
      return {
        walletNo: wallet.wallet_no,
        userId: wallet.user_id,
        availableBalanceCents: wallet.available_balance_cents,
        frozenBalanceCents: wallet.frozen_balance_cents,
        totalRechargeCents: wallet.total_recharge_cents,
        totalSpendCents: wallet.total_spend_cents,
        status: wallet.status,
        version: wallet.version
      };
    }
    const walletNo = `wallet-${actor.userId}`;
    await this.prisma.$executeRaw`
      INSERT INTO user_wallets (
        id, wallet_no, user_id, available_balance_cents, frozen_balance_cents,
        total_recharge_cents, total_spend_cents, status, version, created_at, updated_at
      )
      VALUES (
        ${stableDbId("wallet", actor.userId)}, ${walletNo}, ${actor.userId}, 0, 0,
        0, 0, CAST('active' AS "WalletStatus"), 0, now(), now()
      )
      ON CONFLICT (user_id) DO NOTHING
    `;
    return {
      walletNo,
      userId: actor.userId,
      availableBalanceCents: 0n,
      frozenBalanceCents: 0n,
      totalRechargeCents: 0n,
      totalSpendCents: 0n,
      status: "active",
      version: 0
    };
  }

  async listPublicShopProducts(shopIdentifier: string) {
    const shop = await this.findPublicShop(shopIdentifier);
    if (!shop) throw new ApiError(404, "RESOURCE_NOT_FOUND", "shop not found");
    if ((shop.ownerType ?? "merchant") === "platform") return this.listPublicPlatformShopProducts(shop.id);
    const [platformRows, ownRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        id: string;
        shop_id: string;
	        product_type: "platform" | "merchant_owned";
        platform_product_id: string | null;
        sale_price_cents: bigint;
        status: string;
        display_name: string | null;
        display_subtitle: string | null;
        display_description: string | null;
        display_usage_guide: string | null;
        display_image_url: string | null;
        display_category: string | null;
        display_tags_json: unknown;
        display_specs_json: unknown;
        display_detail_sections_json: unknown;
        pp_id: string | null;
        pp_name: string | null;
        category_name: string | null;
        tags_json: unknown;
        image_url: string | null;
        specs_json: unknown;
        detail_sections_json: unknown;
        stock_count: number | null;
        public_stock_count: number | null;
        sold_count: number | null;
        display_badge: string | null;
        is_recommended: boolean | null;
        display_sort: number | null;
        detail: string | null;
        rights_desc: string | null;
        fulfillment_rule_json: unknown;
        after_sale_rule_json: unknown;
        product_status: string | null;
      }>>`
	        SELECT mpl.id, mpl.shop_id, CAST('platform' AS TEXT) AS product_type, mpl.platform_product_id, mpl.sale_price_cents, mpl.status,
	               mpl.display_name, mpl.display_subtitle, mpl.display_description, mpl.display_usage_guide,
	               mpl.display_image_url, mpl.display_category, mpl.display_tags_json, mpl.display_specs_json,
	               mpl.display_detail_sections_json,
               pp.id AS pp_id, pp.name AS pp_name, pp.category_name, pp.tags_json, pp.image_url,
               pp.specs_json, pp.detail_sections_json, pp.stock_count,
               CASE WHEN pp.fulfillment_rule_json->>'mode' = 'code_pool'
                 THEN (
                   SELECT COUNT(*)::int
                     FROM rights_codes rc
                    WHERE rc.product_id = pp.id
                      AND rc.status = 'available'
                 )
                 ELSE pp.stock_count
               END AS public_stock_count,
               pp.sold_count,
               pp.display_badge, pp.is_recommended, pp.display_sort, pp.detail, pp.rights_desc,
               pp.fulfillment_rule_json, pp.after_sale_rule_json, pp.status AS product_status
	          FROM merchant_product_listings mpl
	          LEFT JOIN platform_products pp ON pp.id = mpl.platform_product_id
	         WHERE mpl.shop_id = ${shop.id} AND mpl.status = 'listed'
	         ORDER BY COALESCE(pp.display_sort, 0) DESC, mpl.id ASC
      `,
      this.prisma.$queryRaw<Array<{
        id: string;
        shop_id: string;
	        product_type: "platform" | "merchant_owned";
        own_product_review_id: string | null;
        sale_price_cents: bigint;
        status: string;
        display_name: string | null;
        display_subtitle: string | null;
        display_description: string | null;
        display_usage_guide: string | null;
        display_image_url: string | null;
        display_category: string | null;
        display_tags_json: unknown;
        display_specs_json: unknown;
        display_detail_sections_json: unknown;
        own_name: string | null;
        detail_json: unknown;
        public_stock_count: number | null;
        fulfillment_rule_json: unknown;
        after_sale_rule_json: unknown;
        product_status: string | null;
      }>>`
	        SELECT mp.id, mp.shop_id, mp.product_type, mp.own_product_review_id, mp.sale_price_cents, mp.status,
	               NULL::text AS display_name, NULL::text AS display_subtitle, NULL::text AS display_description, NULL::text AS display_usage_guide,
	               NULL::text AS display_image_url, NULL::text AS display_category, NULL::jsonb AS display_tags_json, NULL::jsonb AS display_specs_json,
	               NULL::jsonb AS display_detail_sections_json,
               opr.name AS own_name, opr.detail_json,
               CASE WHEN opr.fulfillment_rule_json->>'mode' = 'code_pool'
                 THEN (
                   SELECT COUNT(*)::int
                     FROM rights_codes rc
                    WHERE rc.merchant_product_id = mp.id
                      AND rc.status = 'available'
                 )
                 ELSE COALESCE((opr.detail_json->>'stockCount')::int, 0)
               END AS public_stock_count,
               opr.fulfillment_rule_json, opr.after_sale_rule_json,
               opr.status AS product_status
	          FROM merchant_products mp
	          LEFT JOIN merchant_product_reviews opr ON opr.id = mp.own_product_review_id
	         WHERE mp.shop_id = ${shop.id} AND mp.status = 'listed' AND mp.product_type = 'merchant_owned'
	         ORDER BY mp.id ASC
      `
    ]);
    return [
      ...platformRows.map((row) => ({
        id: row.id,
        shopId: row.shop_id,
        productType: row.product_type,
        salePriceCents: row.sale_price_cents,
        status: row.status,
        product: row.pp_id ? {
          id: row.pp_id,
          name: row.display_name ?? row.pp_name,
          category: row.display_category ?? row.category_name ?? undefined,
          tags: Array.isArray(row.display_tags_json) ? row.display_tags_json : Array.isArray(row.tags_json) ? row.tags_json : undefined,
          subtitle: row.display_subtitle ?? row.rights_desc ?? undefined,
          description: row.display_description ?? row.detail ?? undefined,
          usageGuide: row.display_usage_guide ?? undefined,
          imageUrl: row.display_image_url ?? row.image_url ?? undefined,
          specs: Array.isArray(row.display_specs_json) ? row.display_specs_json : Array.isArray(row.specs_json) ? row.specs_json : undefined,
          detailSections: Array.isArray(row.display_detail_sections_json) ? row.display_detail_sections_json : Array.isArray(row.detail_sections_json) ? row.detail_sections_json : undefined,
          stockCount: row.public_stock_count ?? row.stock_count ?? undefined,
          soldCount: row.sold_count ?? undefined,
          platformProductId: row.platform_product_id ?? undefined,
          displayBadge: row.display_badge ?? undefined,
          isRecommended: row.is_recommended ?? undefined,
          displaySort: row.display_sort ?? undefined,
          fulfillmentRule: row.fulfillment_rule_json,
          afterSaleRule: row.after_sale_rule_json,
          status: row.product_status ?? undefined
        } : null
      })),
      ...ownRows.map((row) => {
        const detail = decodeStoreValue(row.detail_json);
        return {
          id: row.id,
          shopId: row.shop_id,
          productType: row.product_type,
          salePriceCents: row.sale_price_cents,
          status: row.status,
          product: {
            id: row.own_product_review_id,
            name: row.display_name ?? row.own_name ?? undefined,
            category: row.display_category ?? (isRecord(detail) ? stringValue(detail.category) : undefined),
            tags: Array.isArray(row.display_tags_json) ? row.display_tags_json : isRecord(detail) && Array.isArray(detail.tags) ? detail.tags : undefined,
            subtitle: row.display_subtitle ?? (isRecord(detail) ? stringValue(detail.subtitle) : undefined),
            description: row.display_description ?? (isRecord(detail) ? stringValue(detail.description) : undefined),
            usageGuide: row.display_usage_guide ?? (isRecord(detail) ? stringValue(detail.usageGuide) : undefined),
            imageUrl: row.display_image_url ?? (isRecord(detail) ? stringValue(detail.imageUrl) : undefined),
            specs: Array.isArray(row.display_specs_json) ? row.display_specs_json : isRecord(detail) && Array.isArray(detail.specs) ? detail.specs : undefined,
            detailSections: Array.isArray(row.display_detail_sections_json) ? row.display_detail_sections_json : isRecord(detail) && Array.isArray(detail.detailSections) ? detail.detailSections : undefined,
            stockCount: row.public_stock_count ?? undefined,
            fulfillmentRule: decodeStoreValue(row.fulfillment_rule_json),
            afterSaleRule: decodeStoreValue(row.after_sale_rule_json),
            status: row.product_status ?? undefined
          }
        };
      })
    ];
  }

  async listPublicPaymentMethods(shopIdentifier: string) {
    const shop = await this.findPublicShop(shopIdentifier);
    if (!shop) throw new ApiError(404, "RESOURCE_NOT_FOUND", "shop not found");
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
	      owner_type: "platform" | "merchant";
	      provider: "alipay_merchant" | "wechat_merchant" | "epay" | "alipay_personal" | "wechat_personal" | "balance";
      confirm_mode: string;
      is_default: boolean;
      display_name: string;
      merchant_no_masked: string | null;
      app_id_masked: string | null;
      gateway_url: string | null;
      credential_ciphertext: string | null;
      qr_url: string | null;
      return_url: string | null;
    }>>`
	      SELECT id, owner_type, provider, confirm_mode, is_default, display_name,
               merchant_no_masked, app_id_masked, gateway_url, credential_ciphertext,
               qr_url, return_url
	        FROM collection_payment_configs
         WHERE enabled_at IS NOT NULL
	         AND status = 'active'
	         AND provider <> 'balance'
	         AND (
	           (provider IN ('alipay_personal', 'wechat_personal') AND qr_url IS NOT NULL)
	           OR (provider = 'epay' AND gateway_url IS NOT NULL AND merchant_no_masked IS NOT NULL AND credential_ciphertext LIKE 'aes256gcm:%')
	           OR (provider IN ('alipay_merchant', 'wechat_merchant') AND merchant_no_masked IS NOT NULL AND app_id_masked IS NOT NULL AND credential_ciphertext LIKE 'aes256gcm:%')
	         )
	         AND (
	           (owner_type = 'merchant' AND shop_id = ${shop.id})
	           OR (owner_type = 'platform' AND ${shop.ownerType} = 'platform')
	         )
       ORDER BY is_default DESC, updated_at DESC
    `;
    return [
      {
        id: "balance",
        paymentMethodId: "balance",
        shopId: shop.id,
        ownerType: "platform",
        provider: "balance",
        confirmationMode: "automatic",
        channelType: "balance",
        displayName: "余额支付",
        isDefault: false,
        sortOrder: -1,
        paymentFeeBps: 0,
        paymentFeeLabel: "0%",
        publicLabel: "余额支付",
        note: "余额支付无手续费"
      },
	      ...rows.filter((row) => {
          const provider = mapPaymentProviderFromDb(row.provider);
          const credential = decryptPaymentCredentialBundle(row.credential_ciphertext);
          if (isManualPaymentProvider(provider)) return Boolean(row.qr_url);
          if (provider === "epay") return Boolean(row.gateway_url && (credential.merchantNo ?? row.merchant_no_masked) && credential.signingSecret);
          return Boolean((credential.merchantNo ?? row.merchant_no_masked) && (credential.appId ?? row.app_id_masked) && row.credential_ciphertext?.startsWith("aes256gcm:"));
        }).map((row, index) => {
	        const provider = mapPaymentProviderFromDb(row.provider);
	        const feeBps = provider === "balance" ? 0 : 100;
	        return {
	          id: row.id,
	          paymentMethodId: row.id,
	          shopId: shop.id,
	          ownerType: row.owner_type,
	          provider,
	          confirmationMode: row.confirm_mode,
	          channelType: paymentDisplayTypeForProvider(provider),
	          displayName: paymentProviderDisplay(provider),
	          qrUrl: isManualPaymentProvider(provider) ? row.qr_url ?? undefined : undefined,
	          paymentUrl: isManualPaymentProvider(provider) ? row.return_url ?? undefined : undefined,
	          isDefault: row.is_default,
	          sortOrder: index,
	          paymentFeeBps: feeBps,
	          paymentFeeLabel: feeBps === 0 ? "0%" : `${(feeBps / 100).toFixed(0)}%`,
	          publicLabel: paymentProviderPublicLabel(provider, feeBps),
	          note: isManualPaymentProvider(provider) ? "个人收款需商户人工确认" : "官方支付以回调或查单为准"
	        };
      })
    ];
  }

  async quoteOrder(actor: UserActor, input: { shopId: string; merchantProductListingId?: string; quantity?: number; couponId?: string }) {
    const quantity = input.quantity ?? 1;
    const listingId = input.merchantProductListingId;
    if (!listingId) throw new ApiError(400, "PRODUCT_REQUIRED", "product required");
    const shop = await this.requirePublicShop(input.shopId);
    await this.assertDirectShopAcceptsOrders(shop);
    const product = await this.findQuotableProduct(shop.id, listingId);
    if (product.fulfillmentMode === "code_pool" && await this.countAvailableDirectRightsCodes(product) < quantity) {
      throw new ApiError(400, "RIGHTS_CODE_STOCK_INSUFFICIENT", "商品库存不足，暂时无法下单");
    }
    const paidAmountCents = product.salePriceCents * BigInt(quantity);
    const couponDiscountCents = input.couponId
      ? await this.resolveDirectCouponDiscount(actor.userId, input.couponId, paidAmountCents, product.platformProductId, product.merchantProductId, shop.id)
      : 0n;
    const buyerPaidAmountCents = paidAmountCents - couponDiscountCents > 0n ? paidAmountCents - couponDiscountCents : 0n;
    return {
      paidAmountCents,
      buyerPaidAmountCents,
      settlementBasisAmountCents: paidAmountCents,
      couponDiscountCents,
      salePriceCents: product.salePriceCents,
      quantity
    };
  }

  private async countAvailableDirectRightsCodes(product: { platformProductId?: string | null; merchantProductId?: string | null }) {
    if (product.platformProductId) {
      return this.prisma.rightsCode.count({
        where: {
          productId: product.platformProductId,
          status: "available"
        }
      });
    }
    if (product.merchantProductId) {
      return this.prisma.rightsCode.count({
        where: {
          merchantProductId: product.merchantProductId,
          status: "available"
        }
      });
    }
    return 0;
  }

  async createOrder(actor: UserActor, input: {
    shopId: string;
    merchantProductListingId?: string;
    quantity?: number;
    buyerEmail?: string;
    buyerPhone?: string;
    extractionCode?: string;
    couponId?: string;
    paymentMethodId?: string;
    clientPaidAmountCents?: bigint;
  }) {
    const quantity = input.quantity ?? 1;
    const listingId = input.merchantProductListingId ?? input.merchantProductListingId;
    if (!listingId) throw new ApiError(400, "PRODUCT_REQUIRED", "product required");
    const shop = await this.requirePublicShop(input.shopId);
    await this.assertDirectShopAcceptsOrders(shop);
    const product = await this.findOrderProduct(shop.id, listingId);
    const paidAmountCents = product.salePriceCents * BigInt(quantity);
    let couponDiscountCents = 0n;
    let couponSnapshot: Record<string, unknown> | null = null;
    let couponUsage: {
      userCouponId: string;
      couponTemplateId: string;
      discountCents: bigint;
      subsidyCents: bigint;
      idempotencyKey: string;
    } | null = null;
    let buyerPaidAmountCents = paidAmountCents;
    if (product.fulfillmentMode === "code_pool" && !input.extractionCode) {
      throw new ApiError(400, "PURCHASE_PASSWORD_REQUIRED", "this product requires a purchase password");
    }
    if (product.fulfillmentMode === "code_pool" && !/^1[3-9]\d{9}$/.test(input.buyerPhone ?? "")) {
      throw new ApiError(400, "BUYER_PHONE_REQUIRED", "code_pool products require a valid mainland China mobile phone");
    }

    const serviceFeeConfig = await this.activeDirectServiceFeeConfig();
    const serviceFeeBps = serviceFeeConfig.enabled ? BigInt(serviceFeeConfig.feeBps) : 0n;
    const serviceFeeCents = calculateServiceFeeCents(paidAmountCents, serviceFeeBps);
    const orderNo = `order-${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, "0")}`;
    const orderId = stableDbId("order", orderNo);
    const orderItemId = stableDbId("order_item", orderNo);
    const amountId = stableDbId("amount_snapshot", orderNo);
    const now = new Date();
    const merchantExpectedIncomeCents = product.merchantId ? paidAmountCents - product.supplyAmountCents - serviceFeeCents : 0n;
    const snapshot = {
      product: { id: product.platformProductId ?? product.productIdSnapshot, name: product.productName },
      shop: { id: shop.id, shopNo: shop.shopNo, ownerType: product.shopOwnerType },
      pricing: { salePriceCents: product.salePriceCents },
      fulfillmentRule: product.fulfillmentRule,
      afterSaleRule: product.afterSaleRule
    };

    await this.prisma.$transaction(async (tx) => {
      if (input.couponId) {
        const coupon = await this.lockAndApplyDirectCoupon(tx, {
          userId: actor.userId,
          couponId: input.couponId,
          orderId,
          paidAmountCents,
          platformProductId: product.platformProductId,
          merchantProductId: product.merchantProductId,
          shopId: shop.id,
          orderNo
        });
        couponDiscountCents = coupon.discountCents;
        couponSnapshot = coupon.snapshot;
        couponUsage = coupon.usage;
      }
      const finalBuyerPaidAmountCents = paidAmountCents - couponDiscountCents > 0n ? paidAmountCents - couponDiscountCents : 0n;
      if (input.clientPaidAmountCents !== undefined && input.clientPaidAmountCents !== finalBuyerPaidAmountCents) {
        throw new ApiError(400, "AMOUNT_MISMATCH", "client amount does not match backend quote");
      }
      buyerPaidAmountCents = finalBuyerPaidAmountCents;
      await tx.$executeRaw`
        INSERT INTO users (id, status, created_at, updated_at)
        VALUES (${actor.userId}, 'active', now(), now())
        ON CONFLICT (id) DO NOTHING
      `;
      await tx.$executeRaw`
        INSERT INTO orders (
          id, order_no, user_id, merchant_id, shop_id, buyer_email, buyer_phone, purchase_password_hash,
          sales_channel_type, coupon_discount_cents, coupon_snapshot_json, status, payment_status,
          fulfillment_status, refund_status, settlement_status, risk_status,
          paid_amount_cents, created_at, updated_at
        )
        VALUES (
          ${orderId}, ${orderNo}, ${actor.userId}, ${product.merchantId}, ${shop.id},
          ${input.buyerEmail ?? null}, ${input.buyerPhone ?? null}, ${input.extractionCode ? hashSecret(input.extractionCode) : null},
          CAST(${product.salesChannelType} AS "SalesChannelType"),
          ${couponDiscountCents}, ${couponSnapshot ? jsonForDb(couponSnapshot) : null}::jsonb,
          CAST('pending_payment' AS "OrderStatus"), CAST('unpaid' AS "PaymentStatus"),
          CAST('not_started' AS "FulfillmentStatus"), CAST('none' AS "RefundStatus"),
          CAST('pending' AS "SettlementStatus"), CAST('normal' AS "RiskStatus"), ${finalBuyerPaidAmountCents}, ${now}, ${now}
        )
      `;
      if (couponUsage) {
        await tx.$executeRaw`
          INSERT INTO coupon_usage (
            id, user_coupon_id, coupon_template_id, order_id, discount_cents,
            subsidy_cents, idempotency_key, created_at
          )
          VALUES (
            ${stableDbId("coupon_usage", couponUsage.idempotencyKey)}, ${couponUsage.userCouponId},
            ${couponUsage.couponTemplateId}, ${orderId}, ${couponUsage.discountCents},
            ${couponUsage.subsidyCents}, ${couponUsage.idempotencyKey}, now()
          )
          ON CONFLICT (idempotency_key) DO NOTHING
        `;
      }
      await tx.$executeRaw`
        INSERT INTO order_items (
          id, order_id, merchant_product_listing_id, merchant_product_id, platform_shop_product_id,
          sale_source_type, product_type, product_id_snapshot, product_name_snapshot,
          sale_price_cents, quantity, supply_price_cents, service_fee_cents,
          merchant_income_cents, created_at
        )
        VALUES (
          ${orderItemId}, ${orderId}, ${product.merchantProductListingId}, ${product.merchantProductId}, ${product.platformShopProductId},
          CAST(${product.saleSourceType} AS "SaleSourceType"), CAST(${product.productType} AS "ProductType"), ${product.productIdSnapshot}, ${product.productName},
          ${paidAmountCents}, ${quantity}, ${product.supplyAmountCents}, ${serviceFeeCents},
          ${merchantExpectedIncomeCents}, ${now}
        )
      `;
      await tx.$executeRaw`
        INSERT INTO order_amount_snapshots (
          id, order_id, service_fee_bps, paid_amount_cents, supply_amount_cents,
          service_fee_cents, merchant_expected_income_cents, platform_supply_price_cents,
          final_sale_price_cents, fulfillment_cost_cents, payment_channel_fee_cents,
          platform_gross_profit_cents, payment_fee_bps, payment_fee_cents,
          balance_paid_cents, external_paid_cents, service_fee_enabled,
          service_fee_basis_amount_cents, service_fee_config_snapshot_json,
          product_snapshot_json, shop_snapshot_json, pricing_snapshot_json,
          fulfillment_rule_snapshot_json, after_sale_rule_snapshot_json, created_at
        )
        VALUES (
          ${amountId}, ${orderId}, ${Number(serviceFeeBps)}, ${paidAmountCents}, ${product.supplyAmountCents},
          ${serviceFeeCents}, ${merchantExpectedIncomeCents}, ${product.supplyAmountCents},
          ${paidAmountCents}, ${product.platformShopProductId ? product.supplyAmountCents : 0n}, 0,
          ${product.platformShopProductId ? paidAmountCents - product.supplyAmountCents : 0n}, 0, 0,
          0, ${finalBuyerPaidAmountCents}, ${serviceFeeConfig.enabled},
          ${paidAmountCents}, ${jsonForDb(serviceFeeConfig)}::jsonb,
          ${jsonForDb(snapshot.product)}::jsonb, ${jsonForDb(snapshot.shop)}::jsonb,
          ${jsonForDb(snapshot.pricing)}::jsonb, ${jsonForDb(product.fulfillmentRule)}::jsonb,
          ${jsonForDb(product.afterSaleRule)}::jsonb, ${now}
        )
      `;
      if (product.fulfillmentMode === "code_pool") {
        const locked = product.productType === "platform"
          ? await tx.$queryRaw<Array<{ id: string }>>`
            UPDATE rights_codes
               SET status = CAST('locked' AS "RightsCodeStatus"),
                   order_id = ${orderId},
                   issue_key = ${`reserve:${orderNo}`},
                   updated_at = now()
             WHERE id = (
               SELECT id
                 FROM rights_codes
                WHERE status = CAST('available' AS "RightsCodeStatus")
                  AND product_id = ${product.platformProductId ?? null}
                ORDER BY created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
             )
             RETURNING id
          `
          : await tx.$queryRaw<Array<{ id: string }>>`
            UPDATE rights_codes
               SET status = CAST('locked' AS "RightsCodeStatus"),
                   order_id = ${orderId},
                   issue_key = ${`reserve:${orderNo}`},
                   updated_at = now()
             WHERE id = (
               SELECT id
               FROM rights_codes
               WHERE status = CAST('available' AS "RightsCodeStatus")
                  AND merchant_product_id = ${product.merchantProductId}
                ORDER BY created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
             )
             RETURNING id
          `;
        if (locked.length === 0) throw new ApiError(400, "RIGHTS_CODE_STOCK_INSUFFICIENT", `${product.productName} 库存不足，暂时无法下单`);
        await tx.$executeRaw`
          INSERT INTO order_extract_secrets (
            id, order_id, order_item_id, claim_code_hash, status, failed_attempts,
            idempotency_key, created_at, updated_at
          )
          VALUES (
            ${stableDbId("extract_secret", orderNo)}, ${orderId}, ${orderItemId},
            ${hashSecret(input.extractionCode ?? "")}, CAST('active' AS "ExtractSecretStatus"), 0, ${`extract:${orderNo}`}, ${now}, ${now}
          )
        `;
      }
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id,
          after_json, idempotency_key, request_id, ip, created_at
        )
        VALUES (
          ${stableDbId("audit", `order.create:${orderNo}`)}, CAST('user' AS "ActorType"), ${actor.userId},
          'order.create', 'order', ${orderNo}, ${jsonForDb({ orderNo, shopId: shop.id, shopNo: shop.shopNo })}::jsonb,
          ${`audit:order.create:${orderNo}`}, ${`order.create:${orderNo}`}, '127.0.0.1', ${now}
        )
      `;
    }, { maxWait: 10_000, timeout: 30_000 });

    const balancePaymentResult = input.paymentMethodId === "balance"
      ? await this.createPaymentOrder(actor, orderNo, { paymentMethodId: "balance" })
      : undefined;

    return {
      orderNo,
      userId: actor.userId,
      shopId: shop.id,
      shopNo: shop.shopNo,
      merchantProductListingId: listingId,
      productName: product.productName,
      paymentStatus: balancePaymentResult?.order?.paymentStatus ?? "unpaid",
      fulfillmentStatus: balancePaymentResult?.order?.fulfillmentStatus ?? "not_started",
      refundStatus: "none",
      paidAmountCents,
      buyerPaidAmountCents,
      couponDiscountCents,
      purchasePasswordSet: Boolean(input.extractionCode),
      snapshot: {
        quote: { paidAmountCents, buyerPaidAmountCents, salePriceCents: product.salePriceCents, quantity },
        amountSnapshot: { paidAmountCents, buyerPaidAmountCents, serviceFeeBps, serviceFeeCents },
        productSnapshot: snapshot.product,
        fulfillmentRuleSnapshot: product.fulfillmentRule
      }
    };
  }

  async createPaymentOrder(actor: UserActor, orderNo: string, input: { paymentMethodId?: string } = {}) {
    const orderRows = await this.prisma.$queryRaw<Array<{
      id: string;
      order_no: string;
      user_id: string;
      merchant_id: string | null;
      shop_id: string;
      payment_status: string;
      fulfillment_status: string;
      refund_status: string;
      paid_amount_cents: bigint;
      fulfillment_rule_snapshot_json: unknown;
      product_snapshot_json: unknown;
    }>>`
      SELECT o.id, o.order_no, o.user_id, o.merchant_id, o.shop_id, o.payment_status, o.fulfillment_status,
             o.refund_status, o.paid_amount_cents, oas.fulfillment_rule_snapshot_json,
             oas.product_snapshot_json
        FROM orders o
        LEFT JOIN order_amount_snapshots oas ON oas.order_id = o.id
       WHERE o.order_no = ${orderNo}
       LIMIT 1
    `;
    const order = orderRows[0];
    if (!order) throw new ApiError(404, "RESOURCE_NOT_FOUND", "order not found");
    if (order.user_id !== actor.userId) throw new ApiError(403, "FORBIDDEN_USER_SCOPE", "user cannot access another user resource");
    if (order.payment_status === "paid") {
      return { status: "already_paid" as const, orderNo, order: { orderNo, paymentStatus: "paid", fulfillmentStatus: order.fulfillment_status } };
    }
    if (order.refund_status !== "none") throw new ApiError(400, "PAYMENT_ORDER_NOT_ALLOWED", "refunded orders cannot create payment");

    const method = input.paymentMethodId === "balance"
      ? { id: "balance", provider: "balance", confirmMode: "balance_deduct", qrUrl: null as string | null, returnUrl: null as string | null }
      : await this.findDirectPaymentMethod(order.shop_id, input.paymentMethodId);
    const baseAmountCents = order.paid_amount_cents;
    const feeBps = method.provider === "balance" ? 0 : 100;
    const feeCents = calculateServiceFeeCents(baseAmountCents, BigInt(feeBps));
    const amountCents = baseAmountCents + feeCents;
    const paymentNo = `payment-${orderNo}`;
    const paymentId = stableDbId("payment", paymentNo);
    const now = new Date();

    if (method.provider === "balance") {
      const result = await this.prisma.$transaction(async (tx) => {
        const wallets = await tx.$queryRaw<Array<{ id: string; available_balance_cents: bigint }>>`
          SELECT id, available_balance_cents
            FROM user_wallets
           WHERE user_id = ${actor.userId}
           FOR UPDATE
        `;
        const wallet = wallets[0];
        if (!wallet || wallet.available_balance_cents < amountCents) {
          throw new ApiError(400, "WALLET_BALANCE_INSUFFICIENT", "wallet balance is not enough for this order");
        }
        const balanceBeforeCents = wallet.available_balance_cents;
        const balanceAfterCents = wallet.available_balance_cents - amountCents;
        await tx.$executeRaw`
          UPDATE user_wallets
             SET available_balance_cents = available_balance_cents - ${amountCents},
                 total_spend_cents = total_spend_cents + ${amountCents},
                 version = version + 1,
                 updated_at = now()
           WHERE id = ${wallet.id}
        `;
        const collectionSnapshot = this.directPaymentCollectionSnapshot(method);
        await tx.$executeRaw`
          INSERT INTO payments (
            id, payment_no, order_id, user_id, merchant_id, collection_snapshot_json, channel, provider, confirm_mode,
            base_amount_cents, fee_bps, fee_cents, amount_cents, channel_fee_cents,
            status, confirm_source, idempotency_key, paid_at, created_at, updated_at
          )
          VALUES (
            ${paymentId}, ${paymentNo}, ${order.id}, ${actor.userId}, ${order.merchant_id}, ${jsonForDb(collectionSnapshot)}::jsonb,
            CAST('balance' AS "PaymentChannel"),
            CAST('balance' AS "PaymentProvider"), CAST('balance_deduct' AS "PaymentConfirmMode"),
            ${baseAmountCents}, 0, 0, ${amountCents}, 0, CAST('paid' AS "PaymentStatus"),
            CAST('balance' AS "PaymentConfirmSource"), ${`payment:${paymentNo}`}, ${now}, ${now}, ${now}
          )
          ON CONFLICT (idempotency_key) DO NOTHING
        `;
        await this.persistDirectPaymentSnapshot(tx, {
          orderId: order.id,
          orderNo,
          userId: actor.userId,
          paymentId,
          paymentNo,
          method,
          baseAmountCents,
          feeBps: 0,
          feeCents: 0n,
          amountCents,
          status: "paid",
          confirmSource: "balance",
          paidAt: now,
          expiresAt: null,
          collectionSnapshot
        });
        await this.updateDirectOrderPaymentAmountSnapshot(tx, order.id, {
          feeBps: 0,
          feeCents: 0n,
          baseAmountCents,
          amountCents,
          provider: "balance",
          collectionSnapshot
        });
        await tx.$executeRaw`
          INSERT INTO wallet_transactions (
            id, transaction_no, user_id, wallet_id, type, direction, amount_cents,
            balance_before_cents, balance_after_cents, frozen_before_cents, frozen_after_cents,
            order_id, payment_id, source_type, source_id, note, idempotency_key, created_at
          )
          VALUES (
            ${stableDbId("wallet_tx", paymentNo)}, ${`wallet-tx-${paymentNo}`}, ${actor.userId}, ${wallet.id},
            CAST('payment_capture' AS "WalletTransactionType"), CAST('debit' AS "LedgerDirection"), ${amountCents},
            ${balanceBeforeCents}, ${balanceAfterCents}, 0, 0,
            ${order.id}, ${paymentId}, 'order_payment', ${orderNo}, '余额支付扣款',
            ${`wallet-tx:${paymentNo}`}, ${now}
          )
          ON CONFLICT (idempotency_key) DO NOTHING
        `;
        await tx.$executeRaw`
          UPDATE orders
             SET payment_status = CAST('paid' AS "PaymentStatus"),
                 status = CAST('paid' AS "OrderStatus"),
                 paid_at = ${now},
                 updated_at = now()
           WHERE id = ${order.id}
        `;
        if (fulfillmentRuleMode(order.fulfillment_rule_snapshot_json) === "code_pool") {
          await tx.$executeRaw`
            UPDATE rights_codes
               SET status = CAST('issued' AS "RightsCodeStatus"),
                   issued_at = ${now},
                   updated_at = now()
             WHERE order_id = ${order.id}
               AND status = CAST('locked' AS "RightsCodeStatus")
          `;
          await tx.$executeRaw`
            INSERT INTO fulfillment_records (
              id, order_id, order_item_id, merchant_id, shop_id, idempotency_key,
              fulfillment_type, status, success_at, created_at, updated_at
            )
            VALUES (
              ${stableDbId("fulfillment", orderNo)}, ${order.id},
              (SELECT id FROM order_items WHERE order_id = ${order.id} LIMIT 1),
              ${order.merchant_id}, ${order.shop_id}, ${`fulfillment:${orderNo}`},
              CAST('code_pool' AS "FulfillmentType"), CAST('success' AS "FulfillmentStatus"),
              ${now}, ${now}, ${now}
            )
            ON CONFLICT (idempotency_key) DO UPDATE SET
              status = CAST('success' AS "FulfillmentStatus"),
              success_at = EXCLUDED.success_at,
              updated_at = now()
          `;
          await tx.$executeRaw`
            UPDATE orders
               SET status = CAST('fulfilled' AS "OrderStatus"),
                   fulfillment_status = CAST('success' AS "FulfillmentStatus"),
                   fulfilled_at = ${now},
                   updated_at = now()
             WHERE id = ${order.id}
          `;
        }
        return { fulfillmentStatus: fulfillmentRuleMode(order.fulfillment_rule_snapshot_json) === "code_pool" ? "success" : "not_started" };
      }, { maxWait: 10_000, timeout: 30_000 });
      return {
        status: "processed" as const,
        orderNo,
        provider: "balance",
        amountCents,
        paymentNo,
        order: { orderNo, paymentStatus: "paid", fulfillmentStatus: result.fulfillmentStatus }
      };
    }

    const status = method.confirmMode === "manual_confirm" ? "pending_manual_confirmation" : "created";
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const collectionSnapshot = this.directPaymentCollectionSnapshot(method);
    const epayParams = method.provider === "epay"
      ? await this.buildDirectEpayPaymentParams(method, order.order_no, order.product_snapshot_json, amountCents)
      : undefined;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO payments (
          id, payment_no, order_id, user_id, merchant_id, collection_payment_config_id, collection_snapshot_json,
          channel, provider, confirm_mode, base_amount_cents, fee_bps, fee_cents,
          amount_cents, channel_fee_cents, status, confirm_source, idempotency_key,
          expires_at, created_at, updated_at
        )
        VALUES (
          ${paymentId}, ${paymentNo}, ${order.id}, ${actor.userId}, ${order.merchant_id}, ${method.id === "balance" ? null : method.id},
          ${jsonForDb(collectionSnapshot)}::jsonb,
          CAST(${method.provider === "epay" ? "epay" : method.provider.startsWith("wechat") ? "wechat_h5" : "alipay_wap"} AS "PaymentChannel"),
          CAST(${method.provider} AS "PaymentProvider"), CAST(${method.confirmMode} AS "PaymentConfirmMode"),
          ${baseAmountCents}, ${feeBps}, ${feeCents}, ${amountCents}, 0,
          CAST(${method.confirmMode === "manual_confirm" ? "unpaid" : "paying"} AS "PaymentStatus"),
          CAST('unconfirmed' AS "PaymentConfirmSource"), ${`payment:${paymentNo}`},
          ${expiresAt}, ${now}, ${now}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
      await this.persistDirectPaymentSnapshot(tx, {
        orderId: order.id,
        orderNo,
        userId: actor.userId,
        paymentId,
        paymentNo,
        method,
        baseAmountCents,
        feeBps,
        feeCents,
        amountCents,
        status: method.confirmMode === "manual_confirm" ? "unpaid" : "paying",
        confirmSource: "unconfirmed",
        paidAt: null,
        expiresAt,
        collectionSnapshot
      });
      await this.updateDirectOrderPaymentAmountSnapshot(tx, order.id, {
        feeBps,
        feeCents,
        baseAmountCents,
        amountCents,
        provider: method.provider,
        collectionSnapshot
      });
    }, { maxWait: 10_000, timeout: 30_000 });
    return {
      status,
      orderNo,
      provider: method.provider,
      amountCents,
      paymentNo,
      qrCodeUrl: epayParams?.qrCodeUrl ?? method.qrUrl ?? undefined,
      payUrl: epayParams?.paymentUrl ?? method.returnUrl ?? undefined,
      paymentParams: epayParams,
      paymentMethod: {
        id: method.id,
        provider: mapPaymentProviderFromDb(method.provider as "alipay_merchant" | "wechat_merchant" | "epay" | "alipay_personal" | "wechat_personal" | "balance")
      }
    };
  }

  async confirmMerchantOfflinePayment(actor: MerchantActor, orderNo: string, input: { amountCents: bigint; voucherUrl?: string; note?: string }) {
    const orderRows = await this.prisma.$queryRaw<Array<{
      id: string;
      order_no: string;
      user_id: string;
      merchant_id: string | null;
      shop_id: string;
      payment_status: string;
      refund_status: string;
      paid_amount_cents: bigint;
      buyer_email: string | null;
      fulfillment_rule_snapshot_json: unknown;
    }>>`
      SELECT o.id, o.order_no, o.user_id, o.merchant_id, o.shop_id, o.payment_status,
             o.refund_status, o.paid_amount_cents, o.buyer_email,
             oas.fulfillment_rule_snapshot_json
        FROM orders o
        LEFT JOIN order_amount_snapshots oas ON oas.order_id = o.id
       WHERE o.order_no = ${orderNo}
       LIMIT 1
    `;
    const order = orderRows[0];
    if (!order) throw new ApiError(404, "RESOURCE_NOT_FOUND", "order not found");
    if (order.merchant_id !== actor.merchantId || order.shop_id !== actor.shopId) {
      throw new ApiError(403, "FORBIDDEN_MERCHANT_SCOPE", "merchant cannot access another merchant resource");
    }
    if (order.refund_status !== "none") throw new ApiError(400, "MANUAL_CONFIRM_NOT_ALLOWED", "refunded orders cannot be manually confirmed");

    const paymentRows = await this.prisma.$queryRaw<Array<{
      id: string;
      payment_no: string;
      provider: string | null;
      confirm_mode: string | null;
      amount_cents: bigint;
      base_amount_cents: bigint;
      fee_bps: number;
      fee_cents: bigint;
      collection_payment_config_id: string | null;
      collection_snapshot_json: unknown;
    }>>`
      SELECT id, payment_no, provider, confirm_mode, amount_cents, base_amount_cents,
             fee_bps, fee_cents, collection_payment_config_id, collection_snapshot_json
        FROM payments
       WHERE order_id = ${order.id}
       ORDER BY created_at DESC
       LIMIT 1
    `;
    const existingPayment = paymentRows[0];
    if (existingPayment?.provider && !["alipay_personal", "wechat_personal"].includes(existingPayment.provider)) {
      throw new ApiError(400, "MANUAL_CONFIRM_NOT_ALLOWED", "only personal payment orders can be manually confirmed");
    }
    const expectedAmount = existingPayment?.amount_cents ?? order.paid_amount_cents;
    if (input.amountCents !== expectedAmount) {
      throw new ApiError(400, "AMOUNT_MISMATCH", "offline payment amount does not match order amount");
    }
    if (order.payment_status === "paid") {
      return {
        status: "already_paid" as const,
        idempotencyKey: `offline-payment:${orderNo}:${input.voucherUrl ?? expectedAmount.toString()}`,
        order: { orderNo, paymentStatus: "paid", fulfillmentStatus: "success" }
      };
    }

    const manualMethods = existingPayment?.collection_payment_config_id ? [] : await this.prisma.$queryRaw<Array<{
      id: string;
      provider: "alipay_personal" | "wechat_personal";
      confirm_mode: "manual_confirm";
      owner_type: string;
      owner_merchant_id: string | null;
      shop_id: string | null;
      display_name: string;
      merchant_no_masked: string | null;
      app_id_masked: string | null;
      service_provider_masked: string | null;
      gateway_url: string | null;
      api_mode: string | null;
    }>>`
      SELECT id, provider, confirm_mode, owner_type, owner_merchant_id, shop_id, display_name,
             merchant_no_masked, app_id_masked, service_provider_masked, gateway_url, api_mode
        FROM collection_payment_configs
       WHERE enabled_at IS NOT NULL
         AND status = 'active'
         AND confirm_mode = CAST('manual_confirm' AS "PaymentConfirmMode")
         AND provider IN (CAST('alipay_personal' AS "PaymentProvider"), CAST('wechat_personal' AS "PaymentProvider"))
         AND owner_type = CAST('merchant' AS "CollectionConfigOwnerType")
         AND shop_id = ${order.shop_id}
       ORDER BY is_default DESC, updated_at DESC
       LIMIT 1
    `;
    const manualMethod = manualMethods[0];
    const paymentNo = existingPayment?.payment_no ?? `payment-${orderNo}`;
    const paymentId = existingPayment?.id ?? stableDbId("payment", paymentNo);
    const provider = existingPayment?.provider ?? manualMethod?.provider ?? "alipay_personal";
    const method = {
      id: existingPayment?.collection_payment_config_id ?? manualMethod?.id ?? "manual-payment",
      provider,
      confirmMode: "manual_confirm",
      ownerType: manualMethod?.owner_type,
      merchantId: manualMethod?.owner_merchant_id,
      shopId: manualMethod?.shop_id,
      displayName: manualMethod?.display_name ?? paymentProviderDisplay(mapPaymentProviderFromDb(provider)),
      merchantNo: manualMethod?.merchant_no_masked ?? undefined,
      appId: manualMethod?.app_id_masked ?? undefined,
      serviceProviderId: manualMethod?.service_provider_masked ?? undefined,
      gatewayUrl: manualMethod?.gateway_url ?? undefined,
      apiMode: manualMethod?.api_mode ?? undefined
    };
    const collectionSnapshot = isRecord(existingPayment?.collection_snapshot_json)
      ? existingPayment.collection_snapshot_json
      : this.directPaymentCollectionSnapshot(method);
    const baseAmountCents = existingPayment?.base_amount_cents ?? order.paid_amount_cents;
    const feeBps = existingPayment?.fee_bps ?? 0;
    const feeCents = existingPayment?.fee_cents ?? 0n;
    const now = new Date();
    const isCodePool = fulfillmentRuleMode(order.fulfillment_rule_snapshot_json) === "code_pool";
    const idempotencyKey = `offline-payment:${orderNo}:${input.voucherUrl ?? expectedAmount.toString()}`;

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO payments (
          id, payment_no, order_id, user_id, merchant_id, collection_payment_config_id, collection_snapshot_json,
          channel, provider, confirm_mode, base_amount_cents, fee_bps, fee_cents,
          amount_cents, channel_fee_cents, status, confirm_source, idempotency_key,
          paid_at, created_at, updated_at
        )
        VALUES (
          ${paymentId}, ${paymentNo}, ${order.id}, ${order.user_id}, ${order.merchant_id},
          ${method.id === "manual-payment" ? null : method.id}, ${jsonForDb(collectionSnapshot)}::jsonb,
          CAST(${provider.startsWith("wechat") ? "wechat_h5" : "alipay_wap"} AS "PaymentChannel"),
          CAST(${provider} AS "PaymentProvider"), CAST('manual_confirm' AS "PaymentConfirmMode"),
          ${baseAmountCents}, ${feeBps}, ${feeCents}, ${expectedAmount}, 0,
          CAST('paid' AS "PaymentStatus"), CAST('manual_confirm' AS "PaymentConfirmSource"),
          ${`payment:${paymentNo}`}, ${now}, ${now}, ${now}
        )
        ON CONFLICT (idempotency_key) DO UPDATE SET
          status = CAST('paid' AS "PaymentStatus"),
          confirm_source = CAST('manual_confirm' AS "PaymentConfirmSource"),
          paid_at = EXCLUDED.paid_at,
          updated_at = now()
      `;
      await this.persistDirectPaymentSnapshot(tx, {
        orderId: order.id,
        orderNo,
        userId: order.user_id,
        paymentId,
        paymentNo,
        method,
        baseAmountCents,
        feeBps,
        feeCents,
        amountCents: expectedAmount,
        status: "paid",
        confirmSource: "manual_confirm",
        paidAt: now,
        expiresAt: null,
        collectionSnapshot: collectionSnapshot as Record<string, unknown>
      });
      await tx.$executeRaw`
        INSERT INTO payment_confirmations (
          id, confirmation_no, order_id, payment_id, shop_id, amount_cents, voucher_url, note,
          status, reviewed_by, reviewed_at, idempotency_key, created_at, updated_at
        )
        VALUES (
          ${stableDbId("payment_confirmation", idempotencyKey)}, ${`confirm:${orderNo}`},
          ${order.id}, ${paymentId}, ${order.shop_id}, ${expectedAmount}, ${input.voucherUrl ?? null},
          ${input.note ?? null}, CAST('confirmed' AS "PaymentConfirmationStatus"),
          ${actor.merchantId}, ${now}, ${idempotencyKey}, ${now}, ${now}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
      await tx.$executeRaw`
        UPDATE orders
           SET payment_status = CAST('paid' AS "PaymentStatus"),
               status = CAST(${isCodePool ? "fulfilled" : "fulfilling"} AS "OrderStatus"),
               fulfillment_status = CAST(${isCodePool ? "success" : "processing"} AS "FulfillmentStatus"),
               paid_at = ${now},
               fulfilled_at = ${isCodePool ? now : null},
               updated_at = now()
         WHERE id = ${order.id}
      `;
      let issuedCodes: Array<{ id: string; code_ciphertext: string; order_item_id: string }> = [];
      if (isCodePool) {
        issuedCodes = await tx.$queryRaw<Array<{ id: string; code_ciphertext: string; order_item_id: string }>>`
          UPDATE rights_codes rc
             SET status = CAST('issued' AS "RightsCodeStatus"),
                 issued_at = ${now},
                 issue_key = COALESCE(rc.issue_key, ${`issue:${orderNo}:`} || rc.id),
                 updated_at = now()
            FROM order_items oi
           WHERE rc.order_id = ${order.id}
             AND oi.order_id = ${order.id}
             AND rc.status IN (CAST('locked' AS "RightsCodeStatus"), CAST('issued' AS "RightsCodeStatus"))
           RETURNING rc.id, rc.code_ciphertext, oi.id AS order_item_id
        `;
        for (const code of issuedCodes) {
          await tx.$executeRaw`
            INSERT INTO entitlements (
              id, order_id, order_item_id, user_id, rights_code, rights_payload_json,
              status, idempotency_key, issued_at, created_at, updated_at
            )
            VALUES (
              ${stableDbId("entitlement", `${orderNo}:${code.id}`)}, ${order.id}, ${code.order_item_id}, ${order.user_id},
              ${code.code_ciphertext}, ${jsonForDb({ rightsCodeId: code.id })}::jsonb,
              CAST('success' AS "FulfillmentStatus"), ${`entitlement:${orderNo}:${code.id}`}, ${now}, ${now}, ${now}
            )
            ON CONFLICT (idempotency_key) DO NOTHING
          `;
        }
        const firstCode = issuedCodes[0];
        if (firstCode) {
          await tx.$executeRaw`
            INSERT INTO fulfillment_records (
              id, order_id, order_item_id, merchant_id, shop_id, idempotency_key,
              fulfillment_type, status, success_at, created_at, updated_at
            )
            VALUES (
              ${stableDbId("fulfillment", orderNo)}, ${order.id}, ${firstCode.order_item_id},
              ${order.merchant_id}, ${order.shop_id}, ${`fulfillment:${orderNo}`},
              CAST('code_pool' AS "FulfillmentType"), CAST('success' AS "FulfillmentStatus"),
              ${now}, ${now}, ${now}
            )
            ON CONFLICT (idempotency_key) DO UPDATE SET
              status = CAST('success' AS "FulfillmentStatus"),
              success_at = EXCLUDED.success_at,
              updated_at = now()
          `;
        }
      }
      if (isCodePool && order.buyer_email && issuedCodes.length > 0) {
        await tx.$executeRaw`
          INSERT INTO email_delivery_records (
            id, delivery_no, order_id, order_item_id, email, scope, status, code_count,
            error_code, error_message, actor_type, actor_id, source, idempotency_key, created_at, updated_at
          )
          VALUES (
            ${stableDbId("email_delivery", orderNo)}, ${`email:${orderNo}`}, ${order.id},
            ${issuedCodes[0]?.order_item_id ?? null}, ${order.buyer_email}, CAST('extract_link' AS "EmailDeliveryScope"),
            CAST('provider_not_configured' AS "EmailDeliveryStatus"), ${issuedCodes.length},
            'EMAIL_PROVIDER_NOT_CONFIGURED', 'email provider is not configured',
            CAST('system' AS "ActorType"), 'system', 'auto_fulfillment',
            ${`email:${orderNo}`}, ${now}, ${now}
          )
          ON CONFLICT (idempotency_key) DO NOTHING
        `;
      }
      await tx.$executeRaw`
        INSERT INTO ledger_entries (
          id, ledger_no, merchant_id, shop_id, subject_type, subject_id,
          account_type, entry_type, direction, amount_cents, currency, source_type,
          source_id, order_id, idempotency_key, created_at
        )
        VALUES (
          ${stableDbId("ledger", `manual-payment:${orderNo}`)}, ${`ledger:manual-payment:${orderNo}`},
          ${order.merchant_id}, ${order.shop_id}, CAST('merchant' AS "LedgerSubjectType"),
          ${order.merchant_id ?? "platform"}, CAST('merchant_pending_income' AS "LedgerAccountType"),
          CAST('MANUAL_ADJUST' AS "LedgerEntryType"), CAST('credit' AS "LedgerDirection"),
          ${expectedAmount}, 'CNY', 'order', ${orderNo}, ${order.id},
          ${`ledger:manual-payment:${orderNo}`}, ${now}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id,
          after_json, idempotency_key, request_id, ip, created_at
        )
        VALUES (
          ${stableDbId("audit", `order.offline_payment.confirm:${idempotencyKey}`)},
          CAST('merchant' AS "ActorType"), ${actor.merchantId}, 'order.offline_payment.confirm',
          'order', ${orderNo}, ${jsonForDb({ amountCents: expectedAmount, voucherUrl: input.voucherUrl, note: input.note })}::jsonb,
          ${`audit:order.offline_payment.confirm:${idempotencyKey}`}, ${idempotencyKey}, '127.0.0.1', ${now}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
      if (isCodePool) {
        await tx.$executeRaw`
          INSERT INTO audit_logs (
            id, actor_type, actor_id, action, target_type, target_id,
            after_json, idempotency_key, request_id, ip, created_at
          )
          VALUES (
            ${stableDbId("audit", `fulfillment.auto_code_pool:${orderNo}`)},
            CAST('system' AS "ActorType"), 'system', 'fulfillment.auto_code_pool',
            'order', ${orderNo}, ${jsonForDb({ codeIds: issuedCodes.map((code) => code.id) })}::jsonb,
            ${`audit:fulfillment.auto_code_pool:${orderNo}`}, ${`fulfillment.auto_code_pool:${orderNo}`}, '127.0.0.1', ${now}
          )
          ON CONFLICT (idempotency_key) DO NOTHING
        `;
      }
      return { fulfillmentStatus: isCodePool ? "success" : "processing" };
    }, { maxWait: 10_000, timeout: 30_000 });

    return {
      status: "processed" as const,
      idempotencyKey,
      order: { orderNo, paymentStatus: "paid", fulfillmentStatus: result.fulfillmentStatus }
    };
  }

  async generateSettlement(actor: AdminActor, input: { merchantId: string; now?: Date; batchNo: string }) {
    assertAdminPermission(actor, "settlement.generate");
    const now = input.now ?? new Date();
    const idempotencyKey = `settlement:${input.merchantId}:all:${input.batchNo}`;
    const duplicate = await this.prisma.settlementSheet.findUnique({ where: { idempotencyKey } });
    if (duplicate) return { status: "duplicate" as const, sheet: duplicate };

    const rows = await this.prisma.$queryRaw<Array<{
      order_id: string;
      order_no: string;
      seller_merchant_id: string | null;
      seller_shop_id: string;
      first_tier_merchant_id: string | null;
      second_tier_merchant_id: string | null;
      third_tier_merchant_id: string | null;
      first_tier_shop_id: string | null;
      second_tier_shop_id: string | null;
      third_tier_shop_id: string | null;
      fulfilled_at: Date;
      paid_amount_cents: bigint;
      supply_amount_cents: bigint;
      service_fee_cents: bigint;
      merchant_expected_income_cents: bigint;
      platform_supply_price_cents: bigint;
      first_tier_supply_price_cents: bigint;
      second_tier_supply_price_cents: bigint;
      first_tier_income_cents: bigint;
      second_tier_income_cents: bigint;
      third_tier_income_cents: bigint;
    }>>`
      SELECT o.id AS order_id, o.order_no, o.merchant_id AS seller_merchant_id,
             o.shop_id AS seller_shop_id, o.first_tier_merchant_id, o.second_tier_merchant_id,
             o.third_tier_merchant_id, fs.id AS first_tier_shop_id, ss.id AS second_tier_shop_id,
             ts.id AS third_tier_shop_id, o.fulfilled_at,
             oas.paid_amount_cents, oas.supply_amount_cents, oas.service_fee_cents,
             oas.merchant_expected_income_cents, oas.platform_supply_price_cents,
             oas.first_tier_supply_price_cents, oas.second_tier_supply_price_cents,
             oas.first_tier_income_cents, oas.second_tier_income_cents, oas.third_tier_income_cents
        FROM orders o
        JOIN order_amount_snapshots oas ON oas.order_id = o.id
        LEFT JOIN shops fs ON fs.merchant_id = o.first_tier_merchant_id
        LEFT JOIN shops ss ON ss.merchant_id = o.second_tier_merchant_id
        LEFT JOIN shops ts ON ts.merchant_id = o.third_tier_merchant_id
       WHERE o.sales_channel_type <> CAST('platform_self_operated' AS "SalesChannelType")
         AND o.payment_status = CAST('paid' AS "PaymentStatus")
         AND o.fulfillment_status = CAST('success' AS "FulfillmentStatus")
         AND o.settlement_status IN (CAST('pending' AS "SettlementStatus"), CAST('settleable' AS "SettlementStatus"))
         AND o.refund_status = CAST('none' AS "RefundStatus")
         AND o.risk_status = CAST('normal' AS "RiskStatus")
         AND o.fulfilled_at IS NOT NULL
         AND o.fulfilled_at <= ${new Date(now.getTime() - 24 * 60 * 60 * 1000)}
         AND (
           o.merchant_id = ${input.merchantId}
           OR o.first_tier_merchant_id = ${input.merchantId}
           OR o.second_tier_merchant_id = ${input.merchantId}
           OR o.third_tier_merchant_id = ${input.merchantId}
         )
    `;

    const drafts: Array<{
      orderId: string;
      orderNo: string;
      settlementRole: "single_merchant" | "first_tier" | "second_tier" | "third_tier";
      merchantId: string;
      shopId: string;
      paidAmountCents: bigint;
      supplyAmountCents: bigint;
      serviceFeeCents: bigint;
      merchantIncomeCents: bigint;
      fulfilledAt: Date;
      settleableAt: Date;
    }> = [];
    const settleableAt = (fulfilledAt: Date) => new Date(fulfilledAt.getTime() + 24 * 60 * 60 * 1000);
    for (const row of rows) {
      if (row.first_tier_merchant_id === input.merchantId && row.first_tier_shop_id && row.first_tier_income_cents > 0n) {
        drafts.push({
          orderId: row.order_id,
          orderNo: row.order_no,
          settlementRole: "first_tier",
          merchantId: input.merchantId,
          shopId: row.first_tier_shop_id,
          paidAmountCents: row.paid_amount_cents,
          supplyAmountCents: row.platform_supply_price_cents,
          serviceFeeCents: 0n,
          merchantIncomeCents: row.first_tier_income_cents,
          fulfilledAt: row.fulfilled_at,
          settleableAt: settleableAt(row.fulfilled_at)
        });
      }
      if (row.second_tier_merchant_id === input.merchantId && row.second_tier_shop_id && row.third_tier_merchant_id && row.second_tier_income_cents > 0n) {
        drafts.push({
          orderId: row.order_id,
          orderNo: row.order_no,
          settlementRole: "second_tier",
          merchantId: input.merchantId,
          shopId: row.second_tier_shop_id,
          paidAmountCents: row.paid_amount_cents,
          supplyAmountCents: row.first_tier_supply_price_cents,
          serviceFeeCents: 0n,
          merchantIncomeCents: row.second_tier_income_cents,
          fulfilledAt: row.fulfilled_at,
          settleableAt: settleableAt(row.fulfilled_at)
        });
      }
      if (row.seller_merchant_id === input.merchantId && row.merchant_expected_income_cents > 0n) {
        drafts.push({
          orderId: row.order_id,
          orderNo: row.order_no,
          settlementRole: row.third_tier_merchant_id ? "third_tier" : row.second_tier_merchant_id ? "second_tier" : "single_merchant",
          merchantId: input.merchantId,
          shopId: row.seller_shop_id,
          paidAmountCents: row.paid_amount_cents,
          supplyAmountCents: row.supply_amount_cents,
          serviceFeeCents: row.service_fee_cents,
          merchantIncomeCents: row.merchant_expected_income_cents,
          fulfilledAt: row.fulfilled_at,
          settleableAt: settleableAt(row.fulfilled_at)
        });
      }
    }
    const unsettled: typeof drafts = [];
    for (const draft of drafts) {
      const existing = await this.prisma.settlementItem.findUnique({
        where: { orderId_settlementRole: { orderId: draft.orderId, settlementRole: draft.settlementRole } }
      });
      if (!existing) unsettled.push(draft);
    }
    if (unsettled.length === 0) return { status: "no_candidates" as const };

    const settlementNo = `settlement-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const settlementId = stableDbId("settlement", settlementNo);
    const totalPaidCents = unsettled.reduce((sum, item) => sum + item.paidAmountCents, 0n);
    const totalServiceFeeCents = unsettled.reduce((sum, item) => sum + item.serviceFeeCents, 0n);
    const totalMerchantIncomeCents = unsettled.reduce((sum, item) => sum + item.merchantIncomeCents, 0n);
    const periodStart = new Date(Math.min(...unsettled.map((item) => item.fulfilledAt.getTime())));

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO settlement_sheets (
          id, settlement_no, merchant_id, period_start, period_end, status,
          total_order_count, total_paid_cents, total_service_fee_cents,
          total_merchant_income_cents, idempotency_key, created_by, created_at, updated_at
        )
        VALUES (
          ${settlementId}, ${settlementNo}, ${input.merchantId}, ${periodStart}, ${now},
          CAST('confirmed' AS "SettlementSheetStatus"), ${unsettled.length},
          ${totalPaidCents}, ${totalServiceFeeCents}, ${totalMerchantIncomeCents},
          ${idempotencyKey}, ${actor.adminId}, now(), now()
        )
      `;
      for (const item of unsettled) {
        await tx.$executeRaw`
          INSERT INTO settlement_items (
            id, settlement_id, order_id, settlement_role, merchant_id, shop_id,
            paid_amount_cents, supply_amount_cents, service_fee_cents,
            merchant_income_cents, deducted_cents, settle_amount_cents,
            fulfilled_at, settleable_at, created_at
          )
          VALUES (
            ${stableDbId("settlement_item", `${settlementNo}:${item.orderNo}:${item.settlementRole}`)},
            ${settlementId}, ${item.orderId}, CAST(${item.settlementRole} AS "SettlementRole"),
            ${item.merchantId}, ${item.shopId}, ${item.paidAmountCents}, ${item.supplyAmountCents},
            ${item.serviceFeeCents}, ${item.merchantIncomeCents}, 0, ${item.merchantIncomeCents},
            ${item.fulfilledAt}, ${item.settleableAt}, now()
          )
        `;
        await tx.$executeRaw`
          UPDATE orders
             SET settlement_status = CAST('settling' AS "SettlementStatus"),
                 updated_at = now()
           WHERE id = ${item.orderId}
        `;
      }
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id,
          after_json, idempotency_key, request_id, ip, created_at
        )
        VALUES (
          ${stableDbId("audit", `settlement.generate:${settlementNo}`)}, CAST('admin' AS "ActorType"),
          ${actor.adminId}, 'settlement.generate', 'settlement', ${settlementNo},
          ${jsonForDb({ merchantId: input.merchantId, count: unsettled.length })}::jsonb,
          ${`audit:settlement.generate:${settlementNo}`}, ${idempotencyKey}, '127.0.0.1', now()
        )
      `;
    }, { maxWait: 10_000, timeout: 30_000 });

    return {
      status: "processed" as const,
      sheet: {
        id: settlementId,
        settlementNo,
        merchantId: input.merchantId,
        status: "confirmed",
        totalOrderCount: unsettled.length,
        totalPaidCents,
        totalServiceFeeCents,
        totalMerchantIncomeCents,
        items: unsettled
      }
    };
  }

  async confirmManualPayout(actor: AdminActor, settlementNo: string, input: { voucherUrl: string; payoutMethod?: string }) {
    assertAdminPermission(actor, "payout.confirm");
    const sheet = await this.prisma.settlementSheet.findUnique({ where: { settlementNo } });
    if (!sheet) throw new ApiError(404, "RESOURCE_NOT_FOUND", "settlement not found");
    if (sheet.status === "paid") return { status: "duplicate" as const, sheet };
    const payoutNo = `payout-${settlementNo}`;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE settlement_sheets
           SET status = CAST('paid' AS "SettlementSheetStatus"),
               confirmed_by = ${actor.adminId},
               updated_at = now()
         WHERE settlement_no = ${settlementNo}
      `;
      await tx.$executeRaw`
        INSERT INTO manual_payouts (
          id, settlement_id, merchant_id, amount_cents, payee_info_snapshot_json,
          payout_method, payout_voucher_url, status, idempotency_key,
          paid_by, paid_at, created_at, updated_at
        )
        VALUES (
          ${stableDbId("payout", payoutNo)}, ${sheet.id}, ${sheet.merchantId},
          ${sheet.totalMerchantIncomeCents}, ${jsonForDb({ settlementNo, merchantId: sheet.merchantId })}::jsonb,
          ${input.payoutMethod ?? "manual"}, ${input.voucherUrl}, CAST('paid' AS "ManualPayoutStatus"),
          ${`payout:${payoutNo}`}, ${actor.adminId}, now(), now(), now()
        )
        ON CONFLICT (idempotency_key) DO UPDATE SET
          status = CAST('paid' AS "ManualPayoutStatus"),
          payout_voucher_url = EXCLUDED.payout_voucher_url,
          paid_by = EXCLUDED.paid_by,
          paid_at = EXCLUDED.paid_at,
          updated_at = now()
      `;
      await tx.$executeRaw`
        UPDATE orders
           SET settlement_status = CAST('settled' AS "SettlementStatus"),
               updated_at = now()
         WHERE id IN (
           SELECT order_id FROM settlement_items
            WHERE settlement_id = ${sheet.id}
              AND merchant_id = ${sheet.merchantId}
         )
      `;
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id,
          after_json, idempotency_key, request_id, ip, created_at
        )
        VALUES (
          ${stableDbId("audit", `manual_payout.confirm:${settlementNo}`)}, CAST('admin' AS "ActorType"),
          ${actor.adminId}, 'manual_payout.confirm', 'settlement', ${settlementNo},
          ${jsonForDb({ voucherUrl: input.voucherUrl, payoutMethod: input.payoutMethod ?? "manual" })}::jsonb,
          ${`audit:manual_payout.confirm:${settlementNo}`}, ${`manual_payout.confirm:${settlementNo}`}, '127.0.0.1', now()
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
    }, { maxWait: 10_000, timeout: 30_000 });
    return {
      status: "processed" as const,
      sheet: { ...sheet, status: "paid" },
      payout: { payoutNo, settlementNo, merchantId: sheet.merchantId, amountCents: sheet.totalMerchantIncomeCents, status: "paid" }
    };
  }

  async extractOrderCodes(actor: UserActor, orderNo: string, extractionCode: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      order_id: string;
      order_no: string;
      user_id: string;
      payment_status: string;
      fulfillment_status: string;
      refund_status: string;
      secret_id: string | null;
      order_item_id: string | null;
      claim_code_hash: string | null;
      failed_attempts: number | null;
      locked_until: Date | null;
    }>>`
      SELECT o.id AS order_id, o.order_no, o.user_id, o.payment_status, o.fulfillment_status,
             o.refund_status, oes.id AS secret_id, oes.order_item_id, oes.claim_code_hash,
             oes.failed_attempts, oes.locked_until
        FROM orders o
        LEFT JOIN order_extract_secrets oes ON oes.order_id = o.id AND oes.status = CAST('active' AS "ExtractSecretStatus")
       WHERE o.order_no = ${orderNo}
       LIMIT 1
    `;
    const order = rows[0];
    if (!order) throw new ApiError(404, "RESOURCE_NOT_FOUND", "order not found");
    if (order.user_id !== actor.userId) throw new ApiError(403, "FORBIDDEN_USER_SCOPE", "user cannot access another user resource");
    if (order.payment_status !== "paid" || order.fulfillment_status !== "success") {
      throw new ApiError(400, "EXTRACTION_NOT_READY", "delivery codes are not ready");
    }
    if (order.refund_status !== "none") throw new ApiError(403, "EXTRACTION_FORBIDDEN_AFTER_REFUND", "refunded orders cannot view delivery codes");
    if (!order.secret_id || !order.claim_code_hash || !order.order_item_id) {
      throw new ApiError(400, "EXTRACTION_NOT_REQUIRED", "this order is manually delivered");
    }
    const now = new Date();
    if (order.locked_until && order.locked_until > now) {
      await this.insertDirectExtractLog(order.order_id, order.secret_id, actor.userId, "locked", "too_many_attempts");
      throw new ApiError(423, "EXTRACTION_LOCKED", "too many wrong attempts, try again later");
    }
    if (hashSecret(extractionCode) !== order.claim_code_hash) {
      const failedAttempts = (order.failed_attempts ?? 0) + 1;
      const lockedUntil = failedAttempts >= 3 ? new Date(now.getTime() + 30 * 60 * 1000) : null;
      await this.prisma.$executeRaw`
        UPDATE order_extract_secrets
           SET failed_attempts = ${lockedUntil ? 0 : failedAttempts},
               locked_until = ${lockedUntil},
               updated_at = now()
         WHERE id = ${order.secret_id}
      `;
      await this.insertDirectExtractLog(order.order_id, order.secret_id, actor.userId, lockedUntil ? "locked" : "failed", "invalid_code");
      throw new ApiError(403, "PURCHASE_PASSWORD_INVALID", "purchase password is incorrect");
    }
    const codes = await this.prisma.$queryRaw<Array<{ id: string; code_ciphertext: string; issued_at: Date | null }>>`
      SELECT id, code_ciphertext, issued_at
        FROM rights_codes
       WHERE order_id = ${order.order_id}
         AND status = CAST('issued' AS "RightsCodeStatus")
       ORDER BY issued_at ASC, id ASC
    `;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE order_extract_secrets
           SET failed_attempts = 0,
               locked_until = NULL,
               first_viewed_at = COALESCE(first_viewed_at, ${now}),
               updated_at = now()
         WHERE id = ${order.secret_id}
      `;
      await tx.$executeRaw`
        INSERT INTO order_extract_logs (
          id, extract_secret_id, order_id, actor_type, actor_id, result,
          idempotency_key, created_at
        )
        VALUES (
          ${stableDbId("extract_log", `${orderNo}:success:${Date.now()}`)}, ${order.secret_id}, ${order.order_id},
          CAST('user' AS "ActorType"), ${actor.userId}, CAST('success' AS "ExtractLogResult"),
          ${`extract:${orderNo}:success:${Date.now()}`}, ${now}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
      await tx.$executeRaw`
        INSERT INTO audit_logs (
          id, actor_type, actor_id, action, target_type, target_id,
          after_json, idempotency_key, request_id, ip, created_at
        )
        VALUES (
          ${stableDbId("audit", `order.extract.success:${orderNo}:${actor.userId}:${Date.now()}`)},
          CAST('user' AS "ActorType"), ${actor.userId}, 'order.extract.success',
          'order', ${orderNo}, ${jsonForDb({ codeCount: codes.length })}::jsonb,
          ${`audit:order.extract.success:${orderNo}:${actor.userId}:${Date.now()}`},
          ${`order.extract.success:${orderNo}`}, '127.0.0.1', ${now}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
      `;
    }, { maxWait: 10_000, timeout: 30_000 });
    return {
      orderNo,
      status: "success",
      codes: codes.map((code) => ({ codeId: code.id, code: code.code_ciphertext, issuedAt: code.issued_at ?? undefined })),
      message: "卡密已提取，请妥善保存。"
    };
  }

  private async insertDirectExtractLog(orderId: string, extractSecretId: string, userId: string, result: "failed" | "locked", reasonCode: string) {
    const now = new Date();
    await this.prisma.$executeRaw`
      INSERT INTO order_extract_logs (
        id, extract_secret_id, order_id, actor_type, actor_id, result,
        reason_code, idempotency_key, created_at
      )
      VALUES (
        ${stableDbId("extract_log", `${orderId}:${result}:${now.getTime()}`)}, ${extractSecretId}, ${orderId},
        CAST('user' AS "ActorType"), ${userId}, CAST(${result} AS "ExtractLogResult"),
        ${reasonCode}, ${`extract:${orderId}:${result}:${now.getTime()}`}, ${now}
      )
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
  }

  private async findQuotableProduct(shopId: string, listingId: string) {
    const platformRows = await this.prisma.$queryRaw<Array<{
      id: string;
      shop_id: string;
      platform_product_id: string;
      sale_price_cents: bigint;
      status: string;
      product_status: string;
      fulfillment_rule_json: unknown;
    }>>`
      SELECT psp.id, psp.shop_id, psp.platform_product_id, psp.sale_price_cents,
             psp.status, pp.status AS product_status, pp.fulfillment_rule_json
        FROM platform_shop_products psp
        JOIN platform_products pp ON pp.id = psp.platform_product_id
       WHERE psp.id = ${listingId}
       LIMIT 1
    `;
    const platform = platformRows[0];
    if (platform) {
      if (platform.shop_id !== shopId) throw new ApiError(400, "RESOURCE_SCOPE_MISMATCH", "product does not belong to shop");
      if (platform.status !== "listed" || platform.product_status !== "active") throw new ApiError(400, "PRODUCT_NOT_LISTED", "product is not listed");
      return {
        salePriceCents: platform.sale_price_cents,
        platformProductId: platform.platform_product_id,
        fulfillmentMode: fulfillmentRuleMode(platform.fulfillment_rule_json)
      };
    }

    const listingRows = await this.prisma.$queryRaw<Array<{
      id: string;
      shop_id: string;
      platform_product_id: string | null;
      sale_price_cents: bigint;
      status: string;
      product_status: string | null;
      fulfillment_rule_json: unknown;
    }>>`
      SELECT mpl.id, mpl.shop_id, mpl.platform_product_id, mpl.sale_price_cents,
             mpl.status, pp.status AS product_status, pp.fulfillment_rule_json
        FROM merchant_product_listings mpl
        LEFT JOIN platform_products pp ON pp.id = mpl.platform_product_id
       WHERE mpl.id = ${listingId}
       LIMIT 1
    `;
    const listing = listingRows[0];
    if (listing) {
      if (listing.shop_id !== shopId) throw new ApiError(400, "RESOURCE_SCOPE_MISMATCH", "product does not belong to shop");
      if (listing.status !== "listed" || listing.product_status !== "active") throw new ApiError(400, "PRODUCT_NOT_LISTED", "product is not listed");
      return {
        salePriceCents: listing.sale_price_cents,
        platformProductId: listing.platform_product_id ?? undefined,
        fulfillmentMode: fulfillmentRuleMode(listing.fulfillment_rule_json)
      };
    }

    const ownRows = await this.prisma.$queryRaw<Array<{
      id: string;
      shop_id: string;
      sale_price_cents: bigint;
      status: string;
      review_status: string | null;
      fulfillment_rule_json: unknown;
    }>>`
      SELECT mp.id, mp.shop_id, mp.sale_price_cents, mp.status, mpr.status AS review_status,
             mpr.fulfillment_rule_json
        FROM merchant_products mp
        LEFT JOIN merchant_product_reviews mpr ON mpr.id = mp.own_product_review_id
       WHERE mp.id = ${listingId}
       LIMIT 1
    `;
    const own = ownRows[0];
    if (!own) throw new ApiError(404, "RESOURCE_NOT_FOUND", "product not found");
    if (own.shop_id !== shopId) throw new ApiError(400, "RESOURCE_SCOPE_MISMATCH", "product does not belong to shop");
    if (own.status !== "listed" || own.review_status !== "approved") throw new ApiError(400, "PRODUCT_NOT_LISTED", "product is not listed");
    return {
      salePriceCents: own.sale_price_cents,
      merchantProductId: own.id,
      fulfillmentMode: fulfillmentRuleMode(own.fulfillment_rule_json)
    };
  }

  private async requirePublicShop(shopIdentifier: string): Promise<DemoShop> {
    const shop = await this.findPublicShop(shopIdentifier);
    if (!shop) throw new ApiError(404, "RESOURCE_NOT_FOUND", "shop not found");
    return shop;
  }

  private async assertDirectShopAcceptsOrders(shop: DemoShop) {
    if ((shop.ownerType ?? "merchant") !== "merchant") return;
    const merchantId = shop.merchantId;
    if (!merchantId) throw new ApiError(400, "SHOP_NOT_OPEN", "merchant shop is not open");
    const rows = await this.prisma.$queryRaw<Array<{
      merchant_status: string;
      deposit_status: string | null;
      shop_status: string;
      merchant_risk_status: string | null;
      shop_risk_status: string | null;
    }>>`
      SELECT m.status AS merchant_status, da.status AS deposit_status,
             s.status AS shop_status, m.risk_status AS merchant_risk_status,
             s.risk_status AS shop_risk_status
        FROM merchants m
        JOIN shops s ON s.merchant_id = m.id
        LEFT JOIN deposit_accounts da ON da.merchant_id = m.id
       WHERE m.id = ${merchantId}
         AND s.id = ${shop.id}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new ApiError(404, "RESOURCE_NOT_FOUND", "merchant shop not found");
    if (row.deposit_status !== "paid" || row.merchant_status !== "active") {
      throw new ApiError(400, "DEPOSIT_INSUFFICIENT", "merchant deposit is insufficient");
    }
    if (row.shop_status !== "open") throw new ApiError(400, "SHOP_NOT_OPEN", "merchant shop is not open");
    if (row.merchant_risk_status !== "normal" || row.shop_risk_status !== "normal") {
      throw new ApiError(400, "RISK_BLOCKED", "risk freeze blocks order creation");
    }
  }

  private async findOrderProduct(shopId: string, listingId: string) {
    const platformRows = await this.prisma.$queryRaw<Array<{
      id: string;
      shop_id: string;
      platform_product_id: string;
      sale_price_cents: bigint;
      fulfillment_cost_cents: bigint;
      status: string;
      product_status: string;
      product_name: string;
      fulfillment_rule_json: unknown;
      after_sale_rule_json: unknown;
      shop_owner_type: "platform" | "merchant";
    }>>`
      SELECT psp.id, psp.shop_id, psp.platform_product_id, psp.sale_price_cents,
             psp.fulfillment_cost_cents, psp.status, pp.status AS product_status,
             pp.name AS product_name, pp.fulfillment_rule_json, pp.after_sale_rule_json,
             s.owner_type AS shop_owner_type
        FROM platform_shop_products psp
        JOIN platform_products pp ON pp.id = psp.platform_product_id
        JOIN shops s ON s.id = psp.shop_id
       WHERE psp.id = ${listingId}
       LIMIT 1
    `;
    const platform = platformRows[0];
    if (platform) {
      if (platform.shop_id !== shopId) throw new ApiError(400, "RESOURCE_SCOPE_MISMATCH", "product does not belong to shop");
      if (platform.status !== "listed" || platform.product_status !== "active") throw new ApiError(400, "PRODUCT_NOT_LISTED", "product is not listed");
      return {
        merchantId: null as string | null,
        platformShopProductId: platform.id,
        merchantProductListingId: null as string | null,
        merchantProductId: null as string | null,
        platformProductId: platform.platform_product_id,
        productIdSnapshot: platform.platform_product_id,
        productName: platform.product_name,
        productType: "platform",
        saleSourceType: "platform_shop_product",
        salesChannelType: "platform_self_operated",
        salePriceCents: platform.sale_price_cents,
        supplyAmountCents: platform.fulfillment_cost_cents,
        fulfillmentRule: platform.fulfillment_rule_json,
        afterSaleRule: platform.after_sale_rule_json,
        fulfillmentMode: fulfillmentRuleMode(platform.fulfillment_rule_json),
        shopOwnerType: platform.shop_owner_type
      };
    }

    const listingRows = await this.prisma.$queryRaw<Array<{
      id: string;
      merchant_id: string;
      shop_id: string;
      platform_product_id: string;
      sale_price_cents: bigint;
      status: string;
      display_name: string | null;
      product_name: string;
      supply_price_cents: bigint;
      fulfillment_rule_json: unknown;
      after_sale_rule_json: unknown;
      product_status: string;
      shop_owner_type: "platform" | "merchant";
    }>>`
      SELECT mpl.id, mpl.merchant_id, mpl.shop_id, mpl.platform_product_id,
             mpl.sale_price_cents, mpl.status, mpl.display_name,
             pp.name AS product_name, pp.supply_price_cents,
             pp.fulfillment_rule_json, pp.after_sale_rule_json,
             pp.status AS product_status, s.owner_type AS shop_owner_type
        FROM merchant_product_listings mpl
        JOIN platform_products pp ON pp.id = mpl.platform_product_id
        JOIN shops s ON s.id = mpl.shop_id
       WHERE mpl.id = ${listingId}
       LIMIT 1
    `;
    const listing = listingRows[0];
    if (listing) {
      if (listing.shop_id !== shopId) throw new ApiError(400, "RESOURCE_SCOPE_MISMATCH", "product does not belong to shop");
      if (listing.status !== "listed" || listing.product_status !== "active") throw new ApiError(400, "PRODUCT_NOT_LISTED", "product is not listed");
      return {
        merchantId: listing.merchant_id,
        platformShopProductId: null as string | null,
        merchantProductListingId: listing.id,
        merchantProductId: null as string | null,
        platformProductId: listing.platform_product_id,
        productIdSnapshot: listing.platform_product_id,
        productName: listing.display_name ?? listing.product_name,
        productType: "platform",
        saleSourceType: "merchant_product_listing",
        salesChannelType: "single_merchant",
        salePriceCents: listing.sale_price_cents,
        supplyAmountCents: listing.supply_price_cents,
        fulfillmentRule: listing.fulfillment_rule_json,
        afterSaleRule: listing.after_sale_rule_json,
        fulfillmentMode: fulfillmentRuleMode(listing.fulfillment_rule_json),
        shopOwnerType: listing.shop_owner_type
      };
    }

    const ownRows = await this.prisma.$queryRaw<Array<{
      id: string;
      merchant_id: string;
      shop_id: string;
      sale_price_cents: bigint;
      status: string;
      own_name: string;
      detail_json: unknown;
      fulfillment_rule_json: unknown;
      after_sale_rule_json: unknown;
      review_status: string | null;
      shop_owner_type: "platform" | "merchant";
    }>>`
      SELECT mp.id, mp.merchant_id, mp.shop_id, mp.sale_price_cents, mp.status,
             mpr.name AS own_name, mpr.detail_json, mpr.fulfillment_rule_json, mpr.after_sale_rule_json,
             mpr.status AS review_status, s.owner_type AS shop_owner_type
        FROM merchant_products mp
        JOIN merchant_product_reviews mpr ON mpr.id = mp.own_product_review_id
        JOIN shops s ON s.id = mp.shop_id
       WHERE mp.id = ${listingId}
       LIMIT 1
    `;
    const own = ownRows[0];
    if (!own) throw new ApiError(404, "RESOURCE_NOT_FOUND", "product not found");
    if (own.shop_id !== shopId) throw new ApiError(400, "RESOURCE_SCOPE_MISMATCH", "product does not belong to shop");
    if (own.status !== "listed" || own.review_status !== "approved") throw new ApiError(400, "PRODUCT_NOT_LISTED", "product is not listed");
    return {
      merchantId: own.merchant_id,
      platformShopProductId: null as string | null,
      merchantProductListingId: null as string | null,
      merchantProductId: own.id,
      platformProductId: undefined,
      productIdSnapshot: own.id,
      productName: own.own_name,
      productType: "merchant_owned",
      saleSourceType: "merchant_product",
      salesChannelType: "single_merchant",
      salePriceCents: own.sale_price_cents,
      supplyAmountCents: 0n,
      fulfillmentRule: own.fulfillment_rule_json,
      afterSaleRule: own.after_sale_rule_json,
      fulfillmentMode: fulfillmentRuleMode(own.fulfillment_rule_json),
      shopOwnerType: own.shop_owner_type
    };
  }

  private async activeDirectServiceFeeConfig() {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      enabled: boolean;
      fee_bps: number;
      basis_type: string;
      status: string;
      updated_at: Date;
      updated_by: string | null;
    }>>`
      SELECT id, enabled, fee_bps, basis_type, status, updated_at, updated_by
        FROM platform_service_fee_configs
       WHERE status = 'active'
       ORDER BY effective_from DESC, updated_at DESC
       LIMIT 1
    `;
    const row = rows[0];
    return {
      id: row?.id ?? "default",
      enabled: row?.enabled ?? true,
      feeBps: row?.fee_bps ?? 50,
      basisType: row?.basis_type ?? "final_sale_price",
      status: row?.status ?? "active",
      updatedAt: row?.updated_at ?? new Date(),
      updatedBy: row?.updated_by ?? undefined
    };
  }

  private async findDirectPaymentMethod(shopId: string, paymentMethodId?: string) {
    const shop = await this.requirePublicShop(shopId);
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      owner_type: "platform" | "merchant";
      owner_merchant_id: string | null;
      shop_id: string | null;
      provider: "alipay_merchant" | "wechat_merchant" | "epay" | "alipay_personal" | "wechat_personal" | "balance";
      confirm_mode: "callback_query" | "manual_confirm" | "balance_deduct";
      display_name: string;
      merchant_no_masked: string | null;
      app_id_masked: string | null;
      service_provider_masked: string | null;
      gateway_url: string | null;
      api_mode: string | null;
      credential_ciphertext: string | null;
      qr_url: string | null;
      return_url: string | null;
      is_default: boolean;
    }>>`
      SELECT id, owner_type, owner_merchant_id, shop_id, provider, confirm_mode, display_name,
             merchant_no_masked, app_id_masked, service_provider_masked, gateway_url, api_mode,
             credential_ciphertext, qr_url, return_url, is_default
        FROM collection_payment_configs
       WHERE enabled_at IS NOT NULL
         AND status = 'active'
         AND provider <> 'balance'
         AND (
           (provider IN ('alipay_personal', 'wechat_personal') AND qr_url IS NOT NULL)
           OR (provider = 'epay' AND gateway_url IS NOT NULL AND merchant_no_masked IS NOT NULL AND credential_ciphertext LIKE 'aes256gcm:%')
           OR (provider IN ('alipay_merchant', 'wechat_merchant') AND merchant_no_masked IS NOT NULL AND app_id_masked IS NOT NULL AND credential_ciphertext LIKE 'aes256gcm:%')
         )
         AND (
           (owner_type = 'platform' AND ${shop.ownerType} = 'platform')
           OR (owner_type = 'merchant' AND shop_id = ${shop.id})
         )
         AND (${paymentMethodId ?? null} IS NULL OR id = ${paymentMethodId ?? null})
       ORDER BY is_default DESC, updated_at DESC
       LIMIT 1
    `;
    const method = rows[0];
    if (!method) throw new ApiError(400, "PAYMENT_METHOD_UNAVAILABLE", "payment method is unavailable");
    const credential = decryptPaymentCredentialBundle(method.credential_ciphertext);
    if (
      (method.provider === "epay" && !(method.gateway_url && (credential.merchantNo ?? method.merchant_no_masked) && credential.signingSecret))
      || ((method.provider === "alipay_merchant" || method.provider === "wechat_merchant") && !((credential.merchantNo ?? method.merchant_no_masked) && (credential.appId ?? method.app_id_masked)))
      || ((method.provider === "alipay_personal" || method.provider === "wechat_personal") && !method.qr_url)
    ) {
      throw new ApiError(400, "PAYMENT_METHOD_UNAVAILABLE", "payment method is unavailable");
    }
    return {
      id: method.id,
      ownerType: method.owner_type,
      merchantId: method.owner_merchant_id,
      shopId: method.shop_id,
      provider: method.provider,
      confirmMode: method.confirm_mode,
      displayName: method.display_name,
      merchantNo: credential.merchantNo ?? method.merchant_no_masked ?? undefined,
      appId: credential.appId ?? method.app_id_masked ?? undefined,
      serviceProviderId: credential.serviceProviderId ?? method.service_provider_masked ?? undefined,
      signingSecret: credential.signingSecret,
      gatewayUrl: method.gateway_url ?? undefined,
      apiMode: parsePaymentApiMode(method.api_mode),
      qrUrl: method.qr_url,
      returnUrl: method.return_url
    };
  }

  private directPaymentCollectionSnapshot(method: {
    id: string;
    ownerType?: string;
    merchantId?: string | null;
    shopId?: string | null;
    provider: string;
    confirmMode: string;
    displayName?: string;
    merchantNo?: string;
    appId?: string;
    serviceProviderId?: string;
    gatewayUrl?: string;
    apiMode?: string;
  }) {
    return {
      id: method.id,
      ownerType: method.ownerType,
      ownerMerchantId: method.merchantId ?? undefined,
      shopId: method.shopId ?? undefined,
      provider: method.provider,
      confirmMode: method.confirmMode,
      displayName: method.displayName,
      merchantNoMasked: maskSecret(method.merchantNo),
      appIdMasked: maskSecret(method.appId),
      serviceProviderMasked: maskSecret(method.serviceProviderId),
      gatewayUrl: method.gatewayUrl,
      apiMode: method.apiMode
    };
  }

  private async buildDirectEpayPaymentParams(method: {
    provider: string;
    merchantNo?: string;
    signingSecret?: string;
    gatewayUrl?: string;
    apiMode?: PaymentApiMode;
    returnUrl?: string | null;
  }, orderNo: string, productSnapshot: unknown, amountCents: bigint) {
    const gatewayUrl = required(method.gatewayUrl, "epay gatewayUrl");
    const merchantNo = required(method.merchantNo, "epay merchantNo");
    const signingSecret = required(method.signingSecret, "epay signingSecret");
    const notifyUrl = absoluteCallbackUrl("/api/callbacks/payments/epay");
    const returnUrl = method.returnUrl ?? publicSiteUrl();
    const endpoints = epayGatewayEndpoints(gatewayUrl);
    const submitParams: Record<string, string> = {
      pid: merchantNo,
      type: "alipay",
      out_trade_no: orderNo,
      notify_url: notifyUrl,
      return_url: returnUrl,
      name: productNameFromSnapshot(productSnapshot, orderNo),
      money: centsString(amountCents),
      sign_type: "MD5"
    };
    submitParams.sign = signEpayParams(submitParams, signingSecret);
    const submitPaymentUrl = appendQuery(endpoints.submitUrl, submitParams);
    const mapi = method.apiMode === "submit" ? undefined : await requestEpayMapi(endpoints.mapiUrl, submitParams);
    const paymentUrl = mapi?.directAppUrl ?? mapi?.cashierUrl ?? submitPaymentUrl;
    return {
      method: mapi?.directAppUrl ? "APP" : mapi?.ok ? "MAPI" : "GET",
      gatewayUrl: endpoints.submitUrl,
      mapiUrl: endpoints.mapiUrl,
      paymentUrl,
      submitPaymentUrl,
      directAppUrl: mapi?.directAppUrl,
      cashierUrl: mapi?.cashierUrl,
      qrCodeUrl: mapi?.qrCodeUrl ?? paymentUrl,
      submitParams,
      apiMode: method.apiMode ?? "mapi_first",
      mapiStatus: mapi?.ok ? "resolved" : mapi ? "fallback" : "skipped",
      mapiMessage: mapi?.message,
      notifyUrl,
      returnUrl
    };
  }

  private async resolveDirectCouponDiscount(userId: string, couponId: string, paidAmountCents: bigint, platformProductId: string | undefined, merchantProductId: string | undefined, shopId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      discount_amount_cents: bigint;
      threshold_amount_cents: bigint;
      user_coupon_status: string;
      template_status: string;
      valid_from: Date;
      valid_to: Date;
      has_matching_scope: boolean;
    }>>`
      SELECT ct.discount_amount_cents, ct.threshold_amount_cents,
             uc.status AS user_coupon_status, ct.status AS template_status,
             uc.valid_from, uc.valid_to,
             EXISTS (
               SELECT 1
                 FROM coupon_scopes cs
                WHERE cs.coupon_template_id = ct.id
                  AND (
                    cs.scope_type = 'all_products'
                    OR (cs.scope_type = 'platform_product' AND cs.platform_product_id = ${platformProductId ?? null})
                    OR (cs.scope_type = 'merchant_product' AND cs.merchant_product_id = ${merchantProductId ?? null})
                    OR (cs.scope_type = 'shop' AND cs.shop_id = ${shopId})
                  )
             ) AS has_matching_scope
        FROM user_coupons uc
        JOIN coupon_templates ct ON ct.id = uc.coupon_template_id
       WHERE uc.id = ${couponId}
         AND uc.user_id = ${userId}
       LIMIT 1
    `;
    const coupon = rows[0];
    if (!coupon) throw new ApiError(400, "COUPON_UNAVAILABLE", "coupon is not available");
    const now = new Date();
    if (coupon.user_coupon_status !== "active" || coupon.template_status !== "active" || coupon.valid_from > now || coupon.valid_to < now || !coupon.has_matching_scope) {
      throw new ApiError(400, "COUPON_UNAVAILABLE", "coupon is not available");
    }
    if (paidAmountCents < coupon.threshold_amount_cents) throw new ApiError(400, "COUPON_THRESHOLD_NOT_MET", "coupon threshold is not met");
    return coupon.discount_amount_cents > paidAmountCents ? paidAmountCents : coupon.discount_amount_cents;
  }

  private async lockAndApplyDirectCoupon(tx: PrismaTx, input: {
    userId: string;
    couponId: string;
    orderId: string;
    orderNo: string;
    paidAmountCents: bigint;
    platformProductId?: string;
    merchantProductId?: string | null;
    shopId: string;
  }) {
    const rows = await tx.$queryRaw<Array<{
      user_coupon_id: string;
      coupon_template_id: string;
      discount_amount_cents: bigint;
      platform_subsidy_cents: bigint;
      threshold_amount_cents: bigint;
      user_coupon_status: string;
      template_status: string;
      valid_from: Date;
      valid_to: Date;
      template_name: string;
      has_matching_scope: boolean;
    }>>`
      SELECT uc.id AS user_coupon_id, ct.id AS coupon_template_id,
             ct.discount_amount_cents, ct.platform_subsidy_cents, ct.threshold_amount_cents,
             uc.status AS user_coupon_status, ct.status AS template_status,
             uc.valid_from, uc.valid_to, ct.name AS template_name,
             EXISTS (
               SELECT 1
                 FROM coupon_scopes cs
                WHERE cs.coupon_template_id = ct.id
                  AND (
                    cs.scope_type = 'all_products'
                    OR (cs.scope_type = 'platform_product' AND cs.platform_product_id = ${input.platformProductId ?? null})
                    OR (cs.scope_type = 'merchant_product' AND cs.merchant_product_id = ${input.merchantProductId ?? null})
                    OR (cs.scope_type = 'shop' AND cs.shop_id = ${input.shopId})
                  )
             ) AS has_matching_scope
       FROM user_coupons uc
        JOIN coupon_templates ct ON ct.id = uc.coupon_template_id
       WHERE uc.id = ${input.couponId}
         AND uc.user_id = ${input.userId}
       LIMIT 1
       FOR UPDATE OF uc
    `;
    const coupon = rows[0];
    if (!coupon) throw new ApiError(400, "COUPON_UNAVAILABLE", "coupon is not available");
    const now = new Date();
    if (
      coupon.user_coupon_status !== "active"
      || coupon.template_status !== "active"
      || coupon.valid_from > now
      || coupon.valid_to < now
      || !coupon.has_matching_scope
    ) {
      throw new ApiError(400, "COUPON_UNAVAILABLE", "coupon is not available");
    }
    if (input.paidAmountCents < coupon.threshold_amount_cents) throw new ApiError(400, "COUPON_THRESHOLD_NOT_MET", "coupon threshold is not met");
    const discountCents = coupon.discount_amount_cents > input.paidAmountCents ? input.paidAmountCents : coupon.discount_amount_cents;
    const usageIdempotencyKey = `coupon-usage:${coupon.user_coupon_id}:${input.orderNo}`;
    await tx.$executeRaw`
      UPDATE user_coupons
         SET status = CAST('used' AS "CouponStatus"),
             source_id = ${input.orderNo},
             updated_at = now()
       WHERE id = ${coupon.user_coupon_id}
         AND status = CAST('active' AS "CouponStatus")
    `;
    await tx.$executeRaw`
      UPDATE coupon_templates
         SET used_count = used_count + 1,
             updated_at = now()
       WHERE id = ${coupon.coupon_template_id}
    `;
    return {
      discountCents,
      usage: {
        userCouponId: coupon.user_coupon_id,
        couponTemplateId: coupon.coupon_template_id,
        discountCents,
        subsidyCents: coupon.platform_subsidy_cents,
        idempotencyKey: usageIdempotencyKey
      },
      snapshot: {
        userCouponId: coupon.user_coupon_id,
        couponTemplateId: coupon.coupon_template_id,
        name: coupon.template_name,
        discountCents,
        platformSubsidyCents: coupon.platform_subsidy_cents,
        usedAt: now.toISOString()
      }
    };
  }

  private async persistDirectPaymentSnapshot(tx: PrismaTx, input: {
    orderId: string;
    orderNo: string;
    userId: string;
    paymentId: string;
    paymentNo: string;
    method: {
      id: string;
      provider: string;
      confirmMode: string;
      merchantNo?: string;
      appId?: string;
      serviceProviderId?: string;
    };
    baseAmountCents: bigint;
    feeBps: number;
    feeCents: bigint;
    amountCents: bigint;
    status: "unpaid" | "paying" | "paid";
    confirmSource: "unconfirmed" | "callback" | "query" | "manual_confirm" | "balance";
    expiresAt: Date | null;
    paidAt: Date | null;
    collectionSnapshot: Record<string, unknown>;
  }) {
    await tx.$executeRaw`
      INSERT INTO payment_snapshots (
        id, snapshot_no, order_id, payment_id, collection_config_id, provider,
        confirm_mode, environment, config_snapshot_json, merchant_no_masked,
        app_id_masked, service_provider_masked, base_amount_cents, fee_bps,
        fee_cents, payable_amount_cents, currency, payment_no, status,
        confirm_source, expires_at, paid_at, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${stableDbId("payment_snapshot", input.orderNo)}, ${`snapshot:${input.orderNo}`},
        ${input.orderId}, ${input.paymentId}, ${input.method.provider === "balance" ? null : input.method.id},
        CAST(${input.method.provider} AS "PaymentProvider"),
        CAST(${input.method.confirmMode} AS "PaymentConfirmMode"),
        CAST('production' AS "PaymentEnvironment"),
        ${jsonForDb(input.collectionSnapshot)}::jsonb,
        ${maskSecret(input.method.merchantNo) ?? null}, ${maskSecret(input.method.appId) ?? null},
        ${maskSecret(input.method.serviceProviderId) ?? null},
        ${input.baseAmountCents}, ${input.feeBps}, ${input.feeCents}, ${input.amountCents}, 'CNY',
        ${input.paymentNo}, CAST(${input.status} AS "PaymentStatus"),
        CAST(${input.confirmSource} AS "PaymentConfirmSource"), ${input.expiresAt}, ${input.paidAt},
        ${`payment-snapshot:${input.orderNo}`}, now(), now()
      )
      ON CONFLICT (snapshot_no) DO UPDATE SET
        payment_id = EXCLUDED.payment_id,
        collection_config_id = EXCLUDED.collection_config_id,
        provider = EXCLUDED.provider,
        confirm_mode = EXCLUDED.confirm_mode,
        config_snapshot_json = EXCLUDED.config_snapshot_json,
        base_amount_cents = EXCLUDED.base_amount_cents,
        fee_bps = EXCLUDED.fee_bps,
        fee_cents = EXCLUDED.fee_cents,
        payable_amount_cents = EXCLUDED.payable_amount_cents,
        status = EXCLUDED.status,
        confirm_source = EXCLUDED.confirm_source,
        expires_at = EXCLUDED.expires_at,
        paid_at = EXCLUDED.paid_at,
        updated_at = now()
    `;
  }

  private async updateDirectOrderPaymentAmountSnapshot(tx: PrismaTx, orderId: string, input: {
    feeBps: number;
    feeCents: bigint;
    baseAmountCents: bigint;
    amountCents: bigint;
    provider: string;
    collectionSnapshot: Record<string, unknown>;
  }) {
    await tx.$executeRaw`
      UPDATE order_amount_snapshots
         SET payment_fee_bps = ${input.feeBps},
             payment_fee_cents = ${input.feeCents},
             balance_paid_cents = ${input.provider === "balance" ? input.baseAmountCents : 0n},
             external_paid_cents = ${input.provider === "balance" ? 0n : input.amountCents}
       WHERE order_id = ${orderId}
    `;
    await tx.$executeRaw`
      UPDATE orders
         SET paid_amount_cents = ${input.amountCents},
             collection_snapshot_json = ${jsonForDb(input.collectionSnapshot)}::jsonb,
             updated_at = now()
       WHERE id = ${orderId}
    `;
  }

  private async listPublicPlatformShopProducts(shopId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      shop_id: string;
      platform_product_id: string;
      sale_price_cents: bigint;
      status: string;
      name: string | null;
      category_name: string | null;
      tags_json: unknown;
      image_url: string | null;
      specs_json: unknown;
      detail_sections_json: unknown;
      stock_count: number | null;
      public_stock_count: number | null;
      sold_count: number | null;
      display_badge: string | null;
      is_recommended: boolean | null;
      display_sort: number | null;
      detail: string | null;
      rights_desc: string | null;
      fulfillment_rule_json: unknown;
      after_sale_rule_json: unknown;
      product_status: string | null;
    }>>`
      SELECT psp.id, psp.shop_id, psp.platform_product_id, psp.sale_price_cents, psp.status,
             pp.name, pp.category_name, pp.tags_json, pp.image_url, pp.specs_json,
             pp.detail_sections_json, pp.stock_count,
             CASE WHEN pp.fulfillment_rule_json->>'mode' = 'code_pool'
               THEN (
                 SELECT COUNT(*)::int
                   FROM rights_codes rc
                  WHERE rc.product_id = pp.id
                    AND rc.status = 'available'
               )
               ELSE pp.stock_count
             END AS public_stock_count,
             pp.sold_count, pp.display_badge,
             pp.is_recommended, pp.display_sort, pp.detail, pp.rights_desc,
             pp.fulfillment_rule_json, pp.after_sale_rule_json, pp.status AS product_status
        FROM platform_shop_products psp
        JOIN platform_products pp ON pp.id = psp.platform_product_id
       WHERE psp.shop_id = ${shopId} AND psp.status = 'listed'
       ORDER BY pp.display_sort DESC, psp.id ASC
    `;
    return rows.map((row) => ({
      id: row.id,
      shopId: row.shop_id,
      productType: "platform_self_operated",
      salePriceCents: row.sale_price_cents,
      status: row.status,
      product: {
        id: row.platform_product_id,
        name: row.name,
        category: row.category_name ?? undefined,
        tags: Array.isArray(row.tags_json) ? row.tags_json : undefined,
        subtitle: row.rights_desc ?? undefined,
        description: row.detail ?? undefined,
        imageUrl: row.image_url ?? undefined,
        specs: Array.isArray(row.specs_json) ? row.specs_json : undefined,
        detailSections: Array.isArray(row.detail_sections_json) ? row.detail_sections_json : undefined,
        stockCount: row.public_stock_count ?? row.stock_count ?? undefined,
        soldCount: row.sold_count ?? undefined,
        displayBadge: row.display_badge ?? undefined,
        isRecommended: row.is_recommended ?? undefined,
        displaySort: row.display_sort ?? undefined,
        fulfillmentRule: row.fulfillment_rule_json,
        afterSaleRule: row.after_sale_rule_json,
        status: row.product_status ?? undefined
      }
    }));
  }

  private async findPublicShop(shopIdentifier: string): Promise<DemoShop | undefined> {
    const normalized = normalizeShopIdentifier(shopIdentifier);
    const configured = process.env.DEFAULT_PLATFORM_SHOP_ID || process.env.VITE_PLATFORM_SHOP_ID;
    if (!normalized || ["default", "platform", "home"].includes(normalized)) {
      if (configured) {
        const configuredShop = await this.findPublicShop(configured);
        if (configuredShop) return configuredShop;
      }
      const rows = await this.prisma.$queryRaw<Array<PublicShopRow>>`
        SELECT id, owner_type, merchant_id, shop_no, name, share_path, status,
               risk_status, announcement, customer_service_wechat, customer_service_qr_url,
               customer_service_qq, customer_service_qq_qr_url, customer_service_note,
               collection_account_name, collection_qr_url, collection_note,
               theme_color, banner_url, share_title
          FROM shops
         WHERE status = 'open'
         ORDER BY CASE WHEN owner_type = 'platform' THEN 0 ELSE 1 END, created_at ASC
         LIMIT 1
      `;
      return rows[0] ? this.mapPublicShopRow(rows[0]) : undefined;
    }
    const rows = await this.prisma.$queryRaw<Array<PublicShopRow>>`
      SELECT id, owner_type, merchant_id, shop_no, name, share_path, status,
             risk_status, announcement, customer_service_wechat, customer_service_qr_url,
             customer_service_qq, customer_service_qq_qr_url, customer_service_note,
             collection_account_name, collection_qr_url, collection_note,
             theme_color, banner_url, share_title
        FROM shops
       WHERE id = ${normalized}
          OR shop_no = ${normalized}
          OR share_path = ${normalized}
          OR share_path = ${`/s/${normalized}`}
          OR share_path = ${`/shops/${normalized}`}
       LIMIT 1
    `;
    return rows[0] ? this.mapPublicShopRow(rows[0]) : undefined;
  }

  private mapPublicShopRow(row: PublicShopRow): DemoShop {
    return {
      id: row.id,
      ownerType: row.owner_type === "merchant" ? "merchant" : "platform",
      merchantId: row.merchant_id ?? undefined,
      shopNo: row.shop_no,
      sharePath: row.share_path,
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
    };
  }

  private serializePublicShopRow(shop: DemoShop) {
    return {
      id: shop.id,
      merchantId: shop.merchantId,
      ownerType: shop.ownerType ?? "merchant",
      shopNo: shop.shopNo,
      sharePath: shop.sharePath,
      publicPath: publicShopPath(shop),
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

  async load(): Promise<MemoryStore> {
    const store = createEmptyMemoryStore();
    await Promise.all([
      this.loadMerchantsAndDeposits(store),
      this.loadShops(store),
      this.loadPlatformProducts(store),
      this.loadOwnProductReviews(store)
    ]);
    await Promise.all([
      this.loadMerchantProducts(store),
      this.loadRightsCodes(store),
      this.loadOrders(store)
    ]);
    await Promise.all([
      this.loadCoupons(store),
      this.loadInviteAndChannelState(store),
      this.loadFinancialState(store),
      this.loadEmailDeliveries(store)
    ]);
    await Promise.all([
      this.loadWalletState(store),
      this.loadServiceFeeConfig(store),
      this.loadPaymentConfig(store),
      this.loadPaymentMethodConfigs(store),
      this.loadPaymentRuntimeState(store)
    ]);
    return store;
  }

  async repairRuntimeSchema(): Promise<void> {
    await this.ensureCollectionPaymentConfigRuntimeSchema();
    await this.ensureMerchantProductRuntimeSchema();
  }

  async save(_store: MemoryStore): Promise<void> {
    await this.persistInShortTransaction((tx) => this.persistUsers(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistMerchants(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistMerchantAccounts(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistShops(tx, _store));
    await this.persistInShortTransaction((tx) => this.persistProducts(tx, _store));
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
	    if (method === "createMerchantByAdmin" || method === "createMerchantByAdmin") {
	      await this.persistInShortTransaction((tx) => this.persistLatestManualMerchantCreation(tx, store));
	      return;
	    }
    if (method === "createPlatformInviteCode" || method === "createMerchantInviteCode" || method === "createMerchantInviteCode") {
      await this.persistInShortTransaction((tx) => this.persistLatestInviteCodeCreation(tx, store));
      return;
    }
	    if (method === "registerMerchantByInvite" || method === "registerMerchantByInvite") {
	      await this.persistInShortTransaction((tx) => this.persistLatestInviteRegistration(tx, store));
	      return;
	    }
    if (method === "reviewMerchant" || method === "reviewMerchant") {
      await this.persistInShortTransaction((tx) => this.persistLatestMerchantReview(tx, store));
      return;
    }
	    if ([
	      "submitMerchantApplication",
        "submitMerchantApplication"
	    ].includes(method)) {
      await this.persistInShortTransaction((tx) => this.persistUsers(tx, store));
      await this.persistInShortTransaction((tx) => this.persistMerchants(tx, store));
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
      await this.persistInShortTransaction((tx) => this.persistMerchants(tx, store));
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
    if (method === "addMerchantRightsCodes" || method === "addMerchantRightsCodes") {
      await this.persistInShortTransaction((tx) => this.persistLatestMerchantRightsCodeImport(tx, store));
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
    if (method === "upsertChannelProductOffer" || method === "upsertMerchantChannelProductOffer" || method === "upsertMerchantChannelProductOffer") {
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
    if (method === "setMerchantProductPrice" || method === "setMerchantProductPrice") {
      await this.persistInShortTransaction((tx) => this.persistLatestMerchantProductPriceUpdate(tx, store));
      return;
    }
    if (method === "updateMerchantProductDetail" || method === "updateMerchantProductDetail") {
      await this.persistInShortTransaction((tx) => this.persistLatestMerchantProductDetailUpdate(tx, store));
      return;
    }
    if ([
      "updateMerchantShop",
      "updateMerchantShop",
      "updateMerchantShopCollection",
      "updateMerchantShopCollection",
      "updateShopDecor",
      "updateShopCollection",
      "updateShopServiceQrCode"
    ].includes(method)) {
      await this.persistInShortTransaction((tx) => this.persistShops(tx, store));
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
    if (method === "grantCouponTemplate") {
      await this.persistInShortTransaction((tx) => this.persistLatestAdminCouponGrant(tx, store));
      return;
    }
    if (method === "createOrder") {
      await this.persistInShortTransaction((tx) => this.persistLatestOrderCreation(tx, store));
      return;
    }
    if (method === "confirmMerchantOfflinePayment" || method === "confirmMerchantOfflinePayment" || method === "confirmOfflinePayment") {
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
    if (method === "createWalletRecharge" || method === "confirmWalletRecharge") {
      await this.persistInShortTransaction((tx) => this.persistLatestWalletRechargeMutation(tx, store));
      return;
    }
    if (method === "updatePlatformServiceFeeConfig") {
      await this.persistInShortTransaction((tx) => this.persistServiceFeeConfig(tx, store.serviceFeeConfig));
      return;
    }
    if (method === "fulfillMerchantOrder" || method === "fulfillMerchantOrder") {
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
    if (method === "updateMerchantAfterSaleAssist" || method === "updateMerchantAfterSaleAssist") {
      await this.persistInShortTransaction((tx) => {
        const audit = this.latestAuditLog(store, ["after_sale.merchant_assist"]);
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
      "upsertMerchantPaymentMethod",
      "setMerchantPaymentMethodDefault",
      "deleteMerchantPaymentMethod",
      "testMerchantPaymentMethod",
      "upsertMerchantPaymentMethod",
      "setMerchantPaymentMethodDefault",
      "deleteMerchantPaymentMethod",
      "testMerchantPaymentMethod"
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
    for (const merchant of store.merchants.values()) userIds.add(merchant.userId);
    for (const application of store.merchantApplications.values()) userIds.add(application.userId);
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
    for (const merchant of store.merchants.values()) {
      if (merchant.initialPasswordSet && merchant.passwordHash) {
        await this.persistMerchantAccountForMerchant(tx, merchant);
      }
    }
  }

  private async persistLatestManualMerchantCreation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["merchant.admin_create_first_tier"]);
    const merchantId = audit ? stringValue(audit.targetId) : undefined;
    const merchant = merchantId ? store.merchants.get(merchantId) : undefined;
    if (!merchant) throw new Error("manual merchant creation missing current merchant");
    const shop = [...store.shops.values()].find((item) => item.merchantId === merchant.id);
    if (!shop) throw new Error("manual merchant creation missing current shop");
    const depositAccount = store.depositAccounts.get(merchant.id);
    if (!depositAccount) throw new Error("manual merchant creation missing deposit account");
    const depositTransaction = [...store.depositTransactions]
      .reverse()
      .find((item) => item.merchantId === merchant.id && item.reasonCode === "admin_manual_create");

    await this.persistUserId(tx, merchant.userId);
    if (merchant.createdByAdminId) await this.persistAdminPlaceholder(tx, merchant.createdByAdminId);
    if (shop.createdByAdminId && shop.createdByAdminId !== merchant.createdByAdminId) await this.persistAdminPlaceholder(tx, shop.createdByAdminId);
    await this.persistMerchant(tx, merchant);
    await this.persistMerchantAccountForMerchant(tx, merchant);
    await this.persistShop(tx, shop);
    await this.persistDepositAccount(tx, merchant.id, depositAccount);
    if (depositTransaction) await this.persistDepositTransaction(tx, depositTransaction);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistAdminPlaceholder(tx: PrismaTx, adminId: string) {
    await tx.$executeRaw`
      INSERT INTO admin_users (id, username, display_name, password_hash, status, created_at, updated_at)
      VALUES (
        ${adminId}, ${adminId}, 'Bootstrap Admin', 'sha256:bootstrap-placeholder',
        CAST('active' AS "UserStatus"), now(), now()
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }

	  private async persistUserId(tx: PrismaTx, userId: string) {
	    await tx.$executeRaw`
	      INSERT INTO users (id, status, created_at, updated_at)
	      VALUES (${userId}, 'active', now(), now())
	      ON CONFLICT (id) DO UPDATE SET updated_at = now()
	    `;
	  }

  private async persistLatestInviteCodeCreation(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["invite_code.create.platform", "invite_code.create.merchant"]);
    const inviteId = audit ? stringValue(audit.targetId) : undefined;
    const invite = inviteId ? store.inviteCodes.get(inviteId) : undefined;
    if (!invite) throw new Error("invite code creation missing current invite");
    await this.persistInviteCode(tx, invite);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestInviteRegistration(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["merchant.register_by_invite"]);
    const merchantId = audit ? stringValue(audit.targetId) : undefined;
    const merchant = merchantId ? store.merchants.get(merchantId) : undefined;
    if (!merchant) throw new Error("invite registration missing current merchant");
    const shop = [...store.shops.values()].find((item) => item.merchantId === merchant.id);
    if (!shop) throw new Error("invite registration missing current shop");
    const application = [...store.merchantApplications.values()].find((item) => item.merchantId === merchant.id);
    if (!application) throw new Error("invite registration missing current application");
    const depositAccount = store.depositAccounts.get(merchant.id);
    if (!depositAccount) throw new Error("invite registration missing deposit account");
    const inviteId = stringValue((audit?.after as Record<string, unknown> | undefined)?.inviteCodeId) ?? application.inviteCodeId;
    const invite = inviteId ? store.inviteCodes.get(inviteId) : undefined;
    if (!invite) throw new Error("invite registration missing invite code");
    const relation = store.channelRelations.find((item) =>
      item.reason === "invite_registration"
      && (item.secondTierMerchantId === merchant.id || item.thirdTierMerchantId === merchant.id)
    );

    await this.persistUserId(tx, merchant.userId);
    await this.persistMerchant(tx, merchant);
    await this.persistMerchantAccountForMerchant(tx, merchant);
    await this.persistShop(tx, shop);
    await this.persistMerchantApplication(tx, application);
    await this.persistInviteCode(tx, invite);
    if (relation) await this.persistChannelRelation(tx, relation);
    await this.persistDepositAccount(tx, merchant.id, depositAccount);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestMerchantReview(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["merchant.review"]);
    const merchantId = audit ? stringValue(audit.targetId) : undefined;
    const merchant = merchantId ? store.merchants.get(merchantId) : undefined;
    if (!merchant) throw new Error("merchant review missing current merchant");
    const shop = [...store.shops.values()].find((item) => item.merchantId === merchant.id);
    const application = [...store.merchantApplications.values()].find((item) => item.merchantId === merchant.id);
    const depositAccount = store.depositAccounts.get(merchant.id);
    const relations = store.channelRelations.filter((item) =>
      item.secondTierMerchantId === merchant.id || item.thirdTierMerchantId === merchant.id
    );

    await this.persistUserId(tx, merchant.userId);
    await this.persistMerchant(tx, merchant);
    await this.persistMerchantAccountForMerchant(tx, merchant);
    if (shop) await this.persistShop(tx, shop);
    if (application) await this.persistMerchantApplication(tx, application);
    if (depositAccount) await this.persistDepositAccount(tx, merchant.id, depositAccount);
    for (const relation of relations) await this.persistChannelRelation(tx, relation);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestChannelAuthorizationReview(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["channel.authorization.review"]);
    const merchantId = audit ? stringValue(audit.targetId) : undefined;
    const authorization = merchantId
      ? store.channelAuthorizations.find((item) => item.firstTierMerchantId === merchantId)
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

			  private async persistMerchantAccountForMerchant(tx: PrismaTx, merchant: DemoMerchant) {
    if (!merchant.initialPasswordSet || !merchant.passwordHash) return;
    const username = merchant.merchantUsername ?? merchant.id;
    await tx.$executeRaw`
      INSERT INTO merchant_accounts (
        id, user_id, merchant_id, username, phone, password_hash, role, status,
        initial_delivery_status, initial_delivered_at, must_change_password,
        created_by_admin_id, created_at, updated_at
      )
      VALUES (
        ${stableDbId("merchant_account", merchant.id)}, ${merchant.userId}, ${merchant.id},
        ${username}, ${merchant.contactPhone ?? null}, ${merchant.passwordHash},
        CAST('owner' AS "MerchantAccountRole"), CAST('active' AS "MerchantAccountStatus"),
        CAST('delivered' AS "InitialAccountDeliveryStatus"), now(), true,
        NULL, now(), now()
      )
      ON CONFLICT (username) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        merchant_id = EXCLUDED.merchant_id,
        phone = EXCLUDED.phone,
        password_hash = EXCLUDED.password_hash,
        status = EXCLUDED.status,
        initial_delivery_status = EXCLUDED.initial_delivery_status,
        initial_delivered_at = COALESCE(merchant_accounts.initial_delivered_at, EXCLUDED.initial_delivered_at),
        updated_at = now()
    `;
  }

	  private async persistMerchant(tx: PrismaTx, merchant: DemoMerchant) {
      await this.persistMerchantForMerchant(tx, merchant);
		  }

  private async persistMerchantForMerchant(tx: PrismaTx, merchant: DemoMerchant) {
    await tx.$executeRaw`
      INSERT INTO merchants (
        id, merchant_no, tier, name, contact_phone, status, risk_status,
        deposit_status, creation_source, created_by_admin_id,
        initial_account_status, approved_at, created_at, updated_at
      )
      VALUES (
        ${merchant.id}, ${merchant.id}, CAST(${merchant.tier ?? "first_tier"} AS "MerchantTier"),
        ${merchant.name}, ${merchant.contactPhone ?? null},
	        CAST(${mapMerchantStatus(merchant.status)} AS "MerchantStatus"),
        CAST(${mapRiskStatus(merchant.riskStatus)} AS "RiskStatus"),
        CAST(${mapDepositStatus(merchant.depositStatus)} AS "DepositStatus"),
        CAST(${merchant.createdByAdminId ? "admin_manual" : "invite_application"} AS "MerchantCreationSource"),
        ${merchant.createdByAdminId ?? null},
        CAST(${merchant.initialPasswordSet ? "delivered" : "pending"} AS "InitialAccountDeliveryStatus"),
        ${merchant.status === "active" ? new Date() : null}, now(), now()
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

  private async persistMerchantApplication(tx: PrismaTx, application: MerchantApplication) {
    await tx.$executeRaw`
      INSERT INTO merchant_applications (
        id, merchant_id, user_id, invite_code_id, tier, identity_info_json, contact_info_json,
        customer_service_wechat, status, reject_reason, reviewed_by,
        reviewed_at, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${application.applicationNo}, ${application.merchantId}, ${application.userId}, ${application.inviteCodeId ?? null},
        CAST(${application.targetTier ?? "first_tier"} AS "MerchantTier"),
        ${jsonForDb({ inviteCodeId: application.inviteCodeId, targetTier: application.targetTier, parentMerchantId: application.parentMerchantId })}::jsonb,
        ${jsonForDb({ phone: application.contactPhone, inviteCode: application.inviteCode })}::jsonb,
        ${application.customerServiceWechat},
        CAST(${mapReviewStatus(application.status)} AS "ReviewStatus"),
        NULL, NULL, NULL, ${`merchant-application:${application.applicationNo}`}, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        tier = EXCLUDED.tier,
        contact_info_json = EXCLUDED.contact_info_json,
        customer_service_wechat = EXCLUDED.customer_service_wechat,
        updated_at = now()
    `;
  }

	  private async persistShop(tx: PrismaTx, shop: DemoShop) {
    const ownerType = shop.ownerType === "platform" ? "platform" : "merchant";
    await tx.$executeRaw`
      INSERT INTO shops (
        id, owner_type, merchant_id, shop_no, name, announcement,
        customer_service_wechat, customer_service_qr_url, customer_service_qq,
        customer_service_qq_qr_url, customer_service_note, collection_account_name, collection_qr_url,
        collection_note, theme_color, banner_url, share_title, share_path,
        status, risk_status, creation_source, created_by_admin_id, created_at, updated_at
      )
      VALUES (
        ${shop.id}, CAST(${ownerType} AS "ShopOwnerType"),
        ${ownerType === "merchant" ? shop.merchantId ?? null : null},
        ${shop.id}, ${shop.name}, ${shop.announcement ?? null},
        ${shop.customerServiceWechat ?? null}, ${shop.customerServiceQrUrl ?? null},
        ${shop.customerServiceQq ?? null}, ${shop.customerServiceQqQrUrl ?? null},
        ${shop.customerServiceNote ?? null}, ${shop.collectionAccountName ?? null},
        ${shop.collectionQrUrl ?? null}, ${shop.collectionNote ?? null},
        ${shop.themeColor ?? null}, ${shop.bannerUrl ?? null}, ${shop.shareTitle ?? null},
        ${`/shops/${shop.id}`}, CAST(${mapShopStatus(shop.status)} AS "ShopStatus"),
        CAST(${mapRiskStatus(shop.riskStatus)} AS "RiskStatus"),
        CAST(${shop.createdByAdminId ? "admin_manual" : shop.merchantId ? "self_application" : "migration"} AS "MerchantCreationSource"),
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

  private async persistDepositAccount(tx: PrismaTx, merchantId: string, account: {
    requiredAmountCents: bigint;
    availableAmountCents: bigint;
    frozenAmountCents: bigint;
    deductedAmountCents: bigint;
    status: string;
  }) {
    await tx.$executeRaw`
      INSERT INTO deposit_accounts (
        id, merchant_id, required_amount_cents, available_amount_cents,
        frozen_amount_cents, deducted_amount_cents, status, created_at, updated_at
      )
      VALUES (
        ${stableDbId("deposit_account", merchantId)}, ${merchantId},
        ${account.requiredAmountCents}, ${account.availableAmountCents},
        ${account.frozenAmountCents}, ${account.deductedAmountCents},
        CAST(${mapDepositStatus(account.status)} AS "DepositStatus"), now(), now()
      )
      ON CONFLICT (merchant_id) DO UPDATE SET
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
        id, merchant_id, account_id, type, amount_cents,
        balance_before_cents, balance_after_cents, reason_code, related_type,
        related_id, voucher_url, note, idempotency_key, operator_id, created_at
      )
      VALUES (
        ${stableDbId("deposit_tx", txItem.idempotencyKey)}, ${txItem.merchantId},
        (SELECT id FROM deposit_accounts WHERE merchant_id = ${txItem.merchantId} LIMIT 1),
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
    const merchantId = audit ? stringValue(audit.targetId) : undefined;
    const merchant = merchantId ? store.merchants.get(merchantId) : undefined;
    if (!merchant) throw new Error("deposit confirmation missing current merchant");
    const shop = [...store.shops.values()].find((item) => item.merchantId === merchant.id);
    const account = store.depositAccounts.get(merchant.id);
    if (!account) throw new Error("deposit confirmation missing deposit account");
    const transaction = [...store.depositTransactions]
      .reverse()
      .find((item) => item.merchantId === merchant.id && item.reasonCode === "manual_confirm");
    const ledger = [...store.ledgerEntries]
      .reverse()
      .find((item) => item.merchantId === merchant.id && item.entryType === "DEPOSIT_CONFIRMED");
    const relations = store.channelRelations.filter((item) =>
      item.secondTierMerchantId === merchant.id || item.thirdTierMerchantId === merchant.id
    );

    await this.persistMerchant(tx, merchant);
    if (shop) await this.persistShop(tx, shop);
    await this.persistDepositAccount(tx, merchant.id, account);
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

  private async persistLatestMerchantRightsCodeImport(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["rights_code.merchant_import"]);
    const merchantProductListingId = audit ? stringValue(audit.targetId) : undefined;
    const merchantProductListing = merchantProductListingId ? store.merchantProductListings.get(merchantProductListingId) : undefined;
    if (!merchantProductListing) throw new Error("merchant rights code import missing current product");
    const auditAfter = isRecord(audit?.after) ? audit.after : {};
    const importedCodeIds = Array.isArray(auditAfter.codeIds)
      ? auditAfter.codeIds.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const batchNo = stringValue(auditAfter.batchNo);
    const importedAt = dateValue(audit?.createdAt) ?? new Date(0);
    const codes = store.rightsCodes.filter((code) =>
      (code.merchantProductListingId ?? code.productId) === merchantProductListing.id
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
    await this.persistMerchantProductWithDependencies(tx, store, merchantProductListing);
    for (const code of codes) await this.persistAvailableRightsCode(tx, code, store);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestPlatformProductSelection(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["merchant_product_listing.select_platform"]);
    const merchantProductListingId = audit ? stringValue(audit.targetId) : undefined;
    const merchantProductListing = merchantProductListingId ? store.merchantProductListings.get(merchantProductListingId) : undefined;
    if (!merchantProductListing || merchantProductListing.productType !== "platform" || !merchantProductListing.platformProductId) {
      throw new Error("platform product selection missing current merchant product");
    }
    await this.persistMerchantProductWithDependencies(tx, store, merchantProductListing);
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
    const merchant = store.merchants.get(ownProduct.merchantId);
    const shop = store.shops.get(ownProduct.shopId);
    if (!merchant) throw new Error("own product submission missing current merchant");
    if (!shop) throw new Error("own product submission missing current shop");
    await this.persistMerchant(tx, merchant);
    await this.persistMerchantAccountForMerchant(tx, merchant);
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
    const merchantProductListing = [...store.merchantProductListings.values()]
      .find((product) => product.ownProductReviewId === ownProduct.id);
    if (merchantProductListing) await this.persistMerchantProductWithDependencies(tx, store, merchantProductListing);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestOwnProductUpdate(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["own_product.update"]);
    const ownProductId = audit ? stringValue(audit.targetId) : undefined;
    const ownProduct = ownProductId ? store.ownProducts.get(ownProductId) : undefined;
    if (!ownProduct) throw new Error("own product update missing current product");
    await this.persistOwnProductReview(tx, ownProduct);
    const merchantProductListing = [...store.merchantProductListings.values()].find((product) => product.ownProductReviewId === ownProduct.id);
    if (merchantProductListing) await this.persistMerchantProductWithDependencies(tx, store, merchantProductListing);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestPlatformProductBatchSelection(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["merchant_product_listing.batch_select_platform"]);
    const shopId = audit ? stringValue(audit.targetId) : undefined;
    if (!shopId) throw new Error("platform product batch selection missing current shop");
    const products = [...store.merchantProductListings.values()]
      .filter((product) => product.shopId === shopId && product.productType === "platform");
    for (const product of products) await this.persistMerchantProductWithDependencies(tx, store, product);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestMerchantProductPriceUpdate(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["merchant_product_listing.price_update"]);
    const merchantProductListingId = audit ? stringValue(audit.targetId) : undefined;
    const merchantProductListing = merchantProductListingId ? store.merchantProductListings.get(merchantProductListingId) : undefined;
    if (!merchantProductListing) throw new Error("merchant product price update missing current product");
    await this.persistMerchantProductWithDependencies(tx, store, merchantProductListing);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestMerchantProductDetailUpdate(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["merchant_product_listing.detail_update", "merchant_product_listing.price_update"]);
    const merchantProductListingId = audit ? stringValue(audit.targetId) : undefined;
    const merchantProductListing = merchantProductListingId ? store.merchantProductListings.get(merchantProductListingId) : undefined;
    if (!merchantProductListing) throw new Error("merchant product detail update missing current product");
    await this.persistMerchantProductWithDependencies(tx, store, merchantProductListing);
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

  private async persistLatestAdminCouponGrant(tx: PrismaTx, store: MemoryStore) {
    const audit = this.latestAuditLog(store, ["coupon.grant.admin"]);
    if (!audit) return;
    const templateId = stringValue(audit.targetId);
    const template = templateId ? store.couponTemplates.get(templateId) : undefined;
    if (!template) throw new Error("admin coupon grant missing coupon template");
    const after = isRecord(audit.after) ? audit.after : {};
    const couponIds = Array.isArray(after.couponIds)
      ? after.couponIds.map((item) => stringValue(item)).filter((item): item is string => Boolean(item))
      : [];
    for (const couponId of couponIds) {
      const coupon = store.userCoupons.get(couponId);
      if (!coupon) continue;
      await this.persistUserId(tx, coupon.userId);
      await this.persistUserCoupon(tx, coupon, template);
    }
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
    if (order.salesChannelType !== "platform_self_operated" && order.merchantId !== PLATFORM_MERCHANT_ID) {
      const merchant = store.merchants.get(order.merchantId);
      if (!merchant) throw new Error("order creation missing current merchant");
      await this.persistMerchant(tx, merchant);
    }
    await this.persistShop(tx, shop);

    if (order.salesChannelType === "platform_self_operated") {
      const platformShopProduct = store.platformShopProducts.get(order.merchantProductListingId);
      if (platformShopProduct) {
        const product = store.platformProducts.get(platformShopProduct.platformProductId);
        if (!product) throw new Error("order creation missing current platform product");
        await this.persistPlatformProduct(tx, product);
        await this.persistPlatformShopProduct(tx, platformShopProduct);
      }
    } else {
      const merchantProductListing = store.merchantProductListings.get(order.merchantProductListingId);
      if (!merchantProductListing) throw new Error("order creation missing current merchant product");
      const product = merchantProductListing.platformProductId ? store.platformProducts.get(merchantProductListing.platformProductId) : undefined;
      if (product) await this.persistPlatformProduct(tx, product);
      await this.persistMerchantProduct(tx, merchantProductListing);
    }

    if (order.couponId) {
      const coupon = store.userCoupons.get(order.couponId);
      if (!coupon) throw new Error("order creation missing current user coupon");
      await this.persistUserCoupon(tx, coupon, store.couponTemplates.get(coupon.templateId));
    }
    await this.persistOrder(tx, order);
    await this.persistLockedRightsCodesForOrder(tx, store, order);
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
    const audit = this.latestAuditLog(store, ["payment.manual.create", "payment.order.create", "wallet.payment.capture"]);
    const orderNo = audit ? stringValue(audit.targetId) : undefined;
    const order = orderNo ? store.orders.get(orderNo) : undefined;
    if (!order) throw new Error("payment order persistence missing current order");
    await this.persistOrder(tx, order);
    const method = this.paymentMethodForOrder(store, order);
    if (method) await this.persistPaymentMethodConfig(tx, method);
    await this.persistPaymentSnapshotForOrder(tx, store, order);
    if (order.paymentSnapshot?.provider === "balance") await this.persistWalletState(tx, store);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistLatestWalletRechargeMutation(tx: PrismaTx, store: MemoryStore) {
    await this.persistWalletState(tx, store);
    const audit = this.latestAuditLog(store, ["wallet.recharge.create", "wallet.recharge.confirm", "wallet.payment.capture"]);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistServiceFeeConfig(tx: PrismaTx, config: PlatformServiceFeeConfig) {
    await tx.$executeRaw`
      INSERT INTO platform_service_fee_configs (
        id, enabled, fee_bps, basis_type, effective_from, effective_to, status,
        created_by, updated_by, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${config.id}, ${config.enabled}, ${config.feeBps}, ${config.basisType},
        now(), NULL, ${config.status}, ${config.updatedBy ?? null}, ${config.updatedBy ?? null},
        'platform-service-fee-active', now(), ${config.updatedAt}
      )
      ON CONFLICT (idempotency_key) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        fee_bps = EXCLUDED.fee_bps,
        basis_type = EXCLUDED.basis_type,
        status = EXCLUDED.status,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `;
  }

  private async persistWalletState(tx: PrismaTx, store: MemoryStore) {
    for (const wallet of store.userWallets.values()) {
      await tx.$executeRaw`
        INSERT INTO users (id, status, created_at, updated_at)
        VALUES (${wallet.userId}, CAST('active' AS "UserStatus"), now(), now())
        ON CONFLICT (id) DO NOTHING
      `;
      await tx.$executeRaw`
        INSERT INTO user_wallets (
          id, user_id, wallet_no, available_balance_cents, frozen_balance_cents,
          total_recharge_cents, total_spend_cents, status, version, created_at, updated_at
        )
        VALUES (
          ${wallet.id}, ${wallet.userId}, ${wallet.walletNo}, ${wallet.availableBalanceCents},
          ${wallet.frozenBalanceCents}, ${wallet.totalRechargeCents}, ${wallet.totalSpendCents},
          CAST(${wallet.status} AS "WalletStatus"), ${wallet.version}, ${wallet.createdAt}, ${wallet.updatedAt}
        )
        ON CONFLICT (user_id) DO UPDATE SET
          wallet_no = EXCLUDED.wallet_no,
          available_balance_cents = EXCLUDED.available_balance_cents,
          frozen_balance_cents = EXCLUDED.frozen_balance_cents,
          total_recharge_cents = EXCLUDED.total_recharge_cents,
          total_spend_cents = EXCLUDED.total_spend_cents,
          status = EXCLUDED.status,
          version = EXCLUDED.version,
          updated_at = now()
      `;
    }

    for (const recharge of store.walletRecharges.values()) {
      await tx.$executeRaw`
        INSERT INTO wallet_recharge_orders (
          id, recharge_no, user_id, wallet_id, provider, confirm_mode,
          recharge_cents, fee_bps, fee_cents, payable_cents, status, paid_at,
          idempotency_key, created_at, updated_at
        )
        VALUES (
          ${stableDbId("wallet_recharge", recharge.rechargeNo)}, ${recharge.rechargeNo},
          ${recharge.userId}, ${recharge.walletId}, CAST(${mapPaymentProviderToDb(recharge.provider)} AS "PaymentProvider"),
          CAST(${mapPaymentConfirmModeToDb(recharge.confirmationMode)} AS "PaymentConfirmMode"),
          ${recharge.rechargeCents}, ${recharge.feeBps}, ${recharge.feeCents}, ${recharge.payableCents},
          CAST(${recharge.status} AS "WalletRechargeStatus"), ${recharge.paidAt ?? null}, ${recharge.idempotencyKey},
          ${recharge.createdAt}, ${recharge.updatedAt}
        )
        ON CONFLICT (recharge_no) DO UPDATE SET
          status = EXCLUDED.status,
          paid_at = EXCLUDED.paid_at,
          fee_bps = EXCLUDED.fee_bps,
          fee_cents = EXCLUDED.fee_cents,
          payable_cents = EXCLUDED.payable_cents,
          updated_at = now()
      `;
    }

    for (const hold of store.walletHolds.values()) {
      await tx.$executeRaw`
        INSERT INTO wallet_payment_holds (
          id, hold_no, user_id, wallet_id, order_id, payment_id, amount_cents,
          status, expires_at, captured_at, released_at, idempotency_key, created_at, updated_at
        )
        VALUES (
          ${stableDbId("wallet_hold", hold.holdNo)}, ${hold.holdNo}, ${hold.userId}, ${hold.walletId},
          ${stableDbId("order", hold.orderNo)}, NULL,
          ${hold.amountCents}, CAST(${hold.status} AS "WalletHoldStatus"), NULL, ${hold.capturedAt ?? null}, NULL,
          ${hold.idempotencyKey}, now(), now()
        )
        ON CONFLICT (hold_no) DO UPDATE SET
          payment_id = EXCLUDED.payment_id,
          amount_cents = EXCLUDED.amount_cents,
          status = EXCLUDED.status,
          captured_at = EXCLUDED.captured_at,
          updated_at = now()
      `;
    }

    for (const transaction of store.walletTransactions) {
      await tx.$executeRaw`
        INSERT INTO wallet_transactions (
          id, transaction_no, user_id, wallet_id, type, direction, amount_cents,
          balance_before_cents, balance_after_cents, frozen_before_cents, frozen_after_cents,
          order_id, payment_id, recharge_order_id, hold_id, source_type, source_id, note,
          idempotency_key, created_at
        )
        VALUES (
          ${stableDbId("wallet_tx", transaction.transactionNo)}, ${transaction.transactionNo},
          ${transaction.userId}, ${transaction.walletId}, CAST(${transaction.type} AS "WalletTransactionType"),
          CAST(${transaction.direction} AS "LedgerDirection"), ${transaction.amountCents},
          ${transaction.balanceBeforeCents}, ${transaction.balanceAfterCents},
          ${transaction.frozenBeforeCents}, ${transaction.frozenAfterCents},
          ${transaction.orderNo ? stableDbId("order", transaction.orderNo) : null},
          NULL,
          ${transaction.rechargeNo ? stableDbId("wallet_recharge", transaction.rechargeNo) : null},
          ${transaction.holdNo ? stableDbId("wallet_hold", transaction.holdNo) : null},
          ${transaction.sourceType}, ${transaction.sourceId}, ${transaction.note ?? null},
          ${transaction.idempotencyKey}, ${transaction.createdAt}
        )
        ON CONFLICT (transaction_no) DO NOTHING
      `;
    }
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
    if (order.paymentSnapshot?.paymentMethodId === "balance") {
      return {
        id: "balance",
        ownerType: "platform",
        provider: "balance",
        confirmationMode: "automatic",
        displayName: "余额支付",
        enabled: true,
        status: "enabled",
        isDefault: false,
        secretConfigured: true,
        createdAt: new Date(0),
        updatedAt: new Date(0)
      } satisfies PaymentMethodConfig;
    }
    const paymentMethodId = order.paymentSnapshot?.paymentMethodId;
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
      .find((item) => item.entryType === "SETTLEMENT_GENERATED" && item.merchantId === sheet.merchantId);
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
      .find((item) => item.entryType === "PAYOUT_CONFIRMED" && item.merchantId === sheet.merchantId);
    await this.persistLedgerEntries(tx, ledger ? [ledger] : []);
    await this.persistAuditLogs(tx, audit ? [audit] : []);
  }

  private async persistMerchants(tx: PrismaTx, store: MemoryStore) {
    for (const merchant of store.merchants.values()) {
      await this.persistMerchantForMerchant(tx, merchant);
      await this.persistMerchantAccountForMerchant(tx, merchant);
    }

	    for (const application of store.merchantApplications.values()) {
      await this.persistMerchantApplication(tx, application);
	    }
	  }

  private async persistShops(tx: PrismaTx, store: MemoryStore) {
    for (const shop of store.shops.values()) {
      await tx.$executeRaw`
          INSERT INTO shops (
	          id, owner_type, merchant_id, shop_no, name, announcement,
          customer_service_wechat, customer_service_qr_url, customer_service_qq,
          customer_service_qq_qr_url, customer_service_note, collection_account_name, collection_qr_url,
          collection_note, theme_color, banner_url, share_title, share_path,
          status, risk_status, creation_source, created_by_admin_id, created_at, updated_at
        )
        VALUES (
	          ${shop.id}, CAST(${shop.ownerType === "platform" ? "platform" : "merchant"} AS "ShopOwnerType"),
	          ${shop.ownerType === "platform" ? null : shop.merchantId ?? null},
          ${shop.shopNo ?? shop.id}, ${shop.name}, ${shop.announcement ?? null},
          ${shop.customerServiceWechat ?? null}, ${shop.customerServiceQrUrl ?? null},
          ${shop.customerServiceQq ?? null}, ${shop.customerServiceQqQrUrl ?? null},
          ${shop.customerServiceNote ?? null}, ${shop.collectionAccountName ?? null},
          ${shop.collectionQrUrl ?? null}, ${shop.collectionNote ?? null},
          ${shop.themeColor ?? null}, ${shop.bannerUrl ?? null}, ${shop.shareTitle ?? null},
          ${shop.sharePath ?? publicShopPath(shop)}, CAST(${mapShopStatus(shop.status)} AS "ShopStatus"),
          CAST(${mapRiskStatus(shop.riskStatus)} AS "RiskStatus"),
          CAST(${shop.merchantId ? "self_application" : "migration"} AS "MerchantCreationSource"),
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
          INSERT INTO shop_product_groups (id, shop_id, name, sort_order, product_listing_ids, created_at, updated_at)
          VALUES (${stableDbId("shop_group", `${shop.id}:${group.name}:${index}`)}, ${shop.id}, ${group.name}, ${index + 1},
                  ${jsonForDb(group.merchantProductListingIds)}::jsonb, now(), now())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            sort_order = EXCLUDED.sort_order,
            product_listing_ids = EXCLUDED.product_listing_ids,
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

    for (const product of store.merchantProductListings.values()) {
      await this.persistMerchantProduct(tx, product);
    }
  }

  private async persistMerchantProductWithDependencies(tx: PrismaTx, store: MemoryStore, product: DemoMerchantProductListing) {
    const merchant = store.merchants.get(product.merchantId);
    const shop = store.shops.get(product.shopId);
    if (!merchant) throw new Error("merchant product persistence missing current merchant");
    if (!shop) throw new Error("merchant product persistence missing current shop");
    await this.persistMerchant(tx, merchant);
    await this.persistMerchantAccountForMerchant(tx, merchant);
    await this.persistShop(tx, shop);

    if (product.productType === "platform" && product.platformProductId) {
      const platformProduct = store.platformProducts.get(product.platformProductId);
      if (!platformProduct) throw new Error("merchant product persistence missing current platform product");
      await this.persistPlatformProduct(tx, platformProduct);
    }

    if (product.productType === "merchant_owned" && product.ownProductReviewId) {
      const ownProduct = store.ownProducts.get(product.ownProductReviewId);
      if (!ownProduct) throw new Error("merchant product persistence missing current own product review");
      await this.persistOwnProductReview(tx, ownProduct);
    }

    await this.persistMerchantProduct(tx, product);
  }

  private async persistOwnProductReview(tx: PrismaTx, ownProduct: DemoOwnProduct) {
    await tx.$executeRaw`
	      INSERT INTO merchant_product_reviews (
	        id, merchant_id, shop_id, name, detail_json, sale_price_cents,
        after_sale_rule_json, fulfillment_rule_json, fulfillment_type, status, reject_reason,
        risk_reason, reviewed_by, reviewed_at, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${ownProduct.id}, ${ownProduct.merchantId}, ${ownProduct.shopId}, ${ownProduct.name},
        ${jsonForDb(ownProduct)}::jsonb, ${ownProduct.salePriceCents},
        ${jsonForDb(ownProduct.afterSaleRule)}::jsonb, ${jsonForDb(ownProduct.fulfillmentRule)}::jsonb,
        CAST(${fulfillmentModeFromRule(ownProduct.fulfillmentRule)} AS "FulfillmentType"),
        CAST(${mapReviewStatus(ownProduct.reviewStatus)} AS "ReviewStatus"), NULL, NULL, NULL,
        ${ownProduct.reviewStatus === "approved" ? ownProduct.updatedAt ?? new Date() : null},
        ${`merchant-product-review:${ownProduct.id}`},
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

  private async persistMerchantProduct(tx: PrismaTx, product: DemoMerchantProductListing) {
    if (product.productType === "merchant_owned") {
      await tx.$executeRaw`
        INSERT INTO merchant_products (
          id, merchant_id, shop_id, product_type, platform_product_id, own_product_review_id,
          sale_price_cents, status, listed_at, created_at, updated_at
        )
        VALUES (
          ${product.id}, ${product.merchantId}, ${product.shopId}, CAST('merchant_owned' AS "ProductType"),
          ${product.platformProductId ?? null}, ${product.ownProductReviewId ?? null},
          ${product.salePriceCents}, CAST(${mapProductListingStatus(product.status)} AS "ProductListingStatus"),
          ${product.status === "listed" ? new Date() : null}, now(), now()
        )
        ON CONFLICT (id) DO UPDATE SET
          sale_price_cents = EXCLUDED.sale_price_cents,
          status = EXCLUDED.status,
          listed_at = EXCLUDED.listed_at,
          updated_at = now()
      `;
      return;
    }
    await tx.$executeRaw`
      INSERT INTO merchant_product_listings (
        id, merchant_id, shop_id, source_type, platform_product_id, upstream_listing_id,
        sale_price_cents, display_name, display_subtitle, display_description,
        display_usage_guide, display_image_url, display_category, display_tags_json,
        display_specs_json, display_detail_sections_json, status, listed_at, created_at, updated_at
      )
      VALUES (
        ${product.id}, ${product.merchantId}, ${product.shopId}, CAST('platform_product' AS "MerchantProductListingSourceType"),
        ${product.platformProductId ?? null}, NULL,
        ${product.salePriceCents},
        ${product.displayName ?? null}, ${product.displaySubtitle ?? null}, ${product.displayDescription ?? null},
        ${product.displayUsageGuide ?? null}, ${product.displayImageUrl ?? null}, ${product.displayCategory ?? null},
        ${product.displayTags ? jsonForDb(product.displayTags) : null}::jsonb,
        ${product.displaySpecs ? jsonForDb(product.displaySpecs) : null}::jsonb,
        ${product.displayDetailSections ? jsonForDb(product.displayDetailSections) : null}::jsonb,
        CAST(${mapProductListingStatus(product.status)} AS "ProductListingStatus"),
        ${product.status === "listed" ? new Date() : null}, now(), now()
      )
      ON CONFLICT (id) DO UPDATE SET
        sale_price_cents = EXCLUDED.sale_price_cents,
        display_name = EXCLUDED.display_name,
        display_subtitle = EXCLUDED.display_subtitle,
        display_description = EXCLUDED.display_description,
        display_usage_guide = EXCLUDED.display_usage_guide,
        display_image_url = EXCLUDED.display_image_url,
        display_category = EXCLUDED.display_category,
        display_tags_json = EXCLUDED.display_tags_json,
        display_specs_json = EXCLUDED.display_specs_json,
        display_detail_sections_json = EXCLUDED.display_detail_sections_json,
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
        ${product.fulfillmentCostCents}, CAST(${mapProductListingStatus(product.status)} AS "ProductListingStatus"),
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
    void tx;
    void offer;
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
        id, product_id, merchant_product_listing_id, merchant_product_id, code_ciphertext, code_hash, secret_preview,
        owner_type, owner_merchant_id, shop_id, batch_no, status, order_id,
        issue_key, issued_at, import_audit_json, created_at, updated_at
      )
      VALUES (
        ${code.codeId}, ${shape.platformProductId}, ${shape.merchantProductListingId}, ${shape.merchantProductId}, ${code.code},
        ${shape.codeHash}, ${shape.secretPreview}, CAST(${shape.ownerType} AS "RightsCodeOwnerType"),
        ${shape.ownerMerchantId}, ${shape.shopId}, ${code.batchNo},
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
        owner_merchant_id = EXCLUDED.owner_merchant_id,
        shop_id = EXCLUDED.shop_id,
        updated_at = now()
    `;
  }

  private rightsCodeDbShape(code: RightsCode, store: MemoryStore) {
    const platformProductId = code.platformProductId ?? (store.platformProducts.has(code.productId) ? code.productId : null);
    const sourceMerchantProduct = code.merchantProductListingId
      ? store.merchantProductListings.get(code.merchantProductListingId)
      : store.merchantProductListings.get(code.productId);
    const merchantProductId = code.merchantProductId
      ?? (sourceMerchantProduct?.productType === "merchant_owned" ? sourceMerchantProduct.id : null);
    const merchantProductListingId = merchantProductId
      ? null
      : code.merchantProductListingId ?? (store.merchantProductListings.has(code.productId) ? code.productId : null);
    const merchantProductListing = merchantProductListingId ? store.merchantProductListings.get(merchantProductListingId) : undefined;
    const ownerProduct = sourceMerchantProduct ?? merchantProductListing;
    return {
      platformProductId,
      merchantProductListingId,
      merchantProductId,
      ownerType: merchantProductListingId || merchantProductId ? "merchant" : "platform",
      ownerMerchantId: ownerProduct?.merchantId ?? null,
      shopId: ownerProduct?.shopId ?? null,
      codeHash: hashSecret(code.code),
      secretPreview: previewSecret(code.code)
    };
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
    void tx;
    void relation;
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
    void tx;
    void authorization;
  }

  private async persistDeposits(tx: PrismaTx, store: MemoryStore) {
    for (const [merchantId, account] of store.depositAccounts.entries()) {
      await tx.$executeRaw`
        INSERT INTO deposit_accounts (
          id, merchant_id, required_amount_cents, available_amount_cents,
          frozen_amount_cents, deducted_amount_cents, status, created_at, updated_at
        )
        VALUES (
          ${stableDbId("deposit_account", merchantId)}, ${merchantId},
          ${account.requiredAmountCents}, ${account.availableAmountCents},
          ${account.frozenAmountCents}, ${account.deductedAmountCents},
          CAST(${mapDepositStatus(account.status)} AS "DepositStatus"), now(), now()
        )
        ON CONFLICT (merchant_id) DO UPDATE SET
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
          id, merchant_id, account_id, type, amount_cents,
          balance_before_cents, balance_after_cents, reason_code, related_type,
          related_id, voucher_url, note, idempotency_key, operator_id, created_at
        )
        VALUES (
          ${stableDbId("deposit_tx", txItem.idempotencyKey)}, ${txItem.merchantId},
          (SELECT id FROM deposit_accounts WHERE merchant_id = ${txItem.merchantId} LIMIT 1),
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
      const merchantId = requiredStringValue(item.merchantId, "merchantId");
      await tx.$executeRaw`
        INSERT INTO clawbacks (
          id, clawback_no, merchant_id, source_type, source_id, order_id,
          settlement_role, amount_cents, status, deduct_from, reason_code,
          idempotency_key, created_at, updated_at
        )
        VALUES (
          ${stableDbId("clawback", clawbackNo)}, ${clawbackNo}, ${merchantId},
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
    const merchantId = order.salesChannelType === "platform_self_operated" || order.merchantId === PLATFORM_MERCHANT_ID ? null : order.merchantId;
    const platformShopProductId = order.salesChannelType === "platform_self_operated" ? order.merchantProductListingId : null;
    const merchantProductListingId = platformShopProductId ? null : order.merchantProductListingId;
    await tx.$executeRaw`
      INSERT INTO orders (
        id, order_no, user_id, merchant_id, shop_id, buyer_email, buyer_phone, purchase_password_hash,
        sales_channel_type, first_tier_merchant_id, second_tier_merchant_id, third_tier_merchant_id,
        collection_snapshot_json,
        coupon_discount_cents, status, payment_status, fulfillment_status, refund_status,
        settlement_status, risk_status, paid_amount_cents, paid_at, fulfilled_at,
        created_at, updated_at
      )
      VALUES (
        ${orderId}, ${order.orderNo}, ${order.userId}, ${merchantId}, ${order.shopId}, ${order.buyerEmail ?? null}, ${order.buyerPhone ?? null},
        ${order.extractionCodeHash ?? null},
        CAST(${order.salesChannelType} AS "SalesChannelType"),
        ${channel?.firstTierMerchantId ?? null}, ${channel?.secondTierMerchantId ?? null}, ${channel?.thirdTierMerchantId ?? null},
        ${jsonForDb(order.collectionPaymentSnapshot)}::jsonb,
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
        id, order_id, merchant_product_listing_id, merchant_product_id, platform_shop_product_id,
        sale_source_type, product_type, product_id_snapshot, product_name_snapshot,
        sale_price_cents, quantity, supply_price_cents, service_fee_cents,
        merchant_income_cents, created_at
      )
      VALUES (
        ${itemId}, (SELECT id FROM orders WHERE order_no = ${order.orderNo}), ${merchantProductListingId}, NULL, ${platformShopProductId},
        CAST(${platformShopProductId ? "platform_shop_product" : "merchant_product_listing"} AS "SaleSourceType"),
        CAST(${order.snapshot.productType} AS "ProductType"), ${getSnapshotProductId(order.snapshot) ?? order.merchantProductListingId},
        ${order.snapshot.productNameSnapshot}, ${amount.paidAmountCents}, ${order.snapshot.quantity},
        ${amount.supplyAmountCents}, ${amount.serviceFeeCents}, ${amount.merchantExpectedIncomeCents}, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        sale_price_cents = EXCLUDED.sale_price_cents,
        quantity = EXCLUDED.quantity,
        supply_price_cents = EXCLUDED.supply_price_cents,
        service_fee_cents = EXCLUDED.service_fee_cents,
        merchant_income_cents = EXCLUDED.merchant_income_cents
    `;
    await tx.$executeRaw`
      INSERT INTO order_amount_snapshots (
        id, order_id, service_fee_bps, paid_amount_cents, supply_amount_cents,
        service_fee_cents, merchant_expected_income_cents, platform_supply_price_cents,
        resell_supply_price_cents, first_tier_supply_price_cents, second_tier_supply_price_cents,
        final_sale_price_cents, first_tier_income_cents, second_tier_income_cents,
        third_tier_income_cents, fulfillment_cost_cents, payment_channel_fee_cents,
        platform_gross_profit_cents, payment_fee_bps, payment_fee_cents,
        balance_paid_cents, external_paid_cents, service_fee_enabled,
        service_fee_basis_amount_cents, service_fee_config_snapshot_json,
        product_snapshot_json, shop_snapshot_json,
        pricing_snapshot_json, fulfillment_rule_snapshot_json, after_sale_rule_snapshot_json,
        created_at
      )
      VALUES (
        ${amountId}, (SELECT id FROM orders WHERE order_no = ${order.orderNo}), ${Number(amount.serviceFeeBps)},
        ${amount.paidAmountCents}, ${amount.supplyAmountCents}, ${amount.serviceFeeCents},
        ${amount.merchantExpectedIncomeCents}, ${channel?.platformSupplyPriceCents ?? amount.supplyAmountCents},
        ${channel?.resellSupplyPriceCents ?? 0n}, ${channel?.firstTierSupplyPriceCents ?? 0n},
        ${channel?.secondTierSupplyPriceCents ?? 0n}, ${channel?.finalSalePriceCents ?? amount.paidAmountCents},
        ${channel?.firstTierIncomeCents ?? 0n}, ${channel?.secondTierIncomeCents ?? 0n},
        ${channel?.thirdTierIncomeCents ?? 0n}, ${getPlatformSelfGrossMargin(order.snapshot) > 0n ? amount.supplyAmountCents : 0n},
        0, ${getPlatformSelfGrossMargin(order.snapshot)}, ${Number((amount as DemoAmountSnapshot).paymentFeeBps ?? 0n)},
        ${(amount as DemoAmountSnapshot).paymentFeeCents ?? 0n}, ${(amount as DemoAmountSnapshot).balancePaidCents ?? 0n},
        ${(amount as DemoAmountSnapshot).externalPaidCents ?? 0n}, ${(amount as DemoAmountSnapshot).serviceFeeEnabled ?? true},
        ${(amount as DemoAmountSnapshot).serviceFeeBasisAmountCents ?? amount.paidAmountCents},
        ${jsonForDb((amount as DemoAmountSnapshot).serviceFeeConfigSnapshot)}::jsonb, ${jsonForDb(order.snapshot.productSnapshot)}::jsonb,
        ${jsonForDb(order.snapshot.shopSnapshot)}::jsonb, ${jsonForDb(order.snapshot.pricingSnapshot)}::jsonb,
        ${jsonForDb(order.snapshot.fulfillmentRuleSnapshot)}::jsonb, ${jsonForDb(order.snapshot.afterSaleRuleSnapshot)}::jsonb,
        now()
      )
      ON CONFLICT (order_id) DO UPDATE SET
        paid_amount_cents = EXCLUDED.paid_amount_cents,
        supply_amount_cents = EXCLUDED.supply_amount_cents,
        service_fee_cents = EXCLUDED.service_fee_cents,
        merchant_expected_income_cents = EXCLUDED.merchant_expected_income_cents,
        payment_fee_bps = EXCLUDED.payment_fee_bps,
        payment_fee_cents = EXCLUDED.payment_fee_cents,
        balance_paid_cents = EXCLUDED.balance_paid_cents,
        external_paid_cents = EXCLUDED.external_paid_cents,
        service_fee_enabled = EXCLUDED.service_fee_enabled,
        service_fee_basis_amount_cents = EXCLUDED.service_fee_basis_amount_cents,
        service_fee_config_snapshot_json = EXCLUDED.service_fee_config_snapshot_json
    `;
    if (order.paymentStatus === "paid") {
      await tx.$executeRaw`
        INSERT INTO payments (
          id, payment_no, order_id, user_id, merchant_id, collection_payment_config_id, channel,
          amount_cents, channel_fee_cents, status, idempotency_key, paid_at,
          created_at, updated_at
        )
        VALUES (
          ${stableDbId("payment", order.orderNo)}, ${`payment:${order.orderNo}`},
          (SELECT id FROM orders WHERE order_no = ${order.orderNo}), ${order.userId},
          ${merchantId}, ${order.paymentSnapshot?.paymentMethodId ?? null}, CAST('alipay_wap' AS "PaymentChannel"),
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
        id, confirmation_no, order_id, payment_id, shop_id,
        amount_cents, payer_name, voucher_url, note, status, reviewed_by,
        reviewed_at, reject_reason, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${stableDbId("payment_confirmation", idempotencyKey)}, ${idempotencyKey},
        (SELECT id FROM orders WHERE order_no = ${order.orderNo}),
        (SELECT id FROM payments WHERE payment_no = ${`payment:${order.orderNo}`}),
        ${order.shopId}, ${amountCents}, NULL,
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
        id, confirmation_no, order_id, payment_id, shop_id,
        amount_cents, payer_name, voucher_url, note, status, reviewed_by,
        reviewed_at, reject_reason, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${stableDbId("payment_voucher", voucher.id)}, ${voucher.id},
        (SELECT id FROM orders WHERE order_no = ${voucher.orderNo}),
        (SELECT id FROM payments WHERE payment_no = ${`payment:${voucher.orderNo}`}),
        ${voucher.shopId}, ${voucher.amountCents}, ${voucher.payerName ?? null},
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
      && (method.merchantId ?? null) === (changed.merchantId ?? null)
      && (method.shopId ?? null) === (changed.shopId ?? null)
    );
    for (const method of scoped) await this.persistPaymentMethodConfig(tx, method);
  }

  private async persistPaymentMethodConfig(tx: PrismaTx, method: PaymentMethodConfig) {
    const ownerType = method.ownerType === "merchant" ? "merchant" : "platform";
    const status = mapCollectionPaymentConfigStatus(method.status, method.enabled);
    const actorType = method.ownerType === "merchant" ? "merchant" : "admin";
    const credentialStatus = method.secretConfigured || isManualPaymentProvider(method.provider) || method.provider === "balance" ? "configured" : "not_configured";
    const maskedIdentity = {
      merchantNoMasked: maskSecret(method.merchantNo),
      appIdMasked: maskSecret(method.appId),
      serviceProviderMasked: maskSecret(method.serviceProviderId)
    };
    const credentialCiphertext = encryptPaymentCredentialBundle({
      merchantNo: method.merchantNo,
      appId: method.appId,
      serviceProviderId: method.serviceProviderId,
      signingSecret: method.signingSecret
    }) ?? method.signingSecretEncrypted ?? null;
    await tx.$executeRaw`
      INSERT INTO collection_payment_configs (
        id, config_no, owner_type, owner_merchant_id, shop_id,
        provider, confirm_mode, environment, status, is_default, display_name,
        merchant_no_masked, app_id_masked, service_provider_masked, gateway_url, api_mode,
        credential_ref, credential_ciphertext, secret_version, credential_status,
        notify_url, return_url, test_status, last_test_at, last_test_result_json,
        last_callback_at, qr_url, account_masked, instruction,
        created_by_type, created_by_id, updated_by_type, updated_by_id,
        enabled_at, disabled_at, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${method.id}, ${method.id}, CAST(${ownerType} AS "CollectionConfigOwnerType"),
        ${method.merchantId ?? null}, ${method.shopId ?? null},
        CAST(${mapPaymentProviderToDb(method.provider)} AS "PaymentProvider"),
        CAST(${mapPaymentConfirmModeToDbForProvider(method.provider, method.confirmationMode)} AS "PaymentConfirmMode"),
        CAST('production' AS "PaymentEnvironment"),
        CAST(${status} AS "CollectionConfigStatus"),
        ${method.isDefault}, ${method.displayName},
        ${maskedIdentity.merchantNoMasked ?? null}, ${maskedIdentity.appIdMasked ?? null}, ${maskedIdentity.serviceProviderMasked ?? null},
        ${method.gatewayUrl ?? null}, ${method.apiMode ?? defaultPaymentApiMode(method.provider) ?? null},
        ${method.signingSecretPreview ?? method.privateKeyPreview ?? method.publicKeyPreview ?? method.certificatePreview ?? null},
        ${credentialCiphertext}, 1, CAST(${credentialStatus} AS "CredentialStatus"),
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
        gateway_url = EXCLUDED.gateway_url,
        api_mode = EXCLUDED.api_mode,
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
    const orderAmountSnapshot = order.snapshot.amountSnapshot as DemoAmountSnapshot;
    const feeBps = Number(orderAmountSnapshot.paymentFeeBps ?? 0n);
    const feeCents = orderAmountSnapshot.paymentFeeCents ?? 0n;
    const baseAmountCents = amountCents >= feeCents ? amountCents - feeCents : amountCents;
    const configSnapshot = method ? serializePaymentMethodForPersistence(method) : {
      id: snapshot.paymentMethodId,
      provider: snapshot.provider,
      confirmationMode: snapshot.confirmationMode
    };
    await tx.$executeRaw`
      INSERT INTO payments (
        id, payment_no, order_id, user_id, merchant_id, collection_payment_config_id,
        collection_snapshot_json, channel, provider, confirm_mode, environment,
        channel_trade_no, provider_payment_no, provider_trade_no, base_amount_cents,
        fee_bps, fee_cents, amount_cents,
        channel_fee_cents, status, confirm_source, idempotency_key, expires_at,
        paid_at, callback_handled_at, exception_reason, created_at, updated_at
      )
      VALUES (
        ${paymentId}, ${paymentNo},
        (SELECT id FROM orders WHERE order_no = ${order.orderNo}), ${order.userId},
        ${order.merchantId === PLATFORM_MERCHANT_ID ? null : order.merchantId}, ${snapshot.paymentMethodId},
        ${jsonForDb(order.collectionPaymentSnapshot ?? {})}::jsonb,
        CAST(${mapProviderToLegacyPaymentChannel(snapshot.provider)} AS "PaymentChannel"),
        CAST(${mapPaymentProviderToDb(snapshot.provider)} AS "PaymentProvider"),
        CAST(${mapPaymentConfirmModeToDbForProvider(snapshot.provider, snapshot.confirmationMode ?? "automatic")} AS "PaymentConfirmMode"),
        CAST('production' AS "PaymentEnvironment"),
        ${channelTradeNo}, ${providerPaymentNo}, ${providerTradeNo}, ${baseAmountCents},
        ${feeBps}, ${feeCents}, ${amountCents},
        0, CAST(${status} AS "PaymentStatus"),
        CAST(${confirmSource} AS "PaymentConfirmSource"),
        ${`payment:${paymentNo}`}, ${snapshot.expiresAt ?? null}, ${snapshot.paidAt ?? order.paidAt ?? null},
        ${snapshot.callbackProcessedAt ?? null}, ${status === "failed" ? "payment_exception" : null},
        ${snapshot.createdAt ?? new Date()}, now()
      )
      ON CONFLICT (payment_no) DO UPDATE SET
        merchant_id = EXCLUDED.merchant_id,
        collection_payment_config_id = EXCLUDED.collection_payment_config_id,
        collection_snapshot_json = EXCLUDED.collection_snapshot_json,
        provider = EXCLUDED.provider,
        confirm_mode = EXCLUDED.confirm_mode,
        channel_trade_no = COALESCE(EXCLUDED.channel_trade_no, payments.channel_trade_no),
        provider_payment_no = COALESCE(EXCLUDED.provider_payment_no, payments.provider_payment_no),
        provider_trade_no = COALESCE(EXCLUDED.provider_trade_no, payments.provider_trade_no),
        base_amount_cents = EXCLUDED.base_amount_cents,
        fee_bps = EXCLUDED.fee_bps,
        fee_cents = EXCLUDED.fee_cents,
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
        app_id_masked, service_provider_masked, base_amount_cents, fee_bps,
        fee_cents, payable_amount_cents, currency,
        payment_no, provider_payment_no, provider_trade_no, status, confirm_source,
        expires_at, paid_at, callback_handled_at, exception_reason, idempotency_key,
        created_at, updated_at
      )
      VALUES (
        ${stableDbId("payment_snapshot", order.orderNo)}, ${`snapshot:${order.orderNo}`},
        (SELECT id FROM orders WHERE order_no = ${order.orderNo}),
        (SELECT id FROM payments WHERE payment_no = ${paymentNo}), ${snapshot.paymentMethodId},
        CAST(${mapPaymentProviderToDb(snapshot.provider)} AS "PaymentProvider"),
        CAST(${mapPaymentConfirmModeToDbForProvider(snapshot.provider, snapshot.confirmationMode ?? "automatic")} AS "PaymentConfirmMode"),
        CAST('production' AS "PaymentEnvironment"),
        ${jsonForDb(configSnapshot)}::jsonb,
        ${snapshot.merchantNoMasked ?? null}, ${snapshot.appIdMasked ?? null}, ${snapshot.serviceProviderMasked ?? null},
        ${baseAmountCents}, ${feeBps}, ${feeCents}, ${amountCents}, ${snapshot.currency ?? "CNY"}, ${paymentNo}, ${providerPaymentNo}, ${providerTradeNo},
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
        base_amount_cents = EXCLUDED.base_amount_cents,
        fee_bps = EXCLUDED.fee_bps,
        fee_cents = EXCLUDED.fee_cents,
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
          id, product_id, merchant_product_listing_id, merchant_product_id, code_ciphertext, code_hash, secret_preview,
          owner_type, owner_merchant_id, shop_id, batch_no, status, order_id,
          issue_key, issued_at, import_audit_json, created_at, updated_at
        )
        VALUES (
          ${code.codeId}, ${shape.platformProductId}, ${shape.merchantProductListingId}, ${shape.merchantProductId}, ${code.code},
          ${shape.codeHash}, ${shape.secretPreview}, CAST(${shape.ownerType} AS "RightsCodeOwnerType"),
          ${shape.ownerMerchantId}, ${shape.shopId}, ${code.batchNo},
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
          owner_merchant_id = EXCLUDED.owner_merchant_id,
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

  private async persistLockedRightsCodesForOrder(tx: PrismaTx, store: MemoryStore, order: DemoOrder) {
    const codes = store.rightsCodes.filter((code) => code.orderNo === order.orderNo && code.status === "locked");
    for (const code of codes) {
      const shape = this.rightsCodeDbShape(code, store);
      await tx.$executeRaw`
      INSERT INTO rights_codes (
          id, product_id, merchant_product_listing_id, merchant_product_id, code_ciphertext, code_hash, secret_preview,
          owner_type, owner_merchant_id, shop_id, batch_no, status, order_id,
          issue_key, issued_at, import_audit_json, created_at, updated_at
        )
        VALUES (
          ${code.codeId}, ${shape.platformProductId}, ${shape.merchantProductListingId}, ${shape.merchantProductId}, ${code.code},
          ${shape.codeHash}, ${shape.secretPreview}, CAST(${shape.ownerType} AS "RightsCodeOwnerType"),
          ${shape.ownerMerchantId}, ${shape.shopId}, ${code.batchNo},
          CAST('locked' AS "RightsCodeStatus"),
          (SELECT id FROM orders WHERE order_no = ${order.orderNo}),
          ${code.issueKey ?? null}, ${code.issuedAt ?? new Date()},
          ${jsonForDb({ batchNo: code.batchNo, orderNo: order.orderNo, source: "order_reservation" })}::jsonb,
          ${code.createdAt}, now()
        )
        ON CONFLICT (id) DO UPDATE SET
          status = CASE
            WHEN rights_codes.status = CAST('available' AS "RightsCodeStatus") OR rights_codes.order_id = EXCLUDED.order_id THEN EXCLUDED.status
            ELSE rights_codes.status
          END,
          order_id = CASE
            WHEN rights_codes.status = CAST('available' AS "RightsCodeStatus") OR rights_codes.order_id = EXCLUDED.order_id THEN EXCLUDED.order_id
            ELSE rights_codes.order_id
          END,
          issue_key = CASE
            WHEN rights_codes.status = CAST('available' AS "RightsCodeStatus") OR rights_codes.order_id = EXCLUDED.order_id THEN EXCLUDED.issue_key
            ELSE rights_codes.issue_key
          END,
          issued_at = CASE
            WHEN rights_codes.status = CAST('available' AS "RightsCodeStatus") OR rights_codes.order_id = EXCLUDED.order_id THEN EXCLUDED.issued_at
            ELSE rights_codes.issued_at
          END,
          code_hash = COALESCE(rights_codes.code_hash, EXCLUDED.code_hash),
          secret_preview = COALESCE(rights_codes.secret_preview, EXCLUDED.secret_preview),
          owner_type = EXCLUDED.owner_type,
          owner_merchant_id = EXCLUDED.owner_merchant_id,
          shop_id = EXCLUDED.shop_id,
          updated_at = now()
      `;
    }
  }

  private async persistFulfillmentRecordForOrder(tx: PrismaTx, store: MemoryStore, order: DemoOrder) {
    const record = store.fulfillmentRecords.get(order.orderNo);
    if (!record) return;
    await tx.$executeRaw`
      INSERT INTO fulfillment_records (
        id, order_id, order_item_id, merchant_id, shop_id, idempotency_key,
        fulfillment_type, status, success_at, fail_reason, created_at, updated_at
      )
      VALUES (
        ${stableDbId("fulfillment", order.orderNo)}, (SELECT id FROM orders WHERE order_no = ${order.orderNo}),
        ${stableDbId("order_item", order.orderNo)}, (SELECT merchant_id FROM orders WHERE order_no = ${order.orderNo}),
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
      UPDATE user_coupons
         SET status = CAST('voided' AS "CouponStatus"),
             void_reason = 'voided_after_refund',
             updated_at = now()
       WHERE id = ${coupon.id}
    `;
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
          id, product_id, merchant_product_listing_id, merchant_product_id, code_ciphertext, code_hash, secret_preview,
          owner_type, owner_merchant_id, shop_id, batch_no, status, order_id,
          issue_key, issued_at, import_audit_json, created_at, updated_at
        )
        VALUES (
          ${code.codeId}, ${shape.platformProductId}, ${shape.merchantProductListingId}, ${shape.merchantProductId}, ${code.code},
          ${shape.codeHash}, ${shape.secretPreview}, CAST(${shape.ownerType} AS "RightsCodeOwnerType"),
          ${shape.ownerMerchantId}, ${shape.shopId}, ${code.batchNo},
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
          owner_merchant_id = EXCLUDED.owner_merchant_id,
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
          id, order_id, order_item_id, merchant_id, shop_id, idempotency_key,
          fulfillment_type, status, success_at, fail_reason, created_at, updated_at
        )
        VALUES (
          ${stableDbId("fulfillment", orderNo)}, (SELECT id FROM orders WHERE order_no = ${orderNo}),
          ${stableDbId("order_item", orderNo)}, (SELECT merchant_id FROM orders WHERE order_no = ${orderNo}),
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
        id, after_sale_no, order_id, user_id, merchant_id, shop_id,
        status, reason_code, responsibility, requested_refund_cents,
        approved_refund_cents, platform_bear_cents, merchant_bear_cents,
        service_fee_refund_cents, service_fee_bearer, evidence_json,
        created_at, updated_at
      )
      VALUES (
        ${stableDbId("after_sale", afterSale.afterSaleNo)}, ${afterSale.afterSaleNo},
        (SELECT id FROM orders WHERE order_no = ${afterSale.orderNo}), ${afterSale.userId},
        ${afterSale.merchantId === PLATFORM_MERCHANT_ID ? null : afterSale.merchantId}, ${afterSale.shopId},
        CAST(${mapAfterSaleStatus(afterSale.status)} AS "AfterSaleStatus"), ${afterSale.reasonCode},
        CAST(${afterSale.allocation ? "mixed" : "undecided"} AS "Responsibility"),
        ${afterSale.requestedRefundCents}, ${afterSale.allocation?.refundAmountCents ?? 0n},
        ${afterSale.allocation?.platformBearCents ?? 0n}, ${afterSale.allocation?.merchantBearCents ?? 0n},
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
        merchant_bear_cents = EXCLUDED.merchant_bear_cents,
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
        id, settlement_no, merchant_id, period_start, period_end, status,
        total_order_count, total_paid_cents, total_service_fee_cents,
        total_merchant_income_cents, idempotency_key, created_at, updated_at
      )
      VALUES (
        ${stableDbId("settlement", sheet.settlementNo)}, ${sheet.settlementNo}, ${sheet.merchantId},
        ${new Date(0)}, ${new Date()}, CAST(${mapSettlementSheetStatus(sheet.status)} AS "SettlementSheetStatus"),
        ${sheet.totalOrderCount}, ${sheet.totalPaidCents}, ${sheet.totalServiceFeeCents},
        ${sheet.totalMerchantIncomeCents}, ${sheet.idempotencyKey}, now(), now()
      )
      ON CONFLICT (settlement_no) DO UPDATE SET
        status = EXCLUDED.status,
        total_order_count = EXCLUDED.total_order_count,
        total_paid_cents = EXCLUDED.total_paid_cents,
        total_service_fee_cents = EXCLUDED.total_service_fee_cents,
        total_merchant_income_cents = EXCLUDED.total_merchant_income_cents,
        updated_at = now()
    `;
    for (const item of sheet.items) {
      await tx.$executeRaw`
        INSERT INTO settlement_items (
          id, settlement_id, order_id, settlement_role, merchant_id, shop_id,
          paid_amount_cents, supply_amount_cents, service_fee_cents,
          merchant_income_cents, deducted_cents, settle_amount_cents,
          fulfilled_at, settleable_at, created_at
        )
        VALUES (
          ${stableDbId("settlement_item", `${sheet.settlementNo}:${item.orderId}:${item.settlementRole ?? "single_merchant"}`)},
          (SELECT id FROM settlement_sheets WHERE settlement_no = ${sheet.settlementNo}),
          (SELECT id FROM orders WHERE order_no = ${item.orderId}),
          CAST(${item.settlementRole ?? "single_merchant"} AS "SettlementRole"), ${item.merchantId}, ${item.shopId},
          ${item.paidAmountCents}, ${item.supplyAmountCents}, ${item.serviceFeeCents},
          ${item.merchantIncomeCents}, ${item.deductedCents ?? 0n}, ${item.settleAmountCents},
          ${item.fulfilledAt}, ${item.settleableAt}, now()
        )
        ON CONFLICT (order_id, settlement_role) DO UPDATE SET
          settlement_id = EXCLUDED.settlement_id,
          merchant_income_cents = EXCLUDED.merchant_income_cents,
          settle_amount_cents = EXCLUDED.settle_amount_cents
      `;
    }
  }

  private async persistManualPayout(tx: PrismaTx, payout: Record<string, unknown>) {
    const settlementNo = requiredStringValue(payout.settlementNo, "settlementNo");
    const payoutNo = stringValue(payout.payoutNo) ?? stableDbId("payout_no", JSON.stringify(payout));
    await tx.$executeRaw`
      INSERT INTO manual_payouts (
        id, settlement_id, merchant_id, amount_cents, payee_info_snapshot_json,
        payout_method, payout_voucher_url, status, idempotency_key,
        paid_at, created_at, updated_at
      )
      VALUES (
        ${stableDbId("payout", payoutNo)}, (SELECT id FROM settlement_sheets WHERE settlement_no = ${settlementNo}),
        ${requiredStringValue(payout.merchantId, "merchantId")}, ${bigintValue(payout.amountCents)},
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
          id, target_type, target_id, merchant_id, freeze_type, status,
          reason_code, reason_text, active_unique_key, released_at,
          created_at, updated_at
        )
        VALUES (
          ${freeze.id}, ${freeze.targetType}, ${freeze.targetId}, ${stringValue(freeze.merchantId) ?? null},
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
      const merchantId = ledger.merchantId && ledger.merchantId !== PLATFORM_MERCHANT_ID ? ledger.merchantId : null;
      await tx.$executeRaw`
        INSERT INTO ledger_entries (
          id, ledger_no, merchant_id, shop_id, subject_type, subject_id,
          account_type, entry_type, direction, amount_cents, currency, source_type,
          source_id, idempotency_key, created_at
        )
        VALUES (
          ${stableDbId("ledger", ledger.ledgerNo)}, ${ledger.ledgerNo}, ${merchantId}, NULL,
          CAST(${merchantId ? "merchant" : "platform"} AS "LedgerSubjectType"),
          ${merchantId ?? "platform"},
          CAST(${merchantId ? "merchant_pending_income" : "platform_service_fee_income"} AS "LedgerAccountType"),
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
    void store.notifications;

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
    const merchantId = order.salesChannelType === "platform_self_operated" || order.merchantId === PLATFORM_MERCHANT_ID ? null : order.merchantId;
    const platformShopProductId = order.salesChannelType === "platform_self_operated" ? order.merchantProductListingId : null;
    const merchantProductListingId = platformShopProductId ? null : order.merchantProductListingId;
    const saleSourceType = platformShopProductId ? "platform_shop_product" : "merchant_product_listing";
    const finalPaidAmountCents = payableAmount(order);
    const productIdSnapshot = getSnapshotProductId(order.snapshot) ?? order.merchantProductListingId;
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
          id, order_no, user_id, merchant_id, shop_id, buyer_email, buyer_phone, purchase_password_hash,
          sales_channel_type, first_tier_merchant_id, second_tier_merchant_id, third_tier_merchant_id,
          collection_snapshot_json,
          coupon_discount_cents, status, payment_status, fulfillment_status, refund_status,
          settlement_status, risk_status, paid_amount_cents, paid_at, fulfilled_at,
          created_at, updated_at
        )
        VALUES (
          ${orderId}, ${order.orderNo}, ${order.userId}, ${merchantId}, ${order.shopId}, ${order.buyerEmail ?? null}, ${order.buyerPhone ?? null},
          ${order.extractionCodeHash ?? null},
          ${order.salesChannelType}, ${channel?.firstTierMerchantId ?? null}, ${channel?.secondTierMerchantId ?? null}, ${channel?.thirdTierMerchantId ?? null},
          ${jsonForDb(order.collectionPaymentSnapshot)}::jsonb,
          ${order.couponDiscountCents ?? 0n}, ${mapOrderStatus(order.status)}, ${mapPaymentStatus(order.paymentStatus)}, ${mapFulfillmentStatus(order.fulfillmentStatus)}, ${mapRefundStatus(order.refundStatus)},
          ${mapSettlementStatus(order.settlementStatus)}, ${mapRiskStatus(order.riskStatus)}, ${finalPaidAmountCents}, ${order.paidAt}, ${order.fulfilledAt},
          now(), now()
        )
      `;
      await tx.$executeRaw`
        INSERT INTO order_items (
          id, order_id, merchant_product_listing_id, merchant_product_id, platform_shop_product_id,
          sale_source_type, product_type, product_id_snapshot, product_name_snapshot,
          sale_price_cents, quantity, supply_price_cents, service_fee_cents, merchant_income_cents, created_at
        )
        VALUES (
          ${orderItemId}, ${orderId}, ${merchantProductListingId}, NULL, ${platformShopProductId},
          ${saleSourceType}, ${order.snapshot.productType}, ${productIdSnapshot}, ${order.snapshot.productNameSnapshot},
          ${amount.paidAmountCents}, ${order.snapshot.quantity}, ${amount.supplyAmountCents},
          ${amount.serviceFeeCents}, ${amount.merchantExpectedIncomeCents}, now()
        )
      `;
      await tx.$executeRaw`
        INSERT INTO order_amount_snapshots (
          id, order_id, service_fee_bps, paid_amount_cents, supply_amount_cents,
          service_fee_cents, merchant_expected_income_cents, platform_supply_price_cents,
          resell_supply_price_cents, first_tier_supply_price_cents, second_tier_supply_price_cents,
          final_sale_price_cents, first_tier_income_cents, second_tier_income_cents,
          third_tier_income_cents, fulfillment_cost_cents, payment_channel_fee_cents,
          platform_gross_profit_cents, service_fee_enabled, service_fee_basis_amount_cents,
          service_fee_config_snapshot_json, product_snapshot_json, shop_snapshot_json,
          pricing_snapshot_json, fulfillment_rule_snapshot_json, after_sale_rule_snapshot_json,
          created_at
        )
        VALUES (
          ${amountSnapshotId}, ${orderId}, ${Number(amount.serviceFeeBps)}, ${amount.paidAmountCents}, ${amount.supplyAmountCents},
          ${amount.serviceFeeCents}, ${amount.merchantExpectedIncomeCents}, ${channel?.platformSupplyPriceCents ?? amount.supplyAmountCents},
          ${channel?.resellSupplyPriceCents ?? 0n}, ${channel?.firstTierSupplyPriceCents ?? 0n}, ${channel?.secondTierSupplyPriceCents ?? 0n},
          ${channel?.finalSalePriceCents ?? amount.paidAmountCents}, ${channel?.firstTierIncomeCents ?? 0n}, ${channel?.secondTierIncomeCents ?? 0n},
          ${channel?.thirdTierIncomeCents ?? 0n}, ${grossMarginCents > 0n ? amount.supplyAmountCents : 0n}, 0,
          ${grossMarginCents}, ${(amount as DemoAmountSnapshot).serviceFeeEnabled ?? true},
          ${(amount as DemoAmountSnapshot).serviceFeeBasisAmountCents ?? amount.paidAmountCents},
          ${jsonForDb((amount as DemoAmountSnapshot).serviceFeeConfigSnapshot)}::jsonb,
          ${jsonForDb(order.snapshot.productSnapshot)}::jsonb, ${jsonForDb(order.snapshot.shopSnapshot)}::jsonb,
          ${jsonForDb(order.snapshot.pricingSnapshot)}::jsonb, ${jsonForDb(order.snapshot.fulfillmentRuleSnapshot)}::jsonb, ${jsonForDb(order.snapshot.afterSaleRuleSnapshot)}::jsonb,
          now()
        )
      `;
      await tx.$executeRaw`
        INSERT INTO ledger_entries (
          id, ledger_no, merchant_id, shop_id, subject_type, subject_id,
          account_type, entry_type, direction, amount_cents, currency, source_type, source_id,
          order_id, idempotency_key, created_at
        )
        VALUES (
          ${ledgerId}, ${`ledger-${order.orderNo}`}, ${merchantId}, ${order.shopId},
          ${merchantId ? "merchant" : "platform"}, ${merchantId ?? "platform"},
          ${merchantId ? "merchant_pending_income" : "platform_self_operated_revenue"},
          ${merchantId ? "ORDER_MERCHANT_INCOME_PENDING" : "ORDER_PLATFORM_SELF_REVENUE"},
          'credit', ${merchantId ? amount.merchantExpectedIncomeCents : finalPaidAmountCents}, 'CNY', 'order', ${order.orderNo},
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
          ${jsonForDb({ orderNo: order.orderNo, userId: order.userId, shopId: order.shopId, merchantId: order.merchantId })}::jsonb,
          ${auditKey}, ${auditKey}, now()
        )
      `;
    });
  }

  private async loadMerchantsAndDeposits(store: MemoryStore) {
    const merchants = await this.prisma.$queryRaw<Array<{
      id: string;
      user_id: string;
      name: string;
      contact_phone: string | null;
      status: string;
      risk_status: string;
      deposit_status: string;
    }>>`
      SELECT m.id, COALESCE(ma.user_id, m.id) AS user_id, m.name, m.contact_phone,
             m.status, m.risk_status, m.deposit_status
        FROM merchants m
        LEFT JOIN LATERAL (
          SELECT user_id
            FROM merchant_accounts
           WHERE merchant_id = m.id
           ORDER BY created_at ASC
           LIMIT 1
        ) ma ON TRUE
    `;
    for (const row of merchants) {
      store.merchants.set(row.id, {
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
      merchant_id: string;
      required_amount_cents: bigint;
      available_amount_cents: bigint;
      frozen_amount_cents: bigint;
      deducted_amount_cents: bigint;
      status: string;
    }>>`
      SELECT merchant_id, required_amount_cents, available_amount_cents, frozen_amount_cents,
             deducted_amount_cents, status
        FROM deposit_accounts
       WHERE merchant_id IS NOT NULL
    `;
    for (const row of deposits) {
      store.depositAccounts.set(row.merchant_id, {
        merchantId: row.merchant_id,
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
      owner_type: "platform" | "merchant";
      merchant_id: string | null;
      shop_no: string;
      name: string;
      share_path: string;
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
      SELECT s.id, s.owner_type, s.merchant_id, s.shop_no, s.name, s.share_path,
             s.status, s.risk_status, s.announcement,
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
       ORDER BY CASE WHEN s.owner_type = 'platform' THEN 0 ELSE 1 END, s.created_at ASC
    `;
    for (const row of rows) {
      store.shops.set(row.id, {
        id: row.id,
        ownerType: row.owner_type === "merchant" ? "merchant" : "platform",
        merchantId: row.merchant_id ?? undefined,
        shopNo: row.shop_no,
        sharePath: row.share_path,
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
      merchant_id: string;
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
      SELECT id, merchant_id, shop_id, name, detail_json, sale_price_cents,
             after_sale_rule_json, fulfillment_rule_json, status, created_at, updated_at
        FROM merchant_product_reviews
    `;
    for (const row of rows) {
      const detail = decodeStoreValue(row.detail_json);
      store.ownProducts.set(row.id, {
        id: row.id,
        merchantId: row.merchant_id,
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
        minSalePriceCents: isRecord(detail) ? bigintValue(detail.minSalePriceCents) || row.sale_price_cents : row.sale_price_cents,
        fulfillmentRule: decodeStoreValue(row.fulfillment_rule_json),
        afterSaleRule: decodeStoreValue(row.after_sale_rule_json),
        reviewStatus: row.status,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    }
  }

  private async loadMerchantProducts(store: MemoryStore) {
    const merchantRows = await this.prisma.$queryRaw<Array<{
      id: string;
      merchant_id: string;
      shop_id: string;
      product_type: "platform" | "merchant_owned";
      platform_product_id: string | null;
      own_product_review_id: string | null;
      sale_price_cents: bigint;
      display_name: string | null;
      display_subtitle: string | null;
      display_description: string | null;
      display_usage_guide: string | null;
      display_image_url: string | null;
      display_category: string | null;
      display_tags_json: unknown;
      display_specs_json: unknown;
      display_detail_sections_json: unknown;
      status: string;
    }>>`
      SELECT id, merchant_id, shop_id, 'platform'::text AS product_type, platform_product_id,
             NULL::text AS own_product_review_id, sale_price_cents,
             display_name, display_subtitle, display_description,
             display_usage_guide, display_image_url, display_category,
             display_tags_json, display_specs_json, display_detail_sections_json, status
        FROM merchant_product_listings
      UNION ALL
      SELECT id, merchant_id, shop_id, product_type::text AS product_type, platform_product_id,
             own_product_review_id, sale_price_cents,
             NULL::text AS display_name, NULL::text AS display_subtitle, NULL::text AS display_description,
             NULL::text AS display_usage_guide, NULL::text AS display_image_url, NULL::text AS display_category,
             NULL::jsonb AS display_tags_json, NULL::jsonb AS display_specs_json,
             NULL::jsonb AS display_detail_sections_json, status
        FROM merchant_products
    `;
    for (const row of merchantRows) {
      store.merchantProductListings.set(row.id, {
        id: row.id,
        merchantId: row.merchant_id,
        shopId: row.shop_id,
        productType: row.product_type === "merchant_owned" ? "merchant_owned" : row.product_type,
        platformProductId: row.platform_product_id,
        ownProductReviewId: row.own_product_review_id,
        salePriceCents: row.sale_price_cents,
        displayName: row.display_name ?? undefined,
        displaySubtitle: row.display_subtitle ?? undefined,
        displayDescription: row.display_description ?? undefined,
        displayUsageGuide: row.display_usage_guide ?? undefined,
        displayImageUrl: row.display_image_url ?? undefined,
        displayCategory: row.display_category ?? undefined,
        displayTags: Array.isArray(row.display_tags_json) ? row.display_tags_json as string[] : undefined,
        displaySpecs: Array.isArray(row.display_specs_json) ? row.display_specs_json as string[] : undefined,
        displayDetailSections: Array.isArray(row.display_detail_sections_json) ? row.display_detail_sections_json as ProductDetailSection[] : undefined,
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
  private async loadPaymentConfig(store: MemoryStore) {
    const rows = await this.prisma.$queryRaw<Array<PaymentChannelConfig>>`
      SELECT channel, enabled, fee_bps AS "feeBps", fixed_fee_cents AS "fixedFeeCents",
             status_note AS "statusNote", updated_at AS "updatedAt"
        FROM payment_channel_configs
    `;
    if (rows.length) store.paymentChannelConfigs = rows;
  }

  private async loadServiceFeeConfig(store: MemoryStore) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      enabled: boolean;
      fee_bps: number;
      basis_type: "final_sale_price" | "paid_amount";
      status: "active" | "disabled";
      updated_at: Date;
      updated_by: string | null;
    }>>`
      SELECT id, enabled, fee_bps, basis_type, status, updated_at, updated_by
        FROM platform_service_fee_configs
       WHERE status = 'active'
       ORDER BY effective_from DESC, updated_at DESC
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return;
    store.serviceFeeConfig = {
      id: row.id,
      enabled: row.enabled,
      feeBps: row.fee_bps,
      basisType: row.basis_type,
      status: row.status,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by ?? undefined
    };
  }

  private async loadWalletState(store: MemoryStore) {
    const wallets = await this.prisma.$queryRaw<Array<{
      id: string;
      user_id: string;
      wallet_no: string;
      available_balance_cents: bigint;
      frozen_balance_cents: bigint;
      total_recharge_cents: bigint;
      total_spend_cents: bigint;
      status: "active" | "frozen" | "disabled";
      version: number;
      created_at: Date;
      updated_at: Date;
    }>>`
      SELECT id, user_id, wallet_no, available_balance_cents, frozen_balance_cents,
             total_recharge_cents, total_spend_cents, status, version, created_at, updated_at
        FROM user_wallets
    `;
    for (const row of wallets) {
      store.userWallets.set(row.user_id, {
        id: row.id,
        userId: row.user_id,
        walletNo: row.wallet_no,
        availableBalanceCents: row.available_balance_cents,
        frozenBalanceCents: row.frozen_balance_cents,
        totalRechargeCents: row.total_recharge_cents,
        totalSpendCents: row.total_spend_cents,
        status: row.status,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    }

    const recharges = await this.prisma.$queryRaw<Array<{
      recharge_no: string;
      user_id: string;
      wallet_id: string;
      provider: string;
      confirm_mode: string;
      recharge_cents: bigint;
      fee_bps: number;
      fee_cents: bigint;
      payable_cents: bigint;
      status: "pending_payment" | "paid" | "failed" | "cancelled" | "expired";
      paid_at: Date | null;
      idempotency_key: string;
      created_at: Date;
      updated_at: Date;
    }>>`
      SELECT recharge_no, user_id, wallet_id, provider, confirm_mode, recharge_cents,
             fee_bps, fee_cents, payable_cents, status, paid_at, idempotency_key,
             created_at, updated_at
        FROM wallet_recharge_orders
    `;
    for (const row of recharges) {
      store.walletRecharges.set(row.recharge_no, {
        rechargeNo: row.recharge_no,
        userId: row.user_id,
        walletId: row.wallet_id,
        provider: mapPaymentProviderFromDb(row.provider),
        confirmationMode: mapPaymentConfirmModeFromDb(row.confirm_mode),
        rechargeCents: row.recharge_cents,
        feeBps: row.fee_bps,
        feeCents: row.fee_cents,
        payableCents: row.payable_cents,
        status: row.status,
        paidAt: row.paid_at ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        idempotencyKey: row.idempotency_key
      });
    }
  }

  private async loadPaymentMethodConfigs(store: MemoryStore) {
    await this.ensureCollectionPaymentConfigRuntimeSchema();
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      owner_type: string;
      owner_merchant_id: string | null;
      shop_id: string | null;
      provider: string;
      confirm_mode: string;
      status: string;
      is_default: boolean;
      display_name: string;
      merchant_no_masked: string | null;
      app_id_masked: string | null;
      service_provider_masked: string | null;
      gateway_url: string | null;
      api_mode: string | null;
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
      SELECT id, owner_type, owner_merchant_id, shop_id, provider, confirm_mode, status,
             is_default, display_name, merchant_no_masked, app_id_masked, service_provider_masked,
             gateway_url, api_mode, credential_ref, credential_ciphertext, credential_status, return_url, test_status,
             last_test_at, last_test_result_json, last_callback_at, qr_url, account_masked,
             instruction, updated_by_id, created_at, updated_at
        FROM collection_payment_configs
    `;
    for (const row of rows) {
      const provider = mapPaymentProviderFromDb(row.provider);
      const status = mapCollectionPaymentConfigStatusFromDb(row.status);
      const credentialBundle = decryptPaymentCredentialBundle(row.credential_ciphertext);
      const legacyHash = row.credential_ciphertext?.startsWith("sha256:") ? row.credential_ciphertext.slice("sha256:".length) : undefined;
      store.paymentMethods.set(row.id, {
        id: row.id,
        ownerType: row.owner_type === "merchant" ? "merchant" : "platform",
        merchantId: row.owner_merchant_id ?? undefined,
        shopId: row.shop_id ?? undefined,
        provider,
        confirmationMode: mapPaymentConfirmModeFromDb(row.confirm_mode),
        displayName: row.display_name,
        merchantNo: credentialBundle.merchantNo ?? row.merchant_no_masked ?? undefined,
        appId: credentialBundle.appId ?? row.app_id_masked ?? undefined,
        serviceProviderId: credentialBundle.serviceProviderId ?? row.service_provider_masked ?? undefined,
        gatewayUrl: row.gateway_url ?? undefined,
        apiMode: parsePaymentApiMode(row.api_mode),
        accountName: row.account_masked ?? undefined,
        qrUrl: row.qr_url ?? undefined,
        paymentUrl: row.qr_url ?? undefined,
        note: row.instruction ?? undefined,
        returnUrl: row.return_url ?? undefined,
        enabled: row.status === "active",
        status,
        isDefault: row.is_default,
        signingSecret: credentialBundle.signingSecret,
        signingSecretHash: legacyHash,
        signingSecretEncrypted: row.credential_ciphertext ?? undefined,
        signingSecretPreview: row.credential_ref ?? undefined,
        secretConfigured: row.credential_status === "configured" || Boolean(credentialBundle.signingSecret),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by_id ?? undefined,
        lastTestAt: row.last_test_at ?? undefined,
        lastTestResult: row.test_status === "passed" || row.test_status === "failed" ? row.test_status : undefined,
        lastCallbackAt: row.last_callback_at ?? undefined
      });
    }
  }

  private async ensureCollectionPaymentConfigRuntimeSchema() {
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE "collection_payment_configs"
        ADD COLUMN IF NOT EXISTS "display_name" TEXT NOT NULL DEFAULT '收款方式',
        ADD COLUMN IF NOT EXISTS "merchant_no_masked" TEXT,
        ADD COLUMN IF NOT EXISTS "app_id_masked" TEXT,
        ADD COLUMN IF NOT EXISTS "service_provider_masked" TEXT,
        ADD COLUMN IF NOT EXISTS "gateway_url" TEXT,
        ADD COLUMN IF NOT EXISTS "api_mode" TEXT,
        ADD COLUMN IF NOT EXISTS "credential_ref" TEXT,
        ADD COLUMN IF NOT EXISTS "credential_ciphertext" TEXT,
        ADD COLUMN IF NOT EXISTS "secret_version" INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "credential_status" "CredentialStatus" NOT NULL DEFAULT 'not_configured',
        ADD COLUMN IF NOT EXISTS "notify_url" TEXT,
        ADD COLUMN IF NOT EXISTS "return_url" TEXT,
        ADD COLUMN IF NOT EXISTS "test_status" TEXT,
        ADD COLUMN IF NOT EXISTS "last_test_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "last_test_result_json" JSONB,
        ADD COLUMN IF NOT EXISTS "last_callback_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "qr_url" TEXT,
        ADD COLUMN IF NOT EXISTS "account_masked" TEXT,
        ADD COLUMN IF NOT EXISTS "instruction" TEXT,
        ADD COLUMN IF NOT EXISTS "created_by_type" "ActorType" NOT NULL DEFAULT 'system',
        ADD COLUMN IF NOT EXISTS "created_by_id" TEXT,
        ADD COLUMN IF NOT EXISTS "updated_by_type" "ActorType",
        ADD COLUMN IF NOT EXISTS "updated_by_id" TEXT,
        ADD COLUMN IF NOT EXISTS "enabled_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "disabled_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "idempotency_key" TEXT,
        ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    `);
    await this.prisma.$executeRawUnsafe(`
      UPDATE "collection_payment_configs"
         SET "idempotency_key" = COALESCE("idempotency_key", 'collection-payment-config:' || "id"),
             "display_name" = COALESCE(NULLIF("display_name", ''), '收款方式'),
             "updated_at" = COALESCE("updated_at", CURRENT_TIMESTAMP)
    `);
    await this.prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "collection_payment_configs_idempotency_key_key"
        ON "collection_payment_configs"("idempotency_key")
        WHERE "idempotency_key" IS NOT NULL
    `);
    await this.prisma.$executeRawUnsafe(`
      DO $$
      DECLARE item RECORD;
      BEGIN
        FOR item IN
          SELECT conname
            FROM pg_constraint
           WHERE conrelid = 'collection_payment_configs'::regclass
             AND contype = 'u'
             AND pg_get_constraintdef(oid) LIKE '%shop_id%'
        LOOP
          EXECUTE format('ALTER TABLE "collection_payment_configs" DROP CONSTRAINT IF EXISTS %I', item.conname);
        END LOOP;

        FOR item IN
          SELECT indexrelid::regclass::text AS index_name
            FROM pg_index
           WHERE indrelid = 'collection_payment_configs'::regclass
             AND indisunique = true
             AND pg_get_indexdef(indexrelid) LIKE '%shop_id%'
        LOOP
          EXECUTE format('DROP INDEX IF EXISTS %s', item.index_name);
        END LOOP;
      END $$;
    `);
  }

  private async ensureMerchantProductRuntimeSchema() {
    await this.prisma.$executeRawUnsafe(`
      ALTER TABLE "merchant_product_listings"
        ADD COLUMN IF NOT EXISTS "display_name" TEXT,
        ADD COLUMN IF NOT EXISTS "display_subtitle" TEXT,
        ADD COLUMN IF NOT EXISTS "display_description" TEXT,
        ADD COLUMN IF NOT EXISTS "display_usage_guide" TEXT,
        ADD COLUMN IF NOT EXISTS "display_image_url" TEXT,
        ADD COLUMN IF NOT EXISTS "display_category" TEXT,
        ADD COLUMN IF NOT EXISTS "display_tags_json" JSONB,
        ADD COLUMN IF NOT EXISTS "display_specs_json" JSONB,
        ADD COLUMN IF NOT EXISTS "display_detail_sections_json" JSONB
    `);
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
      base_amount_cents: bigint;
      fee_bps: number;
      fee_cents: bigint;
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
             ps.base_amount_cents, ps.fee_bps, ps.fee_cents,
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
        baseAmountCents: row.base_amount_cents,
        feeBps: row.fee_bps,
        feeCents: row.fee_cents,
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
      merchant_product_listing_id: string | null;
      merchant_product_id: string | null;
      code_ciphertext: string;
      batch_no: string;
      status: RightsCode["status"];
      order_no: string | null;
      issue_key: string | null;
      issued_at: Date | null;
      created_at: Date;
    }>>`
      SELECT rc.id, rc.product_id, rc.merchant_product_listing_id, rc.merchant_product_id, rc.code_ciphertext, rc.batch_no,
             rc.status, o.order_no, rc.issue_key, rc.issued_at, rc.created_at
        FROM rights_codes rc
        LEFT JOIN orders o ON o.id = rc.order_id
    `;
    store.rightsCodes = rows.map((row) => ({
      codeId: row.id,
      productId: row.product_id ?? row.merchant_product_listing_id ?? row.merchant_product_id ?? row.id,
      platformProductId: row.product_id ?? undefined,
      merchantProductListingId: row.merchant_product_listing_id ?? undefined,
      merchantProductId: row.merchant_product_id ?? undefined,
      code: row.code_ciphertext,
      batchNo: row.batch_no,
      status: row.status,
      orderNo: row.order_no ?? undefined,
      issueKey: row.issue_key ?? undefined,
      issuedAt: row.issued_at ?? undefined,
      createdAt: row.created_at
    }));
  }

  private async loadOrders(store: MemoryStore) {
    const couponUsageByOrderId = new Map<string, string>();
    const couponUsages = await this.prisma.$queryRaw<Array<{ order_id: string; user_coupon_id: string }>>`
      SELECT order_id, user_coupon_id
        FROM coupon_usage
       WHERE reversed_at IS NULL
    `;
    for (const usage of couponUsages) couponUsageByOrderId.set(usage.order_id, usage.user_coupon_id);

    const rows = await this.prisma.order.findMany({
      include: {
        amountSnapshot: true,
        items: true
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
        merchantId: order.merchantId ?? PLATFORM_MERCHANT_ID,
        shopId: order.shopId,
        merchantProductListingId: item.merchantProductListingId ?? item.platformShopProductId ?? item.productIdSnapshot,
        salesChannelType: order.salesChannelType as SalesChannelType,
        productType: "platform",
        productNameSnapshot: item.productNameSnapshot,
        quantity: item.quantity,
        quote: {
          paidAmountCents: amount.paidAmountCents,
          salePriceCents: item.salePriceCents,
          supplyAmountCents: amount.supplyAmountCents,
          serviceFeeCents: amount.serviceFeeCents,
          merchantExpectedIncomeCents: amount.merchantExpectedIncomeCents,
          serviceFeeBps: BigInt(amount.serviceFeeBps)
        },
        amountSnapshot: {
          serviceFeeBps: BigInt(amount.serviceFeeBps),
          paidAmountCents: amount.paidAmountCents,
          supplyAmountCents: amount.supplyAmountCents,
          serviceFeeCents: amount.serviceFeeCents,
          merchantExpectedIncomeCents: amount.merchantExpectedIncomeCents,
          serviceFeeEnabled: amount.serviceFeeEnabled,
          serviceFeeBasisAmountCents: amount.serviceFeeBasisAmountCents,
          serviceFeeConfigSnapshot: amount.serviceFeeConfigSnapshotJson,
          paymentFeeBps: BigInt(amount.paymentFeeBps),
          paymentFeeCents: amount.paymentFeeCents,
          balancePaidCents: amount.balancePaidCents,
          externalPaidCents: amount.externalPaidCents
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
        merchantId: order.merchantId ?? PLATFORM_MERCHANT_ID,
        shopId: order.shopId,
        merchantProductListingId: item.merchantProductListingId ?? item.platformShopProductId ?? item.productIdSnapshot,
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
        buyerPhone: order.buyerPhone ?? undefined,
        extractionCodeSet: Boolean(order.purchasePasswordHash),
        couponId: couponUsageByOrderId.get(order.id),
        couponDiscountCents: order.couponDiscountCents,
        buyerPaidAmountCents: order.paidAmountCents,
        collectionPaymentConfigId: undefined,
        collectionPaymentSnapshot: order.collectionSnapshotJson as unknown as PaymentMethodPublicSnapshot | undefined,
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
      void_reason: string | null;
      created_at: Date;
      updated_at: Date;
    }>>`
      SELECT id, coupon_template_id, user_id, status, source_type, source_id, void_reason, created_at, updated_at
        FROM user_coupons
    `;
    for (const row of userCoupons) {
      store.userCoupons.set(row.id, {
        id: row.id,
        templateId: row.coupon_template_id,
        userId: row.user_id,
        status: row.status === "voided" && row.void_reason === "voided_after_refund"
          ? "voided_after_refund"
          : row.status === "active" ? "available" : mapUserCouponMemoryStatus(row.status),
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
      tier: MerchantTier;
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

    store.channelAuthorizations = [];
    store.channelRelations = [];
    store.channelProductOffers = [];
  }

  private async loadFinancialState(store: MemoryStore) {
    const settlements = await this.prisma.$queryRaw<Array<{
      settlement_no: string;
      merchant_id: string;
      status: string;
      total_order_count: number;
      total_paid_cents: bigint;
      total_service_fee_cents: bigint;
      total_merchant_income_cents: bigint;
      idempotency_key: string;
    }>>`
      SELECT settlement_no, merchant_id, status, total_order_count, total_paid_cents,
             total_service_fee_cents, total_merchant_income_cents, idempotency_key
        FROM settlement_sheets
    `;
    store.settlementSheets = settlements.map((row) => ({
      settlementNo: row.settlement_no,
      merchantId: row.merchant_id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      items: [],
      totalOrderCount: row.total_order_count,
      totalPaidCents: row.total_paid_cents,
      totalServiceFeeCents: row.total_service_fee_cents,
      totalMerchantIncomeCents: row.total_merchant_income_cents
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
      merchant_id: string | null;
      amount_cents: bigint;
      source_type: string;
      source_id: string;
      created_at: Date;
    }>>`
      SELECT ledger_no, entry_type, merchant_id, amount_cents, source_type, source_id, created_at
        FROM ledger_entries
       ORDER BY created_at DESC
       LIMIT 500
    `;
    store.ledgerEntries = ledgers.map((row) => ({
      ledgerNo: row.ledger_no,
      entryType: row.entry_type,
      merchantId: row.merchant_id ?? undefined,
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
  return fulfillmentMode(snapshot) === "code_pool";
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

type PaymentCredentialBundle = {
  merchantNo?: string;
  appId?: string;
  serviceProviderId?: string;
  signingSecret?: string;
};

function encryptPaymentCredentialBundle(bundle: PaymentCredentialBundle) {
  const clean = Object.fromEntries(Object.entries(bundle).filter(([, value]) => typeof value === "string" && value.length > 0));
  if (Object.keys(clean).length === 0) return undefined;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", paymentCredentialKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(clean), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes256gcm:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptPaymentCredentialBundle(value?: string | null): PaymentCredentialBundle {
  if (!value?.startsWith("aes256gcm:")) return {};
  try {
    const [, ivBase64, tagBase64, ciphertextBase64] = value.split(":");
    if (!ivBase64 || !tagBase64 || !ciphertextBase64) return {};
    const decipher = createDecipheriv("aes-256-gcm", paymentCredentialKey(), Buffer.from(ivBase64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagBase64, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextBase64, "base64url")), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plaintext);
    if (!isRecord(parsed)) return {};
    return {
      merchantNo: stringValue(parsed.merchantNo),
      appId: stringValue(parsed.appId),
      serviceProviderId: stringValue(parsed.serviceProviderId),
      signingSecret: stringValue(parsed.signingSecret)
    };
  } catch {
    return {};
  }
}

function paymentCredentialKey() {
  const source = process.env.PAYMENT_CREDENTIAL_SECRET
    ?? process.env.AUTH_TOKEN_SECRET
    ?? process.env.ADMIN_TOKEN_SECRET
    ?? process.env.JWT_SECRET
    ?? "tosell-local-development-payment-credential-secret";
  return createHash("sha256").update(source).digest();
}

function signEpayParams(params: Record<string, unknown>, signingSecret: string) {
  const payload = Object.keys(params)
    .filter((key) => key !== "sign" && key !== "sign_type")
    .sort()
    .map((key) => {
      const value = params[key];
      return value === undefined || value === null || value === "" ? undefined : `${key}=${String(value)}`;
    })
    .filter((item): item is string => Boolean(item))
    .join("&");
  return createHash("md5").update(`${payload}${signingSecret}`).digest("hex").toLowerCase();
}

function normalizeEpayCallbackPayload(rawPayload: Record<string, unknown>) {
  const orderNo = requiredCallbackString(rawPayload.out_trade_no, "out_trade_no");
  return {
    orderNo,
    providerTradeNo: stringValue(rawPayload.trade_no) ?? orderNo,
    amountCents: yuanStringToCents(requiredCallbackString(rawPayload.money, "money")),
    merchantNo: requiredCallbackString(rawPayload.pid, "pid"),
    tradeStatus: normalizeEpayTradeStatus(stringValue(rawPayload.trade_status))
  };
}

function normalizeEpayTradeStatus(status?: string) {
  if (!status) return "UNKNOWN";
  return ["TRADE_SUCCESS", "SUCCESS", "PAID"].includes(status) ? "TRADE_SUCCESS" : status;
}

function requiredCallbackString(value: unknown, field: string) {
  const result = stringValue(value);
  if (!result) throw new ApiError(400, "PAYMENT_CALLBACK_FIELD_MISSING", `${field} is required`);
  return result;
}

function yuanStringToCents(value: string) {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) throw new ApiError(400, "PAYMENT_CALLBACK_AMOUNT_INVALID", "epay money is invalid");
  const [yuan, fraction = ""] = normalized.split(".");
  return BigInt(yuan) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function centsString(value: bigint) {
  const yuan = value / 100n;
  const cents = value % 100n;
  return `${yuan.toString()}.${cents.toString().padStart(2, "0")}`;
}

function appendQuery(url: string, params: Record<string, string>) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) parsed.searchParams.set(key, value);
  return parsed.toString();
}

function epayGatewayEndpoints(gatewayUrl: string) {
  const trimmed = gatewayUrl.trim();
  if (/\/mapi\.php(?:\?.*)?$/i.test(trimmed)) {
    return {
      mapiUrl: trimmed,
      submitUrl: trimmed.replace(/\/mapi\.php(?:\?.*)?$/i, "/submit.php")
    };
  }
  if (/\/submit\.php(?:\?.*)?$/i.test(trimmed)) {
    return {
      submitUrl: trimmed,
      mapiUrl: trimmed.replace(/\/submit\.php(?:\?.*)?$/i, "/mapi.php")
    };
  }
  const base = trimmed.replace(/\/+$/, "");
  return {
    submitUrl: `${base}/submit.php`,
    mapiUrl: `${base}/mapi.php`
  };
}

async function requestEpayMapi(mapiUrl: string, submitParams: Record<string, string>) {
  if (/\.example\.test\b/i.test(mapiUrl)) return { ok: false, message: "mapi skipped for test gateway" };
  try {
    const response = await fetch(mapiUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(submitParams),
      signal: AbortSignal.timeout(5000)
    });
    const rawText = await response.text();
    const payload = parseJsonObject(rawText);
    if (!response.ok) return { ok: false, message: `mapi http ${response.status}` };
    if (!payload) return { ok: false, message: "mapi returned non-json response" };
    const directAppUrl = findUrlInObject(payload, ["appurl", "app_url", "alipay_url", "alipays_url", "deeplink", "deep_link", "scheme_url", "scheme"]);
    const cashierUrl = findUrlInObject(payload, ["payurl", "pay_url", "payment_url", "jump_url", "h5_url", "url", "checkout_url"]);
    const qrCodeUrl = findUrlInObject(payload, ["qrcode", "qr_code", "code_url", "qrurl"]);
    const message = stringValue(payload.msg) ?? stringValue(payload.message);
    return {
      ok: Boolean(directAppUrl || cashierUrl || qrCodeUrl),
      directAppUrl,
      cashierUrl,
      qrCodeUrl,
      message
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "mapi request failed" };
  }
}

function parseJsonObject(rawText: string) {
  try {
    const parsed = JSON.parse(rawText);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function findUrlInObject(value: unknown, preferredKeys: string[], depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string" && isPaymentNavigationUrl(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUrlInObject(item, preferredKeys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of preferredKeys) {
    const found = findUrlInObject(value[key], preferredKeys, depth + 1);
    if (found) return found;
  }
  for (const nested of Object.values(value)) {
    const found = findUrlInObject(nested, preferredKeys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function isPaymentNavigationUrl(value: string) {
  return /^(https?:\/\/|alipays?:\/\/|weixin:\/\/)/i.test(value);
}

function publicSiteUrl() {
  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined;
  const url = process.env.TOSELL_PUBLIC_URL
    ?? process.env.PUBLIC_SITE_URL
    ?? process.env.PUBLIC_BASE_URL
    ?? process.env.APP_URL
    ?? vercelUrl
    ?? (isProductionRuntime() ? undefined : "http://localhost:5174");
  return required(url, "TOSELL_PUBLIC_URL").replace(/\/+$/, "");
}

function publicApiUrl() {
  const vercelUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined;
  const url = process.env.TOSELL_API_PUBLIC_URL
    ?? process.env.API_PUBLIC_URL
    ?? process.env.PUBLIC_API_URL
    ?? process.env.API_BASE_URL
    ?? vercelUrl
    ?? (isProductionRuntime() ? undefined : "http://localhost:3000");
  return required(url, "TOSELL_API_PUBLIC_URL").replace(/\/+$/, "");
}

function absoluteCallbackUrl(path: string) {
  if (/^https?:\/\//.test(path)) return path;
  return `${publicApiUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

function safeEqualHex(left: string, right: string) {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  const leftBuffer = Buffer.from(normalizedLeft, "utf8");
  const rightBuffer = Buffer.from(normalizedRight, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function orderProductNameForPayment(order: DemoOrder) {
  return String(order.snapshot.productNameSnapshot ?? order.merchantProductListingId ?? order.orderNo).slice(0, 80);
}

function productNameFromSnapshot(snapshot: unknown, fallback: string) {
  if (isRecord(snapshot)) {
    const name = stringValue(snapshot.name) ?? stringValue(snapshot.productName) ?? stringValue(snapshot.productNameSnapshot);
    if (name) return name.slice(0, 80);
  }
  return fallback.slice(0, 80);
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

function mapMerchantStatus(status: string): "draft" | "pending_review" | "rejected" | "pending_deposit" | "active" | "frozen" | "disabled" | "exit_observation" | "exited" {
  return ["draft", "pending_review", "rejected", "pending_deposit", "active", "frozen", "disabled", "exit_observation", "exited"].includes(status)
    ? status as ReturnType<typeof mapMerchantStatus>
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

function mapProductListingStatus(status: string): "draft" | "pending_review" | "rejected" | "approved" | "listed" | "delisted" | "risk_removed" {
  return ["draft", "pending_review", "rejected", "approved", "listed", "delisted", "risk_removed"].includes(status)
    ? status as ReturnType<typeof mapProductListingStatus>
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

function mapAfterSaleStatus(status: string): "pending" | "merchant_processing" | "platform_intervening" | "refund_approved" | "refunding" | "refunded" | "rejected" | "cancelled" {
  return ["pending", "merchant_processing", "platform_intervening", "refund_approved", "refunding", "refunded", "rejected", "cancelled"].includes(status)
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

function mapActorType(status: string): "user" | "merchant" | "admin" | "system" {
  if (status === "user" || status === "merchant" || status === "system") return status;
  if (status === "admin" || status === "operator" || status === "finance") return "admin";
  return "system";
}

function mapLedgerEntryType(status: string): "ORDER_MERCHANT_INCOME_PENDING" | "ORDER_SERVICE_FEE_ACCRUAL" | "ORDER_PLATFORM_SELF_REVENUE" | "ORDER_PLATFORM_SELF_COST" | "ORDER_PAYMENT_CHANNEL_FEE" | "ORDER_FIRST_TIER_INCOME_PENDING" | "ORDER_SECOND_TIER_INCOME_PENDING" | "ORDER_THIRD_TIER_INCOME_PENDING" | "REFUND_MERCHANT_BEAR" | "REFUND_PLATFORM_BEAR" | "REFUND_FIRST_TIER_BEAR" | "REFUND_SECOND_TIER_BEAR" | "REFUND_THIRD_TIER_BEAR" | "SERVICE_FEE_REFUND" | "SETTLEMENT_LOCK" | "SETTLEMENT_PAYOUT" | "CLAWBACK_CREATE" | "CLAWBACK_DEDUCT_PENDING" | "CLAWBACK_DEDUCT_PAYOUT" | "CLAWBACK_DEDUCT_DEPOSIT" | "DEPOSIT_PAY" | "DEPOSIT_DEDUCT" | "DEPOSIT_REFUND" | "RISK_FREEZE" | "RISK_UNFREEZE" | "MANUAL_ADJUST" {
  if (status === "ORDER_MERCHANT_INCOME_PENDING" || status === "ORDER_PLATFORM_SELF_REVENUE") return status;
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

function mapPaymentProviderToDb(provider: PaymentProviderType): "alipay_merchant" | "wechat_merchant" | "epay" | "alipay_personal" | "wechat_personal" | "balance" {
  return provider === "personal_alipay" ? "alipay_personal" : provider;
}

function mapPaymentProviderFromDb(provider: string): PaymentProviderType {
  return provider === "alipay_personal" ? "personal_alipay" : provider as PaymentProviderType;
}

function mapPaymentConfirmModeToDb(mode: "automatic" | "manual"): "callback_query" | "manual_confirm" {
  return mode === "manual" ? "manual_confirm" : "callback_query";
}

function mapPaymentConfirmModeToDbForProvider(provider: PaymentProviderType, mode: "automatic" | "manual"): "callback_query" | "manual_confirm" | "balance_deduct" {
  if (provider === "balance") return "balance_deduct";
  return mapPaymentConfirmModeToDb(mode);
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

function mapPaymentConfirmSource(source?: "callback" | "query" | "manual" | "balance"): "unconfirmed" | "callback" | "query" | "manual_confirm" | "balance" {
  if (source === "callback" || source === "query") return source;
  if (source === "manual") return "manual_confirm";
  if (source === "balance") return "balance";
  return "unconfirmed";
}

function mapPaymentConfirmSourceFromDb(source: string): PaymentSnapshot["confirmationSource"] | undefined {
  if (source === "callback" || source === "query") return source;
  if (source === "manual_confirm") return "manual";
  if (source === "balance") return "balance";
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
  if (provider === "wechat_merchant" || provider === "wechat_personal") return "wechat_h5";
  return "alipay_wap";
}

function paymentChannelForProvider(provider: PaymentProviderType): PaymentChannel {
  if (provider === "wechat_merchant" || provider === "wechat_personal") return "wechat_h5";
  if (provider === "epay") return "epay";
  if (provider === "balance") return "balance";
  return "alipay_wap";
}

function paymentChannelProvider(channel: PaymentChannel): PaymentProviderType | "wechat_miniprogram" | "wechat_h5_jsapi" | "mock" {
  if (channel === "wechat_h5") return "wechat_merchant";
  if (channel === "wechat_h5_jsapi") return "wechat_h5_jsapi";
  if (channel === "wechat_miniprogram") return "wechat_miniprogram";
  if (channel === "epay") return "epay";
  if (channel === "balance") return "balance";
  if (channel === "mock") return "mock";
  return "alipay_merchant";
}

function paymentChannelDisplay(channel: PaymentChannel) {
  if (channel === "wechat_miniprogram") return "微信小程序";
  if (channel === "wechat_h5_jsapi") return "微信 JSAPI";
  if (channel === "wechat_h5") return "微信商户";
  if (channel === "alipay_wap") return "支付宝商户";
  if (channel === "epay") return "e支付";
  if (channel === "balance") return "余额支付";
  return "开发模拟";
}

function isManualPaymentProvider(provider: PaymentProviderType) {
  return provider === "personal_alipay" || provider === "wechat_personal";
}

function defaultPaymentApiMode(provider: PaymentProviderType): PaymentApiMode | undefined {
  return provider === "epay" ? "mapi_first" : undefined;
}

function parsePaymentApiMode(value?: string | null): PaymentApiMode | undefined {
  return value === "submit" || value === "mapi_first" ? value : undefined;
}

function paymentProviderDisplay(provider: PaymentProviderType) {
  if (provider === "wechat_merchant") return "微信商户";
  if (provider === "wechat_personal") return "微信个人";
  if (provider === "alipay_merchant") return "支付宝商户";
  if (provider === "personal_alipay") return "支付宝个人";
  if (provider === "epay") return "e支付";
  return "余额支付";
}

function paymentProviderPublicLabel(provider: PaymentProviderType, feeBps: number) {
  const suffix = feeBps === 0 ? "" : `+${(feeBps / 100).toFixed(0)}%`;
  if (provider === "balance") return "余额支付";
  if (provider === "wechat_merchant") return `微信${suffix}（商家）`;
  if (provider === "wechat_personal") return `微信${suffix}（个人）`;
  if (provider === "alipay_merchant") return `支付宝${suffix}（商家）`;
  if (provider === "personal_alipay") return `支付宝${suffix}（个人）`;
  return `e支付${suffix}（商家）`;
}

function paymentProviderSort(provider: PaymentProviderType) {
  return provider === "balance" ? 0 : isManualPaymentProvider(provider) ? 2 : 1;
}

function dedupePublicPaymentChannels<T extends { provider?: PaymentProviderType; id?: string; isDefault?: boolean; sortOrder?: number }>(channels: T[]) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const channel of channels) {
    const key = channel.provider ?? channel.id ?? "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(channel);
  }
  return result.sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || (left.sortOrder ?? 0) - (right.sortOrder ?? 0));
}

function paymentDisplayTypeForProvider(provider: PaymentProviderType): PaymentDisplayType {
  if (provider === "wechat_merchant") return "wechat_merchant_link";
  if (provider === "wechat_personal") return "wechat_personal_qr";
  if (provider === "epay") return "epay_link";
  if (provider === "personal_alipay") return "alipay_personal_qr";
  return "alipay_merchant_link";
}

function providerCallbackUrlForPersistence(provider: PaymentProviderType) {
  return `/api/callbacks/payments/${provider}`;
}

function serializePaymentMethodForPersistence(method: PaymentMethodConfig) {
  return {
    id: method.id,
    ownerType: method.ownerType,
    merchantId: method.merchantId,
    shopId: method.shopId,
    provider: method.provider,
    confirmationMode: method.confirmationMode,
    displayName: method.displayName,
    productType: method.productType,
    merchantNoMasked: maskSecret(method.merchantNo),
    appIdMasked: maskSecret(method.appId),
    serviceProviderMasked: maskSecret(method.serviceProviderId),
    gatewayUrl: method.gatewayUrl,
    apiMode: method.apiMode ?? defaultPaymentApiMode(method.provider),
    accountName: isManualPaymentProvider(method.provider) ? method.accountName : maskSecret(method.accountName),
    qrUrl: isManualPaymentProvider(method.provider) ? method.qrUrl : undefined,
    paymentUrl: isManualPaymentProvider(method.provider) ? method.paymentUrl : undefined,
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

function mapPaymentDisplayType(type: PaymentDisplayType): "wechat_qr" | "alipay_qr" | "bank_transfer" | "other" {
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

const PLATFORM_MERCHANT_ID = "platform";

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

function optionalTrimmedText(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function normalizeOptionalStringArray(value: string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const next = value.map((item) => item.trim()).filter(Boolean);
  return next.length ? next : undefined;
}

function normalizeOptionalDetailSections(value: ProductDetailSection[] | undefined): ProductDetailSection[] | undefined {
  if (!value) return undefined;
  const next = value
    .map((section) => ({
      title: section.title.trim(),
      items: section.items.map((item) => item.trim()).filter(Boolean)
    }))
    .filter((section) => section.title && section.items.length > 0);
  return next.length ? next : undefined;
}

function maxBigInt(values: Array<bigint | undefined | null>): bigint {
  return values
    .filter((value): value is bigint => typeof value === "bigint")
    .reduce((max, value) => value > max ? value : max, 0n);
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

  store.merchants.set("merchant-1", { id: "merchant-1", userId: "merchant-user-1", name: "测试代理 A", tier: "first_tier", status: "active", riskStatus: "normal", depositStatus: "paid", contactPhone: "13800000000" });
  store.merchants.set("merchant-2", { id: "merchant-2", userId: "merchant-user-2", name: "测试代理 B", tier: "second_tier", parentMerchantId: "merchant-1", status: "active", riskStatus: "normal", depositStatus: "paid", contactPhone: "13900000000" });
  store.merchants.set("merchant-3", { id: "merchant-3", userId: "merchant-user-3", name: "测试代理 C", tier: "third_tier", parentMerchantId: "merchant-2", status: "active", riskStatus: "normal", depositStatus: "paid", contactPhone: "13700000000" });
  store.merchants.set("merchant-new", { id: "merchant-new", userId: "merchant-user-new", name: "新代理", tier: "first_tier", status: "draft", riskStatus: "normal", depositStatus: "pending_payment" });
  store.shops.set("shop-1", {
    id: "shop-1",
    merchantId: "merchant-1",
    name: virtualShopSeed.name,
    status: "open",
    riskStatus: "normal",
    announcement: virtualShopSeed.announcement,
    customerServiceWechat: virtualShopSeed.customerServiceWechat,
    customerServiceQrUrl: "https://example.test/qr-merchant-a.png",
    collectionAccountName: virtualShopSeed.collectionAccountName,
    collectionQrUrl: "https://example.test/pay-merchant-a.png",
    collectionNote: virtualShopSeed.collectionNote,
    themeColor: virtualShopSeed.themeColor,
    bannerUrl: virtualShopSeed.bannerUrl,
    shareTitle: virtualShopSeed.shareTitle,
    productGroups: virtualShopSeed.productGroups.map((group) => ({
      name: group.name,
      merchantProductListingIds: group.merchantListingSeedIds
    }))
  });
  store.shops.set("shop-2", { id: "shop-2", merchantId: "merchant-2", ownerType: "merchant", name: "测试代理 B 小店", status: "open", riskStatus: "normal", customerServiceWechat: "merchant_b_service", customerServiceQrUrl: "https://example.test/qr-merchant-b.png", collectionAccountName: "测试代理B人工收款", collectionQrUrl: "https://example.test/pay-merchant-b.png", collectionNote: "二级店铺人工收款码" });
  store.shops.set("shop-3", { id: "shop-3", merchantId: "merchant-3", ownerType: "merchant", name: "测试代理 C 小店", status: "open", riskStatus: "normal", customerServiceWechat: "merchant_c_service", customerServiceQrUrl: "https://example.test/qr-merchant-c.png", collectionAccountName: "测试代理C人工收款", collectionQrUrl: "https://example.test/pay-merchant-c.png", collectionNote: "三级店铺人工收款码" });
  store.shops.set("shop-new", { id: "shop-new", merchantId: "merchant-new", name: "新代理小店", status: "not_opened", riskStatus: "normal" });
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
    productGroups: [{ name: "官方精选", merchantProductListingIds: ["psp-1", "psp-code"] }]
  });
  seedPaymentMethod(store, {
    id: "collection-shop-1",
    shopId: "shop-1",
    merchantId: "merchant-1",
    ownerType: "merchant",
    provider: "personal_alipay",
    displayName: "支付宝个人收款码",
    accountName: virtualShopSeed.collectionAccountName,
    qrUrl: "https://example.test/pay-merchant-a.png",
    isDefault: true,
    sortOrder: 10
  });
  seedPaymentMethod(store, {
    id: "collection-shop-2",
    shopId: "shop-2",
    merchantId: "merchant-2",
    ownerType: "merchant",
    provider: "wechat_personal",
    displayName: "微信个人收款码",
    accountName: "测试代理B人工收款",
    qrUrl: "https://example.test/pay-merchant-b.png",
    isDefault: true,
    sortOrder: 10
  });
  seedPaymentMethod(store, {
    id: "collection-shop-3",
    shopId: "shop-3",
    merchantId: "merchant-3",
    ownerType: "merchant",
    provider: "personal_alipay",
    displayName: "支付宝个人收款码",
    accountName: "测试代理C人工收款",
    qrUrl: "https://example.test/pay-merchant-c.png",
    isDefault: true,
    sortOrder: 10
  });
  seedPaymentMethod(store, {
    id: "collection-platform-personal-alipay",
    shopId: "shop-platform",
    ownerType: "platform",
    provider: "personal_alipay",
    displayName: "平台个人支付宝",
    accountName: "ToSell 平台自营人工收款",
    qrUrl: "https://example.test/pay-platform.png",
    isDefault: true,
    sortOrder: 10
  });
  seedPaymentMethod(store, {
    id: "collection-platform-epay",
    shopId: "shop-platform",
    ownerType: "platform",
    provider: "epay",
    displayName: "平台 e支付",
    merchantNo: "10783",
    gatewayUrl: "https://xpay.uumua.com/xpay/epay/",
    signingSecret: "dev-epay-signing-secret",
    apiMode: "submit",
    isDefault: false,
    sortOrder: 20
  });
  seedMemoryCatalog(store);
  store.notifications.push({ id: "notice-1", merchantId: "merchant-1", type: "system", title: "V2 经营工具已开启", content: "可以使用店铺装修、批量选品、权益码自动履约和经营看板。", createdAt: new Date(), readAt: null });
  store.depositAccounts.set("merchant-1", { merchantId: "merchant-1", requiredAmountCents: 50_000n, availableAmountCents: 50_000n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "paid" });
  store.depositAccounts.set("merchant-2", { merchantId: "merchant-2", requiredAmountCents: 50_000n, availableAmountCents: 50_000n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "paid" });
  store.depositAccounts.set("merchant-3", { merchantId: "merchant-3", requiredAmountCents: 50_000n, availableAmountCents: 50_000n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "paid" });
  store.depositAccounts.set("merchant-new", { merchantId: "merchant-new", requiredAmountCents: 50_000n, availableAmountCents: 0n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "pending_payment" });
  store.channelAuthorizations.push({ id: "channel-auth-1", firstTierMerchantId: "merchant-1", status: "active", reason: null, reviewedAt: new Date() });
  store.channelRelations.push({ id: "channel-rel-1", firstTierMerchantId: "merchant-1", secondTierMerchantId: "merchant-2", status: "active", reason: null, reviewedAt: new Date(), activeUniqueKey: "second-tier:merchant-2" });
  store.channelRelations.push({ id: "channel-rel-2", firstTierMerchantId: "merchant-1", secondTierMerchantId: "merchant-2", thirdTierMerchantId: "merchant-3", status: "active", reason: null, reviewedAt: new Date(), activeUniqueKey: "third-tier:merchant-3" });
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
    depositRequiredAmountCents: store.depositAccounts.get("merchant-1")?.requiredAmountCents,
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
    merchantApplications: new Map(),
    merchants: new Map(),
    shops: new Map(),
    platformProducts: new Map(),
    platformShopProducts: new Map(),
    ownProducts: new Map(),
    merchantProductListings: new Map(),
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
        paymentMethods: new Map(),
    paymentCallbackLogs: [],
    paymentExceptions: [],
    extractLogs: [],
    emailDeliveries: [],
    serviceFeeConfig: {
      id: "service-fee-default",
      enabled: true,
      feeBps: 50,
      basisType: "final_sale_price",
      status: "active",
      updatedAt: new Date()
    },
    userWallets: new Map(),
    walletRecharges: new Map(),
    walletHolds: new Map(),
    walletTransactions: [],
    paymentChannelConfigs: [
      { channel: "mock", enabled: true, feeBps: 100, fixedFeeCents: 0n, statusNote: "dev_only", updatedAt: new Date() },
      { channel: "wechat_miniprogram", enabled: false, feeBps: 100, fixedFeeCents: 0n, statusNote: "merchant_account_required", updatedAt: new Date() },
      { channel: "wechat_h5_jsapi", enabled: false, feeBps: 100, fixedFeeCents: 0n, statusNote: "merchant_account_required", updatedAt: new Date() },
      { channel: "wechat_h5", enabled: false, feeBps: 100, fixedFeeCents: 0n, statusNote: "merchant_account_required", updatedAt: new Date() },
      { channel: "alipay_wap", enabled: false, feeBps: 100, fixedFeeCents: 0n, statusNote: "alipay_account_required", updatedAt: new Date() },
      { channel: "epay", enabled: false, feeBps: 100, fixedFeeCents: 0n, statusNote: "merchant_account_required", updatedAt: new Date() },
      { channel: "balance", enabled: true, feeBps: 0, fixedFeeCents: 0n, statusNote: "wallet_balance_ready", updatedAt: new Date() }
    ],
    pendingIncomeByMerchant: new Map(),
    payableIncomeByMerchant: new Map(),
    paidIncomeByMerchant: new Map()
  };
}

const storeMapKeys = [
  "merchantApplications",
  "merchants",
  "shops",
  "platformProducts",
  "platformShopProducts",
  "ownProducts",
  "merchantProductListings",
  "depositAccounts",
  "orders",
  "afterSales",
  "refunds",
  "fulfillmentRecords",
  "paymentVouchers",
  "couponTemplates",
  "userCoupons",
  "inviteCodes",
  "paymentMethods",
  "userWallets",
  "walletRecharges",
  "walletHolds"
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
  output.pendingIncomeByMerchant = [...store.pendingIncomeByMerchant.entries()];
  output.payableIncomeByMerchant = [...store.payableIncomeByMerchant.entries()];
  output.paidIncomeByMerchant = [...store.paidIncomeByMerchant.entries()];
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
  store.pendingIncomeByMerchant = new Map(Array.isArray(decoded.pendingIncomeByMerchant) ? decoded.pendingIncomeByMerchant as Array<[string, bigint]> : []);
  store.payableIncomeByMerchant = new Map(Array.isArray(decoded.payableIncomeByMerchant) ? decoded.payableIncomeByMerchant as Array<[string, bigint]> : []);
  store.paidIncomeByMerchant = new Map(Array.isArray(decoded.paidIncomeByMerchant) ? decoded.paidIncomeByMerchant as Array<[string, bigint]> : []);
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

function seedPaymentMethod(store: MemoryStore, input: {
  id: string;
  shopId: string;
  merchantId?: string;
  ownerType: "platform" | "merchant";
  provider: PaymentProviderType;
  displayName: string;
  merchantNo?: string;
  appId?: string;
  serviceProviderId?: string;
  gatewayUrl?: string;
  signingSecret?: string;
  apiMode?: PaymentApiMode;
  accountName?: string;
  qrUrl?: string;
  paymentUrl?: string;
  isDefault: boolean;
  sortOrder: number;
}) {
  store.paymentMethods.set(input.id, {
    id: input.id,
    ownerType: input.ownerType,
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: input.provider,
    confirmationMode: isManualPaymentProvider(input.provider) ? "manual" : "automatic",
    displayName: input.displayName,
    merchantNo: input.merchantNo,
    appId: input.appId,
    serviceProviderId: input.serviceProviderId,
    gatewayUrl: input.gatewayUrl,
    signingSecret: input.signingSecret,
    apiMode: input.apiMode,
    accountName: input.accountName,
    qrUrl: input.qrUrl,
    paymentUrl: input.paymentUrl,
    enabled: true,
    status: "enabled",
    isDefault: input.isDefault,
    secretConfigured: isManualPaymentProvider(input.provider) ? false : Boolean(input.signingSecret) || input.provider !== "epay",
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
    store.merchantProductListings.set(item.merchantListingSeedId, {
      id: item.merchantListingSeedId,
      merchantId: "merchant-1",
      shopId: "shop-1",
      productType: "platform",
      platformProductId: item.demoId,
      ownProductReviewId: null,
      salePriceCents: item.merchantSalePriceCents,
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
  store.merchantProductListings.set("ap-2", { id: "ap-2", merchantId: "merchant-2", shopId: "shop-2", productType: "platform", platformProductId: "prod-1", ownProductReviewId: null, salePriceCents: 16_000n, status: "listed" });
  store.merchantProductListings.set("ap-3", { id: "ap-3", merchantId: "merchant-3", shopId: "shop-3", productType: "platform", platformProductId: "prod-1", ownProductReviewId: null, salePriceCents: 15_000n, status: "listed" });
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
  merchantIncomeCents: bigint;
  alreadyRefundedCents?: bigint;
  refundAmountCents: bigint;
  responsibility: RefundResponsibility;
  platformBearCents?: bigint;
  merchantBearCents?: bigint;
  serviceFeeBearer?: "platform" | "merchant" | "mixed" | "none";
};

type MerchantApplication = {
  applicationNo: string;
  merchantId: string;
  userId: string;
  status: string;
  contactPhone: string;
  customerServiceWechat: string;
  inviteCode?: string;
  inviteCodeId?: string;
  targetTier?: MerchantTier;
  parentMerchantId?: string;
};

type MerchantTier = "first_tier" | "second_tier" | "third_tier";

type DemoMerchant = {
  id: string;
  userId: string;
  name: string;
  contactPhone?: string;
  tier?: MerchantTier;
  parentMerchantId?: string;
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
  ownerType?: "platform" | "merchant";
  merchantId?: string;
  shopNo?: string;
  sharePath?: string;
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
  productGroups?: Array<{ name: string; merchantProductListingIds: string[] }>;
};

type PublicShopRow = {
  id: string;
  owner_type: "platform" | "merchant";
  merchant_id: string | null;
  shop_no: string;
  name: string;
  share_path: string;
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
  merchantId: string;
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

type MerchantProductListingDisplayOverrideInput = {
  displayName?: string;
  displaySubtitle?: string;
  displayDescription?: string;
  displayUsageGuide?: string;
  displayImageUrl?: string;
  displayCategory?: string;
  displayTags?: string[];
  displaySpecs?: string[];
  displayDetailSections?: ProductDetailSection[];
};

type MerchantProductListingSelectionInput = MerchantProductListingDisplayOverrideInput & {
  platformProductId: string;
  salePriceCents: bigint;
};

type MerchantProductListingDetailUpdateInput = MerchantProductListingDisplayOverrideInput & {
  salePriceCents?: bigint;
  status?: string;
};

type DemoMerchantProductListing = {
  id: string;
  merchantId: string;
  shopId: string;
  productType: "platform" | "merchant_owned";
  platformProductId?: string | null;
  ownProductReviewId?: string | null;
  salePriceCents: bigint;
  displayName?: string;
  displaySubtitle?: string;
  displayDescription?: string;
  displayUsageGuide?: string;
  displayImageUrl?: string;
  displayCategory?: string;
  displayTags?: string[];
  displaySpecs?: string[];
  displayDetailSections?: ProductDetailSection[];
  status: string;
  groupName?: string;
};

type SalesChannelType = "platform_self_operated" | "single_merchant" | "two_tier" | "three_tier";
type PaymentChannel = "wechat_miniprogram" | "wechat_h5_jsapi" | "wechat_h5" | "alipay_wap" | "epay" | "balance" | "mock";
type PaymentProviderType = "alipay_merchant" | "wechat_merchant" | "epay" | "personal_alipay" | "wechat_personal" | "balance";
type PaymentApiMode = "mapi_first" | "submit";
type PaymentDisplayType =
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
type DemoAmountSnapshot = DemoOrderSnapshot["amountSnapshot"] & {
  serviceFeeEnabled?: boolean;
  serviceFeeBasisAmountCents?: bigint;
  serviceFeeConfigSnapshot?: unknown;
  paymentFeeBps?: bigint;
  paymentFeeCents?: bigint;
  balancePaidCents?: bigint;
  externalPaidCents?: bigint;
};

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
  merchantId: string;
  shopId: string;
  merchantProductListingId: string;
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
  buyerPhone?: string;
  extractionCodeSet?: boolean;
  extractionCodeHash?: string;
  extractionAttemptCount?: number;
  extractionLockedUntil?: Date | null;
  couponId?: string;
  couponDiscountCents?: bigint;
  buyerPaidAmountCents?: bigint;
  collectionPaymentConfigId?: string;
  collectionPaymentSnapshot?: PaymentMethodPublicSnapshot;
  preferredPaymentMethodId?: string;
  paymentSnapshot?: PaymentSnapshot;
  refundedAmountCents: bigint;
  snapshot: DemoOrderSnapshot;
};

type PlatformServiceFeeConfig = {
  id: string;
  enabled: boolean;
  feeBps: number;
  basisType: "final_sale_price" | "paid_amount";
  status: "active" | "disabled";
  updatedAt: Date;
  updatedBy?: string;
};

type UserWalletState = {
  id: string;
  userId: string;
  walletNo: string;
  availableBalanceCents: bigint;
  frozenBalanceCents: bigint;
  totalRechargeCents: bigint;
  totalSpendCents: bigint;
  status: "active" | "frozen" | "disabled";
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type WalletRecharge = {
  rechargeNo: string;
  userId: string;
  walletId: string;
  paymentMethodId?: string;
  provider: PaymentProviderType;
  confirmationMode: "automatic" | "manual";
  rechargeCents: bigint;
  feeBps: number;
  feeCents: bigint;
  payableCents: bigint;
  status: "pending_payment" | "paid" | "failed" | "cancelled" | "expired";
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  idempotencyKey: string;
};

type WalletPaymentHold = {
  holdNo: string;
  userId: string;
  walletId: string;
  orderNo: string;
  paymentNo?: string;
  amountCents: bigint;
  status: "active" | "captured" | "released" | "expired" | "cancelled";
  capturedAt?: Date;
  idempotencyKey: string;
};

type WalletTransactionState = {
  transactionNo: string;
  userId: string;
  walletId: string;
  type: "recharge" | "payment_hold" | "payment_capture" | "payment_release" | "refund" | "adjustment";
  direction: "credit" | "debit";
  amountCents: bigint;
  balanceBeforeCents: bigint;
  balanceAfterCents: bigint;
  frozenBeforeCents: bigint;
  frozenAfterCents: bigint;
  sourceType: string;
  sourceId: string;
  orderNo?: string;
  paymentNo?: string;
  rechargeNo?: string;
  holdNo?: string;
  note?: string;
  idempotencyKey: string;
  createdAt: Date;
};

type DemoAfterSale = {
  afterSaleNo: string;
  orderNo: string;
  userId: string;
  merchantId: string;
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
  merchantClawbackCents: bigint;
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
  merchantId: string;
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
  merchantId: string;
  idempotencyKey: string;
  status: string;
  items: Array<ReturnType<typeof buildSettlementItems>[number] & { settlementRole?: string }>;
  totalOrderCount: number;
  totalPaidCents: bigint;
  totalServiceFeeCents: bigint;
  totalMerchantIncomeCents: bigint;
};

type SettlementCandidateDraft = Parameters<typeof buildSettlementItems>[0][number];

type ChannelSnapshot = {
  relationId: string;
  firstTierMerchantId: string;
  firstTierShopId: string;
  secondTierMerchantId: string;
  secondTierShopId: string;
  thirdTierMerchantId?: string;
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
  merchantId?: string;
  amountCents: bigint;
  metadata: unknown;
  createdAt: Date;
};

type RightsCode = {
  codeId: string;
  productId: string;
  platformProductId?: string;
  merchantProductListingId?: string;
  merchantProductId?: string;
  code: string;
  batchNo: string;
  status: "available" | "locked" | "issued" | "voided";
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
  merchantId: string;
  type: string;
  title: string;
  content: string;
  createdAt: Date;
  readAt: Date | null;
};

type ChannelAuthorization = {
  id: string;
  firstTierMerchantId: string;
  status: string;
  reason: string | null;
  reviewedAt: Date | null;
};

type ChannelRelation = {
  id: string;
  firstTierMerchantId: string;
  secondTierMerchantId: string;
  thirdTierMerchantId?: string;
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
  ownerType: "platform" | "merchant";
  merchantId?: string;
  shopId?: string;
  provider: PaymentProviderType;
  confirmationMode: "automatic" | "manual";
  displayName: string;
  productType?: string;
  merchantNo?: string;
  appId?: string;
  serviceProviderId?: string;
  gatewayUrl?: string;
  apiMode?: PaymentApiMode;
  accountName?: string;
  qrUrl?: string;
  paymentUrl?: string;
  note?: string;
  returnUrl?: string;
  enabled: boolean;
  status: "pending_test" | "enabled" | "disabled" | "paused";
  isDefault: boolean;
  signingSecret?: string;
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
  baseAmountCents?: bigint;
  feeBps?: number;
  feeCents?: bigint;
  amountCents?: bigint;
  currency?: string;
  orderNo?: string;
  providerPaymentNo?: string;
  providerTradeNo?: string;
  status?: string;
  confirmationSource?: "callback" | "query" | "manual" | "balance";
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

type PaymentMethodPublicSnapshot = {
  id: string;
  shopId: string;
  ownerType: "platform" | "merchant";
  channelType: PaymentDisplayType;
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
  issuerType: "platform" | "merchant";
  issuerMerchantId?: string;
  targetTier: MerchantTier;
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
  merchantApplications: Map<string, MerchantApplication>;
  merchants: Map<string, DemoMerchant>;
  shops: Map<string, DemoShop>;
  platformProducts: Map<string, DemoPlatformProduct>;
  platformShopProducts: Map<string, DemoPlatformShopProduct>;
  ownProducts: Map<string, DemoOwnProduct>;
  merchantProductListings: Map<string, DemoMerchantProductListing>;
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
  paymentMethods: Map<string, PaymentMethodConfig>;
  paymentCallbackLogs: PaymentCallbackLog[];
  paymentExceptions: PaymentException[];
  extractLogs: Array<Record<string, unknown>>;
  emailDeliveries: EmailDelivery[];
  paymentChannelConfigs: PaymentChannelConfig[];
  serviceFeeConfig: PlatformServiceFeeConfig;
  userWallets: Map<string, UserWalletState>;
  walletRecharges: Map<string, WalletRecharge>;
  walletHolds: Map<string, WalletPaymentHold>;
  walletTransactions: WalletTransactionState[];
  pendingIncomeByMerchant: Map<string, bigint>;
  payableIncomeByMerchant: Map<string, bigint>;
  paidIncomeByMerchant: Map<string, bigint>;
};

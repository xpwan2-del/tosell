import { PrismaClient, type Prisma } from "@prisma/client";

export type PrismaTx = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

type DbClient = PrismaClient | PrismaTx;

export type RepositoryContext = {
  prisma: PrismaClient;
};

export const P0_WRITE_CHAIN_CONTRACT = {
  manualFirstTierMerchant: ["merchants", "merchant_accounts", "shops", "deposit_accounts", "audit_logs"],
  merchantApplication: ["merchant_applications", "merchant_invite_codes", "merchants", "audit_logs"],
  depositConfirmation: ["deposit_accounts", "deposit_transactions", "ledger_entries", "audit_logs"],
  productAndOffer: ["platform_products", "merchant_product_listings", "merchant_products", "merchant_product_reviews", "audit_logs"],
  collectionPaymentConfig: ["collection_payment_configs", "shops", "audit_logs"],
  order: ["users", "orders", "order_items", "order_amount_snapshots", "coupon_usage", "ledger_entries", "audit_logs"],
  collectionConfirmation: ["payment_confirmations", "payments", "orders", "fulfillment_records", "fulfillment_attempts", "virtual_codes", "ledger_entries", "audit_logs"],
  fulfillment: ["fulfillment_records", "fulfillment_attempts", "virtual_codes", "order_extract_secrets", "order_extract_logs", "audit_logs"],
  afterSaleRefund: ["after_sales", "refunds", "refund_callbacks", "order_extract_secrets", "ledger_entries", "audit_logs"],
  coupons: ["coupon_templates", "coupon_scopes", "user_coupons", "coupon_grant_records", "coupon_usage", "coupon_void_records"],
  settlement: ["settlement_sheets", "settlement_items", "settlement_confirmations", "ledger_entries", "audit_logs"]
} as const;

export class TransactionService {
  constructor(private readonly prisma: PrismaClient) {}

  transaction<T>(
    fn: (tx: PrismaTx) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; maxWait?: number; timeout?: number }
  ) {
    return this.prisma.$transaction((tx) => fn(tx as PrismaTx), {
      isolationLevel: options?.isolationLevel ?? "Serializable",
      maxWait: options?.maxWait ?? 10_000,
      timeout: options?.timeout ?? 30_000
    });
  }

  createManualFirstTierMerchant<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  submitMerchantApplication<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  createInviteCode<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  confirmDeposit<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  upsertProductOffer<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  configureCollectionPaymentConfig<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  createOrder<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  confirmCollectionAndAutoFulfill<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  issueVirtualCodes<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  lockExtractSecret<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  revokeExtractAfterRefund<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  createAfterSaleRefund<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  useCoupon<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

  voidCoupon<T>(fn: (tx: PrismaTx) => Promise<T>) {
    return this.transaction(fn);
  }

}

class BaseRepository {
  constructor(protected readonly prisma: PrismaClient) {}

  protected db(tx?: PrismaTx): DbClient {
    return tx ?? this.prisma;
  }
}

export class ShopRepository extends BaseRepository {
  findPublicShopById(shopId: string) {
    return this.prisma.shop.findFirst({
      where: { id: shopId },
      include: { collectionPaymentConfigs: { where: { status: "active" }, orderBy: { isDefault: "desc" } } }
    });
  }

  updateCollectionFields(shopId: string, data: Pick<Prisma.ShopUncheckedUpdateInput, "collectionAccountName" | "collectionQrUrl" | "collectionNote">, tx?: PrismaTx) {
    return this.db(tx).shop.update({ where: { id: shopId }, data });
  }

  createCustomerServiceBinding(data: Prisma.ShopCustomerServiceBindingUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).shopCustomerServiceBinding.create({ data });
  }
}

export class MerchantRepository extends BaseRepository {
  findById(merchantId: string) {
    return this.prisma.merchant.findUnique({
      where: { id: merchantId },
      include: { accounts: true, shops: true, depositAccount: true }
    });
  }

  async createManualFirstTier(input: {
    merchant: Prisma.MerchantUncheckedCreateInput;
    account: Prisma.MerchantAccountUncheckedCreateInput;
    shop: Prisma.ShopUncheckedCreateInput;
    depositAccount: Prisma.DepositAccountUncheckedCreateInput;
    auditLog: Prisma.AuditLogUncheckedCreateInput;
  }, tx?: PrismaTx) {
    const run = async (db: DbClient) => {
      if (input.merchant.tier !== "first_tier" || input.merchant.creationSource !== "admin_manual") {
        throw new Error("manual merchant creation is limited to first_tier/admin_manual");
      }
      const merchant = await db.merchant.create({ data: input.merchant });
      const account = await db.merchantAccount.create({ data: { ...input.account, merchantId: merchant.id } });
      const shop = await db.shop.create({ data: { ...input.shop, merchantId: merchant.id } });
      const depositAccount = await db.depositAccount.create({ data: { ...input.depositAccount, merchantId: merchant.id } });
      const auditLog = await db.auditLog.create({ data: input.auditLog });
      return { merchant, account, shop, depositAccount, auditLog };
    };
    return tx ? run(tx) : new TransactionService(this.prisma).createManualFirstTierMerchant(run);
  }

  submitApplication(data: Prisma.MerchantApplicationUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).merchantApplication.create({ data });
  }

  reviewApplication(id: string, data: Prisma.MerchantApplicationUncheckedUpdateInput, tx?: PrismaTx) {
    return this.db(tx).merchantApplication.update({ where: { id }, data });
  }
}

export class MerchantInviteRepository extends BaseRepository {
  findUsableByCodeHash(codeHash: string) {
    return this.prisma.merchantInviteCode.findUnique({ where: { codeHash } });
  }

  create(data: Prisma.MerchantInviteCodeUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).merchantInviteCode.create({ data });
  }

  consume(id: string, tx?: PrismaTx) {
    return this.db(tx).merchantInviteCode.update({
      where: { id },
      data: { usedCount: { increment: 1 } }
    });
  }
}

export class AdminAuthRepository extends BaseRepository {
  findAdminWithRoles(adminId: string) {
    return this.prisma.adminUser.findUnique({
      where: { id: adminId },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } }
    });
  }

  findByUsername(username: string) {
    return this.prisma.adminUser.findUnique({
      where: { username },
      include: { roles: { include: { role: true } } }
    });
  }
}

export class ProductRepository extends BaseRepository {
  createPlatformProduct(data: Prisma.PlatformProductUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).platformProduct.create({ data });
  }

  createMerchantProductReview(data: Prisma.MerchantProductReviewUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).merchantProductReview.create({ data });
  }

  reviewMerchantProduct(id: string, data: Prisma.MerchantProductReviewUncheckedUpdateInput, tx?: PrismaTx) {
    return this.db(tx).merchantProductReview.update({ where: { id }, data });
  }

  upsertMerchantProduct(input: {
    shopId: string;
    productType: Prisma.MerchantProductUncheckedCreateInput["productType"];
    platformProductId: string;
    create: Prisma.MerchantProductUncheckedCreateInput;
    update: Prisma.MerchantProductUncheckedUpdateInput;
  }, tx?: PrismaTx) {
    return this.db(tx).merchantProduct.upsert({
      where: {
        shopId_productType_platformProductId: {
          shopId: input.shopId,
          productType: input.productType,
          platformProductId: input.platformProductId
        }
      },
      create: input.create,
      update: input.update
    });
  }

  upsertMerchantProductListing(input: {
    shopId: string;
    platformProductId: string;
    create: Prisma.MerchantProductListingUncheckedCreateInput;
    update: Prisma.MerchantProductListingUncheckedUpdateInput;
  }, tx?: PrismaTx) {
    return this.db(tx).merchantProductListing.upsert({
      where: {
        shopId_platformProductId: {
          shopId: input.shopId,
          platformProductId: input.platformProductId
        }
      },
      create: input.create,
      update: input.update
    });
  }
}

export class CollectionPaymentConfigRepository extends BaseRepository {
  create(data: Prisma.CollectionPaymentConfigUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).collectionPaymentConfig.create({ data });
  }

  review(id: string, data: Prisma.CollectionPaymentConfigUncheckedUpdateInput, tx?: PrismaTx) {
    return this.db(tx).collectionPaymentConfig.update({ where: { id }, data });
  }

  async setDefault(shopId: string, configId: string, tx?: PrismaTx) {
    const run = async (db: DbClient) => {
      await db.collectionPaymentConfig.updateMany({ where: { shopId }, data: { isDefault: false } });
      return db.collectionPaymentConfig.update({ where: { id: configId }, data: { isDefault: true } });
    };
    return tx ? run(tx) : new TransactionService(this.prisma).configureCollectionPaymentConfig(run);
  }
}

export class OrderRepository extends BaseRepository {
  createOrderGraph(input: {
    order: Prisma.OrderUncheckedCreateInput;
    items: Prisma.OrderItemUncheckedCreateInput[];
    amountSnapshot: Prisma.OrderAmountSnapshotUncheckedCreateInput;
    couponUsage?: Prisma.CouponUsageUncheckedCreateInput;
    ledgers?: Prisma.LedgerEntryUncheckedCreateInput[];
    auditLog: Prisma.AuditLogUncheckedCreateInput;
  }, tx?: PrismaTx) {
    const run = async (db: DbClient) => {
      const order = await db.order.create({ data: input.order });
      const items = await Promise.all(input.items.map((data) => db.orderItem.create({ data: { ...data, orderId: order.id } })));
      const amountSnapshot = await db.orderAmountSnapshot.create({
        data: { ...input.amountSnapshot, orderId: order.id }
      });
      const couponUsage = input.couponUsage
        ? await db.couponUsage.create({ data: { ...input.couponUsage, orderId: order.id } })
        : undefined;
      const ledgers = input.ledgers?.length
        ? await Promise.all(input.ledgers.map((data) => db.ledgerEntry.create({ data: { ...data, orderId: order.id } })))
        : [];
      const auditLog = await db.auditLog.create({ data: input.auditLog });
      return { order, items, amountSnapshot, couponUsage, ledgers, auditLog };
    };
    return tx ? run(tx) : new TransactionService(this.prisma).createOrder(run);
  }

  markRefundExtractionRevoked(orderId: string, refundId: string, tx?: PrismaTx) {
    return this.db(tx).orderExtractSecret.updateMany({
      where: { orderId, status: { in: ["active", "locked"] } },
      data: { status: "revoked", refundId, revokedAt: new Date(), revokeReason: "refund" }
    });
  }
}

export class PaymentConfirmationRepository extends BaseRepository {
  createPayment(data: Prisma.PaymentUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).payment.create({ data });
  }

  createConfirmation(data: Prisma.PaymentConfirmationUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).paymentConfirmation.create({ data });
  }

  recordCallback(data: Prisma.PaymentCallbackUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).paymentCallback.create({ data });
  }

  async confirmCollection(input: {
    confirmationId: string;
    paymentId: string;
    orderId: string;
    amountCents: bigint;
    reviewedById: string;
    ledgers?: Prisma.LedgerEntryUncheckedCreateInput[];
    auditLog: Prisma.AuditLogUncheckedCreateInput;
  }, tx?: PrismaTx) {
    const run = async (db: DbClient) => {
      const confirmation = await db.paymentConfirmation.update({
        where: { id: input.confirmationId },
        data: { paymentId: input.paymentId, status: "confirmed", reviewedById: input.reviewedById, reviewedAt: new Date() }
      });
      const payment = await db.payment.update({
        where: { id: input.paymentId },
        data: { status: "paid", amountCents: input.amountCents, paidAt: new Date() }
      });
      const order = await db.order.update({
        where: { id: input.orderId },
        data: { paymentStatus: "paid", status: "fulfilling", paidAmountCents: input.amountCents, paidAt: new Date() }
      });
      const ledgers = input.ledgers?.length
        ? await Promise.all(input.ledgers.map((data) => db.ledgerEntry.create({ data: { ...data, orderId: input.orderId } })))
        : [];
      const auditLog = await db.auditLog.create({ data: input.auditLog });
      return { confirmation, payment, order, ledgers, auditLog };
    };
    return tx ? run(tx) : new TransactionService(this.prisma).confirmCollectionAndAutoFulfill(run);
  }

  rejectConfirmation(id: string, data: Pick<Prisma.PaymentConfirmationUncheckedUpdateInput, "reviewedById" | "reviewedAt" | "rejectReason">, tx?: PrismaTx) {
    return this.db(tx).paymentConfirmation.update({ where: { id }, data: { ...data, status: "rejected" } });
  }
}

export class InventoryRepository extends BaseRepository {
  importBatch(input: {
    batch: Prisma.VirtualCodeBatchUncheckedCreateInput;
    codes: Prisma.VirtualCodeUncheckedCreateInput[];
  }, tx?: PrismaTx) {
    const run = async (db: DbClient) => {
      const batch = await db.virtualCodeBatch.create({ data: input.batch });
      const codes = await Promise.all(input.codes.map((data) => db.virtualCode.create({ data: { ...data, batchId: batch.id } })));
      return { batch, codes };
    };
    return tx ? run(tx) : new TransactionService(this.prisma).issueVirtualCodes(run);
  }

  async reserveAvailableCodes(input: {
    platformProductId: string;
    orderId: string;
    orderItemId: string;
    quantity: number;
    lockIdempotencyKey: string;
    reservedUntil?: Date;
  }, tx?: PrismaTx) {
    const run = async (db: DbClient) => {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id
          FROM virtual_codes
         WHERE platform_product_id = ${input.platformProductId}
           AND status = 'available'
         ORDER BY created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT ${input.quantity}
      `;
      if (rows.length !== input.quantity) throw new Error("insufficient virtual code inventory");
      const ids = rows.map((row) => row.id);
      await db.virtualCode.updateMany({
        where: { id: { in: ids }, status: "available" },
        data: {
          status: "reserved",
          reservedOrderId: input.orderId,
          reservedOrderItemId: input.orderItemId,
          reservedUntil: input.reservedUntil,
          lockIdempotencyKey: input.lockIdempotencyKey
        }
      });
      return db.virtualCode.findMany({ where: { id: { in: ids } } });
    };
    return tx ? run(tx) : new TransactionService(this.prisma).issueVirtualCodes(run);
  }

  issueReservedCodes(input: {
    ids: string[];
    orderId: string;
    orderItemId: string;
    issueIdempotencyKey: string;
  }, tx?: PrismaTx) {
    return this.db(tx).virtualCode.updateMany({
      where: { id: { in: input.ids }, status: { in: ["reserved", "available"] } },
      data: {
        status: "issued",
        issuedOrderId: input.orderId,
        issuedOrderItemId: input.orderItemId,
        issuedAt: new Date(),
        issueIdempotencyKey: input.issueIdempotencyKey
      }
    });
  }
}

export class FulfillmentRepository extends BaseRepository {
  createRecord(data: Prisma.FulfillmentRecordUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).fulfillmentRecord.create({ data });
  }

  createAttempt(data: Prisma.FulfillmentAttemptUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).fulfillmentAttempt.create({ data });
  }

  markRecord(id: string, data: Prisma.FulfillmentRecordUncheckedUpdateInput, tx?: PrismaTx) {
    return this.db(tx).fulfillmentRecord.update({ where: { id }, data });
  }
}

export class ExtractSecretRepository extends BaseRepository {
  create(data: Prisma.OrderExtractSecretUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).orderExtractSecret.create({ data });
  }

  recordLog(data: Prisma.OrderExtractLogUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).orderExtractLog.create({ data });
  }

  incrementFailure(id: string, lockedUntil?: Date, tx?: PrismaTx) {
    return this.db(tx).orderExtractSecret.update({
      where: { id },
      data: {
        failedAttempts: lockedUntil ? 0 : { increment: 1 },
        lockedUntil,
        status: lockedUntil ? "locked" : "active"
      }
    });
  }

  markViewed(id: string, tx?: PrismaTx) {
    return this.db(tx).orderExtractSecret.update({
      where: { id },
      data: { failedAttempts: 0, lockedUntil: null, firstViewedAt: new Date(), status: "active" }
    });
  }

  revokeAfterRefund(orderId: string, refundId: string, tx?: PrismaTx) {
    return this.db(tx).orderExtractSecret.updateMany({
      where: { orderId, status: { in: ["active", "locked"] } },
      data: { status: "revoked", refundId, revokedAt: new Date(), revokeReason: "refund" }
    });
  }
}

export class CouponRepository extends BaseRepository {
  createTemplate(data: Prisma.CouponTemplateUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).couponTemplate.create({ data });
  }

  createScope(data: Prisma.CouponScopeUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).couponScope.create({ data });
  }

  grant(input: {
    userCoupon: Prisma.UserCouponUncheckedCreateInput;
    grantRecord: Prisma.CouponGrantRecordUncheckedCreateInput;
  }, tx?: PrismaTx) {
    const run = async (db: DbClient) => {
      const userCoupon = await db.userCoupon.create({ data: input.userCoupon });
      const grantRecord = await db.couponGrantRecord.create({ data: { ...input.grantRecord, userCouponId: userCoupon.id } });
      return { userCoupon, grantRecord };
    };
    return tx ? run(tx) : new TransactionService(this.prisma).useCoupon(run);
  }

  async use(input: {
    userCouponId: string;
    usage: Prisma.CouponUsageUncheckedCreateInput;
  }, tx?: PrismaTx) {
    const run = async (db: DbClient) => {
      const userCoupon = await db.userCoupon.update({ where: { id: input.userCouponId }, data: { status: "used" } });
      const usage = await db.couponUsage.create({ data: input.usage });
      return { userCoupon, usage };
    };
    return tx ? run(tx) : new TransactionService(this.prisma).useCoupon(run);
  }

  async void(input: {
    userCouponId: string;
    voidRecord: Prisma.CouponVoidRecordUncheckedCreateInput;
  }, tx?: PrismaTx) {
    const run = async (db: DbClient) => {
      const userCoupon = await db.userCoupon.update({
        where: { id: input.userCouponId },
        data: { status: "voided", voidReason: input.voidRecord.reasonCode }
      });
      const voidRecord = await db.couponVoidRecord.create({ data: input.voidRecord });
      return { userCoupon, voidRecord };
    };
    return tx ? run(tx) : new TransactionService(this.prisma).voidCoupon(run);
  }

  reverseUsage(orderId: string, reason: string, tx?: PrismaTx) {
    return this.db(tx).couponUsage.updateMany({
      where: { orderId, reversedAt: null },
      data: { reversedAt: new Date(), reverseReason: reason }
    });
  }
}

export class AfterSaleRepository extends BaseRepository {
  create(data: Prisma.AfterSaleUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).afterSale.create({ data });
  }

  update(id: string, data: Prisma.AfterSaleUncheckedUpdateInput, tx?: PrismaTx) {
    return this.db(tx).afterSale.update({ where: { id }, data });
  }

  createRefund(data: Prisma.RefundUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).refund.create({ data });
  }

  recordRefundCallback(data: Prisma.RefundCallbackUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).refundCallback.create({ data });
  }
}

export class DepositRepository extends BaseRepository {
  async confirmPayment(input: {
    accountId: string;
    merchantId?: string | null;
    transaction: Omit<Prisma.DepositTransactionUncheckedCreateInput, "accountId">;
    ledger: Prisma.LedgerEntryUncheckedCreateInput;
    auditLog: Prisma.AuditLogUncheckedCreateInput;
  }, tx?: PrismaTx) {
    const run = async (db: DbClient) => {
      const account = await db.depositAccount.findUniqueOrThrow({ where: { id: input.accountId } });
      const nextAvailable = account.availableAmountCents + BigInt(input.transaction.amountCents);
      const depositAccount = await db.depositAccount.update({
        where: { id: input.accountId },
        data: { availableAmountCents: nextAvailable, status: "paid" }
      });
      const transaction = await db.depositTransaction.create({
        data: {
          ...input.transaction,
          accountId: input.accountId,
          merchantId: input.merchantId ?? null,
          balanceBeforeCents: account.availableAmountCents,
          balanceAfterCents: nextAvailable,
          type: "pay"
        }
      });
      const ledger = await db.ledgerEntry.create({ data: { ...input.ledger, depositTransactionId: transaction.id } });
      const auditLog = await db.auditLog.create({ data: input.auditLog });
      return { depositAccount, transaction, ledger, auditLog };
    };
    return tx ? run(tx) : new TransactionService(this.prisma).confirmDeposit(run);
  }

  createTransaction(data: Prisma.DepositTransactionUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).depositTransaction.create({ data });
  }
}

export class LedgerRepository extends BaseRepository {
  append(data: Prisma.LedgerEntryUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).ledgerEntry.create({ data });
  }

  reverse(originalLedgerId: string, data: Prisma.LedgerEntryUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).ledgerEntry.create({ data: { ...data, reversalOfLedgerId: originalLedgerId } });
  }
}

export class AuditRepository extends BaseRepository {
  append(data: Prisma.AuditLogUncheckedCreateInput, tx?: PrismaTx) {
    return this.db(tx).auditLog.create({ data });
  }
}

export type PrismaRepositoryRegistry = ReturnType<typeof createPrismaRepositories>;

export function createPrismaRepositories(prisma: PrismaClient) {
  return {
    tx: new TransactionService(prisma),
    shops: new ShopRepository(prisma),
    merchants: new MerchantRepository(prisma),
    merchantInvites: new MerchantInviteRepository(prisma),
    adminAuth: new AdminAuthRepository(prisma),
    products: new ProductRepository(prisma),
    collectionPaymentConfigs: new CollectionPaymentConfigRepository(prisma),
    orders: new OrderRepository(prisma),
    paymentConfirmations: new PaymentConfirmationRepository(prisma),
    inventory: new InventoryRepository(prisma),
    fulfillment: new FulfillmentRepository(prisma),
    extractSecrets: new ExtractSecretRepository(prisma),
    coupons: new CouponRepository(prisma),
    afterSales: new AfterSaleRepository(prisma),
    deposits: new DepositRepository(prisma),
    ledger: new LedgerRepository(prisma),
    audit: new AuditRepository(prisma)
  };
}

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
  assertUserScope,
  buildOrderSnapshot,
  buildSettlementItems,
  calculateServiceFeeCents,
  deductDeposit,
  processPaymentCallback,
  quoteAgentOwnedProduct,
  quotePlatformProduct,
  refundCallbackKey,
  shouldRestrictForDeposit
} from "../../../packages/core/src/index.js";

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
  return new BackendServices(createMemoryStore());
}

class BackendServices {
  private readonly registry = new IdempotencyRegistry();
  private readonly paymentProvider = new MockPaymentProvider();

  constructor(readonly store: MemoryStore) {}

  health() {
    return { ok: true, service: "tosell-api" };
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
      themeColor: shop.themeColor,
      bannerUrl: shop.bannerUrl,
      shareTitle: shop.shareTitle,
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

  quoteOrder(actor: UserActor, input: { shopId: string; agentProductId: string; quantity?: number }) {
    try {
      const snapshot = this.buildSnapshot({
        orderNo: "quote-only",
        userId: actor.userId,
        shopId: input.shopId,
        agentProductId: input.agentProductId,
        quantity: input.quantity
      });
      return this.serializePublicQuote(snapshot);
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
        throw new ApiError(400, "AMOUNT_MISMATCH", "client amount does not match backend quote");
      }
      const order: DemoOrder = {
        orderNo,
        userId: actor.userId,
        agentId: snapshot.agentId,
        shopId: snapshot.shopId,
        agentProductId: snapshot.agentProductId,
        salesChannelType: "salesChannelType" in snapshot ? snapshot.salesChannelType : "single_agent",
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
      this.store.orders.set(orderNo, order);
      this.audit("system", "order.create", "order", orderNo, { agentId: order.agentId, shopId: order.shopId });
      this.ledger("ORDER_CREATED", { orderNo: order.orderNo, agentId: order.agentId }, order.snapshot.amountSnapshot.paidAmountCents, {
        salesChannelType: order.salesChannelType,
        channel: getChannelSnapshot(order.snapshot)
      });
      return this.serializePublicOrder(order);
    } catch (error) {
      if (error instanceof ApiError && error.code !== "RESOURCE_NOT_FOUND") throw error;
      throw new ApiError(400, "ORDER_CREATE_FAILED", getErrorMessage(error));
    }
  }

  getUserOrder(actor: UserActor, orderNo: string) {
    const order = requireEntity(this.store.orders.get(orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertUserScope(actor, order);
    return this.serializePublicOrder(order);
  }

  listUserOrders(actor: UserActor) {
    return [...this.store.orders.values()]
      .filter((order) => order.userId === actor.userId)
      .map((order) => this.serializePublicOrder(order));
  }

  createAfterSale(actor: UserActor, input: {
    orderNo: string;
    reasonCode: string;
    requestedRefundCents: bigint;
    description?: string;
  }) {
    const order = requireEntity(this.store.orders.get(input.orderNo), "RESOURCE_NOT_FOUND", "order not found");
    assertUserScope(actor, order);
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

  submitAgentApplication(actor: AgentActor, input: { contactPhone: string; customerServiceWechat: string }) {
    const agent = requireEntity(this.store.agents.get(actor.agentId), "RESOURCE_NOT_FOUND", "agent not found");
    agent.status = "pending_review";
    agent.contactPhone = input.contactPhone;
    const application: AgentApplication = {
      applicationNo: nextId(this.store, "agent-app"),
      agentId: agent.id,
      userId: agent.userId,
      status: "pending_review",
      contactPhone: input.contactPhone,
      customerServiceWechat: input.customerServiceWechat
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

  updateAgentShop(actor: AgentActor, input: { name?: string; announcement?: string; customerServiceWechat?: string; customerServiceQrUrl?: string }) {
    const shop = this.getAgentShop(actor);
    Object.assign(shop, input);
    this.audit("agent", "shop.update", "shop", shop.id, input);
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
    if (actor) this.getAgentShop(actor);
    return [...this.store.platformProducts.values()];
  }

  listAdminPlatformProducts(actor: AdminActor) {
    assertAdminPermission(actor, "product.manage");
    return [...this.store.platformProducts.values()];
  }

  updatePlatformProduct(actor: AdminActor, productId: string, input: {
    name?: string;
    supplyPriceCents?: bigint;
    minSalePriceCents?: bigint;
    suggestedSalePriceCents?: bigint;
    status?: string;
  }) {
    assertAdminPermission(actor, "product.manage");
    const product = requireEntity(this.store.platformProducts.get(productId), "RESOURCE_NOT_FOUND", "platform product not found");
    Object.assign(product, input);
    if (product.supplyPriceCents < 0n || product.minSalePriceCents < 0n || product.suggestedSalePriceCents < 0n) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "product prices must be non-negative");
    }
    if (product.minSalePriceCents < product.supplyPriceCents) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "minimum sale price cannot be below supply price");
    }
    this.audit(actor.role, "platform_product.update", "platform_product", product.id, input);
    return product;
  }

  listAdminPlatformShopProducts(actor: AdminActor) {
    assertAdminPermission(actor, "product.manage");
    return [...this.store.platformShopProducts.values()].map((item) => ({
      ...item,
      product: this.store.platformProducts.get(item.platformProductId)
    }));
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
    const orders = this.listAgentOrders(actor);
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
      .map((agentProduct) => this.serializeAgentProduct(agentProduct));
  }

  listAgentOrders(actor: AgentActor) {
    return [...this.store.orders.values()].filter((order) => {
      if (order.agentId === actor.agentId && order.shopId === actor.shopId) return true;
      const channel = getChannelSnapshot(order.snapshot);
      return channel?.firstTierAgentId === actor.agentId && channel.firstTierShopId === actor.shopId;
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
    const agentProduct = requireEntity(this.store.agentProducts.get(agentProductId), "RESOURCE_NOT_FOUND", "agent product not found");
    assertAgentScope(actor, agentProduct);
    try {
      if (agentProduct.productType === "platform") {
        const product = requireEntity(this.store.platformProducts.get(required(agentProduct.platformProductId, "platformProductId")), "RESOURCE_NOT_FOUND", "platform product not found");
        quotePlatformProduct({
          salePriceCents,
          supplyPriceCents: product.supplyPriceCents,
          minSalePriceCents: product.minSalePriceCents
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

  submitOwnProduct(actor: AgentActor, input: {
    name: string;
    salePriceCents: bigint;
    minSalePriceCents?: bigint;
    fulfillmentRule?: unknown;
    afterSaleRule?: unknown;
  }) {
    const shop = this.getAgentShop(actor);
    try {
      quoteAgentOwnedProduct({ salePriceCents: input.salePriceCents, minSalePriceCents: input.minSalePriceCents });
    } catch (error) {
      throw new ApiError(400, "PRICE_RULE_FAILED", getErrorMessage(error));
    }
    const review: DemoOwnProduct = {
      id: nextId(this.store, "own"),
      agentId: actor.agentId,
      shopId: shop.id,
      name: input.name,
      salePriceCents: input.salePriceCents,
      minSalePriceCents: input.minSalePriceCents,
      fulfillmentRule: input.fulfillmentRule ?? { mode: "manual" },
      afterSaleRule: input.afterSaleRule ?? { platformReviewRequired: true },
      reviewStatus: "pending_review",
      status: "pending_review"
    };
    this.store.ownProducts.set(review.id, review);
    this.audit("agent", "own_product.submit", "own_product", review.id, review);
    return review;
  }

  selectPlatformProduct(actor: AgentActor, input: { platformProductId: string; salePriceCents: bigint }) {
    this.getAgentShop(actor);
    const product = requireEntity(this.store.platformProducts.get(input.platformProductId), "RESOURCE_NOT_FOUND", "platform product not found");
    try {
      quotePlatformProduct({
        salePriceCents: input.salePriceCents,
        supplyPriceCents: product.supplyPriceCents,
        minSalePriceCents: product.minSalePriceCents
      });
    } catch (error) {
      throw new ApiError(400, "PRICE_RULE_FAILED", getErrorMessage(error));
    }
    const existing = [...this.store.agentProducts.values()]
      .find((agentProduct) => agentProduct.shopId === actor.shopId && agentProduct.platformProductId === product.id);
    const agentProduct: DemoAgentProduct = existing ?? {
      id: nextId(this.store, "ap"),
      agentId: actor.agentId,
      shopId: actor.shopId,
      productType: "platform",
      platformProductId: product.id,
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

  batchSelectPlatformProducts(actor: AgentActor, input: { items: Array<{ platformProductId: string; salePriceCents: bigint }> }) {
    if (input.items.length === 0) throw new ApiError(400, "BATCH_EMPTY", "items are required");
    if (input.items.length > 50) throw new ApiError(400, "BATCH_TOO_LARGE", "batch size cannot exceed 50");
    for (const item of input.items) {
      const product = requireEntity(this.store.platformProducts.get(item.platformProductId), "RESOURCE_NOT_FOUND", "platform product not found");
      try {
        quotePlatformProduct({
          salePriceCents: item.salePriceCents,
          supplyPriceCents: product.supplyPriceCents,
          minSalePriceCents: product.minSalePriceCents
        });
      } catch (error) {
        throw new ApiError(400, "PRICE_RULE_FAILED", `${product.id}: ${getErrorMessage(error)}`);
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
    this.audit(actor.role, "agent.review", "agent", agentId, input);
    return agent;
  }

  listAgentApplications(actor: AdminActor) {
    assertAdminPermission(actor, "agent.review");
    return [...this.store.agentApplications.values()];
  }

  confirmDeposit(actor: AdminActor, agentId: string, input: { amountCents: bigint; requiredAmountCents?: bigint; voucherUrl?: string }) {
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
      }
      const transaction = this.addDepositTransaction(agentId, {
        type: "pay",
        amountCents: input.amountCents,
        balanceBeforeCents: before,
        balanceAfterCents: account.availableAmountCents,
        reasonCode: "manual_confirm",
        relatedType: "deposit",
        relatedId: agentId,
        idempotencyKey
      });
      this.ledger("DEPOSIT_CONFIRMED", { agentId }, input.amountCents, { transactionNo: transaction.transactionNo });
      this.audit(actor.role, "deposit.confirm", "agent", agentId, transaction);
      return { status: "processed" as const, idempotencyKey, account, transaction };
    });
    return result ?? { status: "duplicate" as const, idempotencyKey, account };
  }

  createPlatformProduct(actor: AdminActor, input: {
    name: string;
    supplyPriceCents: bigint;
    minSalePriceCents: bigint;
    suggestedSalePriceCents: bigint;
    fulfillmentRule?: unknown;
    afterSaleRule?: unknown;
  }) {
    assertAdminPermission(actor, "product.manage");
    const product: DemoPlatformProduct = {
      id: nextId(this.store, "prod"),
      name: input.name,
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

  reviewOwnProduct(actor: AdminActor, ownProductId: string, input: { approved: boolean; reason?: string }) {
    assertAdminPermission(actor, "product.manage");
    const ownProduct = requireEntity(this.store.ownProducts.get(ownProductId), "RESOURCE_NOT_FOUND", "own product not found");
    ownProduct.reviewStatus = input.approved ? "approved" : "rejected";
    ownProduct.status = ownProduct.reviewStatus;
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

  listAdminOrders(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return [...this.store.orders.values()];
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

  createChannelRelation(actor: AdminActor, input: { firstTierAgentId: string; secondTierAgentId: string; reason?: string }) {
    assertAdminPermission(actor, "agent.review");
    if (input.firstTierAgentId === input.secondTierAgentId) throw new ApiError(400, "CHANNEL_RULE_FAILED", "first tier and second tier cannot be same agent");
    const firstTier = requireEntity(this.store.agents.get(input.firstTierAgentId), "RESOURCE_NOT_FOUND", "first tier agent not found");
    const secondTier = requireEntity(this.store.agents.get(input.secondTierAgentId), "RESOURCE_NOT_FOUND", "second tier agent not found");
    const authorization = this.store.channelAuthorizations.find((item) => item.firstTierAgentId === firstTier.id && item.status === "active");
    if (!authorization) throw new ApiError(400, "CHANNEL_RULE_FAILED", "first tier agent is not authorized");
    if (firstTier.status !== "active" || secondTier.status !== "active") throw new ApiError(400, "CHANNEL_RULE_FAILED", "both agents must be active");
    const activeUniqueKey = `second-tier:${secondTier.id}`;
    const existing = this.store.channelRelations.find((item) => item.activeUniqueKey === activeUniqueKey && item.status === "active");
    if (existing) return existing;
    const relation = {
      id: nextId(this.store, "channel-rel"),
      firstTierAgentId: firstTier.id,
      secondTierAgentId: secondTier.id,
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
    const product = requireEntity(this.store.platformProducts.get(input.platformProductId), "RESOURCE_NOT_FOUND", "platform product not found");
    if (input.resellSupplyPriceCents < product.supplyPriceCents) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "resell supply price cannot be below platform supply price");
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
    this.audit(actor.role, "channel.offer.upsert", "channel_product_offer", offer.id, offer);
    return offer;
  }

  listRightsCodes(actor: AdminActor, productId?: string) {
    assertAdminPermission(actor, "product.manage");
    return this.store.rightsCodes.filter((code) => !productId || code.productId === productId);
  }

  addRightsCodes(actor: AdminActor, input: { productId: string; codes: string[]; batchNo?: string }) {
    assertAdminPermission(actor, "product.manage");
    const product = requireEntity(this.store.platformProducts.get(input.productId), "RESOURCE_NOT_FOUND", "platform product not found");
    const uniqueCodes = [...new Set(input.codes.map((code) => code.trim()).filter(Boolean))];
    if (uniqueCodes.length === 0) throw new ApiError(400, "RIGHTS_CODE_EMPTY", "codes are required");
    const created: RightsCode[] = [];
    for (const code of uniqueCodes) {
      if (this.store.rightsCodes.some((item) => item.productId === product.id && item.code === code)) continue;
      const item: RightsCode = {
        codeId: nextId(this.store, "code"),
        productId: product.id,
        code,
        batchNo: input.batchNo ?? "manual",
        status: "available",
        createdAt: new Date()
      };
      this.store.rightsCodes.push(item);
      created.push(item);
    }
    product.fulfillmentRule = { ...(isRecord(product.fulfillmentRule) ? product.fulfillmentRule : {}), mode: "code_pool" };
    this.audit(actor.role, "rights_code.import", "platform_product", product.id, { count: created.length });
    return { count: created.length, product, codes: created };
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
    this.audit(actor.role, "refund.approve", "after_sale", afterSaleNo, allocation);
    return { refund, allocation };
  }

  paymentCallback(input: { channel: string; channelTradeNo: string; orderNo: string; amountCents: bigint }) {
    const order = requireEntity(this.store.orders.get(input.orderNo), "RESOURCE_NOT_FOUND", "order not found");
    try {
      const result = processPaymentCallback({
        provider: this.paymentProvider,
        registry: this.registry,
        payload: input,
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
          if (order.salesChannelType !== "platform_self_operated") {
            this.store.pendingIncomeByAgent.set(order.agentId, (this.store.pendingIncomeByAgent.get(order.agentId) ?? 0n) + order.snapshot.amountSnapshot.agentExpectedIncomeCents);
            const channel = getChannelSnapshot(order.snapshot);
            if (channel) {
              this.store.pendingIncomeByAgent.set(channel.firstTierAgentId, (this.store.pendingIncomeByAgent.get(channel.firstTierAgentId) ?? 0n) + channel.firstTierIncomeCents);
            }
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

  refundCallback(input: { channel: string; channelRefundNo: string; refundNo: string }) {
    const refund = requireEntity(this.store.refunds.get(input.refundNo), "RESOURCE_NOT_FOUND", "refund not found");
    const idempotencyKey = refundCallbackKey(input.channel, input.channelRefundNo);
    const result = this.registry.runOnce(idempotencyKey, () => {
      const order = requireEntity(this.store.orders.get(refund.orderNo), "RESOURCE_NOT_FOUND", "order not found");
      refund.status = "success";
      order.refundedAmountCents += refund.amountCents;
      order.refundStatus = "refunded";
      order.status = "refunded";
      this.ledger("REFUND_SUCCEEDED", { orderNo: order.orderNo, agentId: order.agentId }, refund.amountCents, { refundNo: refund.refundNo });

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
      this.audit("system", "refund.callback", "refund", refund.refundNo, { idempotencyKey });
      return { status: "processed" as const, idempotencyKey, refund };
    });
    return result ?? { status: "duplicate" as const, idempotencyKey };
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
        if (channel?.firstTierAgentId === input.agentId) {
          return [{
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
          }];
        }
        if (order.agentId !== input.agentId) return [];
        return [{
          orderId: order.orderNo,
          settlementRole: channel ? "second_tier" : "single_agent",
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
        }];
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
      if (order && (!getChannelSnapshot(order.snapshot) || item.settlementRole === "second_tier")) order.settlementStatus = "settling";
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
      reason: "微信支付商户号尚未开通，当前仅保留 mock 支付用于本地业务闭环。",
      requiredAccounts: [
        "已认证微信小程序 AppID",
        "微信支付商户号 MCH_ID",
        "商户 API v3 密钥",
        "商户 API 证书/私钥",
        "微信支付平台证书或公钥",
        "支付回调域名与退款回调域名"
      ],
      setupSteps: [
        "在微信公众平台完成小程序主体认证。",
        "在微信支付商户平台申请并绑定小程序 AppID。",
        "开通 JSAPI 支付，配置结算银行账户。",
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
      productionRule: "生产环境必须关闭 MOCK_PAYMENT_ENABLED，并拒绝未验签的支付/退款回调。"
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
    return {
      mockReady: true,
      productionReady: false,
      missing: [
        "WECHAT_APP_ID",
        "WECHAT_MCH_ID",
        "WECHAT_PAY_API_KEY",
        "WECHAT_PAY_CERT_SERIAL_NO",
        "ALIPAY_APP_ID"
      ],
      channels: this.store.paymentChannelConfigs
    };
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
      status: shop.status
    }));
  }

  updateShopServiceQrCode(actor: AdminActor, shopId: string, input: { customerServiceWechat?: string; customerServiceQrUrl?: string }) {
    assertAdminPermission(actor, "agent.review");
    const shop = this.getShop(shopId);
    shop.customerServiceWechat = input.customerServiceWechat ?? shop.customerServiceWechat;
    shop.customerServiceQrUrl = input.customerServiceQrUrl ?? shop.customerServiceQrUrl;
    this.audit(actor.role, "shop.service_qrcode.update", "shop", shop.id, input);
    return shop;
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
    const relation = this.findActiveChannelRelationForSecondTier(agent.id);
    if (relation && agentProduct.productType === "platform" && platformProduct) {
      return this.buildTwoTierSnapshot(input, shop, agent, agentProduct, platformProduct, relation);
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

  private buildTwoTierSnapshot(
    input: { orderNo: string; userId: string; shopId: string; agentProductId: string; quantity?: number; entrySource?: string },
    shop: DemoShop,
    secondTier: DemoAgent,
    agentProduct: DemoAgentProduct,
    platformProduct: DemoPlatformProduct,
    relation: ChannelRelation
  ): DemoOrderSnapshot {
    const firstTier = requireEntity(this.store.agents.get(relation.firstTierAgentId), "RESOURCE_NOT_FOUND", "first tier agent not found");
    const firstTierShop = requireEntity([...this.store.shops.values()].find((candidate) => candidate.agentId === firstTier.id), "RESOURCE_NOT_FOUND", "first tier shop not found");
    const firstTierAccount = requireEntity(this.store.depositAccounts.get(firstTier.id), "RESOURCE_NOT_FOUND", "first tier deposit account not found");
    if (secondTier.status !== "active" || firstTier.status !== "active") throw new ApiError(400, "AGENT_NOT_ACTIVE", "channel agents must be active");
    if (shop.status !== "open" || firstTierShop.status !== "open") throw new ApiError(400, "SHOP_NOT_OPEN", "channel shops must be open");
    if (agentProduct.status !== "listed") throw new ApiError(400, "PRODUCT_NOT_LISTED", "agent product is not listed");
    if (platformProduct.status !== "active") throw new ApiError(400, "PRODUCT_NOT_ACTIVE", "platform product is not active");
    if (secondTier.riskStatus !== "normal" || firstTier.riskStatus !== "normal" || shop.riskStatus !== "normal") {
      throw new ApiError(400, "RISK_BLOCKED", "risk freeze blocks order creation");
    }
    if (shouldRestrictForDeposit(firstTierAccount)) throw new ApiError(400, "DEPOSIT_INSUFFICIENT", "first tier deposit is insufficient");
    const offer = requireEntity(
      this.store.channelProductOffers.find((item) => item.channelRelationId === relation.id && item.platformProductId === platformProduct.id && item.status === "listed"),
      "RESOURCE_NOT_FOUND",
      "channel product offer not found"
    );
    if (offer.resellSupplyPriceCents < platformProduct.supplyPriceCents) {
      throw new ApiError(400, "PRICE_RULE_FAILED", "resell supply price cannot be below platform supply price");
    }
    const quantity = input.quantity ?? 1;
    const quote = quotePlatformProduct({
      salePriceCents: agentProduct.salePriceCents,
      supplyPriceCents: offer.resellSupplyPriceCents,
      minSalePriceCents: platformProduct.minSalePriceCents,
      quantity
    });
    const platformSupplyPriceCents = platformProduct.supplyPriceCents * BigInt(quantity);
    const resellSupplyPriceCents = offer.resellSupplyPriceCents * BigInt(quantity);
    const firstTierIncomeCents = resellSupplyPriceCents - platformSupplyPriceCents;

    return {
      orderNo: input.orderNo,
      userId: input.userId,
      agentId: secondTier.id,
      shopId: shop.id,
      agentProductId: agentProduct.id,
      salesChannelType: "two_tier",
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
        resellSupplyPriceCents,
        finalSalePriceCents: quote.paidAmountCents,
        firstTierIncomeCents,
        secondTierIncomeCents: quote.agentExpectedIncomeCents
      },
      productSnapshot: { id: platformProduct.id, type: "platform", name: platformProduct.name },
      shopSnapshot: {
        id: shop.id,
        name: shop.name,
        customerServiceWechat: shop.customerServiceWechat,
        customerServiceQrUrl: shop.customerServiceQrUrl,
        agentStatus: secondTier.status,
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
        secondTierShopId: shop.id,
        platformSupplyPriceCents,
        resellSupplyPriceCents,
        finalSalePriceCents: quote.paidAmountCents,
        firstTierIncomeCents,
        secondTierIncomeCents: quote.agentExpectedIncomeCents
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
        fulfillmentRule: product.fulfillmentRule,
        afterSaleRule: product.afterSaleRule,
        status: product.status
      } : null
    };
  }

  private serializePublicQuote(snapshot: DemoOrderSnapshot) {
    return {
      paidAmountCents: snapshot.amountSnapshot.paidAmountCents,
      salePriceCents: snapshot.amountSnapshot.paidAmountCents / BigInt(snapshot.quantity),
      quantity: snapshot.quantity
    };
  }

  private serializePublicOrder(order: DemoOrder) {
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
      paidAt: order.paidAt,
      fulfilledAt: order.fulfilledAt,
      refundedAmountCents: order.refundedAmountCents,
      paidAmountCents: order.snapshot.amountSnapshot.paidAmountCents,
      salePriceCents: order.snapshot.amountSnapshot.paidAmountCents / BigInt(order.snapshot.quantity),
      quantity: order.snapshot.quantity,
      productType: order.snapshot.productType,
      productName: order.snapshot.productNameSnapshot,
      shopName: (order.snapshot.shopSnapshot as { name?: string }).name,
      customerServiceWechat: (order.snapshot.shopSnapshot as { customerServiceWechat?: string }).customerServiceWechat,
      customerServiceQrUrl: (order.snapshot.shopSnapshot as { customerServiceQrUrl?: string }).customerServiceQrUrl,
      snapshot: {
        productType: order.snapshot.productType
      }
    };
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
    const rule = product?.fulfillmentRule;
    if (!isRecord(rule) || rule.mode !== "code_pool" || !product) return;
    const quantity = order.snapshot.quantity;
    const codes = this.store.rightsCodes
      .filter((item) => item.productId === product.id && item.status === "available")
      .slice(0, quantity);
    if (codes.length < quantity) {
      order.fulfillmentStatus = "failed";
      order.status = "fulfillment_failed";
      order.settlementStatus = "frozen";
      if (order.salesChannelType !== "platform_self_operated") {
        this.notify(order.agentId, "stock.empty", "权益码库存不足", `${product.name} 库存不足，订单 ${order.orderNo} 已冻结结算。`);
      }
      return;
    }
    for (const [index, code] of codes.entries()) {
      code.status = "issued";
      code.orderNo = order.orderNo;
      code.issueKey = `${order.orderNo}:${index + 1}`;
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
    this.audit("system", "fulfillment.auto_code_pool", "order", order.orderNo, { codeIds: codes.map((code) => code.codeId) });
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

  private findActiveChannelRelationForSecondTier(agentId: string) {
    return this.store.channelRelations.find((relation) => relation.secondTierAgentId === agentId && relation.status === "active");
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
}

const PLATFORM_AGENT_ID = "platform";

function getPlatformSelfGrossMargin(snapshot: DemoOrderSnapshot) {
  const amount = snapshot.amountSnapshot as { platformSelfOperatedGrossMarginCents?: bigint };
  return amount.platformSelfOperatedGrossMarginCents ?? 0n;
}

function getChannelSnapshot(snapshot: DemoOrderSnapshot): TwoTierChannelSnapshot | undefined {
  return (snapshot as { channelSnapshot?: TwoTierChannelSnapshot }).channelSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createMemoryStore(): MemoryStore {
  const store: MemoryStore = {
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

  store.agents.set("agent-1", { id: "agent-1", userId: "agent-user-1", name: "测试代理 A", status: "active", riskStatus: "normal", depositStatus: "paid", contactPhone: "13800000000" });
  store.agents.set("agent-2", { id: "agent-2", userId: "agent-user-2", name: "测试代理 B", status: "active", riskStatus: "normal", depositStatus: "paid", contactPhone: "13900000000" });
  store.agents.set("agent-new", { id: "agent-new", userId: "agent-user-new", name: "新代理", status: "draft", riskStatus: "normal", depositStatus: "pending_payment" });
  store.shops.set("shop-1", {
    id: "shop-1",
    agentId: "agent-1",
    name: "测试代理 A 小店",
    status: "open",
    riskStatus: "normal",
    customerServiceWechat: "agent_a_service",
    customerServiceQrUrl: "https://example.test/qr-agent-a.png",
    themeColor: "#1677ff",
    bannerUrl: "https://example.test/banner-a.png",
    shareTitle: "测试代理 A 小店",
    productGroups: [{ name: "推荐权益", agentProductIds: ["ap-1"] }]
  });
  store.shops.set("shop-2", { id: "shop-2", agentId: "agent-2", ownerType: "agent", name: "测试代理 B 小店", status: "open", riskStatus: "normal", customerServiceWechat: "agent_b_service", customerServiceQrUrl: "https://example.test/qr-agent-b.png" });
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
    themeColor: "#0f5f6f",
    bannerUrl: "https://example.test/banner-platform.png",
    shareTitle: "ToSell 官方权益精选",
    productGroups: [{ name: "官方精选", agentProductIds: ["psp-1", "psp-code"] }]
  });
  store.platformProducts.set("prod-1", { id: "prod-1", name: "测试虚拟权益", category: "会员权益", tags: ["热卖"], supplyPriceCents: 10_000n, minSalePriceCents: 12_000n, suggestedSalePriceCents: 15_000n, fulfillmentRule: { mode: "manual" }, afterSaleRule: { refundBeforeFulfillment: true }, status: "active" });
  store.platformProducts.set("prod-code", { id: "prod-code", name: "自动发码权益", category: "权益码", tags: ["自动履约"], supplyPriceCents: 2_000n, minSalePriceCents: 3_000n, suggestedSalePriceCents: 4_900n, fulfillmentRule: { mode: "code_pool" }, afterSaleRule: { refundBeforeFulfillment: true }, status: "active" });
  store.platformShopProducts.set("psp-1", { id: "psp-1", shopId: "shop-platform", platformProductId: "prod-1", salePriceCents: 14_900n, fulfillmentCostCents: 10_000n, status: "listed", groupName: "官方精选" });
  store.platformShopProducts.set("psp-code", { id: "psp-code", shopId: "shop-platform", platformProductId: "prod-code", salePriceCents: 4_900n, fulfillmentCostCents: 2_000n, status: "listed", groupName: "自动履约" });
  store.agentProducts.set("ap-1", { id: "ap-1", agentId: "agent-1", shopId: "shop-1", productType: "platform", platformProductId: "prod-1", ownProductReviewId: null, salePriceCents: 15_000n, status: "listed" });
  store.agentProducts.set("ap-code", { id: "ap-code", agentId: "agent-1", shopId: "shop-1", productType: "platform", platformProductId: "prod-code", ownProductReviewId: null, salePriceCents: 4_900n, status: "listed", groupName: "自动履约" });
  store.agentProducts.set("ap-2", { id: "ap-2", agentId: "agent-2", shopId: "shop-2", productType: "platform", platformProductId: "prod-1", ownProductReviewId: null, salePriceCents: 16_000n, status: "listed" });
  store.rightsCodes.push(
    { codeId: "code-1", productId: "prod-code", code: "RIGHT-CODE-001", batchNo: "seed", status: "available", createdAt: new Date() },
    { codeId: "code-2", productId: "prod-code", code: "RIGHT-CODE-002", batchNo: "seed", status: "available", createdAt: new Date() }
  );
  store.notifications.push({ id: "notice-1", agentId: "agent-1", type: "system", title: "V2 经营工具已开启", content: "可以使用店铺装修、批量选品、权益码自动履约和经营看板。", createdAt: new Date(), readAt: null });
  store.depositAccounts.set("agent-1", { agentId: "agent-1", requiredAmountCents: 50_000n, availableAmountCents: 50_000n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "paid" });
  store.depositAccounts.set("agent-2", { agentId: "agent-2", requiredAmountCents: 50_000n, availableAmountCents: 50_000n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "paid" });
  store.depositAccounts.set("agent-new", { agentId: "agent-new", requiredAmountCents: 50_000n, availableAmountCents: 0n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "pending_payment" });
  store.channelAuthorizations.push({ id: "channel-auth-1", firstTierAgentId: "agent-1", status: "active", reason: null, reviewedAt: new Date() });
  store.channelRelations.push({ id: "channel-rel-1", firstTierAgentId: "agent-1", secondTierAgentId: "agent-2", status: "active", reason: null, reviewedAt: new Date(), activeUniqueKey: "second-tier:agent-2" });
  store.channelProductOffers.push({ id: "channel-offer-1", channelRelationId: "channel-rel-1", platformProductId: "prod-1", resellSupplyPriceCents: 11_000n, status: "listed" });
  return store;
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
};

type DemoAgent = {
  id: string;
  userId: string;
  name: string;
  contactPhone?: string;
  status: string;
  riskStatus: string;
  depositStatus: string;
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
  themeColor?: string;
  bannerUrl?: string;
  shareTitle?: string;
  productGroups?: Array<{ name: string; agentProductIds: string[] }>;
};

type DemoPlatformProduct = {
  id: string;
  name: string;
  category?: string;
  tags?: string[];
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
  salePriceCents: bigint;
  minSalePriceCents?: bigint;
  fulfillmentRule: unknown;
  afterSaleRule: unknown;
  reviewStatus: string;
  status: string;
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

type SalesChannelType = "platform_self_operated" | "single_agent" | "two_tier";
type PaymentChannel = "wechat_miniprogram" | "wechat_h5_jsapi" | "wechat_h5" | "alipay_wap" | "mock";

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

type TwoTierChannelSnapshot = {
  relationId: string;
  firstTierAgentId: string;
  firstTierShopId: string;
  secondTierAgentId: string;
  secondTierShopId: string;
  platformSupplyPriceCents: bigint;
  resellSupplyPriceCents: bigint;
  finalSalePriceCents: bigint;
  firstTierIncomeCents: bigint;
  secondTierIncomeCents: bigint;
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
  code: string;
  batchNo: string;
  status: "available" | "issued" | "voided";
  orderNo?: string;
  issueKey?: string;
  createdAt: Date;
  issuedAt?: Date;
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
  paymentChannelConfigs: PaymentChannelConfig[];
  pendingIncomeByAgent: Map<string, bigint>;
  payableIncomeByAgent: Map<string, bigint>;
  paidIncomeByAgent: Map<string, bigint>;
};

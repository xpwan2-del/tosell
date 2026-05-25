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
  deductDeposit,
  processPaymentCallback,
  quoteAgentOwnedProduct,
  quotePlatformProduct,
  refundCallbackKey,
  shouldRestrictForDeposit
} from "@tosell/core";

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

  listShopProducts(shopId: string) {
    this.getShop(shopId);
    return [...this.store.agentProducts.values()]
      .filter((agentProduct) => agentProduct.shopId === shopId && agentProduct.status === "listed")
      .map((agentProduct) => this.serializePublicAgentProduct(agentProduct));
  }

  getAgentProduct(agentProductId: string) {
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
    assertAgentScope(actor, shop);
    return shop;
  }

  updateAgentShop(actor: AgentActor, input: { name?: string; announcement?: string; customerServiceWechat?: string }) {
    const shop = this.getAgentShop(actor);
    Object.assign(shop, input);
    this.audit("agent", "shop.update", "shop", shop.id, input);
    return shop;
  }

  listPlatformProducts() {
    return [...this.store.platformProducts.values()];
  }

  listAgentProducts(actor: AgentActor) {
    return [...this.store.agentProducts.values()]
      .filter((agentProduct) => agentProduct.agentId === actor.agentId && agentProduct.shopId === actor.shopId)
      .map((agentProduct) => this.serializeAgentProduct(agentProduct));
  }

  listAgentOrders(actor: AgentActor) {
    return [...this.store.orders.values()].filter((order) => order.agentId === actor.agentId && order.shopId === actor.shopId);
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

  reviewAgent(actor: AdminActor, agentId: string, input: { approved: boolean; reason?: string }) {
    assertAdminPermission(actor, "agent.review");
    const agent = requireEntity(this.store.agents.get(agentId), "RESOURCE_NOT_FOUND", "agent not found");
    agent.status = input.approved ? "pending_deposit" : "rejected";
    this.audit(actor.role, "agent.review", "agent", agentId, input);
    return agent;
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
          this.store.pendingIncomeByAgent.set(order.agentId, (this.store.pendingIncomeByAgent.get(order.agentId) ?? 0n) + order.snapshot.amountSnapshot.agentExpectedIncomeCents);
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

      if (refund.wasSettled) {
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
      .filter((order) => order.agentId === input.agentId)
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
    const items = buildSettlementItems(orders, this.store.settlementItemOrderIds, input.agentId);
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
      this.store.settlementItemOrderIds.add(item.orderId);
      const order = this.store.orders.get(item.orderId);
      if (order) order.settlementStatus = "settling";
    }
    const pending = this.store.pendingIncomeByAgent.get(input.agentId) ?? 0n;
    this.store.pendingIncomeByAgent.set(input.agentId, pending > sheet.totalAgentIncomeCents ? pending - sheet.totalAgentIncomeCents : 0n);
    this.store.payableIncomeByAgent.set(input.agentId, (this.store.payableIncomeByAgent.get(input.agentId) ?? 0n) + sheet.totalAgentIncomeCents);
    this.store.settlementSheets.push(sheet);
    this.audit(actor.role, "settlement.generate", "settlement", sheet.settlementNo, { count: items.length });
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
    this.store.riskFreezes.push({ ...input, status: "active" });
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
    return { status: "processed" as const, key };
  }

  listAuditLogs(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    return this.store.auditLogs;
  }

  reconciliationSummary(actor: AdminActor) {
    assertAdminPermission(actor, "audit.read");
    const orders = [...this.store.orders.values()];
    return {
      totalPaidCents: sum(orders.filter((order) => order.paymentStatus === "paid").map((order) => order.snapshot.amountSnapshot.paidAmountCents)),
      totalRefundedCents: sum(orders.map((order) => order.refundedAmountCents)),
      totalServiceFeeCents: sum(orders.filter((order) => order.paymentStatus === "paid").map((order) => order.snapshot.amountSnapshot.serviceFeeCents)),
      totalAgentIncomeCents: sum(orders.filter((order) => order.paymentStatus === "paid").map((order) => order.snapshot.amountSnapshot.agentExpectedIncomeCents)),
      settlementCount: this.store.settlementSheets.length,
      payoutCount: this.store.manualPayouts.length,
      clawbackCount: this.store.clawbacks.length,
      depositAvailableCents: sum([...this.store.depositAccounts.values()].map((account) => account.availableAmountCents))
    };
  }

  private buildSnapshot(input: { orderNo: string; userId: string; shopId: string; agentProductId: string; quantity?: number; entrySource?: string }) {
    const shop = requireEntity(this.store.shops.get(input.shopId), "RESOURCE_NOT_FOUND", "shop not found");
    const agent = requireEntity(this.store.agents.get(shop.agentId), "RESOURCE_NOT_FOUND", "agent not found");
    const account = requireEntity(this.store.depositAccounts.get(agent.id), "RESOURCE_NOT_FOUND", "deposit account not found");
    if (shouldRestrictForDeposit(account)) throw new ApiError(400, "DEPOSIT_INSUFFICIENT", "agent deposit is insufficient");
    const agentProduct = requireEntity(this.store.agentProducts.get(input.agentProductId), "RESOURCE_NOT_FOUND", "agent product not found");
    if (agentProduct.shopId !== shop.id) throw new ApiError(400, "RESOURCE_SCOPE_MISMATCH", "agent product does not belong to shop");
    const platformProduct = agentProduct.platformProductId ? this.store.platformProducts.get(agentProduct.platformProductId) : undefined;
    const ownProduct = agentProduct.ownProductReviewId ? this.store.ownProducts.get(agentProduct.ownProductReviewId) : undefined;
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

  private serializePublicQuote(snapshot: ReturnType<typeof buildOrderSnapshot>) {
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
}

function createMemoryStore(): MemoryStore {
  const store: MemoryStore = {
    sequence: 0,
    agentApplications: new Map(),
    agents: new Map(),
    shops: new Map(),
    platformProducts: new Map(),
    ownProducts: new Map(),
    agentProducts: new Map(),
    depositAccounts: new Map(),
    depositTransactions: [],
    orders: new Map(),
    afterSales: new Map(),
    refunds: new Map(),
    fulfillmentRecords: new Map(),
    settlementSheets: [],
    settlementItemOrderIds: new Set(),
    manualPayouts: [],
    clawbacks: [],
    riskFreezes: [],
    activeRiskFreezeKeys: new Set(),
    auditLogs: [],
    pendingIncomeByAgent: new Map(),
    payableIncomeByAgent: new Map(),
    paidIncomeByAgent: new Map()
  };

  store.agents.set("agent-1", { id: "agent-1", userId: "agent-user-1", name: "测试代理 A", status: "active", riskStatus: "normal", depositStatus: "paid", contactPhone: "13800000000" });
  store.agents.set("agent-2", { id: "agent-2", userId: "agent-user-2", name: "测试代理 B", status: "active", riskStatus: "normal", depositStatus: "paid", contactPhone: "13900000000" });
  store.agents.set("agent-new", { id: "agent-new", userId: "agent-user-new", name: "新代理", status: "draft", riskStatus: "normal", depositStatus: "pending_payment" });
  store.shops.set("shop-1", { id: "shop-1", agentId: "agent-1", name: "测试代理 A 小店", status: "open", riskStatus: "normal", customerServiceWechat: "agent_a_service" });
  store.shops.set("shop-2", { id: "shop-2", agentId: "agent-2", name: "测试代理 B 小店", status: "open", riskStatus: "normal", customerServiceWechat: "agent_b_service" });
  store.shops.set("shop-new", { id: "shop-new", agentId: "agent-new", name: "新代理小店", status: "not_opened", riskStatus: "normal" });
  store.platformProducts.set("prod-1", { id: "prod-1", name: "测试虚拟权益", supplyPriceCents: 10_000n, minSalePriceCents: 12_000n, suggestedSalePriceCents: 15_000n, fulfillmentRule: { mode: "manual" }, afterSaleRule: { refundBeforeFulfillment: true }, status: "active" });
  store.agentProducts.set("ap-1", { id: "ap-1", agentId: "agent-1", shopId: "shop-1", productType: "platform", platformProductId: "prod-1", ownProductReviewId: null, salePriceCents: 15_000n, status: "listed" });
  store.agentProducts.set("ap-2", { id: "ap-2", agentId: "agent-2", shopId: "shop-2", productType: "platform", platformProductId: "prod-1", ownProductReviewId: null, salePriceCents: 16_000n, status: "listed" });
  store.depositAccounts.set("agent-1", { agentId: "agent-1", requiredAmountCents: 50_000n, availableAmountCents: 50_000n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "paid" });
  store.depositAccounts.set("agent-2", { agentId: "agent-2", requiredAmountCents: 50_000n, availableAmountCents: 50_000n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "paid" });
  store.depositAccounts.set("agent-new", { agentId: "agent-new", requiredAmountCents: 50_000n, availableAmountCents: 0n, frozenAmountCents: 0n, deductedAmountCents: 0n, status: "pending_payment" });
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
  agentId: string;
  name: string;
  status: string;
  riskStatus: string;
  announcement?: string;
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
  items: ReturnType<typeof buildSettlementItems>;
  totalOrderCount: number;
  totalPaidCents: bigint;
  totalServiceFeeCents: bigint;
  totalAgentIncomeCents: bigint;
};

type MemoryStore = {
  sequence: number;
  agentApplications: Map<string, AgentApplication>;
  agents: Map<string, DemoAgent>;
  shops: Map<string, DemoShop>;
  platformProducts: Map<string, DemoPlatformProduct>;
  ownProducts: Map<string, DemoOwnProduct>;
  agentProducts: Map<string, DemoAgentProduct>;
  depositAccounts: Map<string, Parameters<typeof deductDeposit>[0]["account"]>;
  depositTransactions: DepositTransaction[];
  orders: Map<string, DemoOrder>;
  afterSales: Map<string, DemoAfterSale>;
  refunds: Map<string, DemoRefund>;
  fulfillmentRecords: Map<string, Parameters<typeof applyFulfillmentAttempt>[0]["record"]>;
  settlementSheets: SettlementSheet[];
  settlementItemOrderIds: Set<string>;
  manualPayouts: Array<Record<string, unknown>>;
  clawbacks: Array<Record<string, unknown>>;
  riskFreezes: Array<Record<string, unknown>>;
  activeRiskFreezeKeys: Set<string>;
  auditLogs: Array<Record<string, unknown>>;
  pendingIncomeByAgent: Map<string, bigint>;
  payableIncomeByAgent: Map<string, bigint>;
  paidIncomeByAgent: Map<string, bigint>;
};

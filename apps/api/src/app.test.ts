import { describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";

describe("api", () => {
  it("quotes platform product amounts on backend", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/user/orders/quote",
      headers: { "x-user-id": "user-1" },
      payload: {
        shopId: "shop-1",
        agentProductId: "ap-1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      paidAmountCents: "15000",
      salePriceCents: "15000",
      quantity: 1
    });
    expect(JSON.stringify(response.json())).not.toMatch(/supplyAmountCents|serviceFeeCents|agentExpectedIncomeCents/);
  });

  it("rejects quote requests that cannot be resolved from backend product data", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/user/orders/quote",
      headers: { "x-user-id": "user-1" },
      payload: {
        shopId: "shop-1",
        agentProductId: "missing-product"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("PRICE_RULE_FAILED");
  });

  it("deduplicates mock payment callbacks", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: { shopId: "shop-1", agentProductId: "ap-1" }
    });
    const payload = {
      channel: "mock",
      channelTradeNo: "trade-1",
      orderNo: created.json().orderNo,
      amountCents: "15000"
    };

    const first = await app.inject({ method: "POST", url: "/api/callbacks/payments/mock", payload });
    const second = await app.inject({ method: "POST", url: "/api/callbacks/payments/mock", payload });

    expect(first.json().status).toBe("processed");
    expect(second.json().status).toBe("duplicate");
  });

  it("rejects payment callbacks with mismatched amount", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: { shopId: "shop-1", agentProductId: "ap-1" }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: {
        channel: "mock",
        channelTradeNo: "trade-mismatch-1",
        orderNo: created.json().orderNo,
        amountCents: "14999"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("PAYMENT_CALLBACK_REJECTED");
  });

  it("rejects payment callbacks for unknown orders", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: {
        channel: "mock",
        channelTradeNo: "trade-missing",
        orderNo: "missing-order",
        amountCents: "15000"
      }
    });

    expect(response.statusCode).toBe(404);
  });

  it("blocks cross-agent access", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/scope-check",
      headers: {
        "x-agent-id": "a1",
        "x-shop-id": "s1"
      },
      payload: {
        resourceAgentId: "a2"
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("does not accept forged agent identity from the request body", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/agent/scope-check",
      payload: {
        actorAgentId: "agent-1",
        actorShopId: "shop-1",
        resourceAgentId: "agent-1",
        resourceShopId: "shop-1"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().message).toMatch(/x-agent-id/);
  });

  it("requires user identity headers for user order creation", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      payload: { shopId: "shop-1", agentProductId: "ap-1" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().message).toMatch(/x-user-id/);
  });

  it("requires admin identity headers for admin helpers", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/refunds/allocate",
      payload: {
        paidAmountCents: "15000",
        supplyAmountCents: "10000",
        agentIncomeCents: "4925",
        refundAmountCents: "6000",
        responsibility: "platform"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().message).toMatch(/x-admin-role/);
  });

  it("allocates mixed refund responsibility", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/refunds/allocate",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: {
        paidAmountCents: "15000",
        supplyAmountCents: "10000",
        agentIncomeCents: "4925",
        refundAmountCents: "6000",
        responsibility: "mixed",
        platformBearCents: "4000",
        agentBearCents: "2000"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      refundAmountCents: "6000",
      platformBearCents: "4000",
      agentBearCents: "2000",
      serviceFeeRefundCents: "30"
    });
  });

  it("returns settlement candidate only after fulfilled T+1", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/candidate",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: {
        orderId: "order-1",
        paymentStatus: "paid",
        fulfillmentStatus: "success",
        settlementStatus: "pending",
        refundStatus: "none",
        riskStatus: "normal",
        fulfilledAt: "2026-05-24T00:00:00.000Z",
        now: "2026-05-25T00:00:00.000Z"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ settleable: true });
  });

  it("creates orders from backend snapshots and hides them from other agents", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: {
        shopId: "shop-1",
        agentProductId: "ap-1",
        clientPaidAmountCents: "15000"
      }
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      paidAmountCents: "15000",
      salePriceCents: "15000",
      productName: "测试虚拟权益"
    });
    expect(JSON.stringify(created.json())).not.toMatch(/supplyAmountCents|serviceFeeCents|agentExpectedIncomeCents|settlementStatus/);

    const agentTwoOrders = await app.inject({
      method: "GET",
      url: "/api/agent/orders",
      headers: { "x-agent-id": "agent-2", "x-shop-id": "shop-2" }
    });
    expect(agentTwoOrders.json()).toEqual([]);
  });

  it("lists only the current user's orders without internal finance fields", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: { shopId: "shop-1", agentProductId: "ap-1" }
    });
    await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-2" },
      payload: { shopId: "shop-1", agentProductId: "ap-1" }
    });

    const orders = await app.inject({
      method: "GET",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" }
    });

    expect(orders.statusCode).toBe(200);
    expect(orders.json()).toHaveLength(1);
    expect(orders.json()[0]).toMatchObject({ userId: "user-1", paidAmountCents: "15000" });
    expect(JSON.stringify(orders.json())).not.toMatch(/supplyAmountCents|serviceFeeCents|agentExpectedIncomeCents|settlementStatus/);
  });

  it("reviews agent onboarding and opens the shop after deposit confirmation", async () => {
    const app = buildApp();
    const application = await app.inject({
      method: "POST",
      url: "/api/agent/applications",
      headers: { "x-agent-id": "agent-new", "x-shop-id": "shop-new" },
      payload: { contactPhone: "13700000000", customerServiceWechat: "new_agent_service" }
    });
    expect(application.statusCode).toBe(200);
    expect(application.json().status).toBe("pending_review");

    const reviewed = await app.inject({
      method: "POST",
      url: "/api/admin/agents/agent-new/review",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { approved: true }
    });
    expect(reviewed.json().status).toBe("pending_deposit");

    const deposit = await app.inject({
      method: "POST",
      url: "/api/admin/deposits/agent-new/confirm",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { amountCents: "50000", voucherUrl: "https://example.test/deposit.png" }
    });
    expect(deposit.statusCode).toBe(200);
    expect(deposit.json().account.status).toBe("paid");

    const shop = await app.inject({
      method: "GET",
      url: "/api/agent/shop",
      headers: { "x-agent-id": "agent-new", "x-shop-id": "shop-new" }
    });
    expect(shop.json().status).toBe("open");
  });

  it("does not expose internal product finance fields on user product APIs", async () => {
    const app = buildApp();
    const list = await app.inject({
      method: "GET",
      url: "/api/user/shops/shop-1/products"
    });
    const detail = await app.inject({
      method: "GET",
      url: "/api/user/products/ap-1"
    });

    expect(list.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toMatch(/supplyPriceCents|minSalePriceCents|suggestedSalePriceCents/);
    expect(JSON.stringify(detail.json())).not.toMatch(/supplyPriceCents|minSalePriceCents|suggestedSalePriceCents/);
  });

  it("enforces platform minimum sale price on agent pricing APIs", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/agent/products/ap-1/price",
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" },
      payload: { salePriceCents: "11999" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("PRICE_RULE_FAILED");
  });

  it("rejects after-sale requests before payment or above remaining paid amount", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: { shopId: "shop-1", agentProductId: "ap-1" }
    });
    const orderNo = created.json().orderNo;

    const unpaidAfterSale = await app.inject({
      method: "POST",
      url: "/api/user/after-sales",
      headers: { "x-user-id": "user-1" },
      payload: { orderNo, reasonCode: "not_needed", requestedRefundCents: "15000" }
    });
    expect(unpaidAfterSale.statusCode).toBe(400);
    expect(unpaidAfterSale.json().code).toBe("AFTER_SALE_NOT_ALLOWED");

    await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: { channel: "mock", channelTradeNo: "trade-after-sale-1", orderNo, amountCents: "15000" }
    });
    const excessiveAfterSale = await app.inject({
      method: "POST",
      url: "/api/user/after-sales",
      headers: { "x-user-id": "user-1" },
      payload: { orderNo, reasonCode: "not_needed", requestedRefundCents: "15001" }
    });
    expect(excessiveAfterSale.statusCode).toBe(400);
    expect(excessiveAfterSale.json().code).toBe("REFUND_AMOUNT_INVALID");
  });

  it("runs payment, fulfillment, settlement generation, and manual payout without duplicate settlement items", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: { shopId: "shop-1", agentProductId: "ap-1" }
    });
    const orderNo = created.json().orderNo;

    const paid = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: { channel: "mock", channelTradeNo: "trade-settle-1", orderNo, amountCents: "15000" }
    });
    expect(paid.json().status).toBe("processed");

    const fulfilled = await app.inject({
      method: "POST",
      url: `/api/admin/fulfillment/${orderNo}`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { status: "success", evidence: "code-issued", attemptNo: 1 }
    });
    expect(fulfilled.statusCode).toBe(200);

    const firstSettlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { agentId: "agent-1", now: "2030-01-01T00:00:00.000Z", batchNo: "b1" }
    });
    const secondSettlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { agentId: "agent-1", now: "2030-01-01T00:00:00.000Z", batchNo: "b2" }
    });

    expect(firstSettlement.statusCode).toBe(200);
    expect(firstSettlement.json().items).toHaveLength(1);
    expect(secondSettlement.json().items).toHaveLength(0);

    const payout = await app.inject({
      method: "POST",
      url: `/api/admin/settlements/${firstSettlement.json().settlementNo}/payouts`,
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { payoutMethod: "manual_bank_transfer", voucherUrl: "https://example.test/voucher.png" }
    });

    expect(payout.statusCode).toBe(200);
    expect(payout.json().payout.status).toBe("paid");

    const payoutDuplicate = await app.inject({
      method: "POST",
      url: `/api/admin/settlements/${firstSettlement.json().settlementNo}/payouts`,
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { payoutMethod: "manual_bank_transfer" }
    });
    expect(payoutDuplicate.json().status).toBe("duplicate");
  });

  it("submits and approves an agent-owned product before it can be sold", async () => {
    const app = buildApp();
    const submitted = await app.inject({
      method: "POST",
      url: "/api/agent/products/own",
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" },
      payload: {
        name: "代理自有课程权益",
        salePriceCents: "19900",
        minSalePriceCents: "9900",
        fulfillmentMode: "manual"
      }
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().reviewStatus).toBe("pending_review");

    const reviewed = await app.inject({
      method: "POST",
      url: `/api/admin/agent-products/reviews/${submitted.json().id}/review`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { approved: true, reason: "符合虚拟商品规则" }
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().agentProduct.productType).toBe("agent_owned");

    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: {
        shopId: "shop-1",
        agentProductId: reviewed.json().agentProduct.id,
        clientPaidAmountCents: "19900"
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().snapshot.productType).toBe("agent_owned");
  });

  it("creates clawback from agent responsibility refund after payout", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: { shopId: "shop-1", agentProductId: "ap-1" }
    });
    const orderNo = created.json().orderNo;

    await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: { channel: "mock", channelTradeNo: "trade-refund-1", orderNo, amountCents: "15000" }
    });
    await app.inject({
      method: "POST",
      url: `/api/admin/fulfillment/${orderNo}`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { status: "success", attemptNo: 1 }
    });
    const settlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { agentId: "agent-1", now: "2030-01-01T00:00:00.000Z" }
    });
    await app.inject({
      method: "POST",
      url: `/api/admin/settlements/${settlement.json().settlementNo}/payouts`,
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { payoutMethod: "manual_bank_transfer" }
    });

    const afterSale = await app.inject({
      method: "POST",
      url: "/api/user/after-sales",
      headers: { "x-user-id": "user-1" },
      payload: { orderNo, reasonCode: "agent_service_issue", requestedRefundCents: "5000" }
    });
    const refund = await app.inject({
      method: "POST",
      url: `/api/admin/after-sales/${afterSale.json().afterSaleNo}/refunds`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { refundAmountCents: "5000", responsibility: "agent" }
    });
    await app.inject({
      method: "POST",
      url: "/api/callbacks/refunds/mock",
      payload: { channel: "mock", channelRefundNo: "refund-cb-1", refundNo: refund.json().refund.refundNo }
    });
    const clawbacks = await app.inject({
      method: "GET",
      url: "/api/agent/clawbacks",
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" }
    });

    expect(clawbacks.json()).toHaveLength(1);
    expect(clawbacks.json()[0].requestedAmountCents).toBe("5025");
  });

  it("deducts post-settlement refunds from pending manual payout before deposit", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: { shopId: "shop-1", agentProductId: "ap-1" }
    });
    const orderNo = created.json().orderNo;

    await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: { channel: "mock", channelTradeNo: "trade-payable-refund-1", orderNo, amountCents: "15000" }
    });
    await app.inject({
      method: "POST",
      url: `/api/admin/fulfillment/${orderNo}`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { status: "success", attemptNo: 1 }
    });
    const settlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { agentId: "agent-1", now: "2030-01-01T00:00:00.000Z", batchNo: "payable-refund" }
    });

    const afterSale = await app.inject({
      method: "POST",
      url: "/api/user/after-sales",
      headers: { "x-user-id": "user-1" },
      payload: { orderNo, reasonCode: "agent_service_issue", requestedRefundCents: "5000" }
    });
    const refund = await app.inject({
      method: "POST",
      url: `/api/admin/after-sales/${afterSale.json().afterSaleNo}/refunds`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { refundAmountCents: "5000", responsibility: "agent" }
    });
    await app.inject({
      method: "POST",
      url: "/api/callbacks/refunds/mock",
      payload: { channel: "mock", channelRefundNo: "refund-cb-payable-1", refundNo: refund.json().refund.refundNo }
    });

    const clawbacks = await app.inject({
      method: "GET",
      url: "/api/agent/clawbacks",
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" }
    });
    expect(clawbacks.json()[0].deductions).toEqual([
      { from: "payable_income", amountCents: "4925" },
      { from: "deposit", amountCents: "100" }
    ]);

    const payout = await app.inject({
      method: "POST",
      url: `/api/admin/settlements/${settlement.json().settlementNo}/payouts`,
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { payoutMethod: "manual_bank_transfer" }
    });
    expect(payout.json().payout.amountCents).toBe("0");
  });

  it("excludes risk-frozen fulfilled orders from settlement", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: { shopId: "shop-1", agentProductId: "ap-1" }
    });
    const orderNo = created.json().orderNo;

    await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: { channel: "mock", channelTradeNo: "trade-risk-settle-1", orderNo, amountCents: "15000" }
    });
    await app.inject({
      method: "POST",
      url: `/api/admin/fulfillment/${orderNo}`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { status: "success", attemptNo: 1 }
    });
    await app.inject({
      method: "POST",
      url: "/api/admin/risk-freezes",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: {
        targetType: "order",
        targetId: orderNo,
        freezeType: "order_frozen",
        reasonCode: "manual_risk"
      }
    });
    const settlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { agentId: "agent-1", now: "2030-01-01T00:00:00.000Z", batchNo: "risk-freeze" }
    });

    expect(settlement.statusCode).toBe(200);
    expect(settlement.json().items).toHaveLength(0);
  });

  it("rejects cumulative refund allocation above paid amount", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/refunds/allocate",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: {
        paidAmountCents: "15000",
        supplyAmountCents: "10000",
        agentIncomeCents: "4925",
        alreadyRefundedCents: "10000",
        refundAmountCents: "5001",
        responsibility: "platform"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("REFUND_ALLOCATION_FAILED");
  });

  it("deducts deposits idempotently and reports insufficient restriction", async () => {
    const app = buildApp();
    const payload = {
      amountCents: "45000",
      sourceType: "complaint",
      sourceId: "complaint-1",
      reasonCode: "complaint_compensation"
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/admin/deposits/agent-1/deduct",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/admin/deposits/agent-1/deduct",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "processed", restricted: true, balanceAfterCents: "5000" });
    expect(second.json().status).toBe("duplicate");
  });

  it("blocks order creation after shop risk freeze", async () => {
    const app = buildApp();
    const freeze = await app.inject({
      method: "POST",
      url: "/api/admin/risk-freezes",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: {
        targetType: "shop",
        targetId: "shop-1",
        freezeType: "shop_frozen",
        reasonCode: "manual_risk"
      }
    });
    expect(freeze.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: { shopId: "shop-1", agentProductId: "ap-1" }
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().code).toBe("ORDER_CREATE_FAILED");
  });

  it("runs V2 shop decor, batch listing, dashboard, notifications, and payment guide", async () => {
    const app = buildApp();
    const agentHeaders = { "x-agent-id": "agent-1", "x-shop-id": "shop-1" };

    const decor = await app.inject({
      method: "PATCH",
      url: "/api/agent/shop/decor",
      headers: agentHeaders,
      payload: {
        themeColor: "#00aa88",
        bannerUrl: "https://example.test/banner.png",
        shareTitle: "代理 A 精选权益",
        productGroups: [{ name: "自动履约", agentProductIds: ["ap-code"] }]
      }
    });
    expect(decor.statusCode).toBe(200);
    expect(decor.json()).toMatchObject({ themeColor: "#00aa88", shareTitle: "代理 A 精选权益" });

    const shopUpdate = await app.inject({
      method: "PATCH",
      url: "/api/agent/shop",
      headers: agentHeaders,
      payload: {
        customerServiceQrUrl: "https://example.test/qr-agent-a-new.png"
      }
    });
    expect(shopUpdate.statusCode).toBe(200);
    expect(shopUpdate.json().customerServiceQrUrl).toBe("https://example.test/qr-agent-a-new.png");

    const batch = await app.inject({
      method: "POST",
      url: "/api/agent/products/platform/batch",
      headers: agentHeaders,
      payload: {
        items: [
          { platformProductId: "prod-1", salePriceCents: "15000" },
          { platformProductId: "prod-code", salePriceCents: "4900" }
        ]
      }
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json().count).toBe(2);

    const dashboard = await app.inject({
      method: "GET",
      url: "/api/agent/dashboard",
      headers: agentHeaders
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({ activeProductCount: 2 });

    const notifications = await app.inject({
      method: "GET",
      url: "/api/agent/notifications",
      headers: agentHeaders
    });
    expect(notifications.statusCode).toBe(200);
    expect(notifications.json().length).toBeGreaterThan(0);

    const guide = await app.inject({
      method: "GET",
      url: "/api/admin/payment-onboarding-guide",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    expect(guide.statusCode).toBe(200);
    expect(guide.json().envVars).toContain("WECHAT_MCH_ID");
    expect(JSON.stringify(guide.json())).toContain("JSAPI 支付");
  });

  it("supports platform self-operated shop orders without agent settlement", async () => {
    const app = buildApp();

    const shop = await app.inject({
      method: "GET",
      url: "/api/user/shops/shop-platform",
      headers: { "x-user-id": "user-platform" }
    });
    expect(shop.statusCode).toBe(200);
    expect(shop.json()).toMatchObject({
      ownerType: "platform",
      customerServiceQrUrl: "https://example.test/qr-platform-service.png"
    });

    const products = await app.inject({
      method: "GET",
      url: "/api/user/shops/shop-platform/products",
      headers: { "x-user-id": "user-platform" }
    });
    expect(products.statusCode).toBe(200);
    expect(products.json()[0]).toMatchObject({ id: "psp-1", productType: "platform_self_operated" });

    const quote = await app.inject({
      method: "POST",
      url: "/api/user/orders/quote",
      headers: { "x-user-id": "user-platform" },
      payload: { shopId: "shop-platform", agentProductId: "psp-1" }
    });
    expect(quote.statusCode).toBe(200);
    expect(quote.json()).toMatchObject({ paidAmountCents: "14900", salePriceCents: "14900" });
    expect(JSON.stringify(quote.json())).not.toMatch(/fulfillmentCostCents|platformSelfOperatedGrossMarginCents/);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-platform" },
      payload: { shopId: "shop-platform", agentProductId: "psp-1", clientPaidAmountCents: "14900" }
    });
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({
      salesChannelType: "platform_self_operated",
      customerServiceQrUrl: "https://example.test/qr-platform-service.png"
    });
    expect(JSON.stringify(order.json())).not.toMatch(/platformSelfOperatedGrossMarginCents|fulfillmentCostCents/);

    const payment = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: {
        channel: "mock",
        channelTradeNo: "trade-platform-self",
        orderNo: order.json().orderNo,
        amountCents: "14900"
      }
    });
    expect(payment.statusCode).toBe(200);

    const settlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { agentId: "platform", now: "2030-01-01T00:00:00.000Z", batchNo: "platform-self" }
    });
    expect(settlement.statusCode).toBe(200);
    expect(settlement.json().items).toHaveLength(0);

    const reconciliation = await app.inject({
      method: "GET",
      url: "/api/exports/reconciliation-summary",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" }
    });
    expect(reconciliation.json()).toMatchObject({
      platformSelfOperatedPaidCents: "14900",
      platformSelfOperatedGrossMarginCents: "4825"
    });
  });

  it("protects internal platform product pricing behind agent auth", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/agent/products/platform"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().message).toMatch(/x-agent-id/);
  });

  it("does not partially apply failed batch product selection", async () => {
    const app = buildApp();
    const before = await app.inject({
      method: "GET",
      url: "/api/agent/products",
      headers: { "x-agent-id": "agent-2", "x-shop-id": "shop-2" }
    });

    const failed = await app.inject({
      method: "POST",
      url: "/api/agent/products/platform/batch",
      headers: { "x-agent-id": "agent-2", "x-shop-id": "shop-2" },
      payload: {
        items: [
          { platformProductId: "prod-code", salePriceCents: "4900" },
          { platformProductId: "prod-1", salePriceCents: "11999" }
        ]
      }
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/agent/products",
      headers: { "x-agent-id": "agent-2", "x-shop-id": "shop-2" }
    });

    expect(failed.statusCode).toBe(400);
    expect(failed.json().code).toBe("PRICE_RULE_FAILED");
    expect(after.json()).toEqual(before.json());
  });

  it("imports rights codes and auto-fulfills code-pool orders after mock payment", async () => {
    const app = buildApp();
    const imported = await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: {
        productId: "prod-code",
        batchNo: "v2-test",
        codes: ["V2-CODE-001", "V2-CODE-002"]
      }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().count).toBe(2);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-v2" },
      payload: { shopId: "shop-1", agentProductId: "ap-code", clientPaidAmountCents: "4900" }
    });
    expect(order.statusCode).toBe(200);

    const payment = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: {
        channel: "mock",
        channelTradeNo: "trade-v2-code",
        orderNo: order.json().orderNo,
        amountCents: "4900"
      }
    });
    expect(payment.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/user/orders/${order.json().orderNo}`,
      headers: { "x-user-id": "user-v2" }
    });
    expect(detail.json()).toMatchObject({ status: "fulfilled", fulfillmentStatus: "success" });

    const risk = await app.inject({
      method: "GET",
      url: "/api/admin/risk-dashboard",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    expect(risk.statusCode).toBe(200);
    expect(risk.json()).toHaveProperty("lowStockProducts");
  });

  it("auto-fulfills one rights code per purchased quantity", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: {
        productId: "prod-code",
        batchNo: "quantity-test",
        codes: ["QTY-CODE-001", "QTY-CODE-002", "QTY-CODE-003"]
      }
    });

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-qty" },
      payload: { shopId: "shop-1", agentProductId: "ap-code", quantity: 2, clientPaidAmountCents: "9800" }
    });
    await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: {
        channel: "mock",
        channelTradeNo: "trade-v2-qty",
        orderNo: order.json().orderNo,
        amountCents: "9800"
      }
    });

    const codes = await app.inject({
      method: "GET",
      url: "/api/admin/rights-codes?productId=prod-code",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });

    const issuedForOrder = codes.json().filter((code: { orderNo?: string }) => code.orderNo === order.json().orderNo);
    expect(issuedForOrder).toHaveLength(2);
  });
});

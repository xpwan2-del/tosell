import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { buildApp } from "./app.ts";

describe.sequential("api", () => {
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
      productName: "ChatGPT Plus 成品号月卡"
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
        fulfillmentMode: "manual",
        manualFulfillmentInstruction: "付款后联系店铺客服开通课程权益"
      }
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().reviewStatus).toBe("pending_review");

    const ownDetail = await app.inject({
      method: "GET",
      url: `/api/agent/products/own/${submitted.json().id}`,
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" }
    });
    expect(ownDetail.statusCode).toBe(200);
    expect(ownDetail.json()).toMatchObject({
      ownProductId: submitted.json().id,
      fulfillmentMode: "manual",
      manualFulfillmentInstruction: "付款后联系店铺客服开通课程权益"
    });

    const ownPatch = await app.inject({
      method: "PATCH",
      url: `/api/agent/products/own/${submitted.json().id}`,
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" },
      payload: { subtitle: "人工交付课程", manualFulfillmentInstruction: "请提供订单号给客服核销" }
    });
    expect(ownPatch.statusCode).toBe(200);
    expect(ownPatch.json()).toMatchObject({
      subtitle: "人工交付课程",
      manualFulfillmentInstruction: "请提供订单号给客服核销"
    });

    const unauthenticatedQueue = await app.inject({ method: "GET", url: "/api/admin/agent-products/reviews" });
    expect(unauthenticatedQueue.statusCode).toBe(401);

    const forbiddenQueue = await app.inject({
      method: "GET",
      url: "/api/admin/agent-products/reviews",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" }
    });
    expect(forbiddenQueue.statusCode).toBe(403);

    const pendingQueue = await app.inject({
      method: "GET",
      url: "/api/admin/agent-products/reviews?reviewStatus=pending_review&agentId=agent-1&shopId=shop-1&page=1&pageSize=10",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    expect(pendingQueue.statusCode).toBe(200);
    expect(pendingQueue.json()).toMatchObject({ page: 1, pageSize: 10 });
    expect(pendingQueue.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: submitted.json().id,
        ownProductId: submitted.json().id,
        agentId: "agent-1",
        shopId: "shop-1",
        name: "代理自有课程权益",
        salePriceCents: "19900",
        minSalePriceCents: "9900",
        fulfillmentMode: "manual",
        reviewStatus: "pending_review",
        status: "pending_review",
        agent: expect.objectContaining({ id: "agent-1", name: "测试代理 A" }),
        shop: expect.objectContaining({ id: "shop-1" })
      })
    ]));

    const reviewed = await app.inject({
      method: "POST",
      url: `/api/admin/agent-products/reviews/${submitted.json().id}/review`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { approved: true, reason: "符合虚拟商品规则" }
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().agentProduct.productType).toBe("agent_owned");

    const reviewDetail = await app.inject({
      method: "GET",
      url: `/api/admin/agent-products/reviews/${submitted.json().id}`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    expect(reviewDetail.statusCode).toBe(200);
    expect(reviewDetail.json()).toMatchObject({
      ownProductId: submitted.json().id,
      agentProductId: reviewed.json().agentProduct.id,
      reviewStatus: "approved",
      status: "listed",
      agent: expect.objectContaining({ id: "agent-1" }),
      shop: expect.objectContaining({ id: "shop-1" })
    });

    const approvedQueue = await app.inject({
      method: "GET",
      url: `/api/admin/agent-products/reviews?status=listed&agentId=agent-1&limit=5&offset=0`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    expect(approvedQueue.statusCode).toBe(200);
    expect(approvedQueue.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: submitted.json().id,
        ownProductId: submitted.json().id,
        reviewStatus: "approved",
        status: "listed"
      })
    ]));

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

  it("exposes product detail contracts, safe fulfillment switching, purchase-password extraction, and email resend", async () => {
    const app = buildApp();
    const operatorHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };
    const agentHeaders = { "x-agent-id": "agent-1", "x-shop-id": "shop-1" };

    const platformDetail = await app.inject({ method: "GET", url: "/api/admin/products/prod-code", headers: operatorHeaders });
    expect(platformDetail.statusCode).toBe(200);
    expect(platformDetail.json()).toMatchObject({
      id: "prod-code",
      fulfillmentMode: "code_pool",
      rightsCodePool: expect.objectContaining({
        available: expect.any(Number),
        plaintextDefaultVisible: false,
        permissions: expect.objectContaining({
          canImport: true,
          canExportMasked: true,
          canViewPlaintext: false,
          canExportPlaintext: false
        })
      })
    });

    const unsafeSwitch = await app.inject({
      method: "PATCH",
      url: "/api/admin/products/prod-code",
      headers: operatorHeaders,
      payload: { fulfillmentMode: "manual" }
    });
    expect(unsafeSwitch.statusCode).toBe(400);
    expect(unsafeSwitch.json().code).toBe("FULFILLMENT_MODE_CHANGE_UNSAFE");

    const manualUpdate = await app.inject({
      method: "PATCH",
      url: "/api/admin/products/prod-1",
      headers: operatorHeaders,
      payload: { fulfillmentMode: "manual", manualFulfillmentInstruction: "付款后请通过微信或 QQ 联系客服人工交付" }
    });
    expect(manualUpdate.statusCode).toBe(200);
    expect(manualUpdate.json()).toMatchObject({
      fulfillmentMode: "manual",
      manualFulfillmentInstruction: "付款后请通过微信或 QQ 联系客服人工交付"
    });

    const manualCodeImport = await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: operatorHeaders,
      payload: { productId: "prod-1", codes: ["SHOULD-NOT-IMPORT"] }
    });
    expect(manualCodeImport.statusCode).toBe(400);
    expect(manualCodeImport.json().code).toBe("RIGHTS_CODE_PRODUCT_MODE_INVALID");

    const serviceContact = await app.inject({
      method: "PATCH",
      url: "/api/agent/shop",
      headers: agentHeaders,
      payload: { customerServiceQq: "123456789", customerServiceQqQrUrl: "https://example.test/qq-service.png" }
    });
    expect(serviceContact.statusCode).toBe(200);

    const agentProductDetail = await app.inject({ method: "GET", url: "/api/agent/products/ap-1", headers: agentHeaders });
    expect(agentProductDetail.statusCode).toBe(200);
    expect(agentProductDetail.json()).toMatchObject({
      id: "ap-1",
      fieldPermissions: expect.objectContaining({ editable: expect.arrayContaining(["salePriceCents"]) })
    });
    expect(agentProductDetail.json().product.supplyPriceCents).toBeUndefined();
    expect(agentProductDetail.json().product.platformSupplyPriceCents).toBe("10000");

    const manualOrder = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "manual-detail-user" },
      payload: { shopId: "shop-1", agentProductId: "ap-1", clientPaidAmountCents: "15000" }
    });
    expect(manualOrder.statusCode).toBe(200);
    const manualConfirm = await app.inject({
      method: "POST",
      url: `/api/agent/orders/${manualOrder.json().orderNo}/confirm-payment`,
      headers: agentHeaders,
      payload: { amountCents: "15000", voucherUrl: "manual://detail/manual" }
    });
    expect(manualConfirm.statusCode).toBe(200);
    const manualFulfillment = await app.inject({
      method: "POST",
      url: `/api/agent/orders/${manualOrder.json().orderNo}/fulfillment`,
      headers: agentHeaders,
      payload: { status: "success", attemptNo: 1, evidence: "manual fulfillment evidence" }
    });
    expect(manualFulfillment.statusCode).toBe(200);
    const manualDetail = await app.inject({
      method: "GET",
      url: `/api/user/orders/${manualOrder.json().orderNo}`,
      headers: { "x-user-id": "manual-detail-user" }
    });
    expect(manualDetail.json().delivery).toMatchObject({
      mode: "manual",
      manualFulfillmentInstruction: "付款后请通过微信或 QQ 联系客服人工交付",
      customerServiceWechat: expect.any(String),
      customerServiceQq: expect.any(String)
    });
    expect(manualDetail.json().delivery).not.toHaveProperty("codes");

    await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: operatorHeaders,
      payload: { productId: "prod-code", batchNo: "password-detail", codes: ["PWD-CODE-001"] }
    });
    const precheck = await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/precheck",
      headers: operatorHeaders,
      payload: { productId: "prod-code", codes: ["", "PWD-CODE-001", "NEW-CODE-001", "NEW-CODE-001", "bad\u0001"] }
    });
    expect(precheck.statusCode).toBe(200);
    expect(precheck.json().summary).toMatchObject({ total: 5, create: 1, skipped: 2, failed: 2, importable: 1 });
    expect(precheck.json().details).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 1, action: "fail", reasonCode: "EMPTY_LINE" }),
      expect.objectContaining({ line: 2, action: "skip", reasonCode: "DUPLICATE_EXISTING" }),
      expect.objectContaining({ line: 4, action: "skip", reasonCode: "DUPLICATE_IN_REQUEST" }),
      expect.objectContaining({ line: 5, action: "fail", reasonCode: "INVALID_FORMAT" })
    ]));
    expect(JSON.stringify(precheck.json())).not.toContain("PWD-CODE-001");
    const detailedImport = await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: operatorHeaders,
      payload: { productId: "prod-code", batchNo: "password-detail-extra", codes: ["", "PWD-CODE-001", "NEW-CODE-001", "NEW-CODE-001"] }
    });
    expect(detailedImport.statusCode).toBe(200);
    expect(detailedImport.json()).toMatchObject({ count: 1, createdCount: 1, skippedCount: 2, failedCount: 1 });
    expect(detailedImport.json().details).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "create", codeId: expect.any(String) }),
      expect.objectContaining({ action: "skip", reasonCode: "DUPLICATE_EXISTING" }),
      expect.objectContaining({ action: "fail", reasonCode: "EMPTY_LINE" })
    ]));
    expect(JSON.stringify(detailedImport.json())).not.toContain("NEW-CODE-001");

    const plaintextDenied = await app.inject({
      method: "GET",
      url: "/api/admin/rights-codes/plaintext?productId=prod-code",
      headers: operatorHeaders
    });
    expect(plaintextDenied.statusCode).toBe(403);
    const plaintextAllowed = await app.inject({
      method: "GET",
      url: "/api/admin/rights-codes/plaintext?productId=prod-code",
      headers: { "x-admin-id": "admin-1", "x-admin-role": "admin" }
    });
    expect(plaintextAllowed.statusCode).toBe(200);
    expect(JSON.stringify(plaintextAllowed.json())).toContain("PWD-CODE-001");

    const codeOrder = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "password-user" },
      payload: {
        shopId: "shop-1",
        agentProductId: "ap-code",
        clientPaidAmountCents: "4900",
        buyerEmail: "password@example.com",
        purchasePassword: "135790"
      }
    });
    expect(codeOrder.statusCode).toBe(200);
    const codePayment = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: { channel: "mock", channelTradeNo: "trade-password-detail", orderNo: codeOrder.json().orderNo, amountCents: "4900" }
    });
    expect(codePayment.statusCode).toBe(200);
    const codeDetail = await app.inject({
      method: "GET",
      url: `/api/user/orders/${codeOrder.json().orderNo}`,
      headers: { "x-user-id": "password-user" }
    });
    expect(codeDetail.json()).toMatchObject({ purchasePasswordSet: true });
    expect(codeDetail.json().delivery).toMatchObject({
      purchasePasswordSet: true,
      extractionToken: expect.stringMatching(/^ext_[0-9a-z]+_[0-9a-f]{40}$/)
    });
    expect(codeDetail.json().delivery.message).toContain("购买密码");
    expect(JSON.stringify(codeDetail.json())).not.toContain("extractionCodeSet");

    const wrongPassword = await app.inject({
      method: "POST",
      url: `/api/user/extractions/${codeDetail.json().delivery.extractionToken}`,
      headers: { "x-user-id": "password-user" },
      payload: { purchasePassword: "000000" }
    });
    expect(wrongPassword.statusCode).toBe(403);
    expect(wrongPassword.json()).toMatchObject({
      code: "PURCHASE_PASSWORD_INVALID",
      message: expect.stringContaining("purchase password")
    });
    expect(JSON.stringify(wrongPassword.json())).not.toContain("extraction code");

    const extracted = await app.inject({
      method: "POST",
      url: `/api/user/extractions/${codeDetail.json().delivery.extractionToken}`,
      headers: { "x-user-id": "password-user" },
      payload: { purchasePassword: "135790" }
    });
    expect(extracted.statusCode).toBe(200);
    expect(extracted.json().codes).toHaveLength(1);

    const resend = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${codeOrder.json().orderNo}/email-deliveries`,
      headers: operatorHeaders
    });
    expect(resend.statusCode).toBe(200);
    expect(resend.json()).toMatchObject({
      orderNo: codeOrder.json().orderNo,
      email: "password@example.com",
      codeCount: 1,
      source: "manual_resend"
    });

    const audits = await app.inject({ method: "GET", url: "/api/admin/audit-logs", headers: operatorHeaders });
    expect(JSON.stringify(audits.json())).toContain("email.delivery.resend");
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
        customerServiceQrUrl: "https://example.test/qr-agent-a-new.png",
        customerServiceQq: "123456789",
        customerServiceQqQrUrl: "https://example.test/qq-agent-a-new.png",
        customerServiceNote: "工作日 10:00-18:00"
      }
    });
    expect(shopUpdate.statusCode).toBe(200);
    expect(shopUpdate.json().customerServiceQrUrl).toBe("https://example.test/qr-agent-a-new.png");
    expect(shopUpdate.json()).toMatchObject({
      customerServiceQq: "123456789",
      customerServiceQqQrUrl: "https://example.test/qq-agent-a-new.png",
      customerServiceNote: "工作日 10:00-18:00"
    });
    const publicShop = await app.inject({ method: "GET", url: "/api/user/shops/shop-1" });
    expect(publicShop.statusCode).toBe(200);
    expect(publicShop.json()).toMatchObject({
      customerServiceQrUrl: "https://example.test/qr-agent-a-new.png",
      customerServiceQq: "123456789",
      customerServiceQqQrUrl: "https://example.test/qq-agent-a-new.png",
      customerServiceNote: "工作日 10:00-18:00"
    });
    expect(publicShop.json()).not.toHaveProperty("onlineCustomerServiceUrl");
    expect(publicShop.json()).not.toHaveProperty("onlineChatUrl");

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
    expect(dashboard.json()).toMatchObject({ activeProductCount: 8 });

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

  it("exposes production management surfaces for every P0 backend module", async () => {
    const app = buildApp();
    const operatorHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };
    const financeHeaders = { "x-admin-id": "finance-1", "x-admin-role": "finance" };

    const agentApplications = await app.inject({ method: "GET", url: "/api/admin/agent-applications", headers: operatorHeaders });
    const afterSales = await app.inject({ method: "GET", url: "/api/admin/after-sales", headers: operatorHeaders });
    const refunds = await app.inject({ method: "GET", url: "/api/admin/refunds", headers: operatorHeaders });
    const settlements = await app.inject({ method: "GET", url: "/api/admin/settlements", headers: financeHeaders });
    const deposits = await app.inject({ method: "GET", url: "/api/admin/deposits", headers: financeHeaders });
    const channels = await app.inject({ method: "GET", url: "/api/admin/channels", headers: operatorHeaders });
    const qrcodes = await app.inject({ method: "GET", url: "/api/admin/service-qrcodes", headers: operatorHeaders });
    const paymentConfig = await app.inject({ method: "GET", url: "/api/admin/payment-config/status", headers: operatorHeaders });

    expect(agentApplications.statusCode).toBe(200);
    expect(afterSales.statusCode).toBe(200);
    expect(refunds.statusCode).toBe(200);
    expect(settlements.statusCode).toBe(200);
    expect(deposits.statusCode).toBe(200);
    expect(channels.statusCode).toBe(200);
    expect(channels.json()).toHaveProperty("authorizations");
    expect(channels.json()).toHaveProperty("relations");
    expect(qrcodes.statusCode).toBe(200);
    expect(qrcodes.json()[0]).toHaveProperty("customerServiceQrUrl");
    expect(paymentConfig.statusCode).toBe(200);
    expect(paymentConfig.json().map((item: Record<string, unknown>) => item.channel)).toContain("mock");

    const updatedQr = await app.inject({
      method: "PATCH",
      url: "/api/admin/shops/shop-1/service-qrcode",
      headers: operatorHeaders,
      payload: {
        customerServiceQrUrl: "https://example.test/admin-qr.png",
        customerServiceQq: "987654321",
        customerServiceQqQrUrl: "https://example.test/admin-qq.png",
        customerServiceNote: "售前售后请备注订单号"
      }
    });
    expect(updatedQr.statusCode).toBe(200);
    expect(updatedQr.json().customerServiceQrUrl).toBe("https://example.test/admin-qr.png");
    expect(updatedQr.json()).toMatchObject({
      customerServiceQq: "987654321",
      customerServiceQqQrUrl: "https://example.test/admin-qq.png",
      customerServiceNote: "售前售后请备注订单号"
    });

    const channelReview = await app.inject({
      method: "POST",
      url: "/api/admin/channels/agent-2/review",
      headers: operatorHeaders,
      payload: { approved: true, reason: "允许作为一级渠道配置二级供货" }
    });
    expect(channelReview.statusCode).toBe(200);
    expect(channelReview.json()).toMatchObject({ firstTierAgentId: "agent-2", status: "active" });

    const operatorPaymentUpdate = await app.inject({
      method: "PATCH",
      url: "/api/admin/payment-config/metadata",
      headers: operatorHeaders,
      payload: { channel: "wechat_miniprogram", enabled: false, statusNote: "等待商户号开通" }
    });
    expect(operatorPaymentUpdate.statusCode).toBe(403);

    const paymentUpdate = await app.inject({
      method: "PATCH",
      url: "/api/admin/payment-config/metadata",
      headers: financeHeaders,
      payload: { channel: "wechat_miniprogram", enabled: false, statusNote: "等待商户号开通" }
    });
    expect(paymentUpdate.statusCode).toBe(200);
    expect(paymentUpdate.json()).toMatchObject({ channel: "wechat_miniprogram", statusNote: "等待商户号开通" });

    const paymentCheck = await app.inject({ method: "POST", url: "/api/admin/payment-config/check", headers: operatorHeaders });
    expect(paymentCheck.statusCode).toBe(200);
    expect(paymentCheck.json()).toMatchObject({ mockReady: true, productionReady: false, demoAuthEnabled: true });

    const freeze = await app.inject({
      method: "POST",
      url: "/api/admin/risk-freezes",
      headers: operatorHeaders,
      payload: {
        targetType: "shop",
        targetId: "shop-2",
        freezeType: "shop_frozen",
        reasonCode: "manual_risk"
      }
    });
    expect(freeze.statusCode).toBe(200);
    const riskList = await app.inject({ method: "GET", url: "/api/admin/risk-freezes", headers: operatorHeaders });
    expect(riskList.json()).toHaveLength(1);
    const released = await app.inject({
      method: "POST",
      url: `/api/admin/risk-freezes/${freeze.json().freeze.id}/release`,
      headers: operatorHeaders
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().status).toBe("released");
  });

  it("runs controlled two-tier supply without rebate semantics", async () => {
    const app = buildApp();
    const operatorHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };
    const financeHeaders = { "x-admin-id": "finance-1", "x-admin-role": "finance" };

    const invalidOffer = await app.inject({
      method: "POST",
      url: "/api/admin/channels/offers",
      headers: operatorHeaders,
      payload: {
        channelRelationId: "channel-rel-1",
        platformProductId: "prod-1",
        resellSupplyPriceCents: "9900"
      }
    });
    expect(invalidOffer.statusCode).toBe(400);

    const quote = await app.inject({
      method: "POST",
      url: "/api/user/orders/quote",
      headers: { "x-user-id": "two-tier-user" },
      payload: { shopId: "shop-2", agentProductId: "ap-2" }
    });
    expect(quote.json()).toMatchObject({ paidAmountCents: "16000", salePriceCents: "16000" });
    expect(JSON.stringify(quote.json())).not.toMatch(/firstTierIncomeCents|resellSupplyPriceCents|commission|返佣/);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "two-tier-user" },
      payload: { shopId: "shop-2", agentProductId: "ap-2", clientPaidAmountCents: "16000" }
    });
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({ salesChannelType: "two_tier", paidAmountCents: "16000" });
    expect(JSON.stringify(order.json())).not.toMatch(/firstTierIncomeCents|secondTierIncomeCents|resellSupplyPriceCents/);

    await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: {
        channel: "mock",
        channelTradeNo: "trade-two-tier",
        orderNo: order.json().orderNo,
        amountCents: "16000"
      }
    });
    await app.inject({
      method: "POST",
      url: `/api/admin/fulfillment/${order.json().orderNo}`,
      headers: operatorHeaders,
      payload: { status: "success", attemptNo: 1, evidence: "two-tier-manual" }
    });

    const firstTierSettlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: financeHeaders,
      payload: { agentId: "agent-1", now: "2030-01-01T00:00:00.000Z", batchNo: "two-tier-first" }
    });
    expect(firstTierSettlement.statusCode).toBe(200);
    expect(firstTierSettlement.json().items[0]).toMatchObject({
      orderId: order.json().orderNo,
      settlementRole: "first_tier",
      agentIncomeCents: "1000"
    });

    const secondTierSettlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: financeHeaders,
      payload: { agentId: "agent-2", now: "2030-01-01T00:00:00.000Z", batchNo: "two-tier-second" }
    });
    expect(secondTierSettlement.statusCode).toBe(200);
    expect(secondTierSettlement.json().items[0]).toMatchObject({
      orderId: order.json().orderNo,
      settlementRole: "second_tier",
      agentIncomeCents: "4920"
    });

    const ledger = await app.inject({ method: "GET", url: "/api/admin/ledger-entries", headers: financeHeaders });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().map((item: Record<string, unknown>) => item.entryType)).toEqual(
      expect.arrayContaining(["ORDER_CREATED", "PAYMENT_SUCCEEDED", "SETTLEMENT_GENERATED"])
    );
    expect(JSON.stringify(ledger.json())).not.toMatch(/commission|rebate|返佣|团队奖|三级/);
  });

  it("runs controlled three-tier supply by price spread and blocks fourth-tier creation", async () => {
    const app = buildApp();
    const financeHeaders = { "x-admin-id": "finance-1", "x-admin-role": "finance" };
    const operatorHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };

    const invalidThirdTierOffer = await app.inject({
      method: "POST",
      url: "/api/admin/channels/offers",
      headers: operatorHeaders,
      payload: {
        channelRelationId: "channel-rel-2",
        platformProductId: "prod-1",
        resellSupplyPriceCents: "10500"
      }
    });
    expect(invalidThirdTierOffer.statusCode).toBe(400);

    const fourthTierAttempt = await app.inject({
      method: "POST",
      url: "/api/admin/channels/relations",
      headers: operatorHeaders,
      payload: {
        firstTierAgentId: "agent-2",
        secondTierAgentId: "agent-3",
        thirdTierAgentId: "agent-new"
      }
    });
    expect(fourthTierAttempt.statusCode).toBe(400);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "three-tier-user" },
      payload: { shopId: "shop-3", agentProductId: "ap-3", clientPaidAmountCents: "15000" }
    });
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({ salesChannelType: "three_tier", paidAmountCents: "15000" });
    expect(JSON.stringify(order.json())).not.toMatch(/firstTierIncomeCents|secondTierIncomeCents|thirdTierIncomeCents|resellSupplyPriceCents|commission|返佣/);

    await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: {
        channel: "mock",
        channelTradeNo: "trade-three-tier",
        orderNo: order.json().orderNo,
        amountCents: "15000"
      }
    });
    await app.inject({
      method: "POST",
      url: `/api/admin/fulfillment/${order.json().orderNo}`,
      headers: operatorHeaders,
      payload: { status: "success", attemptNo: 1, evidence: "three-tier-manual" }
    });

    const firstTierSettlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: financeHeaders,
      payload: { agentId: "agent-1", now: "2030-01-01T00:00:00.000Z", batchNo: "three-tier-first" }
    });
    expect(firstTierSettlement.statusCode).toBe(200);
    expect(firstTierSettlement.json().items[0]).toMatchObject({ settlementRole: "first_tier", agentIncomeCents: "1000" });

    const secondTierSettlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: financeHeaders,
      payload: { agentId: "agent-2", now: "2030-01-01T00:00:00.000Z", batchNo: "three-tier-second" }
    });
    expect(secondTierSettlement.statusCode).toBe(200);
    expect(secondTierSettlement.json().items[0]).toMatchObject({ settlementRole: "second_tier", agentIncomeCents: "2000" });

    const thirdTierSettlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: financeHeaders,
      payload: { agentId: "agent-3", now: "2030-01-01T00:00:00.000Z", batchNo: "three-tier-third" }
    });
    expect(thirdTierSettlement.statusCode).toBe(200);
    expect(thirdTierSettlement.json().items[0]).toMatchObject({ settlementRole: "third_tier", agentIncomeCents: "1925" });
  });

  it("enforces tiered price visibility on merchant product and order APIs", async () => {
    const app = buildApp();
    const secondProducts = await app.inject({
      method: "GET",
      url: "/api/agent/products",
      headers: { "x-agent-id": "agent-2", "x-shop-id": "shop-2" }
    });
    const thirdProducts = await app.inject({
      method: "GET",
      url: "/api/agent/products",
      headers: { "x-agent-id": "agent-3", "x-shop-id": "shop-3" }
    });
    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "tier-visibility-user" },
      payload: { shopId: "shop-3", agentProductId: "ap-3", clientPaidAmountCents: "15000" }
    });
    const secondOrders = await app.inject({
      method: "GET",
      url: "/api/agent/orders",
      headers: { "x-agent-id": "agent-2", "x-shop-id": "shop-2" }
    });
    const thirdOrders = await app.inject({
      method: "GET",
      url: "/api/agent/orders",
      headers: { "x-agent-id": "agent-3", "x-shop-id": "shop-3" }
    });

    expect(order.statusCode).toBe(200);
    expect(JSON.stringify(secondProducts.json())).not.toMatch(/platformSupplyPriceCents|supplyPriceCents/);
    expect(JSON.stringify(thirdProducts.json())).not.toMatch(/platformSupplyPriceCents|firstTierSupplyPriceCents|supplyPriceCents/);
    expect(JSON.stringify(secondOrders.json())).not.toMatch(/platformSupplyPriceCents/);
    expect(JSON.stringify(thirdOrders.json())).not.toMatch(/platformSupplyPriceCents|firstTierSupplyPriceCents/);
  });

  it("scopes merchant channel offers, fulfillment, and after-sale assistance", async () => {
    const app = buildApp();
    const firstHeaders = { "x-agent-id": "agent-1", "x-shop-id": "shop-1" };
    const secondHeaders = { "x-agent-id": "agent-2", "x-shop-id": "shop-2" };
    const thirdHeaders = { "x-agent-id": "agent-3", "x-shop-id": "shop-3" };

    const firstOffer = await app.inject({
      method: "POST",
      url: "/api/agent/channels/offers",
      headers: firstHeaders,
      payload: { downstreamAgentId: "agent-2", platformProductId: "prod-1", resellSupplyPriceCents: "11200" }
    });
    const secondOffer = await app.inject({
      method: "POST",
      url: "/api/agent/channels/offers",
      headers: secondHeaders,
      payload: { downstreamAgentId: "agent-3", platformProductId: "prod-1", resellSupplyPriceCents: "13200" }
    });
    const thirdOffer = await app.inject({
      method: "POST",
      url: "/api/agent/channels/offers",
      headers: thirdHeaders,
      payload: { downstreamAgentId: "agent-new", platformProductId: "prod-1", resellSupplyPriceCents: "14000" }
    });
    const crossOffer = await app.inject({
      method: "POST",
      url: "/api/agent/channels/offers",
      headers: firstHeaders,
      payload: { downstreamAgentId: "agent-3", platformProductId: "prod-1", resellSupplyPriceCents: "14000" }
    });

    expect(firstOffer.statusCode).toBe(200);
    expect(firstOffer.json()).toMatchObject({ channelRelationId: "channel-rel-1", resellSupplyPriceCents: "11200" });
    expect(secondOffer.statusCode).toBe(200);
    expect(secondOffer.json()).toMatchObject({ channelRelationId: "channel-rel-2", resellSupplyPriceCents: "13200" });
    expect(thirdOffer.statusCode).toBe(403);
    expect(thirdOffer.json().code).toBe("FOURTH_TIER_FORBIDDEN");
    expect(crossOffer.statusCode).toBe(403);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "merchant-scope-user" },
      payload: { shopId: "shop-3", agentProductId: "ap-3", clientPaidAmountCents: "15000" }
    });
    expect(order.statusCode).toBe(200);

    const thirdOrders = await app.inject({ method: "GET", url: "/api/agent/orders", headers: thirdHeaders });
    expect(thirdOrders.statusCode).toBe(200);
    expect(thirdOrders.json().some((item: Record<string, unknown>) => item.orderNo === order.json().orderNo)).toBe(true);

    const thirdOrderDetail = await app.inject({ method: "GET", url: `/api/agent/orders/${order.json().orderNo}`, headers: thirdHeaders });
    const crossOrderDetail = await app.inject({
      method: "GET",
      url: `/api/agent/orders/${order.json().orderNo}`,
      headers: { "x-agent-id": "agent-new", "x-shop-id": "shop-new" }
    });
    expect(thirdOrderDetail.statusCode).toBe(200);
    expect(thirdOrderDetail.json()).toMatchObject({ orderNo: order.json().orderNo });
    expect(crossOrderDetail.statusCode).toBe(404);

    const crossConfirm = await app.inject({
      method: "POST",
      url: `/api/agent/orders/${order.json().orderNo}/confirm-payment`,
      headers: secondHeaders,
      payload: { amountCents: "15000", voucherUrl: "manual://cross-confirm" }
    });
    expect(crossConfirm.statusCode).toBe(403);

    const confirm = await app.inject({
      method: "POST",
      url: `/api/agent/orders/${order.json().orderNo}/confirm-payment`,
      headers: thirdHeaders,
      payload: { amountCents: "15000", voucherUrl: "manual://third-confirm" }
    });
    expect(confirm.statusCode).toBe(200);

    const crossFulfill = await app.inject({
      method: "POST",
      url: `/api/agent/orders/${order.json().orderNo}/fulfillment`,
      headers: secondHeaders,
      payload: { status: "success", attemptNo: 1, evidence: "wrong merchant" }
    });
    expect(crossFulfill.statusCode).toBe(403);

    const fulfillment = await app.inject({
      method: "POST",
      url: `/api/agent/orders/${order.json().orderNo}/fulfillment`,
      headers: thirdHeaders,
      payload: { status: "success", attemptNo: 1, evidence: "manual delivery" }
    });
    expect(fulfillment.statusCode).toBe(200);

    const afterSale = await app.inject({
      method: "POST",
      url: "/api/user/after-sales",
      headers: { "x-user-id": "merchant-scope-user" },
      payload: { orderNo: order.json().orderNo, reasonCode: "need_help", requestedRefundCents: "1000" }
    });
    expect(afterSale.statusCode).toBe(200);

    const secondAfterSales = await app.inject({ method: "GET", url: "/api/agent/after-sales", headers: secondHeaders });
    const thirdAfterSales = await app.inject({ method: "GET", url: "/api/agent/after-sales", headers: thirdHeaders });
    expect(secondAfterSales.json().some((item: Record<string, unknown>) => item.afterSaleNo === afterSale.json().afterSaleNo)).toBe(false);
    expect(thirdAfterSales.json().some((item: Record<string, unknown>) => item.afterSaleNo === afterSale.json().afterSaleNo)).toBe(true);

    const crossAssist = await app.inject({
      method: "POST",
      url: `/api/agent/after-sales/${afterSale.json().afterSaleNo}/assist`,
      headers: secondHeaders,
      payload: { note: "越权协处理", evidenceUrl: "manual://cross-assist" }
    });
    expect(crossAssist.statusCode).toBe(403);

    const assist = await app.inject({
      method: "POST",
      url: `/api/agent/after-sales/${afterSale.json().afterSaleNo}/assist`,
      headers: thirdHeaders,
      payload: { note: "已补充商户处理意见", evidenceUrl: "manual://assist" }
    });
    expect(assist.statusCode).toBe(200);
    expect(assist.json()).toMatchObject({ status: "recorded" });
  });

  it("lists only active shop collection channels and lets the selling merchant confirm collection idempotently", async () => {
    const app = buildApp();
    const channels = await app.inject({ method: "GET", url: "/api/h5/shops/shop-1/collection-channels" });
    expect(channels.statusCode).toBe(200);
    expect(channels.json()[0]).toMatchObject({ id: "collection-shop-1", channelType: "alipay_personal_qr" });
    expect(JSON.stringify(channels.json())).not.toMatch(/mock/i);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "agent-confirm-user" },
      payload: {
        shopId: "shop-1",
        agentProductId: "ap-1",
        collectionChannelId: "collection-shop-1",
        clientPaidAmountCents: "15000"
      }
    });
    const first = await app.inject({
      method: "POST",
      url: `/api/agent/orders/${order.json().orderNo}/confirm-payment`,
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" },
      payload: { amountCents: "15000", voucherUrl: "manual://agent-confirm/1" }
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/agent/orders/${order.json().orderNo}/confirm-payment`,
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" },
      payload: { amountCents: "15000", voucherUrl: "manual://agent-confirm/1" }
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "processed" });
    expect(duplicate.json()).toMatchObject({ status: "duplicate" });
  });

  it("rejects admin manual creation for non-first-tier merchants and writes audit", async () => {
    const app = buildApp();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/admin/agents/manual",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { name: "错误二级商户", targetTier: "second_tier" }
    });
    const audit = await app.inject({
      method: "GET",
      url: "/api/admin/audit-logs",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe("ADMIN_CREATE_FIRST_TIER_ONLY");
    expect(JSON.stringify(audit.json())).toContain("agent.admin_create_rejected_non_first_tier");
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
          { platformProductId: "prod-1", salePriceCents: "16000" },
          { platformProductId: "prod-1", salePriceCents: "10000" }
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
      payload: { shopId: "shop-1", agentProductId: "ap-code", clientPaidAmountCents: "4900", buyerEmail: "buyer@example.com", extractionCode: "123456" }
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
    expect(detail.json()).toMatchObject({
      status: "fulfilled",
      fulfillmentStatus: "success",
      delivery: {
        mode: "automatic",
        buyerEmail: "buyer@example.com",
        extractionToken: expect.stringMatching(/^ext_/)
      }
    });
    expect(detail.json().delivery.codes).toEqual([]);

    const tokenExtracted = await app.inject({
      method: "POST",
      url: `/api/user/extractions/${detail.json().delivery.extractionToken}`,
      headers: { "x-user-id": "user-v2" },
      payload: { extractionCode: "123456" }
    });
    expect(tokenExtracted.statusCode).toBe(200);
    expect(tokenExtracted.json().codes).toHaveLength(1);

    const extracted = await app.inject({
      method: "POST",
      url: `/api/user/orders/${order.json().orderNo}/extract`,
      headers: { "x-user-id": "user-v2" },
      payload: { extractionCode: "123456" }
    });
    expect(extracted.statusCode).toBe(200);
    expect(extracted.json().codes).toHaveLength(1);

    const list = await app.inject({
      method: "GET",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-v2" }
    });
    expect(list.json()[0].delivery.codes).toEqual([]);
    expect(list.json()[0].buyerEmail).toBeUndefined();
    expect(list.json()[0].delivery.buyerEmail).toBeUndefined();
    expect(JSON.stringify(list.json())).not.toContain("V2-CODE-001");
    expect(JSON.stringify(list.json())).not.toContain("buyer@example.com");

    const emailDeliveries = await app.inject({
      method: "GET",
      url: "/api/admin/email-deliveries",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    expect(emailDeliveries.statusCode).toBe(200);
    expect(emailDeliveries.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderNo: order.json().orderNo,
        email: "buyer@example.com",
        codeCount: 1,
        status: "provider_not_configured"
      })
    ]));

    const risk = await app.inject({
      method: "GET",
      url: "/api/admin/risk-dashboard",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    expect(risk.statusCode).toBe(200);
    expect(risk.json()).toHaveProperty("lowStockProducts");
  });

  it("locks card extraction after three wrong codes and records extract logs", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { productId: "prod-code", batchNo: "lock-test", codes: ["LOCK-CODE-001"] }
    });
    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "extract-lock-user" },
      payload: { shopId: "shop-1", agentProductId: "ap-code", clientPaidAmountCents: "4900", extractionCode: "567890" }
    });
    await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: { channel: "mock", channelTradeNo: "trade-extract-lock", orderNo: order.json().orderNo, amountCents: "4900" }
    });
    for (let index = 0; index < 3; index += 1) {
      await app.inject({
        method: "POST",
        url: `/api/user/orders/${order.json().orderNo}/extract`,
        headers: { "x-user-id": "extract-lock-user" },
        payload: { extractionCode: "111111" }
      });
    }
    const locked = await app.inject({
      method: "POST",
      url: `/api/user/orders/${order.json().orderNo}/extract`,
      headers: { "x-user-id": "extract-lock-user" },
      payload: { extractionCode: "567890" }
    });
    const logs = await app.inject({
      method: "GET",
      url: "/api/admin/order-extract-logs",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });

    expect(locked.statusCode).toBe(423);
    expect(JSON.stringify(logs.json())).toContain("extract-lock-user");
    expect(JSON.stringify(logs.json())).toContain("locked");
  });

  it("lets merchants import card-code inventory only for their own automatic products", async () => {
    const app = buildApp();
    const agentHeaders = { "x-agent-id": "agent-1", "x-shop-id": "shop-1" };
    const adminHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };

    const own = await app.inject({
      method: "POST",
      url: "/api/agent/products/own",
      headers: agentHeaders,
      payload: {
        name: "商户自有自动卡密",
        salePriceCents: "8800",
        minSalePriceCents: "1000",
        fulfillmentMode: "code_pool"
      }
    });
    expect(own.statusCode).toBe(200);

    const review = await app.inject({
      method: "POST",
      url: `/api/admin/agent-products/reviews/${own.json().id}/review`,
      headers: adminHeaders,
      payload: { approved: true, reason: "自动发码商品资料通过" }
    });
    expect(review.statusCode).toBe(200);
    const agentProductId = review.json().agentProduct.id;

    const rejectedPlatformImport = await app.inject({
      method: "POST",
      url: "/api/agent/rights-codes/import",
      headers: agentHeaders,
      payload: { agentProductId: "ap-code", batchNo: "bad-scope", codes: ["NOPE-001"] }
    });
    expect(rejectedPlatformImport.statusCode).toBe(400);
    expect(rejectedPlatformImport.json().code).toBe("RIGHTS_CODE_PRODUCT_SCOPE_INVALID");

    const ownPrecheck = await app.inject({
      method: "POST",
      url: "/api/agent/rights-codes/precheck",
      headers: agentHeaders,
      payload: { agentProductId, codes: ["OWN-CODE-001", "OWN-CODE-001", "", "bad\u0002"] }
    });
    expect(ownPrecheck.statusCode).toBe(200);
    expect(ownPrecheck.json().summary).toMatchObject({ create: 1, skipped: 1, failed: 2 });
    expect(JSON.stringify(ownPrecheck.json())).not.toContain("OWN-CODE-001");

    const imported = await app.inject({
      method: "POST",
      url: "/api/agent/rights-codes/import",
      headers: agentHeaders,
      payload: { agentProductId, batchNo: "own-batch", codes: ["OWN-CODE-001"] }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ count: 1 });
    expect(JSON.stringify(imported.json())).not.toContain("OWN-CODE-001");

    const inventory = await app.inject({
      method: "GET",
      url: `/api/agent/rights-codes?agentProductId=${agentProductId}`,
      headers: agentHeaders
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()[0]).toMatchObject({ productId: agentProductId, codePreview: "OW***01" });
    expect(JSON.stringify(inventory.json())).not.toContain("OWN-CODE-001");

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "merchant-own-buyer" },
      payload: { shopId: "shop-1", agentProductId, clientPaidAmountCents: "8800", extractionCode: "778899" }
    });
    expect(order.statusCode).toBe(200);

    const payment = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: { channel: "mock", channelTradeNo: "trade-own-code", orderNo: order.json().orderNo, amountCents: "8800" }
    });
    expect(payment.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/user/orders/${order.json().orderNo}`,
      headers: { "x-user-id": "merchant-own-buyer" }
    });
    expect(detail.json().delivery.extractionToken).toMatch(/^ext_/);

    const extracted = await app.inject({
      method: "POST",
      url: `/api/user/extractions/${detail.json().delivery.extractionToken}`,
      headers: { "x-user-id": "merchant-own-buyer" },
      payload: { extractionCode: "778899" }
    });
    expect(extracted.statusCode).toBe(200);
    expect(extracted.json().codes[0].code).toBe("OWN-CODE-001");
  });

  it("allows repeated extraction codes on different orders and locks attempts per order", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { productId: "prod-code", batchNo: "repeat-code-test", codes: ["REPEAT-CODE-001", "REPEAT-CODE-002"] }
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "repeat-extract-user" },
      payload: { shopId: "shop-1", agentProductId: "ap-code", clientPaidAmountCents: "4900", extractionCode: "246810" }
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "repeat-extract-user" },
      payload: { shopId: "shop-1", agentProductId: "ap-code", clientPaidAmountCents: "4900", extractionCode: "246810" }
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: { channel: "mock", channelTradeNo: "trade-repeat-extract-1", orderNo: first.json().orderNo, amountCents: "4900" }
    });
    await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: { channel: "mock", channelTradeNo: "trade-repeat-extract-2", orderNo: second.json().orderNo, amountCents: "4900" }
    });
    for (let index = 0; index < 3; index += 1) {
      await app.inject({
        method: "POST",
        url: `/api/user/orders/${first.json().orderNo}/extract`,
        headers: { "x-user-id": "repeat-extract-user" },
        payload: { extractionCode: "000000" }
      });
    }
    const firstLocked = await app.inject({
      method: "POST",
      url: `/api/user/orders/${first.json().orderNo}/extract`,
      headers: { "x-user-id": "repeat-extract-user" },
      payload: { extractionCode: "246810" }
    });
    const secondExtracted = await app.inject({
      method: "POST",
      url: `/api/user/orders/${second.json().orderNo}/extract`,
      headers: { "x-user-id": "repeat-extract-user" },
      payload: { extractionCode: "246810" }
    });

    expect(firstLocked.statusCode).toBe(423);
    expect(secondExtracted.statusCode).toBe(200);
    expect(secondExtracted.json().codes).toHaveLength(1);
  });

  it("requires extraction code but keeps buyer email optional for automatic card-code orders", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-email-required" },
      payload: { shopId: "shop-1", agentProductId: "ap-code", clientPaidAmountCents: "4900" }
    });
    const optionalEmail = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-email-optional" },
      payload: { shopId: "shop-1", agentProductId: "ap-code", clientPaidAmountCents: "4900", extractionCode: "234567" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("PURCHASE_PASSWORD_REQUIRED");
    expect(optionalEmail.statusCode).toBe(200);
    expect(optionalEmail.json().buyerEmail).toBeUndefined();
  });

  it("grants first-register coupons and applies one platform coupon without changing price-spread basis", async () => {
    const app = buildApp();
    const auth = await app.inject({
      method: "POST",
      url: "/api/auth/h5/register",
      payload: { phone: "13812345678", displayName: "券用户" }
    });
    const couponId = auth.json().grantedCoupon.id;
    const quote = await app.inject({
      method: "POST",
      url: "/api/user/orders/quote",
      headers: { "x-user-id": "h5-phone-13812345678" },
      payload: { shopId: "shop-1", agentProductId: "ap-1", couponId }
    });
    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "h5-phone-13812345678" },
      payload: { shopId: "shop-1", agentProductId: "ap-1", couponId, clientPaidAmountCents: "14500" }
    });
    const agentOrders = await app.inject({
      method: "GET",
      url: "/api/agent/orders",
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" }
    });

    expect(auth.statusCode).toBe(200);
    expect(quote.json()).toMatchObject({
      paidAmountCents: "14500",
      buyerPaidAmountCents: "14500",
      settlementBasisAmountCents: "15000",
      couponDiscountCents: "500"
    });
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({
      paidAmountCents: "14500",
      buyerPaidAmountCents: "14500",
      settlementBasisAmountCents: "15000",
      couponDiscountCents: "500"
    });
    const wrongCollectionAmount = await app.inject({
      method: "POST",
      url: `/api/agent/orders/${order.json().orderNo}/confirm-payment`,
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" },
      payload: { amountCents: order.json().settlementBasisAmountCents, voucherUrl: "manual://coupon/wrong-basis" }
    });
    const collection = await app.inject({
      method: "POST",
      url: `/api/agent/orders/${order.json().orderNo}/confirm-payment`,
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" },
      payload: { amountCents: order.json().buyerPaidAmountCents, voucherUrl: "manual://coupon/buyer-paid" }
    });
    expect(agentOrders.json().find((item: { orderNo: string }) => item.orderNo === order.json().orderNo)).toMatchObject({
      paidAmountCents: "14500",
      buyerPaidAmountCents: "14500",
      settlementBasisAmountCents: "15000"
    });
    expect(wrongCollectionAmount.statusCode).toBe(400);
    expect(wrongCollectionAmount.json().code).toBe("AMOUNT_MISMATCH");
    expect(collection.statusCode).toBe(200);
    expect(collection.json()).toMatchObject({ status: "processed" });
  });

  it("lets the back office confirm offline collection and trigger automatic delivery without real payment", async () => {
    const app = buildApp();
    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "offline-user" },
      payload: {
        shopId: "shop-1",
        agentProductId: "ap-code",
        clientPaidAmountCents: "4900",
        buyerEmail: "offline@example.com",
        extractionCode: "345678"
      }
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${order.json().orderNo}/offline-payment`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: {
        amountCents: "4900",
        voucherUrl: "manual://offline-payment/test-1",
        note: "线下收款确认"
      }
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${order.json().orderNo}/offline-payment`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: {
        amountCents: "4900",
        voucherUrl: "manual://offline-payment/test-1"
      }
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/user/orders/${order.json().orderNo}`,
      headers: { "x-user-id": "offline-user" }
    });

    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ status: "processed" });
    expect(duplicate.json()).toMatchObject({ status: "duplicate" });
    expect(detail.json()).toMatchObject({
      paymentStatus: "paid",
      fulfillmentStatus: "success",
      delivery: { mode: "automatic", buyerEmail: "offline@example.com" }
    });
    expect(detail.json().delivery.codes).toEqual([]);
  });

  it("scopes payment vouchers to the selling merchant and lets finance approve them", async () => {
    const app = buildApp();
    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "voucher-user" },
      payload: {
        shopId: "shop-1",
        agentProductId: "ap-1",
        clientPaidAmountCents: "15000"
      }
    });
    const voucher = await app.inject({
      method: "POST",
      url: `/api/user/orders/${order.json().orderNo}/payment-vouchers`,
      headers: { "x-user-id": "voucher-user" },
      payload: {
        channel: "alipay_wap",
        payerName: "验收付款人",
        voucherUrl: "https://example.test/voucher.png",
        note: "页面级验收付款凭证"
      }
    });
    const crossUserVoucher = await app.inject({
      method: "POST",
      url: `/api/user/orders/${order.json().orderNo}/payment-vouchers`,
      headers: { "x-user-id": "other-voucher-user" },
      payload: {
        channel: "alipay_wap",
        payerName: "越权付款人",
        voucherUrl: "https://example.test/cross-voucher.png"
      }
    });
    const ownList = await app.inject({
      method: "GET",
      url: "/api/agent/payment-vouchers",
      headers: { "x-agent-id": "agent-1", "x-shop-id": "shop-1" }
    });
    const crossList = await app.inject({
      method: "GET",
      url: "/api/agent/payment-vouchers",
      headers: { "x-agent-id": "agent-2", "x-shop-id": "shop-2" }
    });
    const reviewed = await app.inject({
      method: "POST",
      url: `/api/admin/payment-vouchers/${voucher.json().id}/review`,
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { approved: true, reason: "凭证有效" }
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/user/orders/${order.json().orderNo}`,
      headers: { "x-user-id": "voucher-user" }
    });

    expect(voucher.statusCode).toBe(200);
    expect(crossUserVoucher.statusCode).toBe(403);
    expect(crossUserVoucher.json()).toMatchObject({ code: "FORBIDDEN_USER_SCOPE" });
    expect(ownList.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: voucher.json().id, orderNo: order.json().orderNo, status: "pending_review" })
    ]));
    expect(crossList.json()).toEqual([]);
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json()).toMatchObject({ status: "approved" });
    expect(detail.json()).toMatchObject({ paymentStatus: "paid" });
  });

  it("audits reconciliation exports and supports admin order pagination filters", async () => {
    const app = buildApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "export-user-1" },
      payload: { shopId: "shop-1", agentProductId: "ap-1", clientPaidAmountCents: "15000" }
    });
    await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "export-user-2" },
      payload: { shopId: "shop-1", agentProductId: "ap-1", clientPaidAmountCents: "15000" }
    });
    const page = await app.inject({
      method: "GET",
      url: "/api/admin/orders?page=1&pageSize=1&shopId=shop-1&status=pending_payment_confirmation",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    const exported = await app.inject({
      method: "GET",
      url: "/api/exports/reconciliation-summary",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    const audit = await app.inject({
      method: "GET",
      url: "/api/admin/audit-logs",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });

    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ page: 1, pageSize: 1 });
    expect(page.json().total).toBeGreaterThanOrEqual(2);
    expect(page.json().items).toHaveLength(1);
    expect(page.json().items[0].orderNo).toBe(first.json().orderNo);
    expect(exported.statusCode).toBe(200);
    expect(exported.json()).toHaveProperty("totalPaidCents");
    expect(JSON.stringify(audit.json())).toContain("export.reconciliation_summary");
  });

  it("refuses production business service when persistence is not configured", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalMock = process.env.MOCK_PAYMENT_ENABLED;
    const originalSecret = process.env.AUTH_TOKEN_SECRET;
    const originalDemoAuth = process.env.ALLOW_DEMO_AUTH;
    process.env.NODE_ENV = "production";
    process.env.AUTH_TOKEN_SECRET = "test-production-secret";
    process.env.ALLOW_DEMO_AUTH = "true";
    process.env.MOCK_PAYMENT_ENABLED = "true";
    try {
      const app = buildApp();
      const health = await app.inject({ method: "GET", url: "/api/health" });
      const business = await app.inject({ method: "GET", url: "/api/user/shops/shop-1" });

      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: false, runtime: "production", code: "PERSISTENCE_NOT_CONFIGURED" });
      expect(business.statusCode).toBe(503);
      expect(business.json().code).toBe("PERSISTENCE_NOT_CONFIGURED");
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalMock === undefined) delete process.env.MOCK_PAYMENT_ENABLED;
      else process.env.MOCK_PAYMENT_ENABLED = originalMock;
      if (originalSecret === undefined) delete process.env.AUTH_TOKEN_SECRET;
      else process.env.AUTH_TOKEN_SECRET = originalSecret;
      if (originalDemoAuth === undefined) delete process.env.ALLOW_DEMO_AUTH;
      else process.env.ALLOW_DEMO_AUTH = originalDemoAuth;
    }
  });

  it("wires production to Prisma mode, disables mini-program login, and issues admin bearer sessions", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalSecret = process.env.AUTH_TOKEN_SECRET;
    const originalAdminUser = process.env.ADMIN_USERNAME;
    const originalAdminPassword = process.env.ADMIN_PASSWORD;
    const originalAdminId = process.env.ADMIN_ID;
    const originalAdminRole = process.env.ADMIN_ROLE;
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://tosell:tosell@localhost:5432/tosell";
    process.env.AUTH_TOKEN_SECRET = "test-production-secret";
    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD = "secret";
    process.env.ADMIN_ID = "admin-prod";
    process.env.ADMIN_ROLE = "admin";
    try {
      const app = buildApp();
      const health = await app.inject({ method: "GET", url: "/api/health" });
      const mini = await app.inject({
        method: "POST",
        url: "/api/auth/wechat-miniprogram/login",
        payload: { code: "wx-code" }
      });
      const legacyMini = await app.inject({
        method: "POST",
        url: "/api/auth/wechat/miniprogram/login",
        payload: { code: "wx-code" }
      });
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/admin/login",
        payload: { username: "admin", password: "secret" }
      });
      const session = await app.inject({
        method: "GET",
        url: "/api/auth/admin/session",
        headers: { authorization: `Bearer ${login.json().token}` }
      });
      const headerOnlySession = await app.inject({
        method: "GET",
        url: "/api/auth/admin/session",
        headers: { "x-admin-id": "admin-prod", "x-admin-role": "admin" }
      });

      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ ok: true, runtime: "production", persistenceMode: "prisma", databaseConfigured: true });
      expect(mini.statusCode).toBe(410);
      expect(mini.json().code).toBe("MINIPROGRAM_LOGIN_DISABLED");
      expect(legacyMini.statusCode).toBe(410);
      expect(legacyMini.json().code).toBe("MINIPROGRAM_LOGIN_DISABLED");
      expect(login.statusCode).toBe(200);
      expect(login.json().admin).toMatchObject({ adminId: "admin-prod", adminRole: "admin" });
      expect(session.statusCode).toBe(200);
      expect(session.json().admin).toMatchObject({ adminId: "admin-prod", adminRole: "admin" });
      expect(headerOnlySession.statusCode).toBe(401);
      expect(headerOnlySession.json().code).toBe("AUTH_REQUIRED");
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalSecret === undefined) delete process.env.AUTH_TOKEN_SECRET;
      else process.env.AUTH_TOKEN_SECRET = originalSecret;
      if (originalAdminUser === undefined) delete process.env.ADMIN_USERNAME;
      else process.env.ADMIN_USERNAME = originalAdminUser;
      if (originalAdminPassword === undefined) delete process.env.ADMIN_PASSWORD;
      else process.env.ADMIN_PASSWORD = originalAdminPassword;
      if (originalAdminId === undefined) delete process.env.ADMIN_ID;
      else process.env.ADMIN_ID = originalAdminId;
      if (originalAdminRole === undefined) delete process.env.ADMIN_ROLE;
      else process.env.ADMIN_ROLE = originalAdminRole;
    }
  });

  it("issues merchant bearer sessions for manual first-tier accounts", async () => {
    const app = buildApp();
    const adminHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };
    const create = await app.inject({
      method: "POST",
      url: "/api/admin/agents/manual",
      headers: adminHeaders,
      payload: {
        name: "Bearer 登录商户",
        shopName: "Bearer 登录店铺",
        contactPhone: "13600000001",
        customerServiceWechat: "merchant_service",
        initialPassword: "merchant-pass-1",
        depositRequiredAmountCents: "50000"
      }
    });
    expect(create.statusCode).toBe(200);

    const account = create.json().credential.account;
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/agent/login",
      payload: { account, password: "merchant-pass-1" }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().agent).toMatchObject({
      agentId: create.json().agent.id,
      depositStatus: "pending_payment"
    });

    const session = await app.inject({
      method: "GET",
      url: "/api/auth/agent/session",
      headers: { authorization: `Bearer ${login.json().token}` }
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().shop).toMatchObject({ shopId: create.json().shop.id });

    const shop = await app.inject({
      method: "GET",
      url: "/api/agent/shop",
      headers: { authorization: `Bearer ${login.json().token}` }
    });
    expect(shop.statusCode).toBe(200);
    expect(shop.json()).toMatchObject({ id: create.json().shop.id });
  });

  it("does not return a successful H5 register session when production coupon persistence fails", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalSecret = process.env.AUTH_TOKEN_SECRET;
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgresql://tosell:tosell@localhost:5432/tosell";
    process.env.AUTH_TOKEN_SECRET = "test-production-secret";
    try {
      const app = buildApp();
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/h5/register",
        payload: { phone: "13800009999", displayName: "生产注册失败测试" }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("DATABASE_UNAVAILABLE");
      expect(response.body).not.toContain("\"token\"");
      expect(response.body).not.toContain("grantedCoupon");
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalSecret === undefined) delete process.env.AUTH_TOKEN_SECRET;
      else process.env.AUTH_TOKEN_SECRET = originalSecret;
    }
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
      payload: { shopId: "shop-1", agentProductId: "ap-code", quantity: 2, clientPaidAmountCents: "9800", buyerEmail: "qty@example.com", extractionCode: "456789" }
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
    const orderCodes = await app.inject({
      method: "GET",
      url: `/api/admin/rights-codes?productId=prod-code&orderNo=${order.json().orderNo}&status=issued`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });

    const issuedForOrder = codes.json().filter((code: { orderNo?: string }) => code.orderNo === order.json().orderNo);
    expect(issuedForOrder).toHaveLength(2);
    expect(orderCodes.json()).toHaveLength(2);
  });

  it("registers first, second, and third-tier merchants through formal invite-code APIs and rejects fourth tier", async () => {
    const app = buildApp();
    const adminHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };
    const financeHeaders = { "x-admin-id": "finance-1", "x-admin-role": "finance" };

    const firstInvite = await app.inject({
      method: "POST",
      url: "/api/admin/invite-codes",
      headers: adminHeaders,
      payload: { code: "P0-FIRST-E2E", depositRequiredAmountCents: "50000" }
    });
    expect(firstInvite.statusCode).toBe(200);
    expect(firstInvite.json()).toMatchObject({ code: "P0-FIRST-E2E", targetTier: "first_tier" });

    const first = await app.inject({
      method: "POST",
      url: "/api/agent/register-by-invite",
      payload: { inviteCode: "P0-FIRST-E2E", name: "一级正式 API 商户", shopName: "一级正式 API 店" }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().agent).toMatchObject({ tier: "first_tier", status: "pending_review" });
    const firstAgentId = first.json().agent.id;
    const firstCredential = first.json().credential;

    const firstBeforeReviewLogin = await app.inject({
      method: "POST",
      url: "/api/auth/agent/login",
      payload: { account: firstCredential.account, password: firstCredential.initialPassword }
    });
    expect(firstBeforeReviewLogin.statusCode).toBe(403);

    await app.inject({ method: "POST", url: `/api/admin/agents/${firstAgentId}/review`, headers: adminHeaders, payload: { approved: true } });
    await app.inject({ method: "POST", url: `/api/admin/deposits/${firstAgentId}/confirm`, headers: financeHeaders, payload: { amountCents: "50000", voucherUrl: "manual://deposit/first-e2e" } });
    const firstLogin = await app.inject({
      method: "POST",
      url: "/api/auth/agent/login",
      payload: { account: firstCredential.account, password: firstCredential.initialPassword }
    });
    expect(firstLogin.statusCode).toBe(200);
    const firstAgentHeaders = { authorization: `Bearer ${firstLogin.json().token}` };

    const secondInvite = await app.inject({
      method: "POST",
      url: "/api/agent/invite-codes",
      headers: firstAgentHeaders,
      payload: { code: "P0-SECOND-E2E" }
    });
    expect(secondInvite.statusCode).toBe(200);
    expect(secondInvite.json()).toMatchObject({
      code: "P0-SECOND-E2E",
      targetTier: "second_tier",
      status: "active",
      usedCount: 0,
      depositRequiredAmountCents: "50000",
      issuer: { type: "agent", agentId: firstAgentId },
      currentMerchantScope: { agentId: firstAgentId, ownsInvite: true }
    });
    expect(secondInvite.json()).not.toHaveProperty("codeHash");

    const firstInviteList = await app.inject({ method: "GET", url: "/api/agent/invite-codes", headers: firstAgentHeaders });
    expect(firstInviteList.statusCode).toBe(200);
    expect(firstInviteList.json().map((item: Record<string, unknown>) => item.code)).toContain("P0-SECOND-E2E");
    expect(JSON.stringify(firstInviteList.json())).not.toContain("P0-THIRD-E2E");
    expect(JSON.stringify(firstInviteList.json())).not.toContain("codeHash");

    const second = await app.inject({
      method: "POST",
      url: "/api/agent/register-by-invite",
      payload: { inviteCode: "P0-SECOND-E2E", name: "二级正式 API 商户", shopName: "二级正式 API 店" }
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().agent).toMatchObject({ tier: "second_tier", parentAgentId: firstAgentId, status: "pending_review" });
    const secondAgentId = second.json().agent.id;
    const secondCredential = second.json().credential;

    await app.inject({ method: "POST", url: `/api/admin/agents/${secondAgentId}/review`, headers: adminHeaders, payload: { approved: true } });
    await app.inject({ method: "POST", url: `/api/admin/deposits/${secondAgentId}/confirm`, headers: financeHeaders, payload: { amountCents: "50000", voucherUrl: "manual://deposit/second-e2e" } });
    const secondLogin = await app.inject({
      method: "POST",
      url: "/api/auth/agent/login",
      payload: { account: secondCredential.account, password: secondCredential.initialPassword }
    });
    expect(secondLogin.statusCode).toBe(200);
    const secondAgentHeaders = { authorization: `Bearer ${secondLogin.json().token}` };

    const thirdInvite = await app.inject({
      method: "POST",
      url: "/api/agent/invite-codes",
      headers: secondAgentHeaders,
      payload: { code: "P0-THIRD-E2E" }
    });
    expect(thirdInvite.statusCode).toBe(200);
    expect(thirdInvite.json()).toMatchObject({
      code: "P0-THIRD-E2E",
      targetTier: "third_tier",
      status: "active",
      usedCount: 0,
      depositRequiredAmountCents: "50000",
      issuer: { type: "agent", agentId: secondAgentId },
      currentMerchantScope: { agentId: secondAgentId, ownsInvite: true }
    });
    expect(thirdInvite.json()).not.toHaveProperty("codeHash");

    const secondInviteList = await app.inject({ method: "GET", url: "/api/agent/invite-codes", headers: secondAgentHeaders });
    expect(secondInviteList.statusCode).toBe(200);
    expect(secondInviteList.json().map((item: Record<string, unknown>) => item.code)).toContain("P0-THIRD-E2E");
    expect(JSON.stringify(secondInviteList.json())).not.toContain("P0-SECOND-E2E");
    expect(JSON.stringify(secondInviteList.json())).not.toContain("codeHash");

    const third = await app.inject({
      method: "POST",
      url: "/api/agent/register-by-invite",
      payload: { inviteCode: "P0-THIRD-E2E", name: "三级正式 API 商户", shopName: "三级正式 API 店" }
    });
    expect(third.statusCode).toBe(200);
    expect(third.json().agent).toMatchObject({ tier: "third_tier", parentAgentId: secondAgentId, status: "pending_review" });
    const thirdAgentId = third.json().agent.id;
    const thirdCredential = third.json().credential;

    await app.inject({ method: "POST", url: `/api/admin/agents/${thirdAgentId}/review`, headers: adminHeaders, payload: { approved: true } });
    await app.inject({ method: "POST", url: `/api/admin/deposits/${thirdAgentId}/confirm`, headers: financeHeaders, payload: { amountCents: "50000", voucherUrl: "manual://deposit/third-e2e" } });
    const thirdLogin = await app.inject({
      method: "POST",
      url: "/api/auth/agent/login",
      payload: { account: thirdCredential.account, password: thirdCredential.initialPassword }
    });
    expect(thirdLogin.statusCode).toBe(200);

    const fourth = await app.inject({
      method: "POST",
      url: "/api/agent/invite-codes",
      headers: { authorization: `Bearer ${thirdLogin.json().token}` },
      payload: { code: "P0-FOURTH-E2E" }
    });
    const invites = await app.inject({ method: "GET", url: "/api/admin/invite-codes", headers: adminHeaders });
    const thirdInviteList = await app.inject({ method: "GET", url: "/api/agent/invite-codes", headers: { authorization: `Bearer ${thirdLogin.json().token}` } });

    expect(fourth.statusCode).toBe(400);
    expect(fourth.json().code).toBe("FOURTH_TIER_FORBIDDEN");
    expect(thirdInviteList.statusCode).toBe(200);
    expect(thirdInviteList.json()).toEqual([]);
    expect(JSON.stringify(invites.json())).toContain("P0-FIRST-E2E");
    expect(JSON.stringify(invites.json())).toContain("P0-SECOND-E2E");
    expect(JSON.stringify(invites.json())).toContain("P0-THIRD-E2E");
  });
});

function signedBearer(payload: Record<string, unknown>, secret: string) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `Bearer ${body}.${signature}`;
}

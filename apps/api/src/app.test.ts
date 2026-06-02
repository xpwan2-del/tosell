import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
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
        merchantProductListingId: "mpl-1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      paidAmountCents: "15000",
      salePriceCents: "15000",
      quantity: 1
    });
    expect(JSON.stringify(response.json())).not.toMatch(/supplyAmountCents|serviceFeeCents|merchantExpectedIncomeCents/);
  });

  it("rejects quote requests that cannot be resolved from backend product data", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/user/orders/quote",
      headers: { "x-user-id": "user-1" },
      payload: {
        shopId: "shop-1",
        merchantProductListingId: "missing-product"
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
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

  it("blocks cross-merchant access", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/merchant/scope-check",
      headers: {
        "x-merchant-id": "a1",
        "x-shop-id": "s1"
      },
      payload: {
        resourceMerchantId: "a2"
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("does not accept forged merchant identity from the request body", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/merchant/scope-check",
      payload: {
        actorMerchantId: "merchant-1",
        actorShopId: "shop-1",
        resourceMerchantId: "merchant-1",
        resourceShopId: "shop-1"
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().message).toMatch(/x-merchant-id/);
  });

  it("requires user identity headers for user order creation", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
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
        merchantIncomeCents: "4925",
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
        merchantIncomeCents: "4925",
        refundAmountCents: "6000",
        responsibility: "mixed",
        platformBearCents: "4000",
        merchantBearCents: "2000"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      refundAmountCents: "6000",
      platformBearCents: "4000",
      merchantBearCents: "2000",
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

  it("creates orders from backend snapshots and hides them from other merchants", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: {
        shopId: "shop-1",
        merchantProductListingId: "mpl-1",
        clientPaidAmountCents: "15000"
      }
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      paidAmountCents: "15000",
      salePriceCents: "15000",
      productName: "ChatGPT Plus 成品号月卡"
    });
    expect(JSON.stringify(created.json())).not.toMatch(/supplyAmountCents|serviceFeeCents|merchantExpectedIncomeCents|settlementStatus/);

    const merchantTwoOrders = await app.inject({
      method: "GET",
      url: "/api/merchant/orders",
      headers: { "x-merchant-id": "merchant-2", "x-shop-id": "shop-2" }
    });
    expect(merchantTwoOrders.json()).toEqual([]);
  });

  it("lists only the current user's orders without internal finance fields", async () => {
    const app = buildApp();
    await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
    });
    await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-2" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
    });

    const orders = await app.inject({
      method: "GET",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" }
    });

    expect(orders.statusCode).toBe(200);
    expect(orders.json()).toHaveLength(1);
    expect(orders.json()[0]).toMatchObject({ userId: "user-1", paidAmountCents: "15000" });
    expect(JSON.stringify(orders.json())).not.toMatch(/supplyAmountCents|serviceFeeCents|merchantExpectedIncomeCents|settlementStatus/);
  });

  it("reviews merchant onboarding and opens the shop after deposit confirmation", async () => {
    const app = buildApp();
    const application = await app.inject({
      method: "POST",
      url: "/api/merchant/applications",
      headers: { "x-merchant-id": "merchant-new", "x-shop-id": "shop-new" },
      payload: { contactPhone: "13700000000", customerServiceWechat: "new_merchant_service" }
    });
    expect(application.statusCode).toBe(200);
    expect(application.json().status).toBe("pending_review");

    const reviewed = await app.inject({
      method: "POST",
      url: "/api/admin/merchants/merchant-new/review",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { approved: true }
    });
    expect(reviewed.json().status).toBe("pending_deposit");

    const deposit = await app.inject({
      method: "POST",
      url: "/api/admin/deposits/merchant-new/confirm",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { amountCents: "50000", voucherUrl: "https://example.test/deposit.png" }
    });
    expect(deposit.statusCode).toBe(200);
    expect(deposit.json().account.status).toBe("paid");

    const shop = await app.inject({
      method: "GET",
      url: "/api/merchant/shop",
      headers: { "x-merchant-id": "merchant-new", "x-shop-id": "shop-new" }
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
      url: "/api/user/products/mpl-1"
    });

    expect(list.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toMatch(/supplyPriceCents|minSalePriceCents|suggestedSalePriceCents/);
    expect(JSON.stringify(detail.json())).not.toMatch(/supplyPriceCents|minSalePriceCents|suggestedSalePriceCents/);
  });

  it("enforces platform minimum sale price on merchant pricing APIs", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/merchant/products/mpl-1/price",
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" },
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
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
      payload: { merchantId: "merchant-1", now: "2030-01-01T00:00:00.000Z", batchNo: "b1" }
    });
    const secondSettlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: { merchantId: "merchant-1", now: "2030-01-01T00:00:00.000Z", batchNo: "b2" }
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

  it("submits and approves a merchant-owned product before it can be sold", async () => {
    const app = buildApp();
    const submitted = await app.inject({
      method: "POST",
      url: "/api/merchant/products/own",
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" },
      payload: {
        name: "代理自有课程权益",
        category: "账号成品",
        tags: ["自有商品", "课程"],
        subtitle: "人工交付课程",
        description: "平台审核时需要看到完整商品说明",
        usageGuide: "付款后联系店铺客服开通课程权益",
        imageUrl: "https://example.com/course.png",
        specs: ["月卡", "人工开通"],
        detailSections: [{ title: "审核要点", items: ["核对说明", "核对交付方式"] }],
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
      url: `/api/merchant/products/own/${submitted.json().id}`,
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" }
    });
    expect(ownDetail.statusCode).toBe(200);
    expect(ownDetail.json()).toMatchObject({
      ownProductId: submitted.json().id,
      fulfillmentMode: "manual",
      manualFulfillmentInstruction: "付款后联系店铺客服开通课程权益"
    });

    const ownPatch = await app.inject({
      method: "PATCH",
      url: `/api/merchant/products/own/${submitted.json().id}`,
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" },
      payload: { subtitle: "人工交付课程", manualFulfillmentInstruction: "请提供订单号给客服核销" }
    });
    expect(ownPatch.statusCode).toBe(200);
    expect(ownPatch.json()).toMatchObject({
      subtitle: "人工交付课程",
      manualFulfillmentInstruction: "请提供订单号给客服核销"
    });

    const unauthenticatedQueue = await app.inject({ method: "GET", url: "/api/admin/merchant-products/reviews" });
    expect(unauthenticatedQueue.statusCode).toBe(401);

    const forbiddenQueue = await app.inject({
      method: "GET",
      url: "/api/admin/merchant-products/reviews",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" }
    });
    expect(forbiddenQueue.statusCode).toBe(403);

    const pendingQueue = await app.inject({
      method: "GET",
      url: "/api/admin/merchant-products/reviews?reviewStatus=pending_review&merchantId=merchant-1&shopId=shop-1&page=1&pageSize=10",
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    expect(pendingQueue.statusCode).toBe(200);
    expect(pendingQueue.json()).toMatchObject({ page: 1, pageSize: 10 });
    expect(pendingQueue.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: submitted.json().id,
        ownProductId: submitted.json().id,
        shopId: "shop-1",
        name: "代理自有课程权益",
        category: "账号成品",
        tags: ["自有商品", "课程"],
        subtitle: "人工交付课程",
        description: "平台审核时需要看到完整商品说明",
        usageGuide: "付款后联系店铺客服开通课程权益",
        imageUrl: "https://example.com/course.png",
        specs: ["月卡", "人工开通"],
        detailSections: [{ title: "审核要点", items: ["核对说明", "核对交付方式"] }],
        salePriceCents: "19900",
        minSalePriceCents: "9900",
        fulfillmentMode: "manual",
        reviewStatus: "pending_review",
        status: "pending_review",
        merchant: expect.objectContaining({ id: "merchant-1", name: "测试代理 A" }),
        shop: expect.objectContaining({ id: "shop-1" })
      })
    ]));

    const reviewed = await app.inject({
      method: "POST",
      url: `/api/admin/merchant-products/reviews/${submitted.json().id}/review`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { approved: true, reason: "符合虚拟商品规则" }
    });
    expect(reviewed.statusCode).toBe(200);
    expect(reviewed.json().merchantProductListing.productType).toBe("merchant_owned");
    expect(reviewed.json().ownProduct).toMatchObject({
      reviewStatus: "approved",
      status: "listed",
      reviewedBy: "operator-1",
      reviewedAt: expect.any(String)
    });

    const reviewDetail = await app.inject({
      method: "GET",
      url: `/api/admin/merchant-products/reviews/${submitted.json().id}`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    expect(reviewDetail.statusCode).toBe(200);
    expect(reviewDetail.json()).toMatchObject({
      ownProductId: submitted.json().id,
      reviewStatus: "approved",
      status: "listed",
      category: "账号成品",
      imageUrl: "https://example.com/course.png",
      merchant: expect.objectContaining({ id: "merchant-1" }),
      shop: expect.objectContaining({ id: "shop-1" })
    });

    const approvedQueue = await app.inject({
      method: "GET",
      url: `/api/admin/merchant-products/reviews?status=listed&merchantId=merchant-1&limit=5&offset=0`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" }
    });
    expect(approvedQueue.statusCode).toBe(200);
    expect(approvedQueue.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: submitted.json().id,
        ownProductId: submitted.json().id,
        reviewStatus: "approved",
        status: "listed",
        reviewedBy: "operator-1",
        reviewedAt: expect.any(String)
      })
    ]));

    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: {
        shopId: "shop-1",
        merchantProductListingId: reviewed.json().merchantProductListing.id,
        clientPaidAmountCents: "19900"
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().snapshot.productType).toBe("merchant_owned");
  });

  it("exposes product detail contracts, safe fulfillment switching, purchase-password extraction, and email resend", async () => {
    const app = buildApp();
    const operatorHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };
    const merchantHeaders = { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" };

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
      url: "/api/merchant/shop",
      headers: merchantHeaders,
      payload: { customerServiceQq: "123456789", customerServiceQqQrUrl: "https://example.test/qq-service.png" }
    });
    expect(serviceContact.statusCode).toBe(200);

    const merchantProductListingDetail = await app.inject({ method: "GET", url: "/api/merchant/products/mpl-1", headers: merchantHeaders });
    expect(merchantProductListingDetail.statusCode).toBe(200);
    expect(merchantProductListingDetail.json()).toMatchObject({
      id: "mpl-1",
      fieldPermissions: expect.objectContaining({ editable: expect.arrayContaining(["salePriceCents"]) })
    });
    expect(merchantProductListingDetail.json().product.supplyPriceCents).toBeUndefined();
    expect(merchantProductListingDetail.json().product.platformSupplyPriceCents).toBe("10000");

    const manualOrder = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "manual-detail-user" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1", clientPaidAmountCents: "15000" }
    });
    expect(manualOrder.statusCode).toBe(200);
    const manualConfirm = await app.inject({
      method: "POST",
      url: `/api/merchant/orders/${manualOrder.json().orderNo}/confirm-payment`,
      headers: merchantHeaders,
      payload: { amountCents: "15000", voucherUrl: "manual://detail/manual" }
    });
    expect(manualConfirm.statusCode).toBe(200);
    const manualFulfillment = await app.inject({
      method: "POST",
      url: `/api/merchant/orders/${manualOrder.json().orderNo}/fulfillment`,
      headers: merchantHeaders,
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
        merchantProductListingId: "mpl-code",
        clientPaidAmountCents: "4900",
        buyerEmail: "password@example.com",
        buyerPhone: "13800000001",
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

  it("creates clawback from merchant responsibility refund after payout", async () => {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-1" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
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
      payload: { merchantId: "merchant-1", now: "2030-01-01T00:00:00.000Z" }
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
      payload: { orderNo, reasonCode: "merchant_service_issue", requestedRefundCents: "5000" }
    });
    const refund = await app.inject({
      method: "POST",
      url: `/api/admin/after-sales/${afterSale.json().afterSaleNo}/refunds`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { refundAmountCents: "5000", responsibility: "merchant" }
    });
    await app.inject({
      method: "POST",
      url: "/api/callbacks/refunds/mock",
      payload: { channel: "mock", channelRefundNo: "refund-cb-1", refundNo: refund.json().refund.refundNo }
    });
    const clawbacks = await app.inject({
      method: "GET",
      url: "/api/merchant/clawbacks",
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" }
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
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
      payload: { merchantId: "merchant-1", now: "2030-01-01T00:00:00.000Z", batchNo: "payable-refund" }
    });

    const afterSale = await app.inject({
      method: "POST",
      url: "/api/user/after-sales",
      headers: { "x-user-id": "user-1" },
      payload: { orderNo, reasonCode: "merchant_service_issue", requestedRefundCents: "5000" }
    });
    const refund = await app.inject({
      method: "POST",
      url: `/api/admin/after-sales/${afterSale.json().afterSaleNo}/refunds`,
      headers: { "x-admin-id": "operator-1", "x-admin-role": "operator" },
      payload: { refundAmountCents: "5000", responsibility: "merchant" }
    });
    await app.inject({
      method: "POST",
      url: "/api/callbacks/refunds/mock",
      payload: { channel: "mock", channelRefundNo: "refund-cb-payable-1", refundNo: refund.json().refund.refundNo }
    });

    const clawbacks = await app.inject({
      method: "GET",
      url: "/api/merchant/clawbacks",
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" }
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
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
      payload: { merchantId: "merchant-1", now: "2030-01-01T00:00:00.000Z", batchNo: "risk-freeze" }
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
        merchantIncomeCents: "4925",
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
      url: "/api/admin/deposits/merchant-1/deduct",
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/admin/deposits/merchant-1/deduct",
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().code).toBe("ORDER_CREATE_FAILED");
  });

  it("runs V2 shop decor, batch listing, dashboard, notifications, and payment guide", async () => {
    const app = buildApp();
    const merchantHeaders = { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" };

    const decor = await app.inject({
      method: "PATCH",
      url: "/api/merchant/shop/decor",
      headers: merchantHeaders,
      payload: {
        themeColor: "#00aa88",
        bannerUrl: "https://example.test/banner.png",
        shareTitle: "代理 A 精选权益",
        productGroups: [{ name: "自动履约", merchantProductListingIds: ["mpl-code"] }]
      }
    });
    expect(decor.statusCode).toBe(200);
    expect(decor.json()).toMatchObject({ themeColor: "#00aa88", shareTitle: "代理 A 精选权益" });

    const shopUpdate = await app.inject({
      method: "PATCH",
      url: "/api/merchant/shop",
      headers: merchantHeaders,
      payload: {
        customerServiceQrUrl: "https://example.test/qr-merchant-a-new.png",
        customerServiceQq: "123456789",
        customerServiceQqQrUrl: "https://example.test/qq-merchant-a-new.png",
        customerServiceNote: "工作日 10:00-18:00"
      }
    });
    expect(shopUpdate.statusCode).toBe(200);
    expect(shopUpdate.json().customerServiceQrUrl).toBe("https://example.test/qr-merchant-a-new.png");
    expect(shopUpdate.json()).toMatchObject({
      customerServiceQq: "123456789",
      customerServiceQqQrUrl: "https://example.test/qq-merchant-a-new.png",
      customerServiceNote: "工作日 10:00-18:00"
    });
    const publicShop = await app.inject({ method: "GET", url: "/api/user/shops/shop-1" });
    expect(publicShop.statusCode).toBe(200);
    expect(publicShop.json()).toMatchObject({
      customerServiceQrUrl: "https://example.test/qr-merchant-a-new.png",
      customerServiceQq: "123456789",
      customerServiceQqQrUrl: "https://example.test/qq-merchant-a-new.png",
      customerServiceNote: "工作日 10:00-18:00"
    });
    expect(publicShop.json()).not.toHaveProperty("onlineCustomerServiceUrl");
    expect(publicShop.json()).not.toHaveProperty("onlineChatUrl");

    const batch = await app.inject({
      method: "POST",
      url: "/api/merchant/products/platform/batch",
      headers: merchantHeaders,
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
      url: "/api/merchant/dashboard",
      headers: merchantHeaders
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json()).toMatchObject({ activeProductCount: 8 });

    const notifications = await app.inject({
      method: "GET",
      url: "/api/merchant/notifications",
      headers: merchantHeaders
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

  it("supports platform self-operated shop orders without merchant settlement", async () => {
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
      payload: { shopId: "shop-platform", merchantProductListingId: "psp-1" }
    });
    expect(quote.statusCode).toBe(200);
    expect(quote.json()).toMatchObject({ paidAmountCents: "14900", salePriceCents: "14900" });
    expect(JSON.stringify(quote.json())).not.toMatch(/fulfillmentCostCents|platformSelfOperatedGrossMarginCents/);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-platform" },
      payload: { shopId: "shop-platform", merchantProductListingId: "psp-1", clientPaidAmountCents: "14900" }
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
      payload: { merchantId: "platform", now: "2030-01-01T00:00:00.000Z", batchNo: "platform-self" }
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

    const merchantApplications = await app.inject({ method: "GET", url: "/api/admin/merchant-applications", headers: operatorHeaders });
    const afterSales = await app.inject({ method: "GET", url: "/api/admin/after-sales", headers: operatorHeaders });
    const refunds = await app.inject({ method: "GET", url: "/api/admin/refunds", headers: operatorHeaders });
    const settlements = await app.inject({ method: "GET", url: "/api/admin/settlements", headers: financeHeaders });
    const deposits = await app.inject({ method: "GET", url: "/api/admin/deposits", headers: financeHeaders });
    const channels = await app.inject({ method: "GET", url: "/api/admin/merchant-supply", headers: operatorHeaders });
    const qrcodes = await app.inject({ method: "GET", url: "/api/admin/service-qrcodes", headers: operatorHeaders });
    const paymentConfig = await app.inject({ method: "GET", url: "/api/admin/payment-config/status", headers: operatorHeaders });

    expect(merchantApplications.statusCode).toBe(200);
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
    expect(paymentConfig.json().map((item: Record<string, unknown>) => item.provider)).toEqual(expect.arrayContaining([
      "alipay_merchant",
      "wechat_merchant",
      "epay",
      "personal_alipay",
      "wechat_personal",
      "balance"
    ]));

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
      url: "/api/admin/merchant-supply/merchant-2/review",
      headers: operatorHeaders,
      payload: { approved: true, reason: "允许作为一级渠道配置二级供货" }
    });
    expect(channelReview.statusCode).toBe(200);
    expect(channelReview.json()).toMatchObject({ firstTierMerchantId: "merchant-2", status: "active" });

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
      url: "/api/admin/merchant-supply/offers",
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
      payload: { shopId: "shop-2", merchantProductListingId: "ap-2" }
    });
    expect(quote.json()).toMatchObject({ paidAmountCents: "16000", salePriceCents: "16000" });
    expect(JSON.stringify(quote.json())).not.toMatch(/firstTierIncomeCents|resellSupplyPriceCents|commission|返佣/);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "two-tier-user" },
      payload: { shopId: "shop-2", merchantProductListingId: "ap-2", clientPaidAmountCents: "16000" }
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
      payload: { merchantId: "merchant-1", now: "2030-01-01T00:00:00.000Z", batchNo: "two-tier-first" }
    });
    expect(firstTierSettlement.statusCode).toBe(200);
    expect(firstTierSettlement.json().items[0]).toMatchObject({
      orderId: order.json().orderNo,
      settlementRole: "first_tier",
      merchantIncomeCents: "1000"
    });

    const secondTierSettlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: financeHeaders,
      payload: { merchantId: "merchant-2", now: "2030-01-01T00:00:00.000Z", batchNo: "two-tier-second" }
    });
    expect(secondTierSettlement.statusCode).toBe(200);
    expect(secondTierSettlement.json().items[0]).toMatchObject({
      orderId: order.json().orderNo,
      settlementRole: "second_tier",
      merchantIncomeCents: "4920"
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
      url: "/api/admin/merchant-supply/offers",
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
      url: "/api/admin/merchant-supply/relations",
      headers: operatorHeaders,
      payload: {
        firstTierMerchantId: "merchant-2",
        secondTierMerchantId: "merchant-3",
        thirdTierMerchantId: "merchant-new"
      }
    });
    expect(fourthTierAttempt.statusCode).toBe(400);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "three-tier-user" },
      payload: { shopId: "shop-3", merchantProductListingId: "ap-3", clientPaidAmountCents: "15000" }
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
      payload: { merchantId: "merchant-1", now: "2030-01-01T00:00:00.000Z", batchNo: "three-tier-first" }
    });
    expect(firstTierSettlement.statusCode).toBe(200);
    expect(firstTierSettlement.json().items[0]).toMatchObject({ settlementRole: "first_tier", merchantIncomeCents: "1000" });

    const secondTierSettlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: financeHeaders,
      payload: { merchantId: "merchant-2", now: "2030-01-01T00:00:00.000Z", batchNo: "three-tier-second" }
    });
    expect(secondTierSettlement.statusCode).toBe(200);
    expect(secondTierSettlement.json().items[0]).toMatchObject({ settlementRole: "second_tier", merchantIncomeCents: "2000" });

    const thirdTierSettlement = await app.inject({
      method: "POST",
      url: "/api/admin/settlements/generate",
      headers: financeHeaders,
      payload: { merchantId: "merchant-3", now: "2030-01-01T00:00:00.000Z", batchNo: "three-tier-third" }
    });
    expect(thirdTierSettlement.statusCode).toBe(200);
    expect(thirdTierSettlement.json().items[0]).toMatchObject({ settlementRole: "third_tier", merchantIncomeCents: "1925" });
  });

  it("lets M3 sell upstream-opened code-pool platform products from the platform master pool", async () => {
    const app = buildApp();
    const operatorHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };
    const secondHeaders = { "x-merchant-id": "merchant-2", "x-shop-id": "shop-2" };
    const thirdHeaders = { "x-merchant-id": "merchant-3", "x-shop-id": "shop-3" };

    await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: operatorHeaders,
      payload: { productId: "prod-code", batchNo: "m3-code-pool", codes: ["M3-CODE-POOL-001"] }
    });
    const firstToSecondOffer = await app.inject({
      method: "POST",
      url: "/api/admin/merchant-supply/offers",
      headers: operatorHeaders,
      payload: { channelRelationId: "channel-rel-1", platformProductId: "prod-code", resellSupplyPriceCents: "2500" }
    });
    expect(firstToSecondOffer.statusCode).toBe(200);

    const secondListing = await app.inject({
      method: "POST",
      url: "/api/merchant/products/platform",
      headers: secondHeaders,
      payload: {
        platformProductId: "prod-code",
        salePriceCents: "3900",
        displayName: "M2 Claude 自动发码",
        status: "listed"
      }
    });
    expect(secondListing.statusCode).toBe(200);
    expect(secondListing.json()).toMatchObject({ platformProductId: "prod-code", productType: "platform" });

    const secondToThirdOffer = await app.inject({
      method: "POST",
      url: "/api/admin/merchant-supply/offers",
      headers: operatorHeaders,
      payload: { channelRelationId: "channel-rel-2", platformProductId: "prod-code", resellSupplyPriceCents: "4200" }
    });
    expect(secondToThirdOffer.statusCode).toBe(200);

    const thirdListing = await app.inject({
      method: "POST",
      url: "/api/merchant/products/platform",
      headers: thirdHeaders,
      payload: {
        platformProductId: "prod-code",
        salePriceCents: "5900",
        displayName: "M3 Claude 自动发码",
        status: "listed"
      }
    });
    expect(thirdListing.statusCode).toBe(200);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "m3-code-pool-user" },
      payload: {
        shopId: "shop-3",
        merchantProductListingId: thirdListing.json().id,
        clientPaidAmountCents: "5900",
        buyerPhone: "13800000009",
        purchasePassword: "654321"
      }
    });
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({ salesChannelType: "three_tier", paidAmountCents: "5900" });

    const lockedCodes = await app.inject({
      method: "GET",
      url: `/api/admin/rights-codes?productId=prod-code&orderNo=${order.json().orderNo}&status=locked`,
      headers: operatorHeaders
    });
    expect(lockedCodes.statusCode).toBe(200);
    expect(lockedCodes.json()).toHaveLength(1);
    expect(lockedCodes.json()[0]).toMatchObject({ productId: "prod-code", status: "locked" });

    const payment = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: {
        channel: "mock",
        channelTradeNo: "trade-m3-code-pool",
        orderNo: order.json().orderNo,
        amountCents: "5900"
      }
    });
    expect(payment.statusCode).toBe(200);

    const issuedCodes = await app.inject({
      method: "GET",
      url: `/api/admin/rights-codes?productId=prod-code&orderNo=${order.json().orderNo}&status=issued`,
      headers: operatorHeaders
    });
    expect(issuedCodes.statusCode).toBe(200);
    expect(issuedCodes.json()).toHaveLength(1);
    expect(issuedCodes.json()[0]).toMatchObject({ productId: "prod-code", status: "issued" });
  });

  it("enforces tiered price visibility on merchant product and order APIs", async () => {
    const app = buildApp();
    const secondProducts = await app.inject({
      method: "GET",
      url: "/api/merchant/products",
      headers: { "x-merchant-id": "merchant-2", "x-shop-id": "shop-2" }
    });
    const thirdProducts = await app.inject({
      method: "GET",
      url: "/api/merchant/products",
      headers: { "x-merchant-id": "merchant-3", "x-shop-id": "shop-3" }
    });
    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "tier-visibility-user" },
      payload: { shopId: "shop-3", merchantProductListingId: "ap-3", clientPaidAmountCents: "15000" }
    });
    const secondOrders = await app.inject({
      method: "GET",
      url: "/api/merchant/orders",
      headers: { "x-merchant-id": "merchant-2", "x-shop-id": "shop-2" }
    });
    const thirdOrders = await app.inject({
      method: "GET",
      url: "/api/merchant/orders",
      headers: { "x-merchant-id": "merchant-3", "x-shop-id": "shop-3" }
    });

    expect(order.statusCode).toBe(200);
    expect(JSON.stringify(secondProducts.json())).not.toMatch(/platformSupplyPriceCents|supplyPriceCents/);
    expect(JSON.stringify(thirdProducts.json())).not.toMatch(/platformSupplyPriceCents|firstTierSupplyPriceCents|supplyPriceCents/);
    expect(JSON.stringify(secondOrders.json())).not.toMatch(/platformSupplyPriceCents/);
    expect(JSON.stringify(thirdOrders.json())).not.toMatch(/platformSupplyPriceCents|firstTierSupplyPriceCents/);
  });

  it("scopes merchant channel offers, fulfillment, and after-sale assistance", async () => {
    const app = buildApp();
    const firstHeaders = { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" };
    const secondHeaders = { "x-merchant-id": "merchant-2", "x-shop-id": "shop-2" };
    const thirdHeaders = { "x-merchant-id": "merchant-3", "x-shop-id": "shop-3" };

    const firstOffer = await app.inject({
      method: "POST",
      url: "/api/merchant/supply/offers",
      headers: firstHeaders,
      payload: { downstreamMerchantId: "merchant-2", platformProductId: "prod-1", resellSupplyPriceCents: "11200" }
    });
    const secondOffer = await app.inject({
      method: "POST",
      url: "/api/merchant/supply/offers",
      headers: secondHeaders,
      payload: { downstreamMerchantId: "merchant-3", platformProductId: "prod-1", resellSupplyPriceCents: "13200" }
    });
    const thirdOffer = await app.inject({
      method: "POST",
      url: "/api/merchant/supply/offers",
      headers: thirdHeaders,
      payload: { downstreamMerchantId: "merchant-new", platformProductId: "prod-1", resellSupplyPriceCents: "14000" }
    });
    const crossOffer = await app.inject({
      method: "POST",
      url: "/api/merchant/supply/offers",
      headers: firstHeaders,
      payload: { downstreamMerchantId: "merchant-3", platformProductId: "prod-1", resellSupplyPriceCents: "14000" }
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
      payload: { shopId: "shop-3", merchantProductListingId: "ap-3", clientPaidAmountCents: "15000" }
    });
    expect(order.statusCode).toBe(200);

    const thirdOrders = await app.inject({ method: "GET", url: "/api/merchant/orders", headers: thirdHeaders });
    expect(thirdOrders.statusCode).toBe(200);
    expect(thirdOrders.json().some((item: Record<string, unknown>) => item.orderNo === order.json().orderNo)).toBe(true);

    const thirdOrderDetail = await app.inject({ method: "GET", url: `/api/merchant/orders/${order.json().orderNo}`, headers: thirdHeaders });
    const crossOrderDetail = await app.inject({
      method: "GET",
      url: `/api/merchant/orders/${order.json().orderNo}`,
      headers: { "x-merchant-id": "merchant-new", "x-shop-id": "shop-new" }
    });
    expect(thirdOrderDetail.statusCode).toBe(200);
    expect(thirdOrderDetail.json()).toMatchObject({ orderNo: order.json().orderNo });
    expect(crossOrderDetail.statusCode).toBe(404);

    const crossConfirm = await app.inject({
      method: "POST",
      url: `/api/merchant/orders/${order.json().orderNo}/confirm-payment`,
      headers: secondHeaders,
      payload: { amountCents: "15000", voucherUrl: "manual://cross-confirm" }
    });
    expect(crossConfirm.statusCode).toBe(403);

    const confirm = await app.inject({
      method: "POST",
      url: `/api/merchant/orders/${order.json().orderNo}/confirm-payment`,
      headers: thirdHeaders,
      payload: { amountCents: "15000", voucherUrl: "manual://third-confirm" }
    });
    expect(confirm.statusCode).toBe(200);

    const crossFulfill = await app.inject({
      method: "POST",
      url: `/api/merchant/orders/${order.json().orderNo}/fulfillment`,
      headers: secondHeaders,
      payload: { status: "success", attemptNo: 1, evidence: "wrong merchant" }
    });
    expect(crossFulfill.statusCode).toBe(403);

    const fulfillment = await app.inject({
      method: "POST",
      url: `/api/merchant/orders/${order.json().orderNo}/fulfillment`,
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

    const secondAfterSales = await app.inject({ method: "GET", url: "/api/merchant/after-sales", headers: secondHeaders });
    const thirdAfterSales = await app.inject({ method: "GET", url: "/api/merchant/after-sales", headers: thirdHeaders });
    expect(secondAfterSales.json().some((item: Record<string, unknown>) => item.afterSaleNo === afterSale.json().afterSaleNo)).toBe(false);
    expect(thirdAfterSales.json().some((item: Record<string, unknown>) => item.afterSaleNo === afterSale.json().afterSaleNo)).toBe(true);

    const crossAssist = await app.inject({
      method: "POST",
      url: `/api/merchant/after-sales/${afterSale.json().afterSaleNo}/assist`,
      headers: secondHeaders,
      payload: { note: "越权协处理", evidenceUrl: "manual://cross-assist" }
    });
    expect(crossAssist.statusCode).toBe(403);

    const assist = await app.inject({
      method: "POST",
      url: `/api/merchant/after-sales/${afterSale.json().afterSaleNo}/assist`,
      headers: thirdHeaders,
      payload: { note: "已补充商户处理意见", evidenceUrl: "manual://assist" }
    });
    expect(assist.statusCode).toBe(200);
    expect(assist.json()).toMatchObject({ status: "recorded" });
  });

  it("lists only active shop payment methods and lets the selling merchant confirm collection idempotently", async () => {
    const app = buildApp();
    const methods = await app.inject({ method: "GET", url: "/api/h5/shops/shop-1/payment-methods" });
    expect(methods.statusCode).toBe(200);
    expect(methods.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "collection-shop-1", channelType: "alipay_personal_qr" })
    ]));
    expect(JSON.stringify(methods.json())).not.toMatch(/mock/i);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "merchant-confirm-user" },
      payload: {
        shopId: "shop-1",
        merchantProductListingId: "mpl-1",
        paymentMethodId: "collection-shop-1",
        clientPaidAmountCents: "15000"
      }
    });
    const first = await app.inject({
      method: "POST",
      url: `/api/merchant/orders/${order.json().orderNo}/confirm-payment`,
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" },
      payload: { amountCents: "15000", voucherUrl: "manual://merchant-confirm/1" }
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/merchant/orders/${order.json().orderNo}/confirm-payment`,
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" },
      payload: { amountCents: "15000", voucherUrl: "manual://merchant-confirm/1" }
    });

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "processed" });
    expect(duplicate.json()).toMatchObject({ status: "duplicate" });
  });

  it("snapshots the full platform service fee config on new orders", async () => {
    const app = buildApp();
    const adminHeaders = { "x-admin-id": "admin-1", "x-admin-role": "admin" };
    const createOrder = (userId: string) => app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": userId },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1" }
    });
    const findAdminOrder = async (orderNo: string) => {
      const response = await app.inject({ method: "GET", url: `/api/admin/orders?orderNo=${orderNo}`, headers: adminHeaders });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      return (Array.isArray(body) ? body : body.items)[0];
    };

    const disabledConfig = await app.inject({
      method: "PATCH",
      url: "/api/admin/platform-service-fee",
      headers: adminHeaders,
      payload: { enabled: false, feeBps: 50 }
    });
    expect(disabledConfig.statusCode).toBe(200);
    const disabledOrder = await createOrder("service-fee-disabled-user");
    expect(disabledOrder.statusCode).toBe(200);
    const disabledAdminOrder = await findAdminOrder(disabledOrder.json().orderNo);
    expect(disabledAdminOrder.snapshot.amountSnapshot).toMatchObject({
      serviceFeeEnabled: false,
      serviceFeeCents: "0",
      serviceFeeBasisAmountCents: disabledAdminOrder.snapshot.amountSnapshot.paidAmountCents,
      serviceFeeConfigSnapshot: expect.objectContaining({ enabled: false, feeBps: 50, basisType: "final_sale_price" })
    });

    const enabledConfig = await app.inject({
      method: "PATCH",
      url: "/api/admin/platform-service-fee",
      headers: adminHeaders,
      payload: { enabled: true, feeBps: 100 }
    });
    expect(enabledConfig.statusCode).toBe(200);
    const enabledOrder = await createOrder("service-fee-enabled-user");
    expect(enabledOrder.statusCode).toBe(200);
    const enabledAdminOrder = await findAdminOrder(enabledOrder.json().orderNo);
    expect(enabledAdminOrder.snapshot.amountSnapshot).toMatchObject({
      serviceFeeEnabled: true,
      serviceFeeBps: "100",
      serviceFeeConfigSnapshot: expect.objectContaining({ enabled: true, feeBps: 100, basisType: "final_sale_price" })
    });
    expect(BigInt(enabledAdminOrder.snapshot.amountSnapshot.serviceFeeCents)).toBeGreaterThan(0n);
  });

  it("rejects admin manual creation for non-first-tier merchants and writes audit", async () => {
    const app = buildApp();
    const rejected = await app.inject({
      method: "POST",
      url: "/api/admin/merchants/manual",
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
    expect(JSON.stringify(audit.json())).toContain("merchant.admin_create_rejected_non_first_tier");
  });

  it("protects internal platform product pricing behind merchant auth", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/merchant/products/platform"
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().message).toMatch(/x-merchant-id/);
  });

  it("inherits upstream platform product display edits across agency tiers without changing the platform source", async () => {
    const app = buildApp();
    const firstHeaders = { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" };
    const secondHeaders = { "x-merchant-id": "merchant-2", "x-shop-id": "shop-2" };
    const thirdHeaders = { "x-merchant-id": "merchant-3", "x-shop-id": "shop-3" };

    const firstEdit = await app.inject({
      method: "PATCH",
      url: "/api/merchant/products/mpl-1",
      headers: firstHeaders,
      payload: {
        displayName: "一级代理展示名",
        displayDescription: "一级代理自己写的展示详情",
        displayImageUrl: "https://example.test/first-merchant-product.png"
      }
    });
    expect(firstEdit.statusCode).toBe(200);

    const secondSelectionList = await app.inject({
      method: "GET",
      url: "/api/merchant/products/platform",
      headers: secondHeaders
    });
    expect(secondSelectionList.statusCode).toBe(200);
    expect(secondSelectionList.json().find((item: { id: string }) => item.id === "prod-1")).toMatchObject({
      id: "prod-1",
      name: "一级代理展示名",
      sourceName: "ChatGPT Plus 成品号月卡",
      description: "一级代理自己写的展示详情",
      imageUrl: "https://example.test/first-merchant-product.png"
    });

    const secondEdit = await app.inject({
      method: "POST",
      url: "/api/merchant/products/platform",
      headers: secondHeaders,
      payload: {
        platformProductId: "prod-1",
        salePriceCents: "16000",
        displayName: "二级代理展示名",
        displayDescription: "二级代理自己写的展示详情"
      }
    });
    expect(secondEdit.statusCode).toBe(200);
    expect(secondEdit.json()).toMatchObject({
      platformProductId: "prod-1",
      displayName: "二级代理展示名"
    });

    const thirdSelectionList = await app.inject({
      method: "GET",
      url: "/api/merchant/products/platform",
      headers: thirdHeaders
    });
    expect(thirdSelectionList.statusCode).toBe(200);
    expect(thirdSelectionList.json().find((item: { id: string }) => item.id === "prod-1")).toMatchObject({
      id: "prod-1",
      name: "二级代理展示名",
      sourceName: "ChatGPT Plus 成品号月卡",
      description: "二级代理自己写的展示详情"
    });

    const thirdEdit = await app.inject({
      method: "PATCH",
      url: "/api/merchant/products/ap-3",
      headers: thirdHeaders,
      payload: {
        displayName: "三级店铺最终商品名",
        displayDescription: "三级店铺最终详情",
        displayImageUrl: "https://example.test/third-merchant-product.png"
      }
    });
    expect(thirdEdit.statusCode).toBe(200);

    const publicProducts = await app.inject({ method: "GET", url: "/api/user/shops/shop-3/products" });
    const publicProduct = publicProducts.json().find((item: { id: string }) => item.id === "ap-3");
    expect(publicProduct).toMatchObject({
      id: "ap-3",
      product: expect.objectContaining({
        id: "prod-1",
        name: "三级店铺最终商品名",
        description: "三级店铺最终详情",
        imageUrl: "https://example.test/third-merchant-product.png"
      })
    });

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "display-chain-user" },
      payload: { shopId: "shop-3", merchantProductListingId: "ap-3", clientPaidAmountCents: "15000" }
    });
    expect(order.statusCode).toBe(200);
    expect(order.json()).toMatchObject({
      productName: "三级店铺最终商品名",
      productType: "platform",
      salesChannelType: "three_tier"
    });
  });

  it("uploads product images as local file urls instead of data urls", async () => {
    const app = buildApp();
    const headers = { "x-admin-id": "operator-1", "x-admin-role": "operator" };
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d
    ]);

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/admin/product-images",
      headers,
      payload: {
        filename: "test-product.png",
        contentType: "image/png",
        dataBase64: pngBytes.toString("base64")
      }
    });

    expect(uploaded.statusCode).toBe(200);
    const imageUrl = uploaded.json().imageUrl as string;
    expect(imageUrl).toMatch(/^\/uploads\/product-images\/test-product-/);
    expect(imageUrl).not.toMatch(/^data:image\//);

    const fetched = await app.inject({ method: "GET", url: imageUrl });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(fetched.rawPayload).length).toBe(pngBytes.length);

    await rm(join(process.cwd(), "apps/api", imageUrl.replace(/^\//, "")), { force: true });
  });

  it("allows browser preflight for admin product updates", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/admin/products/prod-design",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type,x-admin-id,x-admin-role"
      }
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(response.headers["access-control-allow-headers"]).toContain("x-admin-role");
  });

  it("does not partially apply failed batch product selection", async () => {
    const app = buildApp();
    const before = await app.inject({
      method: "GET",
      url: "/api/merchant/products",
      headers: { "x-merchant-id": "merchant-2", "x-shop-id": "shop-2" }
    });

    const failed = await app.inject({
      method: "POST",
      url: "/api/merchant/products/platform/batch",
      headers: { "x-merchant-id": "merchant-2", "x-shop-id": "shop-2" },
      payload: {
        items: [
          { platformProductId: "prod-1", salePriceCents: "16000" },
          { platformProductId: "prod-1", salePriceCents: "10000" }
        ]
      }
    });

    const after = await app.inject({
      method: "GET",
      url: "/api/merchant/products",
      headers: { "x-merchant-id": "merchant-2", "x-shop-id": "shop-2" }
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-code", clientPaidAmountCents: "4900", buyerEmail: "buyer@example.com", buyerPhone: "13800000002", extractionCode: "123456" }
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

  it("imports account-password credentials and only reveals them after paid order extraction", async () => {
    const app = buildApp();
    const operatorHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };
    const merchantHeaders = { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" };

    const product = await app.inject({
      method: "POST",
      url: "/api/admin/products",
      headers: operatorHeaders,
      payload: {
        name: "账号密码自动发货测试商品",
        category: "AI 会员",
        tags: ["账号密码"],
        stockCount: 1,
        soldCount: 0,
        supplyPriceCents: "2000",
        minSalePriceCents: "3000",
        suggestedSalePriceCents: "4900",
        fulfillmentMode: "code_pool",
        credentialType: "account_password"
      }
    });
    expect(product.statusCode).toBe(200);
    expect(product.json().fulfillmentRule).toMatchObject({ mode: "code_pool", credentialType: "account_password" });

    const listing = await app.inject({
      method: "POST",
      url: "/api/merchant/products/platform",
      headers: merchantHeaders,
      payload: {
        platformProductId: product.json().id,
        salePriceCents: "4900",
        displayName: "账号密码自动发货测试上架",
        status: "listed"
      }
    });
    expect(listing.statusCode).toBe(200);

    const precheck = await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/precheck",
      headers: operatorHeaders,
      payload: {
        productId: product.json().id,
        credentialType: "account_password",
        codes: ["account-user@example.com,Passw0rd!,Claude 月卡"]
      }
    });
    expect(precheck.statusCode).toBe(200);
    expect(precheck.json().summary).toMatchObject({ create: 1, failed: 0 });
    expect(JSON.stringify(precheck.json())).not.toContain("Passw0rd!");

    const imported = await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: operatorHeaders,
      payload: {
        productId: product.json().id,
        batchNo: "account-password-batch",
        credentialType: "account_password",
        codes: ["account-user@example.com,Passw0rd!,Claude 月卡"]
      }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ count: 1 });
    expect(JSON.stringify(imported.json())).not.toContain("Passw0rd!");

    const inventory = await app.inject({
      method: "GET",
      url: `/api/admin/rights-codes?productId=${product.json().id}`,
      headers: operatorHeaders
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()[0]).toMatchObject({
      productId: product.json().id,
      credentialType: "account_password",
      codePreview: expect.stringContaining("密码已隐藏")
    });
    expect(JSON.stringify(inventory.json())).not.toContain("Passw0rd!");

    const plaintext = await app.inject({
      method: "GET",
      url: `/api/admin/rights-codes/plaintext?productId=${product.json().id}`,
      headers: { "x-admin-id": "admin-1", "x-admin-role": "admin" }
    });
    expect(plaintext.statusCode).toBe(200);
    expect(plaintext.json()[0]).toMatchObject({
      credentialType: "account_password",
      account: "account-user@example.com",
      password: "Passw0rd!",
      note: "Claude 月卡"
    });

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "account-password-user" },
      payload: {
        shopId: "shop-1",
        merchantProductListingId: listing.json().id,
        clientPaidAmountCents: "4900",
        buyerPhone: "13800000014",
        extractionCode: "654321"
      }
    });
    expect(order.statusCode).toBe(200);

    const payment = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: {
        channel: "mock",
        channelTradeNo: "trade-account-password",
        orderNo: order.json().orderNo,
        amountCents: "4900"
      }
    });
    expect(payment.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/user/orders/${order.json().orderNo}`,
      headers: { "x-user-id": "account-password-user" }
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().delivery.codes).toEqual([]);
    expect(JSON.stringify(detail.json())).not.toContain("Passw0rd!");

    const extracted = await app.inject({
      method: "POST",
      url: `/api/user/extractions/${detail.json().delivery.extractionToken}`,
      headers: { "x-user-id": "account-password-user" },
      payload: { extractionCode: "654321" }
    });
    expect(extracted.statusCode).toBe(200);
    expect(extracted.json().codes[0]).toMatchObject({
      credentialType: "account_password",
      credentialLabel: "账号密码",
      account: "account-user@example.com",
      password: "Passw0rd!",
      note: "Claude 月卡"
    });
  });

  it("locks one platform code-pool item at order creation and issues it only after payment confirmation", async () => {
    const app = buildApp();
    const operatorHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };

    const imported = await app.inject({
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: operatorHeaders,
      payload: {
        productId: "prod-code",
        batchNo: "lock-before-pay",
        codes: ["PAYLOCK-CODE-001", "PAYLOCK-CODE-002"]
      }
    });
    expect(imported.statusCode).toBe(200);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "lock-before-pay-user" },
      payload: {
        shopId: "shop-1",
        merchantProductListingId: "mpl-code",
        clientPaidAmountCents: "4900",
        buyerEmail: "lock@example.com",
        buyerPhone: "13800000003",
        purchasePassword: "112233"
      }
    });
    expect(order.statusCode).toBe(200);

    const lockedCodes = await app.inject({
      method: "GET",
      url: `/api/admin/rights-codes?productId=prod-code&orderNo=${order.json().orderNo}&status=locked`,
      headers: operatorHeaders
    });
    expect(lockedCodes.statusCode).toBe(200);
    expect(lockedCodes.json()).toHaveLength(1);
    expect(lockedCodes.json()[0]).toMatchObject({
      orderNo: order.json().orderNo,
      status: "locked"
    });

    const payment = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/mock",
      payload: {
        channel: "mock",
        channelTradeNo: "trade-lock-before-pay",
        orderNo: order.json().orderNo,
        amountCents: "4900"
      }
    });
    expect(payment.statusCode).toBe(200);

    const issuedCodes = await app.inject({
      method: "GET",
      url: `/api/admin/rights-codes?productId=prod-code&orderNo=${order.json().orderNo}&status=issued`,
      headers: operatorHeaders
    });
    expect(issuedCodes.statusCode).toBe(200);
    expect(issuedCodes.json()).toHaveLength(1);

    const detail = await app.inject({
      method: "GET",
      url: `/api/user/orders/${order.json().orderNo}`,
      headers: { "x-user-id": "lock-before-pay-user" }
    });
    expect(detail.json()).toMatchObject({
      status: "fulfilled",
      fulfillmentStatus: "success",
      delivery: expect.objectContaining({ mode: "automatic" })
    });
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-code", clientPaidAmountCents: "4900", buyerPhone: "13800000010", extractionCode: "567890" }
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
    const merchantHeaders = { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" };
    const adminHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };

    const own = await app.inject({
      method: "POST",
      url: "/api/merchant/products/own",
      headers: merchantHeaders,
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
      url: `/api/admin/merchant-products/reviews/${own.json().id}/review`,
      headers: adminHeaders,
      payload: { approved: true, reason: "自动发码商品资料通过" }
    });
    expect(review.statusCode).toBe(200);
    const merchantProductListingId = review.json().merchantProductListing.id;

    const rejectedPlatformImport = await app.inject({
      method: "POST",
      url: "/api/merchant/rights-codes/import",
      headers: merchantHeaders,
      payload: { merchantProductListingId: "mpl-code", batchNo: "bad-scope", codes: ["NOPE-001"] }
    });
    expect(rejectedPlatformImport.statusCode).toBe(400);
    expect(rejectedPlatformImport.json().code).toBe("RIGHTS_CODE_PRODUCT_SCOPE_INVALID");

    const ownPrecheck = await app.inject({
      method: "POST",
      url: "/api/merchant/rights-codes/precheck",
      headers: merchantHeaders,
      payload: { merchantProductListingId, codes: ["OWN-CODE-001", "OWN-CODE-001", "", "bad\u0002"] }
    });
    expect(ownPrecheck.statusCode).toBe(200);
    expect(ownPrecheck.json().summary).toMatchObject({ create: 1, skipped: 1, failed: 2 });
    expect(JSON.stringify(ownPrecheck.json())).not.toContain("OWN-CODE-001");

    const imported = await app.inject({
      method: "POST",
      url: "/api/merchant/rights-codes/import",
      headers: merchantHeaders,
      payload: { merchantProductListingId, batchNo: "own-batch", codes: ["OWN-CODE-001"] }
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ count: 1 });
    expect(JSON.stringify(imported.json())).not.toContain("OWN-CODE-001");

    const inventory = await app.inject({
      method: "GET",
      url: `/api/merchant/rights-codes?merchantProductListingId=${merchantProductListingId}`,
      headers: merchantHeaders
    });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()[0]).toMatchObject({ productId: merchantProductListingId, codePreview: "OW***01" });
    expect(JSON.stringify(inventory.json())).not.toContain("OWN-CODE-001");

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "merchant-own-buyer" },
      payload: { shopId: "shop-1", merchantProductListingId, clientPaidAmountCents: "8800", buyerPhone: "13800000004", extractionCode: "778899" }
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-code", clientPaidAmountCents: "4900", buyerPhone: "13800000005", extractionCode: "246810" }
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "repeat-extract-user" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-code", clientPaidAmountCents: "4900", buyerPhone: "13800000006", extractionCode: "246810" }
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-code", clientPaidAmountCents: "4900" }
    });
    const optionalEmail = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "user-email-optional" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-code", clientPaidAmountCents: "4900", buyerPhone: "13800000007", extractionCode: "234567" }
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1", couponId }
    });
    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "h5-phone-13812345678" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1", couponId, clientPaidAmountCents: "14500" }
    });
    const merchantOrders = await app.inject({
      method: "GET",
      url: "/api/merchant/orders",
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" }
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
      url: `/api/merchant/orders/${order.json().orderNo}/confirm-payment`,
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" },
      payload: { amountCents: order.json().settlementBasisAmountCents, voucherUrl: "manual://coupon/wrong-basis" }
    });
    const collection = await app.inject({
      method: "POST",
      url: `/api/merchant/orders/${order.json().orderNo}/confirm-payment`,
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" },
      payload: { amountCents: order.json().buyerPaidAmountCents, voucherUrl: "manual://coupon/buyer-paid" }
    });
    expect(merchantOrders.json().find((item: { orderNo: string }) => item.orderNo === order.json().orderNo)).toMatchObject({
      paidAmountCents: "14500",
      buyerPaidAmountCents: "14500",
      settlementBasisAmountCents: "15000"
    });
    expect(wrongCollectionAmount.statusCode).toBe(400);
    expect(wrongCollectionAmount.json().code).toBe("AMOUNT_MISMATCH");
    expect(collection.statusCode).toBe(200);
    expect(collection.json()).toMatchObject({ status: "processed" });
  });

  it("allows platform admin to grant one amount coupon to a phone user and skips duplicate available grants", async () => {
    const app = buildApp();
    const createTemplate = await app.inject({
      method: "POST",
      url: "/api/admin/coupons",
      headers: { "x-admin-role": "admin", "x-admin-id": "admin-test" },
      payload: { name: "平台测试金额券", discountCents: "300", validDays: 7, status: "active" }
    });
    const couponTemplateId = createTemplate.json().id;
    const firstGrant = await app.inject({
      method: "POST",
      url: `/api/admin/coupons/${couponTemplateId}/grants`,
      headers: { "x-admin-role": "admin", "x-admin-id": "admin-test" },
      payload: { target: "single_user", phone: "13900008888" }
    });
    const duplicateGrant = await app.inject({
      method: "POST",
      url: `/api/admin/coupons/${couponTemplateId}/grants`,
      headers: { "x-admin-role": "admin", "x-admin-id": "admin-test" },
      payload: { target: "single_user", phone: "13900008888" }
    });
    const userCoupons = await app.inject({
      method: "GET",
      url: "/api/user/coupons?shopId=shop-1&merchantProductListingId=mpl-1",
      headers: { "x-user-id": "h5-phone-13900008888" }
    });
    const grantedCouponId = userCoupons.json().find((coupon: { templateId: string }) => coupon.templateId === couponTemplateId)?.id;
    const quote = await app.inject({
      method: "POST",
      url: "/api/user/orders/quote",
      headers: { "x-user-id": "h5-phone-13900008888" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1", couponId: grantedCouponId }
    });

    expect(createTemplate.statusCode).toBe(200);
    expect(firstGrant.statusCode).toBe(200);
    expect(firstGrant.json()).toMatchObject({ grantedCount: 1, skippedCount: 0 });
    expect(duplicateGrant.statusCode).toBe(200);
    expect(duplicateGrant.json()).toMatchObject({ grantedCount: 0, skippedCount: 1 });
    expect(grantedCouponId).toBeTruthy();
    expect(quote.json()).toMatchObject({
      paidAmountCents: "14700",
      buyerPaidAmountCents: "14700",
      settlementBasisAmountCents: "15000",
      couponDiscountCents: "300"
    });
  });

  it("lets the back office confirm offline collection and trigger automatic delivery without real payment", async () => {
    const app = buildApp();
    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "offline-user" },
      payload: {
        shopId: "shop-1",
        merchantProductListingId: "mpl-code",
        clientPaidAmountCents: "4900",
        buyerEmail: "offline@example.com",
        buyerPhone: "13800000008",
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
        merchantProductListingId: "mpl-1",
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
      url: "/api/merchant/payment-vouchers",
      headers: { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" }
    });
    const crossList = await app.inject({
      method: "GET",
      url: "/api/merchant/payment-vouchers",
      headers: { "x-merchant-id": "merchant-2", "x-shop-id": "shop-2" }
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
    expect(reviewed.json()).toMatchObject({ status: "approved", disputeMaterialOnly: true });
    expect(detail.json()).toMatchObject({ paymentStatus: "unpaid", fulfillmentStatus: "not_started" });
  });

  it("manages scoped payment methods, verifies callbacks and queries, and keeps vouchers out of payment confirmation", async () => {
    const app = buildApp();
    const adminHeaders = { "x-admin-id": "admin-1", "x-admin-role": "admin" };
    const merchantHeaders = { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" };
    const secret = "merchant-secret-001";
    const sign = (provider: string, orderNo: string, amountCents: string, tradeNo: string, merchantNo: string) => {
      const key = `sha256:${createHash("sha256").update(secret).digest("hex")}`;
      return createHmac("sha256", key).update(`${provider}|${orderNo}|${amountCents}|${tradeNo}|${merchantNo}`).digest("hex");
    };

    const alipay = await app.inject({
      method: "POST",
      url: "/api/admin/payment-methods",
      headers: adminHeaders,
      payload: {
        provider: "alipay_merchant",
        displayName: "平台支付宝商户",
        productType: "qr",
        merchantNo: "ali-mch-10001",
        appId: "ali-app-10001",
        signingSecret: secret,
        privateKey: "-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----",
        publicKey: "alipay-public-secret",
        enabled: true,
        isDefault: true,
        returnUrl: "https://h5.example.test/orders"
      }
    });
    expect(alipay.statusCode).toBe(200);
    expect(JSON.stringify(alipay.json())).not.toContain(secret);
    expect(alipay.json()).toMatchObject({
      provider: "alipay_merchant",
      confirmationMode: "automatic",
      keyStatus: expect.objectContaining({ signingSecret: "configured", privateKey: "configured", publicKey: "configured" })
    });

    const wechat = await app.inject({
      method: "POST",
      url: "/api/admin/payment-methods",
      headers: adminHeaders,
      payload: {
        provider: "wechat_merchant",
        displayName: "平台腾讯微信商户",
        productType: "native",
        merchantNo: "wx-mch-10001",
        appId: "wx-app-10001",
        signingSecret: "wx-secret",
        certificate: "wx-cert-secret",
        enabled: true
      }
    });
    expect(wechat.statusCode).toBe(200);
    expect(JSON.stringify(wechat.json())).not.toContain("wx-secret");

    const epay = await app.inject({
      method: "POST",
      url: "/api/admin/payment-methods",
      headers: adminHeaders,
      payload: {
        provider: "epay",
        displayName: "平台 e支付",
        merchantNo: "epay-mch-10001",
        gatewayUrl: "https://epay.example.test/gateway",
        signingSecret: "epay-secret",
        enabled: true
      }
    });
    expect(epay.statusCode).toBe(200);
    expect(JSON.stringify(epay.json())).not.toContain("epay-secret");

    const personal = await app.inject({
      method: "POST",
      url: "/api/merchant/payment-methods",
      headers: merchantHeaders,
      payload: {
        provider: "personal_alipay",
        displayName: "商户个人支付宝",
        accountName: "merchant-alipay@example.test",
        qrUrl: "https://example.test/personal-alipay.png",
        note: "个人支付宝仅人工确认收款",
        enabled: true,
        isDefault: true
      }
    });
    expect(personal.statusCode).toBe(200);
    expect(personal.json()).toMatchObject({ provider: "personal_alipay", confirmationMode: "manual", isDefault: true });

    const merchantEpay = await app.inject({
      method: "POST",
      url: "/api/merchant/payment-methods",
      headers: merchantHeaders,
      payload: {
        provider: "epay",
        displayName: "商户 e支付",
        merchantNo: "merchant-epay-mch-10001",
        gatewayUrl: "https://epay.example.test/gateway",
        signingSecret: "merchant-epay-secret",
        enabled: true,
        isDefault: false
      }
    });
    expect(merchantEpay.statusCode).toBe(200);
    expect(JSON.stringify(merchantEpay.json())).not.toContain("merchant-epay-secret");
    const merchantEpayTest = await app.inject({
      method: "POST",
      url: `/api/merchant/payment-methods/${merchantEpay.json().id}/test`,
      headers: merchantHeaders
    });
    expect(merchantEpayTest.statusCode).toBe(200);
    expect(merchantEpayTest.json()).toMatchObject({ status: "passed", provider: "epay" });

    const publicMethods = await app.inject({ method: "GET", url: "/api/h5/shops/shop-1/payment-methods" });
    expect(publicMethods.statusCode).toBe(200);
    const publicProviders = publicMethods.json().map((method: Record<string, unknown>) => method.provider);
    expect(publicProviders.filter((provider: unknown) => provider === "balance")).toHaveLength(1);
    expect(publicProviders.filter((provider: unknown) => provider === "personal_alipay")).toHaveLength(2);
    expect(publicProviders.filter((provider: unknown) => provider === "epay")).toHaveLength(1);
    expect(publicProviders).not.toContain("alipay_merchant");
    expect(publicMethods.json().map((method: Record<string, unknown>) => method.id)).not.toContain(alipay.json().id);

    const platformLeakOrder = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "platform-leak-user" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1", clientPaidAmountCents: "15000" }
    });
    const platformPaymentAttempt = await app.inject({
      method: "POST",
      url: `/api/user/orders/${platformLeakOrder.json().orderNo}/payments`,
      headers: { "x-user-id": "platform-leak-user" },
      payload: { paymentMethodId: alipay.json().id }
    });
    expect(platformPaymentAttempt.statusCode).toBe(404);
    expect(platformPaymentAttempt.json()).toMatchObject({ code: "PAYMENT_METHOD_UNAVAILABLE" });

    const crossDefault = await app.inject({
      method: "POST",
      url: `/api/merchant/payment-methods/${personal.json().id}/default`,
      headers: { "x-merchant-id": "merchant-2", "x-shop-id": "shop-2" }
    });
    expect(crossDefault.statusCode).toBe(403);

    const order = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "pay-user" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-code", clientPaidAmountCents: "4900", buyerPhone: "13800000009", purchasePassword: "Abcd1234!" }
    });
    expect(order.statusCode).toBe(200);
    const manualPayment = await app.inject({
      method: "POST",
      url: `/api/user/orders/${order.json().orderNo}/payments`,
      headers: { "x-user-id": "pay-user" },
      payload: { paymentMethodId: personal.json().id }
    });
    expect(manualPayment.statusCode).toBe(200);
    expect(manualPayment.json()).toMatchObject({
      status: "pending_manual_confirmation",
      provider: "personal_alipay",
      message: expect.stringContaining("人工确认")
    });

    const manualConfirm = await app.inject({
      method: "POST",
      url: `/api/merchant/orders/${order.json().orderNo}/confirm-payment`,
      headers: merchantHeaders,
      payload: { amountCents: "4900", note: "个人支付宝到账" }
    });
    expect(manualConfirm.statusCode).toBe(200);
    expect(manualConfirm.json().order).toMatchObject({ paymentStatus: "paid", fulfillmentStatus: "success" });

    const merchantAlipay = await app.inject({
      method: "POST",
      url: "/api/merchant/payment-methods",
      headers: merchantHeaders,
      payload: {
        provider: "alipay_merchant",
        displayName: "商户支付宝商家",
        productType: "qr",
        merchantNo: "ali-mch-10001",
        appId: "ali-app-10001",
        signingSecret: secret,
        enabled: true,
        returnUrl: "https://h5.example.test/orders"
      }
    });
    expect(merchantAlipay.statusCode).toBe(200);

    const autoOrder = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "auto-pay-user" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-code", clientPaidAmountCents: "4900", buyerPhone: "13800000011", purchasePassword: "135790" }
    });
    const createdPayment = await app.inject({
      method: "POST",
      url: `/api/user/orders/${autoOrder.json().orderNo}/payments`,
      headers: { "x-user-id": "auto-pay-user" },
      payload: { paymentMethodId: merchantAlipay.json().id }
    });
    expect(createdPayment.statusCode).toBe(200);
    expect(createdPayment.json()).toMatchObject({
      status: "created",
      provider: "alipay_merchant",
      paymentParams: expect.objectContaining({ qrCodeUrl: expect.any(String), returnUrl: "https://h5.example.test/orders" })
    });

    const badSignature = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/alipay_merchant",
      payload: {
        orderNo: autoOrder.json().orderNo,
        providerTradeNo: "ali-trade-1",
        amountCents: "4900",
        merchantNo: "ali-mch-10001",
        appId: "ali-app-10001",
        tradeStatus: "TRADE_SUCCESS",
        signature: "bad"
      }
    });
    expect(badSignature.statusCode).toBe(400);
    expect(badSignature.json().code).toBe("PAYMENT_CALLBACK_SIGNATURE_INVALID");

    const mismatch = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/alipay_merchant",
      payload: {
        orderNo: autoOrder.json().orderNo,
        providerTradeNo: "ali-trade-mismatch",
        amountCents: "4800",
        merchantNo: "ali-mch-10001",
        appId: "ali-app-10001",
        tradeStatus: "TRADE_SUCCESS",
        signature: sign("alipay_merchant", autoOrder.json().orderNo, "4800", "ali-trade-mismatch", "ali-mch-10001")
      }
    });
    expect(mismatch.statusCode).toBe(200);
    expect(mismatch.json()).toMatchObject({ status: "exception", exception: expect.objectContaining({ reasonCode: "AMOUNT_MISMATCH" }) });

    const paidByQuery = await app.inject({
      method: "POST",
      url: `/api/admin/orders/${autoOrder.json().orderNo}/payment-query`,
      headers: { "x-admin-id": "finance-1", "x-admin-role": "finance" },
      payload: {
        providerTradeNo: "ali-trade-success",
        amountCents: "4900",
        merchantNo: "ali-mch-10001",
        appId: "ali-app-10001",
        tradeStatus: "TRADE_SUCCESS",
        signature: sign("alipay_merchant", autoOrder.json().orderNo, "4900", "ali-trade-success", "ali-mch-10001")
      }
    });
    expect(paidByQuery.statusCode).toBe(200);
    expect(paidByQuery.json().status).toBe("processed");
    expect(paidByQuery.json().order).toMatchObject({ paymentStatus: "paid", fulfillmentStatus: "success" });

    const duplicateCallback = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/alipay_merchant",
      payload: {
        orderNo: autoOrder.json().orderNo,
        providerTradeNo: "ali-trade-success",
        amountCents: "4900",
        merchantNo: "ali-mch-10001",
        appId: "ali-app-10001",
        tradeStatus: "TRADE_SUCCESS",
        signature: sign("alipay_merchant", autoOrder.json().orderNo, "4900", "ali-trade-success", "ali-mch-10001")
      }
    });
    expect(duplicateCallback.statusCode).toBe(200);
    expect(duplicateCallback.json().status).toBe("duplicate");

    const epayOrder = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "epay-user" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-code", clientPaidAmountCents: "4900", buyerPhone: "13800000013", purchasePassword: "975310" }
    });
    const epayPayment = await app.inject({
      method: "POST",
      url: `/api/user/orders/${epayOrder.json().orderNo}/payments`,
      headers: { "x-user-id": "epay-user" },
      payload: { paymentMethodId: merchantEpay.json().id }
    });
    expect(epayPayment.statusCode).toBe(200);
    expect(epayPayment.json()).toMatchObject({
      status: "created",
      provider: "epay",
      paymentParams: expect.objectContaining({
        paymentUrl: expect.stringContaining("https://epay.example.test/gateway"),
        submitParams: expect.objectContaining({
          pid: "merchant-epay-mch-10001",
          out_trade_no: epayOrder.json().orderNo,
          money: "49.49",
          sign_type: "MD5"
        })
      })
    });
    const epayPaymentAgain = await app.inject({
      method: "POST",
      url: `/api/user/orders/${epayOrder.json().orderNo}/payments`,
      headers: { "x-user-id": "epay-user" },
      payload: { paymentMethodId: merchantEpay.json().id }
    });
    expect(epayPaymentAgain.statusCode).toBe(200);
    expect(epayPaymentAgain.json().paymentParams.submitParams.money).toBe("49.49");
    expect(JSON.stringify(epayPayment.json())).not.toContain("epay-secret");
    const epayCallbackPayload = {
      pid: "merchant-epay-mch-10001",
      trade_no: "epay-trade-success",
      out_trade_no: epayOrder.json().orderNo,
      type: "alipay",
      name: "权益商品 C",
      money: "49.49",
      trade_status: "TRADE_SUCCESS",
      sign_type: "MD5"
    };
    const epaySignPayload = Object.keys(epayCallbackPayload)
      .filter((key) => key !== "sign_type")
      .sort()
      .map((key) => `${key}=${String(epayCallbackPayload[key as keyof typeof epayCallbackPayload])}`)
      .join("&");
    const epayCallback = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/epay",
      payload: {
        ...epayCallbackPayload,
        sign: createHash("md5").update(`${epaySignPayload}merchant-epay-secret`).digest("hex")
      }
    });
    expect(epayCallback.statusCode).toBe(200);
    expect(epayCallback.body).toBe("success");
    const epayFormCallbackPayload = {
      ...epayCallbackPayload,
      trade_no: "epay-trade-success-form"
    };
    const epayFormSignPayload = Object.keys(epayFormCallbackPayload)
      .filter((key) => key !== "sign_type")
      .sort()
      .map((key) => `${key}=${String(epayFormCallbackPayload[key as keyof typeof epayFormCallbackPayload])}`)
      .join("&");
    const epayFormCallback = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/epay",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        ...epayFormCallbackPayload,
        sign: createHash("md5").update(`${epayFormSignPayload}merchant-epay-secret`).digest("hex")
      }).toString()
    });
    expect(epayFormCallback.statusCode).toBe(200);
    expect(epayFormCallback.body).toBe("success");
    const epayPaidOrder = await app.inject({
      method: "GET",
      url: `/api/user/orders/${epayOrder.json().orderNo}`,
      headers: { "x-user-id": "epay-user" }
    });
    expect(epayPaidOrder.json()).toMatchObject({ paymentStatus: "paid", fulfillmentStatus: "success" });

    const hupijiaoMethod = await app.inject({
      method: "POST",
      url: "/api/merchant/payment-methods",
      headers: merchantHeaders,
      payload: {
        provider: "epay",
        displayName: "商户虎皮椒 e支付",
        merchantNo: "merchant-hupi-10001",
        gatewayUrl: "https://epay.example.test/gateway",
        apiMode: "hupijiao_direct",
        signingSecret: "merchant-hupi-secret",
        enabled: true,
        isDefault: false
      }
    });
    expect(hupijiaoMethod.statusCode).toBe(200);
    const hupijiaoOrder = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "hupijiao-user" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1", clientPaidAmountCents: "15000" }
    });
    expect(hupijiaoOrder.statusCode).toBe(200);
    const hupijiaoPayment = await app.inject({
      method: "POST",
      url: `/api/user/orders/${hupijiaoOrder.json().orderNo}/payments`,
      headers: { "x-user-id": "hupijiao-user" },
      payload: { paymentMethodId: hupijiaoMethod.json().id }
    });
    expect(hupijiaoPayment.statusCode).toBe(200);
    expect(hupijiaoPayment.json()).toMatchObject({
      status: "created",
      provider: "epay",
      paymentParams: expect.objectContaining({
        method: "HUPIJIAO",
        apiMode: "hupijiao_direct",
        paymentUrl: expect.stringContaining(hupijiaoOrder.json().orderNo)
      })
    });
    expect(hupijiaoPayment.json().paymentParams.submitParams).toBeUndefined();
    const hupijiaoCallbackPayload = {
      appid: "merchant-hupi-10001",
      trade_order_id: hupijiaoOrder.json().orderNo,
      transaction_id: "hupijiao-trade-success",
      total_fee: "151.50",
      status: "OD",
      nonce_str: "hupijiao-callback-nonce",
      time: "1780359000"
    };
    const hupijiaoSignPayload = Object.keys(hupijiaoCallbackPayload)
      .sort()
      .map((key) => `${key}=${String(hupijiaoCallbackPayload[key as keyof typeof hupijiaoCallbackPayload])}`)
      .join("&");
    const hupijiaoCallback = await app.inject({
      method: "POST",
      url: "/api/callbacks/payments/epay",
      payload: {
        ...hupijiaoCallbackPayload,
        hash: createHash("md5").update(`${hupijiaoSignPayload}merchant-hupi-secret`).digest("hex")
      }
    });
    expect(hupijiaoCallback.statusCode).toBe(200);
    expect(hupijiaoCallback.body).toBe("success");
    const hupijiaoPaidOrder = await app.inject({
      method: "GET",
      url: `/api/user/orders/${hupijiaoOrder.json().orderNo}`,
      headers: { "x-user-id": "hupijiao-user" }
    });
    expect(hupijiaoPaidOrder.json()).toMatchObject({ paymentStatus: "paid" });

    const callbacks = await app.inject({ method: "GET", url: "/api/admin/payment-callbacks", headers: adminHeaders });
    const exceptions = await app.inject({ method: "GET", url: "/api/admin/payment-exceptions", headers: adminHeaders });
    expect(callbacks.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "alipay_merchant", status: "rejected" })
    ]));
    expect(exceptions.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: "SIGNATURE_INVALID" }),
      expect.objectContaining({ reasonCode: "AMOUNT_MISMATCH" })
    ]));
  });

  it("blocks configuration and public payment display for frozen shops or restricted merchants", async () => {
    const app = buildApp();
    const operatorHeaders = { "x-admin-id": "operator-1", "x-admin-role": "operator" };
    const merchantHeaders = { "x-merchant-id": "merchant-1", "x-shop-id": "shop-1" };

    const shopFreeze = await app.inject({
      method: "POST",
      url: "/api/admin/risk-freezes",
      headers: operatorHeaders,
      payload: {
        targetType: "shop",
        targetId: "shop-1",
        freezeType: "shop_frozen",
        reasonCode: "manual_risk"
      }
    });
    expect(shopFreeze.statusCode).toBe(200);

    const publicMethods = await app.inject({ method: "GET", url: "/api/h5/shops/shop-1/payment-methods" });
    expect(publicMethods.statusCode).toBe(200);
    expect(publicMethods.json()).toEqual([]);

    const shopUpdate = await app.inject({
      method: "PATCH",
      url: "/api/merchant/shop",
      headers: merchantHeaders,
      payload: { announcement: "冻结期间不允许修改" }
    });
    expect(shopUpdate.statusCode).toBe(403);
    expect(shopUpdate.json().code).toBe("SHOP_RESTRICTED");

    const paymentCreate = await app.inject({
      method: "POST",
      url: "/api/merchant/payment-methods",
      headers: merchantHeaders,
      payload: {
        provider: "personal_alipay",
        displayName: "冻结后新增个人支付宝",
        accountName: "merchant-alipay@example.test",
        qrUrl: "https://example.test/frozen-pay.png",
        enabled: true
      }
    });
    expect(paymentCreate.statusCode).toBe(403);
    expect(paymentCreate.json().code).toBe("SHOP_RESTRICTED");

    const restrictedApp = buildApp();
    const merchantFreeze = await restrictedApp.inject({
      method: "POST",
      url: "/api/admin/risk-freezes",
      headers: operatorHeaders,
      payload: {
        targetType: "merchant",
        targetId: "merchant-1",
        freezeType: "settlement_restricted",
        reasonCode: "manual_risk"
      }
    });
    expect(merchantFreeze.statusCode).toBe(200);
    const offer = await restrictedApp.inject({
      method: "POST",
      url: "/api/merchant/supply/offers",
      headers: merchantHeaders,
      payload: {
        downstreamMerchantId: "merchant-2",
        platformProductId: "prod-1",
        resellSupplyPriceCents: "11200"
      }
    });
    expect(offer.statusCode).toBe(403);
    expect(offer.json().code).toBe("MERCHANT_RESTRICTED");
  });

  it("audits reconciliation exports and supports admin order pagination filters", async () => {
    const app = buildApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "export-user-1" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1", clientPaidAmountCents: "15000" }
    });
    await app.inject({
      method: "POST",
      url: "/api/user/orders",
      headers: { "x-user-id": "export-user-2" },
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-1", clientPaidAmountCents: "15000" }
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
      url: "/api/admin/merchants/manual",
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
      url: "/api/auth/merchant/login",
      payload: { account, password: "merchant-pass-1" }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().merchant).toMatchObject({
      merchantId: create.json().merchant.id,
      depositStatus: "pending_payment"
    });

    const session = await app.inject({
      method: "GET",
      url: "/api/auth/merchant/session",
      headers: { authorization: `Bearer ${login.json().token}` }
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().shop).toMatchObject({ shopId: create.json().shop.id });

    const shop = await app.inject({
      method: "GET",
      url: "/api/merchant/shop",
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
      payload: { shopId: "shop-1", merchantProductListingId: "mpl-code", quantity: 2, clientPaidAmountCents: "9800", buyerEmail: "qty@example.com", buyerPhone: "13800000012", extractionCode: "456789" }
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

    const issuedForOrder = codes.json().filter((code: { orderNo?: string; status?: string }) => code.orderNo === order.json().orderNo && code.status === "issued");
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
      url: "/api/merchant/register-by-invite",
      payload: { inviteCode: "P0-FIRST-E2E", name: "一级正式 API 商户", shopName: "一级正式 API 店" }
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().merchant).toMatchObject({ tier: "first_tier", status: "pending_review" });
    const firstMerchantId = first.json().merchant.id;
    const firstCredential = first.json().credential;

    const firstBeforeReviewLogin = await app.inject({
      method: "POST",
      url: "/api/auth/merchant/login",
      payload: { account: firstCredential.account, password: firstCredential.initialPassword }
    });
    expect(firstBeforeReviewLogin.statusCode).toBe(403);

    await app.inject({ method: "POST", url: `/api/admin/merchants/${firstMerchantId}/review`, headers: adminHeaders, payload: { approved: true } });
    await app.inject({ method: "POST", url: `/api/admin/deposits/${firstMerchantId}/confirm`, headers: financeHeaders, payload: { amountCents: "50000", voucherUrl: "manual://deposit/first-e2e" } });
    const firstLogin = await app.inject({
      method: "POST",
      url: "/api/auth/merchant/login",
      payload: { account: firstCredential.account, password: firstCredential.initialPassword }
    });
    expect(firstLogin.statusCode).toBe(200);
    const firstMerchantHeaders = { authorization: `Bearer ${firstLogin.json().token}` };

    const secondInvite = await app.inject({
      method: "POST",
      url: "/api/merchant/invite-codes",
      headers: firstMerchantHeaders,
      payload: { code: "P0-SECOND-E2E" }
    });
    expect(secondInvite.statusCode).toBe(200);
    expect(secondInvite.json()).toMatchObject({
      code: "P0-SECOND-E2E",
      targetTier: "second_tier",
      status: "active",
      usedCount: 0,
      depositRequiredAmountCents: "50000",
      issuer: { type: "merchant" },
      currentMerchantScope: { ownsInvite: true }
    });
    expect(secondInvite.json()).not.toHaveProperty("codeHash");

    const firstInviteList = await app.inject({ method: "GET", url: "/api/merchant/invite-codes", headers: firstMerchantHeaders });
    expect(firstInviteList.statusCode).toBe(200);
    expect(firstInviteList.json().map((item: Record<string, unknown>) => item.code)).toContain("P0-SECOND-E2E");
    expect(JSON.stringify(firstInviteList.json())).not.toContain("P0-THIRD-E2E");
    expect(JSON.stringify(firstInviteList.json())).not.toContain("codeHash");

    const second = await app.inject({
      method: "POST",
      url: "/api/merchant/register-by-invite",
      payload: { inviteCode: "P0-SECOND-E2E", name: "二级正式 API 商户", shopName: "二级正式 API 店" }
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().merchant).toMatchObject({ tier: "second_tier", parentMerchantId: firstMerchantId, status: "pending_review" });
    const secondMerchantId = second.json().merchant.id;
    const secondCredential = second.json().credential;

    await app.inject({ method: "POST", url: `/api/admin/merchants/${secondMerchantId}/review`, headers: adminHeaders, payload: { approved: true } });
    await app.inject({ method: "POST", url: `/api/admin/deposits/${secondMerchantId}/confirm`, headers: financeHeaders, payload: { amountCents: "50000", voucherUrl: "manual://deposit/second-e2e" } });
    const secondLogin = await app.inject({
      method: "POST",
      url: "/api/auth/merchant/login",
      payload: { account: secondCredential.account, password: secondCredential.initialPassword }
    });
    expect(secondLogin.statusCode).toBe(200);
    const secondMerchantHeaders = { authorization: `Bearer ${secondLogin.json().token}` };

    const thirdInvite = await app.inject({
      method: "POST",
      url: "/api/merchant/invite-codes",
      headers: secondMerchantHeaders,
      payload: { code: "P0-THIRD-E2E" }
    });
    expect(thirdInvite.statusCode).toBe(200);
    expect(thirdInvite.json()).toMatchObject({
      code: "P0-THIRD-E2E",
      targetTier: "third_tier",
      status: "active",
      usedCount: 0,
      depositRequiredAmountCents: "50000",
      issuer: { type: "merchant" },
      currentMerchantScope: { ownsInvite: true }
    });
    expect(thirdInvite.json()).not.toHaveProperty("codeHash");

    const secondInviteList = await app.inject({ method: "GET", url: "/api/merchant/invite-codes", headers: secondMerchantHeaders });
    expect(secondInviteList.statusCode).toBe(200);
    expect(secondInviteList.json().map((item: Record<string, unknown>) => item.code)).toContain("P0-THIRD-E2E");
    expect(JSON.stringify(secondInviteList.json())).not.toContain("P0-SECOND-E2E");
    expect(JSON.stringify(secondInviteList.json())).not.toContain("codeHash");

    const third = await app.inject({
      method: "POST",
      url: "/api/merchant/register-by-invite",
      payload: { inviteCode: "P0-THIRD-E2E", name: "三级正式 API 商户", shopName: "三级正式 API 店" }
    });
    expect(third.statusCode).toBe(200);
    expect(third.json().merchant).toMatchObject({ tier: "third_tier", parentMerchantId: secondMerchantId, status: "pending_review" });
    const thirdMerchantId = third.json().merchant.id;
    const thirdCredential = third.json().credential;

    await app.inject({ method: "POST", url: `/api/admin/merchants/${thirdMerchantId}/review`, headers: adminHeaders, payload: { approved: true } });
    await app.inject({ method: "POST", url: `/api/admin/deposits/${thirdMerchantId}/confirm`, headers: financeHeaders, payload: { amountCents: "50000", voucherUrl: "manual://deposit/third-e2e" } });
    const thirdLogin = await app.inject({
      method: "POST",
      url: "/api/auth/merchant/login",
      payload: { account: thirdCredential.account, password: thirdCredential.initialPassword }
    });
    expect(thirdLogin.statusCode).toBe(200);

    const fourth = await app.inject({
      method: "POST",
      url: "/api/merchant/invite-codes",
      headers: { authorization: `Bearer ${thirdLogin.json().token}` },
      payload: { code: "P0-FOURTH-E2E" }
    });
    const invites = await app.inject({ method: "GET", url: "/api/admin/invite-codes", headers: adminHeaders });
    const thirdInviteList = await app.inject({ method: "GET", url: "/api/merchant/invite-codes", headers: { authorization: `Bearer ${thirdLogin.json().token}` } });

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

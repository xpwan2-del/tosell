import { describe, expect, it } from "vitest";
import {
  IdempotencyRegistry,
  MockPaymentProvider,
  allocateRefund,
  applyClawback,
  applyFulfillmentAttempt,
  assertMerchantScope,
  assertNoDuplicateSettlementItems,
  buildOrderSnapshot,
  buildSettlementItems,
  canConfirmManualPayout,
  canReviewProduct,
  deductDeposit,
  isSettlementCandidate,
  paymentCallbackKey,
  processPaymentCallback,
  quotePlatformProduct
} from "./index.js";

describe("pricing", () => {
  it("calculates supply, service fee, and merchant income using cents", () => {
    const quote = quotePlatformProduct({
      salePriceCents: 15_000n,
      supplyPriceCents: 10_000n,
      minSalePriceCents: 12_000n
    });

    expect(quote.paidAmountCents).toBe(15_000n);
    expect(quote.supplyAmountCents).toBe(10_000n);
    expect(quote.serviceFeeCents).toBe(75n);
    expect(quote.merchantExpectedIncomeCents).toBe(4_925n);
  });

  it("rejects sale price below minimum sale price", () => {
    expect(() =>
      quotePlatformProduct({
        salePriceCents: 11_999n,
        supplyPriceCents: 10_000n,
        minSalePriceCents: 12_000n
      })
    ).toThrow(/below minimum/);
  });

  it("applies quantity before calculating service fee and merchant income", () => {
    const quote = quotePlatformProduct({
      salePriceCents: 15_000n,
      supplyPriceCents: 10_000n,
      minSalePriceCents: 12_000n,
      quantity: 2
    });

    expect(quote.paidAmountCents).toBe(30_000n);
    expect(quote.supplyAmountCents).toBe(20_000n);
    expect(quote.serviceFeeCents).toBe(150n);
    expect(quote.merchantExpectedIncomeCents).toBe(9_850n);
  });

  it("rejects prices that would make merchant income negative", () => {
    expect(() =>
      quotePlatformProduct({
        salePriceCents: 10_000n,
        supplyPriceCents: 10_000n,
        minSalePriceCents: 10_000n
      })
    ).toThrow(/merchant income/);
  });
});

describe("refund allocation", () => {
  it("allocates platform responsibility to platform", () => {
    const refund = allocateRefund({
      paidAmountCents: 15_000n,
      supplyAmountCents: 10_000n,
      merchantIncomeCents: 4_925n,
      refundAmountCents: 15_000n,
      responsibility: "platform"
    });

    expect(refund.platformBearCents).toBe(15_000n);
    expect(refund.merchantBearCents).toBe(0n);
    expect(refund.serviceFeeRefundCents).toBe(75n);
  });

  it("requires explicit split for mixed responsibility", () => {
    expect(() =>
      allocateRefund({
        paidAmountCents: 15_000n,
        supplyAmountCents: 10_000n,
        merchantIncomeCents: 4_925n,
        refundAmountCents: 6_000n,
        responsibility: "mixed"
      })
    ).toThrow(/explicit/);
  });

  it("allocates merchant responsibility to merchant without refunding platform service fee", () => {
    const refund = allocateRefund({
      paidAmountCents: 15_000n,
      supplyAmountCents: 10_000n,
      merchantIncomeCents: 4_925n,
      refundAmountCents: 5_000n,
      responsibility: "merchant"
    });

    expect(refund.platformBearCents).toBe(0n);
    expect(refund.merchantBearCents).toBe(5_000n);
    expect(refund.serviceFeeRefundCents).toBe(25n);
    expect(refund.serviceFeeBearer).toBe("merchant");
    expect(refund.merchantServiceFeeBearCents).toBe(25n);
    expect(refund.merchantTotalCostCents).toBe(5_025n);
  });

  it("accepts explicit mixed responsibility split", () => {
    const refund = allocateRefund({
      paidAmountCents: 15_000n,
      supplyAmountCents: 10_000n,
      merchantIncomeCents: 4_925n,
      refundAmountCents: 6_000n,
      responsibility: "mixed",
      platformBearCents: 4_000n,
      merchantBearCents: 2_000n
    });

    expect(refund.platformBearCents).toBe(4_000n);
    expect(refund.merchantBearCents).toBe(2_000n);
    expect(refund.serviceFeeRefundCents).toBe(30n);
    expect(refund.platformServiceFeeBearCents).toBe(20n);
    expect(refund.merchantServiceFeeBearCents).toBe(10n);
  });
});

describe("settlement", () => {
  it("selects only fulfilled normal T+1 orders", () => {
    expect(
      isSettlementCandidate({
        orderId: "order-1",
        paymentStatus: "paid",
        fulfillmentStatus: "success",
        settlementStatus: "pending",
        refundStatus: "none",
        riskStatus: "normal",
        fulfilledAt: new Date("2026-05-24T00:00:00.000Z"),
        now: new Date("2026-05-25T01:00:00.000Z")
      })
    ).toBe(true);
  });

  it("rejects duplicate settlement order ids", () => {
    expect(() => assertNoDuplicateSettlementItems(["a", "b", "a"])).toThrow(/duplicate/);
  });

  it("does not settle orders before T+1 or during refund and risk freeze", () => {
    const base = {
      orderId: "order-1",
      paymentStatus: "paid",
      fulfillmentStatus: "success",
      settlementStatus: "pending",
      refundStatus: "none",
      riskStatus: "normal",
      fulfilledAt: new Date("2026-05-24T00:00:00.000Z")
    };

    expect(isSettlementCandidate({ ...base, now: new Date("2026-05-24T23:59:59.000Z") })).toBe(false);
    expect(isSettlementCandidate({ ...base, settlementStatus: "settling", now: new Date("2026-05-25T01:00:00.000Z") })).toBe(false);
    expect(isSettlementCandidate({ ...base, refundStatus: "refunding", now: new Date("2026-05-25T01:00:00.000Z") })).toBe(false);
    expect(isSettlementCandidate({ ...base, riskStatus: "order_frozen", now: new Date("2026-05-25T01:00:00.000Z") })).toBe(false);
  });

  it("requires settlement items to belong to the settlement merchant batch", () => {
    expect(() =>
      buildSettlementItems([
        {
          orderId: "order-1",
          merchantId: "merchant-2",
          shopId: "shop-2",
          paymentStatus: "paid",
          fulfillmentStatus: "success",
          settlementStatus: "pending",
          refundStatus: "none",
          riskStatus: "normal",
          fulfilledAt: new Date("2026-05-24T00:00:00.000Z"),
          now: new Date("2026-05-25T01:00:00.000Z"),
          paidAmountCents: 15_000n,
          supplyAmountCents: 10_000n,
          serviceFeeCents: 75n,
          merchantIncomeCents: 4_925n
        }
      ], [], "merchant-1")
    ).toThrow(/does not belong/);
  });
});

describe("permissions and idempotency", () => {
  it("rejects cross-merchant access", () => {
    expect(() =>
      assertMerchantScope({ role: "merchant", merchantId: "a1", shopId: "s1" }, { merchantId: "a2" })
    ).toThrow(/another merchant/);
  });

  it("runs duplicate payment callback once", () => {
    const registry = new IdempotencyRegistry();
    const key = paymentCallbackKey("wechat", "trade-1");
    expect(registry.runOnce(key, () => "ok")).toBe("ok");
    expect(registry.runOnce(key, () => "again")).toBeUndefined();
  });

  it("allows a merchant to access only their own shop resource", () => {
    expect(() =>
      assertMerchantScope(
        { role: "merchant", merchantId: "a1", shopId: "s1" },
        { merchantId: "a1", shopId: "s1" }
      )
    ).not.toThrow();

    expect(() =>
      assertMerchantScope(
        { role: "merchant", merchantId: "a1", shopId: "s1" },
        { merchantId: "a1", shopId: "s2" }
      )
    ).toThrow(/another shop/);
  });

  it("separates finance payout and operator product review permissions", () => {
    expect(canConfirmManualPayout({ role: "finance", adminId: "f1" })).toBe(true);
    expect(canConfirmManualPayout({ role: "operator", adminId: "o1" })).toBe(false);
    expect(canReviewProduct({ role: "operator", adminId: "o1" })).toBe(true);
    expect(canReviewProduct({ role: "finance", adminId: "f1" })).toBe(false);
  });
});

describe("order, payment, fulfillment, deposit, and clawback helpers", () => {
  const orderInput = {
    orderNo: "order-1",
    userId: "u1",
    merchant: {
      id: "a1",
      name: "代理一",
      status: "active",
      riskStatus: "normal",
      depositStatus: "paid"
    },
    shop: {
      id: "s1",
      name: "代理小店",
      status: "open",
      riskStatus: "normal",
      customerServiceWechat: "service-a1"
    },
    merchantProductListing: {
      id: "ap1",
      merchantId: "a1",
      shopId: "s1",
      productType: "platform" as const,
      platformProductId: "p1",
      ownProductReviewId: null,
      salePriceCents: 15_000n,
      status: "listed"
    },
    platformProduct: {
      id: "p1",
      name: "会员月卡",
      supplyPriceCents: 10_000n,
      minSalePriceCents: 12_000n,
      suggestedSalePriceCents: 15_000n,
      fulfillmentRule: { mode: "manual" },
      afterSaleRule: { days: 7 },
      status: "active"
    }
  };

  it("builds an immutable order snapshot only for matching merchant, shop, and product", () => {
    const snapshot = buildOrderSnapshot(orderInput);

    expect(snapshot.merchantId).toBe("a1");
    expect(snapshot.shopId).toBe("s1");
    expect(snapshot.productSnapshot).toEqual({ id: "p1", type: "platform", name: "会员月卡" });
    expect(snapshot.amountSnapshot.merchantExpectedIncomeCents).toBe(4_925n);

    expect(() =>
      buildOrderSnapshot({
        ...orderInput,
        merchantProductListing: { ...orderInput.merchantProductListing, shopId: "other-shop" }
      })
    ).toThrow(/shop/);
  });

  it("verifies payment callback order, amount, signature, and idempotency", () => {
    const registry = new IdempotencyRegistry();
    let processed = 0;
    const result = processPaymentCallback({
      provider: new MockPaymentProvider(),
      registry,
      payload: {
        channel: "mock",
        channelTradeNo: "trade-1",
        orderNo: "order-1",
        amountCents: 15_000n
      },
      order: {
        orderNo: "order-1",
        paidAmountCents: 15_000n,
        paymentStatus: "paying"
      },
      onProcessed: () => {
        processed += 1;
      }
    });

    expect(result.status).toBe("processed");
    expect(processed).toBe(1);
  });

  it("deduplicates fulfillment attempts", () => {
    const registry = new IdempotencyRegistry();
    const record = { fulfillmentId: "f1", orderItemId: "oi1", status: "not_started" as const, attemptCount: 0 };

    expect(applyFulfillmentAttempt({
      registry,
      record,
      attemptNo: 1,
      result: { status: "success", evidence: "code-issued" }
    }).duplicate).toBe(false);
    expect(applyFulfillmentAttempt({
      registry,
      record,
      attemptNo: 1,
      result: { status: "failed", failReason: "duplicate" }
    }).duplicate).toBe(true);
    expect(record.attemptCount).toBe(1);
  });

  it("deducts deposit idempotently and marks restriction when insufficient", () => {
    const registry = new IdempotencyRegistry();
    const account = {
      merchantId: "a1",
      requiredAmountCents: 10_000n,
      availableAmountCents: 3_000n,
      frozenAmountCents: 0n,
      deductedAmountCents: 0n,
      status: "paid" as const
    };

    const first = deductDeposit({
      registry,
      account,
      amountCents: 5_000n,
      sourceType: "refund",
      sourceId: "r1",
      reasonCode: "AFTER_SALE"
    });
    const second = deductDeposit({
      registry,
      account,
      amountCents: 5_000n,
      sourceType: "refund",
      sourceId: "r1",
      reasonCode: "AFTER_SALE"
    });

    expect(first.status).toBe("processed");
    expect(first).toMatchObject({ deductedAmountCents: 3_000n, restricted: true });
    expect(second.status).toBe("duplicate");
  });

  it("applies clawback in pending income, payable income, then deposit order", () => {
    const result = applyClawback(10_000n, {
      pendingIncomeCents: 2_000n,
      payableIncomeCents: 3_000n,
      depositAvailableCents: 4_000n
    });

    expect(result.deductedAmountCents).toBe(9_000n);
    expect(result.remainingAmountCents).toBe(1_000n);
    expect(result.status).toBe("insufficient");
    expect(result.restrictMerchant).toBe(true);
  });
});

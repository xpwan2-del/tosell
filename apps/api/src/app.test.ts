import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

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
      supplyAmountCents: "10000",
      serviceFeeCents: "75",
      agentExpectedIncomeCents: "4925"
    });
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
    expect(created.json().snapshot.amountSnapshot.agentExpectedIncomeCents).toBe("4925");

    const agentTwoOrders = await app.inject({
      method: "GET",
      url: "/api/agent/orders",
      headers: { "x-agent-id": "agent-2", "x-shop-id": "shop-2" }
    });
    expect(agentTwoOrders.json()).toEqual([]);
  });

  it("runs payment, fulfillment, and settlement generation without duplicate settlement items", async () => {
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
});

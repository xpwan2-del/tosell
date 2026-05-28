import { createHmac } from "node:crypto";
import { buildApp } from "./app.js";

type SmokeApp = ReturnType<typeof buildApp>;
type InjectResponse = {
  statusCode: number;
  body: string;
  json: () => any;
};
type InjectOptions = {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
};

const suffix = Date.now().toString(36);
const numericSuffix = Date.now().toString().slice(-8);
const STEP_TIMEOUT_MS = Number(process.env.SMOKE_STEP_TIMEOUT_MS ?? 20_000);
const OVERALL_TIMEOUT_MS = Number(process.env.SMOKE_OVERALL_TIMEOUT_MS ?? 5 * 60_000);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sign(payload: Record<string, unknown>) {
  const secret = requireEnv("AUTH_TOKEN_SECRET");
  const body = Buffer.from(JSON.stringify({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + 60 * 60
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function logSmoke(event: string, label: string, detail?: Record<string, unknown>) {
  console.log(JSON.stringify({
    smoke: event,
    label,
    at: new Date().toISOString(),
    ...detail
  }));
}

async function withTimeout<T>(label: string, detail: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms: ${detail}`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function expectJson(response: InjectResponse, expectedStatus: number, label: string) {
  if (response.statusCode !== expectedStatus) {
    throw new Error(`${label} expected ${expectedStatus}, got ${response.statusCode}: ${response.body.slice(0, 400)}`);
  }
  return response.json();
}

async function injectJson(app: SmokeApp, label: string, options: InjectOptions, expectedStatus = 200) {
  const method = String(options.method ?? "GET");
  const path = options.url;
  logSmoke("start", label, { method, path, timeoutMs: STEP_TIMEOUT_MS });
  const startedAt = Date.now();
  try {
    const response = await withTimeout(
      label,
      `${method} ${path}`,
      STEP_TIMEOUT_MS,
      () => app.inject(options as never) as Promise<InjectResponse>
    );
    const body = await expectJson(response, expectedStatus, label);
    logSmoke("pass", label, { method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
    return body;
  } catch (error) {
    logSmoke("fail", label, {
      method,
      path,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function injectErrorCode(app: SmokeApp, label: string, options: InjectOptions, expectedStatus: number, expectedCode: string) {
  const body = await injectJson(app, label, options, expectedStatus);
  if (body?.code !== expectedCode) {
    throw new Error(`${label} expected error code ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body;
}

async function closeApp(app: SmokeApp, label: string) {
  logSmoke("start", label, { timeoutMs: STEP_TIMEOUT_MS });
  const startedAt = Date.now();
  try {
    await withTimeout(label, "app.close()", STEP_TIMEOUT_MS, () => app.close());
    logSmoke("pass", label, { durationMs: Date.now() - startedAt });
  } catch (error) {
    logSmoke("fail", label, {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function runSmoke() {
  if (process.env.APP_ENV !== "production") throw new Error("APP_ENV=production is required");
  requireEnv("DATABASE_URL");
  requireEnv("AUTH_TOKEN_SECRET");
  const adminUsername = requireEnv("ADMIN_USERNAME");
  const adminPassword = process.env.SMOKE_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
  if (!adminPassword) throw new Error("SMOKE_ADMIN_PASSWORD or ADMIN_PASSWORD is required");

  logSmoke("start", "production smoke entry", {
    suffix,
    stepTimeoutMs: STEP_TIMEOUT_MS,
    overallTimeoutMs: OVERALL_TIMEOUT_MS
  });
  const app = buildApp();
  let appClosed = false;
  let readbackApp: SmokeApp | undefined;
  let readbackClosed = false;
  try {
  const adminSession = await injectJson(app, "admin login", {
    method: "POST",
    url: "/api/auth/admin/login",
    payload: {
      username: adminUsername,
      password: adminPassword
    }
  });
  const adminHeaders = { authorization: `Bearer ${adminSession.token}` };

  const health = await injectJson(app, "health prisma persistence", { method: "GET", url: "/api/health" });
  if (health.persistenceMode !== "prisma" || !health.databaseConfigured) {
    throw new Error(`health did not report Prisma persistence: ${JSON.stringify(health)}`);
  }
  await injectJson(app, "admin session bearer", {
    method: "GET",
    url: "/api/auth/admin/session",
    headers: adminHeaders
  });
  await injectJson(app, "demo header rejected", {
    method: "GET",
    url: "/api/auth/admin/session",
    headers: { "x-admin-id": "demo", "x-admin-role": "admin" }
  }, 401);
  await injectJson(app, "mini-program disabled", {
    method: "POST",
    url: "/api/auth/wechat-miniprogram/login",
    payload: { code: `wx-${suffix}` }
  }, 410);

  await injectJson(app, "coupon create", {
    method: "POST",
    url: "/api/admin/coupons",
    headers: adminHeaders,
    payload: {
      name: `首登券-${suffix}`,
      discountCents: "100",
      validDays: 7,
      grantOnFirstRegister: true,
      status: "active"
    }
  });

  const manualAgent = await injectJson(app, "manual first-tier merchant", {
    method: "POST",
    url: "/api/admin/agents/manual",
    headers: adminHeaders,
    payload: {
      name: `P0一级商户-${suffix}`,
      shopName: `P0小店-${suffix}`,
      customerServiceWechat: `service_${suffix}`,
      depositPaid: true,
      depositAmountCents: "50000"
    }
  });
  await injectJson(app, "deposit confirm", {
    method: "POST",
    url: `/api/admin/deposits/${manualAgent.agent.id}/confirm`,
    headers: adminHeaders,
    payload: { amountCents: "50000", voucherUrl: `fixture://deposit/${suffix}` }
  });

  const platformProduct = await injectJson(app, "platform product create", {
    method: "POST",
    url: "/api/admin/products",
    headers: adminHeaders,
    payload: {
      name: `P0卡密商品-${suffix}`,
      supplyPriceCents: "1000",
      minSalePriceCents: "1200",
      suggestedSalePriceCents: "1500",
      fulfillmentMode: "code_pool"
    }
  });

  const pendingDepositAgent = await injectJson(app, "deposit gate pending merchant create", {
    method: "POST",
    url: "/api/admin/agents/manual",
    headers: adminHeaders,
    payload: {
      name: `P0待保证金商户-${suffix}`,
      shopName: `P0待保证金小店-${suffix}`,
      customerServiceWechat: `pending_service_${suffix}`,
      depositPaid: false,
      depositAmountCents: "0"
    }
  });
  const pendingAgentHeaders = {
    authorization: `Bearer ${sign({ role: "agent", agentId: pendingDepositAgent.agent.id, shopId: pendingDepositAgent.shop.id })}`
  };
  await injectErrorCode(app, "deposit gate blocks product listing", {
    method: "POST",
    url: "/api/agent/products/platform",
    headers: pendingAgentHeaders,
    payload: {
      platformProductId: platformProduct.id,
      salePriceCents: "1500"
    }
  }, 403, "DEPOSIT_INSUFFICIENT");
  const depositGateBuyer = await injectJson(app, "deposit gate buyer register", {
    method: "POST",
    url: "/api/auth/h5/register",
    payload: { phone: `139${numericSuffix}`, displayName: `保证金门槛买家-${suffix}` }
  });
  await injectErrorCode(app, "deposit gate blocks payable order create", {
    method: "POST",
    url: "/api/user/orders",
    headers: { authorization: `Bearer ${depositGateBuyer.token}` },
    payload: {
      shopId: pendingDepositAgent.shop.id,
      agentProductId: platformProduct.id,
      clientPaidAmountCents: "1500"
    }
  }, 400, "DEPOSIT_INSUFFICIENT");

  await injectJson(app, "rights code import", {
    method: "POST",
    url: "/api/admin/rights-codes/import",
    headers: adminHeaders,
    payload: {
      productId: platformProduct.id,
      batchNo: `p0-${suffix}`,
      codes: [`P0-${suffix}-001`, `P0-${suffix}-002`, `P0-${suffix}-003`]
    }
  });

  const agentToken = sign({ role: "agent", agentId: manualAgent.agent.id, shopId: manualAgent.shop.id });
  const agentHeaders = { authorization: `Bearer ${agentToken}` };
  const channel = await injectJson(app, "collection channel submit", {
    method: "POST",
    url: "/api/agent/collection-channels",
    headers: agentHeaders,
    payload: {
      channelType: "alipay_personal_qr",
      displayName: `测试收款-${suffix}`,
      accountName: `收款人-${suffix}`,
      qrUrl: `https://example.test/pay-${suffix}.png`,
      isDefault: true
    }
  });
  await injectJson(app, "collection channel review", {
    method: "POST",
    url: `/api/admin/collection-channels/${channel.id}/review`,
    headers: adminHeaders,
    payload: { approved: true }
  });

  const agentProduct = await injectJson(app, "product listing select", {
    method: "POST",
    url: "/api/agent/products/platform",
    headers: agentHeaders,
    payload: {
      platformProductId: platformProduct.id,
      salePriceCents: "1500"
    }
  });

  const register = await injectJson(app, "h5 register coupon grant", {
    method: "POST",
    url: "/api/auth/h5/register",
    payload: { phone: `138${numericSuffix}`, displayName: `买家-${suffix}` }
  });
  if (register.grantedCoupon && typeof register.grantedCoupon.then === "function") {
    throw new Error("grantedCoupon leaked a Promise-like value");
  }
  const userHeaders = { authorization: `Bearer ${register.token}` };

  const order = await injectJson(app, "h5 shop/order create", {
    method: "POST",
    url: "/api/user/orders",
    headers: userHeaders,
    payload: {
      shopId: manualAgent.shop.id,
      agentProductId: agentProduct.id,
      buyerEmail: `buyer-${suffix}@example.test`,
      extractionCode: "246810",
      collectionChannelId: channel.id,
      clientPaidAmountCents: register.grantedCoupon ? "1400" : "1500",
      couponId: register.grantedCoupon?.id
    }
  });
  await injectJson(app, "confirm collection", {
    method: "POST",
    url: `/api/agent/orders/${order.orderNo}/confirm-payment`,
    headers: agentHeaders,
    payload: { amountCents: order.buyerPaidAmountCents ?? order.paidAmountCents, voucherUrl: `fixture://collection/${suffix}` }
  });
  const extracted = await injectJson(app, "auto fulfillment/extract", {
    method: "POST",
    url: `/api/user/orders/${order.orderNo}/extract`,
    headers: userHeaders,
    payload: { extractionCode: "246810" }
  });
  if (!Array.isArray(extracted.codes) || extracted.codes.length < 1) throw new Error("expected issued rights code");

  const lockOrder = await injectJson(app, "wrong extract lock order create", {
    method: "POST",
    url: "/api/user/orders",
    headers: userHeaders,
    payload: {
      shopId: manualAgent.shop.id,
      agentProductId: agentProduct.id,
      extractionCode: "135790",
      collectionChannelId: channel.id,
      clientPaidAmountCents: "1500"
    }
  });
  await injectJson(app, "wrong extract lock order confirm", {
    method: "POST",
    url: `/api/agent/orders/${lockOrder.orderNo}/confirm-payment`,
    headers: agentHeaders,
    payload: { amountCents: "1500", voucherUrl: `fixture://collection/${suffix}-2` }
  });
  for (let index = 0; index < 3; index += 1) {
    await injectJson(app, `wrong extract lock attempt ${index + 1}`, {
      method: "POST",
      url: `/api/user/orders/${lockOrder.orderNo}/extract`,
      headers: userHeaders,
      payload: { extractionCode: "000000" }
    }, 403);
  }
  await injectJson(app, "wrong extract locked", {
    method: "POST",
    url: `/api/user/orders/${lockOrder.orderNo}/extract`,
    headers: userHeaders,
    payload: { extractionCode: "000000" }
  }, 423);
  const afterSale = await injectJson(app, "refund disables extract after-sale create", {
    method: "POST",
    url: "/api/user/after-sales",
    headers: userHeaders,
    payload: {
      orderNo: lockOrder.orderNo,
      reasonCode: "fixture_refund",
      requestedRefundCents: "1500"
    }
  });
  await injectJson(app, "refund disables extract approve", {
    method: "POST",
    url: `/api/admin/after-sales/${afterSale.afterSaleNo}/refunds`,
    headers: adminHeaders,
    payload: {
      refundAmountCents: "1500",
      responsibility: "platform"
    }
  });
  await injectJson(app, "refund disables extract verify", {
    method: "POST",
    url: `/api/user/orders/${lockOrder.orderNo}/extract`,
    headers: userHeaders,
    payload: { extractionCode: "135790" }
  }, 403);

  const settlement = await injectJson(app, "clearing settlement generate", {
    method: "POST",
    url: "/api/admin/settlements/generate",
    headers: adminHeaders,
    payload: {
      agentId: manualAgent.agent.id,
      now: "2030-01-01T00:00:00.000Z",
      batchNo: `p0-${suffix}`
    }
  });
  await injectJson(app, "ledger stats readable", {
    method: "GET",
    url: "/api/admin/ledger-entries",
    headers: adminHeaders
  });
  await injectJson(app, "sales stats readable", {
    method: "GET",
    url: "/api/admin/sales-dashboard",
    headers: adminHeaders
  });
  await closeApp(app, "close primary app");
  appClosed = true;

  logSmoke("start", "restart readback app");
  readbackApp = buildApp();
  logSmoke("pass", "restart readback app");
  await injectJson(readbackApp, "read back shop after restart", {
    method: "GET",
    url: `/api/user/shops/${manualAgent.shop.id}`
  });
  await injectJson(readbackApp, "read back order after restart", {
    method: "GET",
    url: `/api/user/orders/${order.orderNo}`,
    headers: userHeaders
  });
  await closeApp(readbackApp, "close readback app");
  readbackClosed = true;

  logSmoke("pass", "production smoke summary", {
    ok: true,
    persistenceMode: health.persistenceMode,
    shopId: manualAgent.shop.id,
    agentId: manualAgent.agent.id,
    productId: platformProduct.id,
    agentProductId: agentProduct.id,
    orderNo: order.orderNo,
    settlementNo: settlement.settlementNo
  });
  } finally {
    if (!appClosed) {
      await closeApp(app, "close primary app after failure").catch((error) => {
        logSmoke("fail", "close primary app after failure", { error: error instanceof Error ? error.message : String(error) });
      });
    }
    if (readbackApp && !readbackClosed) {
      await closeApp(readbackApp, "close readback app after failure").catch((error) => {
        logSmoke("fail", "close readback app after failure", { error: error instanceof Error ? error.message : String(error) });
      });
    }
  }
}

async function main() {
  const overallTimer = setTimeout(() => {
    logSmoke("fail", "production smoke overall timeout", {
      timeoutMs: OVERALL_TIMEOUT_MS,
      error: `production smoke timed out after ${OVERALL_TIMEOUT_MS}ms`
    });
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);
  try {
    await runSmoke();
  } finally {
    clearTimeout(overallTimer);
  }
}

main().catch((error) => {
  logSmoke("fail", "production smoke", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

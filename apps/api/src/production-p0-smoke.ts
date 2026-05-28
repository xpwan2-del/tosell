import { createHash } from "node:crypto";
import { PrismaClient } from "../../../packages/database/src/index.js";
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
const OVERALL_TIMEOUT_MS = Number(process.env.SMOKE_OVERALL_TIMEOUT_MS ?? 12 * 60_000);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function logSmoke(event: string, label: string, detail?: Record<string, unknown>) {
  console.log(JSON.stringify({
    smoke: event,
    label,
    at: new Date().toISOString(),
    ...detail
  }));
}

function assertArray(value: unknown, label: string): Array<Record<string, any>> {
  if (!Array.isArray(value)) throw new Error(`${label} expected an array`);
  return value as Array<Record<string, any>>;
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => containsKey(item, key));
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value).some((item) => containsKey(item, key));
}

function assertMissingKeys(value: unknown, label: string, keys: string[]) {
  for (const key of keys) {
    if (containsKey(value, key)) throw new Error(`${label} leaked ${key}`);
  }
}

function assertStatus(value: Record<string, any> | undefined, label: string, key: string, expected: string) {
  if (!value || value[key] !== expected) {
    throw new Error(`${label} expected ${key}=${expected}, got ${JSON.stringify(value).slice(0, 400)}`);
  }
}

async function createLimitedOperatorFixture(adminUsername: string) {
  const prisma = new PrismaClient();
  const username = `${adminUsername}-operator-${suffix}`;
  const password = `operator-${suffix}`;
  const passwordHash = `sha256:${createHash("sha256").update(password).digest("hex")}`;
  try {
    const [operator, role] = await Promise.all([
      prisma.adminUser.upsert({
        where: { username },
        update: {
          passwordHash,
          displayName: `Operator ${suffix}`,
          status: "active"
        },
        create: {
          username,
          passwordHash,
          displayName: `Operator ${suffix}`,
          status: "active"
        }
      }),
      prisma.role.upsert({
        where: { code: "operator" },
        update: { name: "Operator" },
        create: { code: "operator", name: "Operator" }
      })
    ]);
    await prisma.adminUserRole.createMany({
      data: [{ adminUserId: operator.id, roleId: role.id }],
      skipDuplicates: true
    });
    return { username, password };
  } finally {
    await prisma.$disconnect();
  }
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
  logSmoke("start", "limited operator fixture", { timeoutMs: STEP_TIMEOUT_MS });
  const limitedOperator = await withTimeout(
    "limited operator fixture",
    "create operator fixture",
    STEP_TIMEOUT_MS,
    () => createLimitedOperatorFixture(adminUsername)
  );
  logSmoke("pass", "limited operator fixture");
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
  const limitedOperatorSession = await injectJson(app, "limited operator login", {
    method: "POST",
    url: "/api/auth/admin/login",
    payload: {
      username: limitedOperator.username,
      password: limitedOperator.password
    }
  });
  const limitedOperatorHeaders = { authorization: `Bearer ${limitedOperatorSession.token}` };

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
      depositRequiredAmountCents: "50000",
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
      depositRequiredAmountCents: "50000",
      depositPaid: false,
      depositAmountCents: "0"
    }
  });
  const pendingAgentLogin = await injectJson(app, "deposit gate pending merchant login", {
    method: "POST",
    url: "/api/auth/agent/login",
    payload: {
      account: pendingDepositAgent.credential.account,
      password: pendingDepositAgent.credential.initialPassword
    }
  });
  const pendingAgentHeaders = { authorization: `Bearer ${pendingAgentLogin.token}` };
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
  const redactedCodes = await injectJson(app, "rights code list redacted", {
    method: "GET",
    url: `/api/admin/rights-codes?productId=${platformProduct.id}`,
    headers: adminHeaders
  });
  if (Array.isArray(redactedCodes) && redactedCodes.some((item) => typeof item.code === "string")) {
    throw new Error("rights code list leaked plaintext code");
  }
  await injectErrorCode(app, "rights code plaintext denied without permission", {
    method: "GET",
    url: `/api/admin/rights-codes/plaintext?productId=${platformProduct.id}`,
    headers: limitedOperatorHeaders
  }, 403, "FORBIDDEN_ADMIN_PERMISSION");
  await injectJson(app, "rights code plaintext audited", {
    method: "GET",
    url: `/api/admin/rights-codes/plaintext?productId=${platformProduct.id}`,
    headers: adminHeaders
  });
  const plaintextAudits = await injectJson(app, "rights code plaintext audit readable", {
    method: "GET",
    url: "/api/admin/audit-logs",
    headers: adminHeaders
  });
  if (!assertArray(plaintextAudits, "rights code plaintext audit readable").some((item) => item.action === "rights_code.secret.read")) {
    throw new Error("rights code plaintext access audit was not recorded");
  }

  const agentLogin = await injectJson(app, "manual merchant login", {
    method: "POST",
    url: "/api/auth/agent/login",
    payload: {
      account: manualAgent.credential.account,
      password: manualAgent.credential.initialPassword
    }
  });
  const agentHeaders = { authorization: `Bearer ${agentLogin.token}` };
  await injectJson(app, "agent session bearer", {
    method: "GET",
    url: "/api/auth/agent/session",
    headers: agentHeaders
  });

  const inviteFirst = await injectJson(app, "invite first-tier create", {
    method: "POST",
    url: "/api/admin/invite-codes",
    headers: adminHeaders,
    payload: {
      code: `P0-FIRST-${suffix}`,
      depositRequiredAmountCents: "50000"
    }
  });
  const invitedFirst = await injectJson(app, "invite first-tier register", {
    method: "POST",
    url: "/api/agent/register-by-invite",
    payload: {
      inviteCode: inviteFirst.code,
      name: `P0邀请一级-${suffix}`,
      shopName: `P0邀请一级店-${suffix}`
    }
  });
  await injectJson(app, "invite first-tier review approve", {
    method: "POST",
    url: `/api/admin/agents/${invitedFirst.agent.id}/review`,
    headers: adminHeaders,
    payload: { approved: true }
  });
  await injectJson(app, "invite first-tier deposit confirm", {
    method: "POST",
    url: `/api/admin/deposits/${invitedFirst.agent.id}/confirm`,
    headers: adminHeaders,
    payload: { amountCents: "50000", voucherUrl: `fixture://deposit/invite-first-${suffix}` }
  });
  const invitedFirstLogin = await injectJson(app, "invite first-tier merchant login", {
    method: "POST",
    url: "/api/auth/agent/login",
    payload: {
      account: invitedFirst.credential.account,
      password: invitedFirst.credential.initialPassword
    }
  });
  const invitedFirstHeaders = { authorization: `Bearer ${invitedFirstLogin.token}` };
  await injectJson(app, "invite first-tier agent shop bearer", {
    method: "GET",
    url: "/api/agent/shop",
    headers: invitedFirstHeaders
  });
  await injectJson(app, "invite first-tier agent products bearer", {
    method: "GET",
    url: "/api/agent/products",
    headers: invitedFirstHeaders
  });

  await injectJson(app, "first-tier channel authorization approve", {
    method: "POST",
    url: `/api/admin/channels/${invitedFirst.agent.id}/review`,
    headers: adminHeaders,
    payload: { approved: true }
  });
  const inviteSecond = await injectJson(app, "invite second-tier create", {
    method: "POST",
    url: "/api/agent/invite-codes",
    headers: invitedFirstHeaders,
    payload: { code: `P0-SECOND-${suffix}` }
  });
  if (
    inviteSecond.code !== `P0-SECOND-${suffix}`
    || inviteSecond.targetTier !== "second_tier"
    || inviteSecond.issuer?.agentId !== invitedFirst.agent.id
    || inviteSecond.currentMerchantScope?.agentId !== invitedFirst.agent.id
    || inviteSecond.depositRequiredAmountCents === undefined
    || containsKey(inviteSecond, "codeHash")
  ) {
    throw new Error(`second-tier invite create response missing merchant UI fields: ${JSON.stringify(inviteSecond).slice(0, 400)}`);
  }
  const firstInviteList = await injectJson(app, "first-tier invite list scoped", {
    method: "GET",
    url: "/api/agent/invite-codes",
    headers: invitedFirstHeaders
  });
  assertMissingKeys(firstInviteList, "first-tier invite list scoped", ["codeHash"]);
  const firstInviteCodes = assertArray(firstInviteList, "first-tier invite list scoped").map((item) => item.code);
  if (!firstInviteCodes.includes(`P0-SECOND-${suffix}`) || firstInviteCodes.includes(`P0-THIRD-${suffix}`)) {
    throw new Error(`first-tier invite list was not scoped to current merchant: ${JSON.stringify(firstInviteList).slice(0, 400)}`);
  }
  const invitedSecond = await injectJson(app, "invite second-tier register", {
    method: "POST",
    url: "/api/agent/register-by-invite",
    payload: {
      inviteCode: inviteSecond.code,
      name: `P0邀请二级-${suffix}`,
      shopName: `P0邀请二级店-${suffix}`
    }
  });
  await injectJson(app, "invite second-tier review approve", {
    method: "POST",
    url: `/api/admin/agents/${invitedSecond.agent.id}/review`,
    headers: adminHeaders,
    payload: { approved: true }
  });
  await injectJson(app, "invite second-tier deposit confirm", {
    method: "POST",
    url: `/api/admin/deposits/${invitedSecond.agent.id}/confirm`,
    headers: adminHeaders,
    payload: { amountCents: "50000", voucherUrl: `fixture://deposit/invite-second-${suffix}` }
  });
  const invitedSecondLogin = await injectJson(app, "invite second-tier merchant login", {
    method: "POST",
    url: "/api/auth/agent/login",
    payload: {
      account: invitedSecond.credential.account,
      password: invitedSecond.credential.initialPassword
    }
  });
  const invitedSecondHeaders = { authorization: `Bearer ${invitedSecondLogin.token}` };
  const firstSecondRelation = await injectJson(app, "first-second channel relation active", {
    method: "POST",
    url: "/api/admin/channels/relations",
    headers: adminHeaders,
    payload: {
      firstTierAgentId: invitedFirst.agent.id,
      secondTierAgentId: invitedSecond.agent.id,
      reason: "production smoke price isolation"
    }
  });
  await injectJson(app, "first-second transfer price offer", {
    method: "POST",
    url: "/api/admin/channels/offers",
    headers: adminHeaders,
    payload: {
      channelRelationId: firstSecondRelation.id,
      platformProductId: platformProduct.id,
      resellSupplyPriceCents: "1100",
      status: "listed"
    }
  });
  await injectJson(app, "merchant first-tier transfer price offer", {
    method: "POST",
    url: "/api/agent/channels/offers",
    headers: invitedFirstHeaders,
    payload: {
      downstreamAgentId: invitedSecond.agent.id,
      platformProductId: platformProduct.id,
      resellSupplyPriceCents: "1100",
      status: "listed"
    }
  });
  const inviteThird = await injectJson(app, "invite third-tier create", {
    method: "POST",
    url: "/api/agent/invite-codes",
    headers: invitedSecondHeaders,
    payload: { code: `P0-THIRD-${suffix}` }
  });
  if (
    inviteThird.code !== `P0-THIRD-${suffix}`
    || inviteThird.targetTier !== "third_tier"
    || inviteThird.issuer?.agentId !== invitedSecond.agent.id
    || inviteThird.currentMerchantScope?.agentId !== invitedSecond.agent.id
    || inviteThird.depositRequiredAmountCents === undefined
    || containsKey(inviteThird, "codeHash")
  ) {
    throw new Error(`third-tier invite create response missing merchant UI fields: ${JSON.stringify(inviteThird).slice(0, 400)}`);
  }
  const secondInviteList = await injectJson(app, "second-tier invite list scoped", {
    method: "GET",
    url: "/api/agent/invite-codes",
    headers: invitedSecondHeaders
  });
  assertMissingKeys(secondInviteList, "second-tier invite list scoped", ["codeHash"]);
  const secondInviteCodes = assertArray(secondInviteList, "second-tier invite list scoped").map((item) => item.code);
  if (!secondInviteCodes.includes(`P0-THIRD-${suffix}`) || secondInviteCodes.includes(`P0-SECOND-${suffix}`)) {
    throw new Error(`second-tier invite list was not scoped to current merchant: ${JSON.stringify(secondInviteList).slice(0, 400)}`);
  }
  const invitedThird = await injectJson(app, "invite third-tier register", {
    method: "POST",
    url: "/api/agent/register-by-invite",
    payload: {
      inviteCode: inviteThird.code,
      name: `P0邀请三级-${suffix}`,
      shopName: `P0邀请三级店-${suffix}`
    }
  });
  await injectJson(app, "invite third-tier review approve", {
    method: "POST",
    url: `/api/admin/agents/${invitedThird.agent.id}/review`,
    headers: adminHeaders,
    payload: { approved: true }
  });
  await injectJson(app, "invite third-tier deposit confirm", {
    method: "POST",
    url: `/api/admin/deposits/${invitedThird.agent.id}/confirm`,
    headers: adminHeaders,
    payload: { amountCents: "50000", voucherUrl: `fixture://deposit/invite-third-${suffix}` }
  });
  const invitedThirdLogin = await injectJson(app, "invite third-tier merchant login", {
    method: "POST",
    url: "/api/auth/agent/login",
    payload: {
      account: invitedThird.credential.account,
      password: invitedThird.credential.initialPassword
    }
  });
  const invitedThirdHeaders = { authorization: `Bearer ${invitedThirdLogin.token}` };
  const threeTierRelation = await injectJson(app, "first-second-third channel relation active", {
    method: "POST",
    url: "/api/admin/channels/relations",
    headers: adminHeaders,
    payload: {
      firstTierAgentId: invitedFirst.agent.id,
      secondTierAgentId: invitedSecond.agent.id,
      thirdTierAgentId: invitedThird.agent.id,
      reason: "production smoke price isolation"
    }
  });
  await injectJson(app, "second-third transfer price offer", {
    method: "POST",
    url: "/api/admin/channels/offers",
    headers: adminHeaders,
    payload: {
      channelRelationId: threeTierRelation.id,
      platformProductId: platformProduct.id,
      resellSupplyPriceCents: "1300",
      status: "listed"
    }
  });
  await injectJson(app, "merchant second-tier transfer price offer", {
    method: "POST",
    url: "/api/agent/channels/offers",
    headers: invitedSecondHeaders,
    payload: {
      downstreamAgentId: invitedThird.agent.id,
      platformProductId: platformProduct.id,
      resellSupplyPriceCents: "1300",
      status: "listed"
    }
  });
  await injectErrorCode(app, "merchant third-tier transfer price rejected", {
    method: "POST",
    url: "/api/agent/channels/offers",
    headers: invitedThirdHeaders,
    payload: {
      downstreamAgentId: invitedFirst.agent.id,
      platformProductId: platformProduct.id,
      resellSupplyPriceCents: "1500",
      status: "listed"
    }
  }, 403, "FOURTH_TIER_FORBIDDEN");
  await injectErrorCode(app, "merchant cross-relation transfer price rejected", {
    method: "POST",
    url: "/api/agent/channels/offers",
    headers: invitedFirstHeaders,
    payload: {
      downstreamAgentId: invitedThird.agent.id,
      platformProductId: platformProduct.id,
      resellSupplyPriceCents: "1500",
      status: "listed"
    }
  }, 403, "FORBIDDEN_AGENT_SCOPE");
  const secondVisibleProducts = await injectJson(app, "second-tier price isolation products", {
    method: "GET",
    url: "/api/agent/products/platform",
    headers: invitedSecondHeaders
  });
  assertMissingKeys(secondVisibleProducts, "second-tier price isolation products", ["supplyPriceCents", "platformSupplyPriceCents"]);
  const secondVisibleProduct = assertArray(secondVisibleProducts, "second-tier price isolation products")
    .find((item) => item.id === platformProduct.id);
  if (!secondVisibleProduct || secondVisibleProduct.visibleUpstreamSupplyPriceCents !== "1100") {
    throw new Error(`second-tier product visibility was not scoped to first-tier transfer price: ${JSON.stringify(secondVisibleProduct).slice(0, 400)}`);
  }
  const thirdVisibleProducts = await injectJson(app, "third-tier price isolation products", {
    method: "GET",
    url: "/api/agent/products/platform",
    headers: invitedThirdHeaders
  });
  assertMissingKeys(thirdVisibleProducts, "third-tier price isolation products", ["supplyPriceCents", "platformSupplyPriceCents", "ownTransferSupplyPriceCents"]);
  const thirdVisibleProduct = assertArray(thirdVisibleProducts, "third-tier price isolation products")
    .find((item) => item.id === platformProduct.id);
  if (!thirdVisibleProduct || thirdVisibleProduct.visibleUpstreamSupplyPriceCents !== "1300") {
    throw new Error(`third-tier product visibility was not scoped to second-tier transfer price: ${JSON.stringify(thirdVisibleProduct).slice(0, 400)}`);
  }
  await injectErrorCode(app, "third-tier fourth invite rejected", {
    method: "POST",
    url: "/api/agent/invite-codes",
    headers: invitedThirdHeaders,
    payload: { code: `P0-FOURTH-${suffix}` }
  }, 400, "FOURTH_TIER_FORBIDDEN");
  const thirdInviteList = await injectJson(app, "third-tier invite list scoped", {
    method: "GET",
    url: "/api/agent/invite-codes",
    headers: invitedThirdHeaders
  });
  if (assertArray(thirdInviteList, "third-tier invite list scoped").length !== 0) {
    throw new Error(`third-tier invite list should be empty: ${JSON.stringify(thirdInviteList).slice(0, 400)}`);
  }

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
  const agentOrders = await injectJson(app, "agent order list scoped", {
    method: "GET",
    url: "/api/agent/orders",
    headers: agentHeaders
  });
  if (!assertArray(agentOrders, "agent order list scoped").some((item) => item.orderNo === order.orderNo)) {
    throw new Error("agent order list did not include own order");
  }
  await injectJson(app, "agent order detail scoped", {
    method: "GET",
    url: `/api/agent/orders/${order.orderNo}`,
    headers: agentHeaders
  });
  await injectErrorCode(app, "agent order detail cross-scope rejected", {
    method: "GET",
    url: `/api/agent/orders/${order.orderNo}`,
    headers: invitedSecondHeaders
  }, 404, "RESOURCE_NOT_FOUND");
  await injectErrorCode(app, "agent confirm collection cross-scope rejected", {
    method: "POST",
    url: `/api/agent/orders/${order.orderNo}/confirm-payment`,
    headers: invitedSecondHeaders,
    payload: { amountCents: order.buyerPaidAmountCents ?? order.paidAmountCents, voucherUrl: `fixture://collection/cross-${suffix}` }
  }, 403, "FORBIDDEN_AGENT_SCOPE");
  await injectJson(app, "confirm collection", {
    method: "POST",
    url: `/api/agent/orders/${order.orderNo}/confirm-payment`,
    headers: agentHeaders,
    payload: { amountCents: order.buyerPaidAmountCents ?? order.paidAmountCents, voucherUrl: `fixture://collection/${suffix}` }
  });
  await injectErrorCode(app, "agent fulfillment cross-scope rejected", {
    method: "POST",
    url: `/api/agent/orders/${order.orderNo}/fulfillment`,
    headers: invitedSecondHeaders,
    payload: { status: "success", attemptNo: 1, evidence: `fixture://fulfillment/cross-${suffix}` }
  }, 403, "FORBIDDEN_AGENT_SCOPE");
  await injectJson(app, "agent fulfillment scoped", {
    method: "POST",
    url: `/api/agent/orders/${order.orderNo}/fulfillment`,
    headers: agentHeaders,
    payload: { status: "success", attemptNo: 1, evidence: `fixture://fulfillment/${suffix}` }
  });
  const extracted = await injectJson(app, "auto fulfillment/extract", {
    method: "POST",
    url: `/api/user/orders/${order.orderNo}/extract`,
    headers: userHeaders,
    payload: { extractionCode: "246810" }
  });
  if (!Array.isArray(extracted.codes) || extracted.codes.length < 1) throw new Error("expected issued rights code");

  const guest = await injectJson(app, "h5 guest auth", {
    method: "POST",
    url: "/api/auth/h5/guest"
  });
  const guestHeaders = { authorization: `Bearer ${guest.token}` };
  const guestShop = await injectJson(app, "h5 guest browse shop", {
    method: "GET",
    url: `/api/user/shops/${manualAgent.shop.id}`
  });
  if (guestShop.id !== manualAgent.shop.id) throw new Error("guest shop browse returned the wrong shop");
  const guestProducts = await injectJson(app, "h5 guest browse shop products", {
    method: "GET",
    url: `/api/user/shops/${manualAgent.shop.id}/products`
  });
  if (!Array.isArray(guestProducts) || !guestProducts.some((item: Record<string, any>) => item.id === agentProduct.id)) {
    throw new Error("guest shop browse did not include listed product");
  }
  await injectJson(app, "h5 guest product detail", {
    method: "GET",
    url: `/api/user/products/${agentProduct.id}`
  });
  const guestQuote = await injectJson(app, "h5 guest quote", {
    method: "POST",
    url: "/api/user/orders/quote",
    headers: guestHeaders,
    payload: {
      shopId: manualAgent.shop.id,
      agentProductId: agentProduct.id
    }
  });
  const guestOrder = await injectJson(app, "h5 guest order create", {
    method: "POST",
    url: "/api/user/orders",
    headers: guestHeaders,
    payload: {
      shopId: manualAgent.shop.id,
      agentProductId: agentProduct.id,
      extractionCode: "975310",
      collectionChannelId: channel.id,
      clientPaidAmountCents: guestQuote.buyerPaidAmountCents ?? guestQuote.paidAmountCents
    }
  });
  await injectJson(app, "h5 guest confirm collection", {
    method: "POST",
    url: `/api/agent/orders/${guestOrder.orderNo}/confirm-payment`,
    headers: agentHeaders,
    payload: {
      amountCents: guestOrder.buyerPaidAmountCents ?? guestOrder.paidAmountCents,
      voucherUrl: `fixture://collection/guest-${suffix}`
    }
  });
  const guestExtracted = await injectJson(app, "h5 guest extract", {
    method: "POST",
    url: `/api/user/orders/${guestOrder.orderNo}/extract`,
    headers: guestHeaders,
    payload: { extractionCode: "975310" }
  });
  if (!Array.isArray(guestExtracted.codes) || guestExtracted.codes.length < 1) throw new Error("guest order did not issue rights code");

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
      orderNo: order.orderNo,
      reasonCode: "fixture_refund",
      requestedRefundCents: order.buyerPaidAmountCents ?? order.paidAmountCents
    }
  });
  const agentAfterSales = await injectJson(app, "agent after-sale list scoped", {
    method: "GET",
    url: "/api/agent/after-sales",
    headers: agentHeaders
  });
  if (!assertArray(agentAfterSales, "agent after-sale list scoped").some((item) => item.afterSaleNo === afterSale.afterSaleNo)) {
    throw new Error("agent after-sale list did not include own after-sale");
  }
  await injectErrorCode(app, "agent after-sale assist cross-scope rejected", {
    method: "POST",
    url: `/api/agent/after-sales/${afterSale.afterSaleNo}/assist`,
    headers: invitedSecondHeaders,
    payload: {
      note: "production smoke cross-scope after-sale assistance",
      evidenceUrl: `fixture://after-sale-assist/cross-${suffix}`
    }
  }, 403, "FORBIDDEN_AGENT_SCOPE");
  await injectJson(app, "agent after-sale assist scoped", {
    method: "POST",
    url: `/api/agent/after-sales/${afterSale.afterSaleNo}/assist`,
    headers: agentHeaders,
    payload: {
      note: "production smoke merchant after-sale assistance",
      evidenceUrl: `fixture://after-sale-assist/${suffix}`
    }
  });
  const refundApproval = await injectJson(app, "refund disables extract approve", {
    method: "POST",
    url: `/api/admin/after-sales/${afterSale.afterSaleNo}/refunds`,
    headers: adminHeaders,
    payload: {
      refundAmountCents: order.buyerPaidAmountCents ?? order.paidAmountCents,
      responsibility: "platform"
    }
  });
  await injectJson(app, "refund manual confirmation", {
    method: "POST",
    url: `/api/admin/refunds/${refundApproval.refund.refundNo}/manual-confirm`,
    headers: adminHeaders,
    payload: {
      channelRefundNo: `manual-refund-${suffix}`,
      voucherUrl: `fixture://refund/${suffix}`,
      note: "production smoke manual refund confirmation"
    }
  });
  await injectJson(app, "refund disables extract verify", {
    method: "POST",
    url: `/api/user/orders/${order.orderNo}/extract`,
    headers: userHeaders,
    payload: { extractionCode: "246810" }
  }, 403);
  const refundedOrder = await injectJson(app, "refund order status readback", {
    method: "GET",
    url: `/api/user/orders/${order.orderNo}`,
    headers: userHeaders
  });
  assertStatus(refundedOrder, "refund order status readback", "status", "refunded");
  assertStatus(refundedOrder, "refund order status readback", "refundStatus", "refunded");
  const userCoupons = await injectJson(app, "refund coupon void readback", {
    method: "GET",
    url: "/api/user/coupons",
    headers: userHeaders
  });
  const refundedCoupon = register.grantedCoupon
    ? assertArray(userCoupons, "refund coupon void readback").find((item) => item.id === register.grantedCoupon.id)
    : undefined;
  if (register.grantedCoupon && refundedCoupon?.status !== "voided_after_refund") {
    throw new Error(`refund did not void used registration coupon: ${JSON.stringify(refundedCoupon).slice(0, 400)}`);
  }
  const adminRefunds = await injectJson(app, "refund success admin readback", {
    method: "GET",
    url: "/api/admin/refunds",
    headers: adminHeaders
  });
  const adminRefund = assertArray(adminRefunds, "refund success admin readback")
    .find((item) => item.refundNo === refundApproval.refund.refundNo);
  assertStatus(adminRefund, "refund success admin readback", "status", "refunded");
  const adminOrders = await injectJson(app, "refund settlement freeze admin order readback", {
    method: "GET",
    url: "/api/admin/orders",
    headers: adminHeaders
  });
  const adminRefundedOrder = assertArray(adminOrders, "refund settlement freeze admin order readback")
    .find((item) => item.orderNo === order.orderNo);
  assertStatus(adminRefundedOrder, "refund settlement freeze admin order readback", "settlementStatus", "frozen");
  const refundLedgers = await injectJson(app, "refund ledger readback", {
    method: "GET",
    url: "/api/admin/ledger-entries",
    headers: adminHeaders
  });
  if (!assertArray(refundLedgers, "refund ledger readback").some((item) => item.entryType === "REFUND_SUCCEEDED" && item.orderNo === order.orderNo)) {
    throw new Error("refund ledger entry was not recorded");
  }
  await injectJson(app, "refund clawback readback", {
    method: "GET",
    url: "/api/agent/clawbacks",
    headers: agentHeaders
  });
  await injectJson(app, "refund deposit transactions readback", {
    method: "GET",
    url: "/api/agent/deposit-transactions",
    headers: agentHeaders
  });

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

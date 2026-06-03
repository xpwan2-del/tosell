import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaClient } from "../../../packages/database/src/index.js";
import { buildApp } from "./app.js";

type FixtureApp = ReturnType<typeof buildApp>;
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
type MerchantFixture = {
  label: string;
  merchant: any;
  shop: any;
  credential: { account: string; initialPassword: string };
  headers?: Record<string, string>;
};

const runId = (process.env.E2E_FIXTURE_RUN_ID ?? Date.now().toString(36)).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
const STEP_TIMEOUT_MS = Number(process.env.E2E_FIXTURE_STEP_TIMEOUT_MS ?? 30_000);
const OVERALL_TIMEOUT_MS = Number(process.env.E2E_FIXTURE_OVERALL_TIMEOUT_MS ?? 10 * 60_000);
const fixtureDepositCents = "50000";
const fixtureSamplePassword = process.env.E2E_FIXTURE_SAMPLE_PASSWORD ?? process.env.ADMIN_PASSWORD;
const latestMarkerKey = "e2e-business-fixtures:latest";
const runMarkerKey = `e2e-business-fixtures:${runId}`;
const READINESS_RETRY_ATTEMPTS = Number(process.env.E2E_FIXTURE_READINESS_RETRY_ATTEMPTS ?? 5);
const READINESS_RETRY_DELAY_MS = Number(process.env.E2E_FIXTURE_READINESS_RETRY_DELAY_MS ?? 1500);
const requiredPermissions = [
  "merchant.review",
  "product.manage",
  "after_sale.arbitrate",
  "settlement.generate",
  "settlement.confirm",
  "payout.confirm",
  "deposit.manage",
  "payment_config.manage",
  "risk.freeze",
  "audit.read",
  "rbac.manage",
  "merchant.manage",
  "shop.manage",
  "order.read",
  "payment.confirm",
  "fulfillment.manage",
  "after_sale.manage",
  "coupon.manage",
  "settlement.manage",
  "ledger.read",
  "risk.manage",
  "rights_code.secret.read"
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function logFixture(event: string, label: string, detail?: Record<string, unknown>) {
  console.log(JSON.stringify({
    fixture: event,
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
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms: ${detail}`)), timeoutMs);
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

async function injectJson(app: FixtureApp, label: string, options: InjectOptions, expectedStatus = 200) {
  const method = String(options.method ?? "GET");
  const path = options.url;
  logFixture("start", label, { method, path, timeoutMs: STEP_TIMEOUT_MS });
  const startedAt = Date.now();
  try {
    const response = await withTimeout(
      label,
      `${method} ${path}`,
      STEP_TIMEOUT_MS,
      () => app.inject(options as never) as Promise<InjectResponse>
    );
    const body = await expectJson(response, expectedStatus, label);
    logFixture("pass", label, { method, path, statusCode: response.statusCode, durationMs: Date.now() - startedAt });
    return body;
  } catch (error) {
    logFixture("fail", label, {
      method,
      path,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function injectErrorCode(app: FixtureApp, label: string, options: InjectOptions, expectedStatus: number, expectedCode: string) {
  const body = await injectJson(app, label, options, expectedStatus);
  if (body?.code !== expectedCode) {
    throw new Error(`${label} expected error code ${expectedCode}, got ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientPrismaConnectionError(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof record.code === "string" ? record.code : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "P1001"
    || code === "P1002"
    || code === "P1017"
    || code === "P2024"
    || code === "P2028"
    || /Transaction API error/i.test(message)
    || /Transaction not found/i.test(message)
    || /Can't reach database server/i.test(message)
    || /Timed out fetching a new connection/i.test(message)
    || /server closed the connection/i.test(message)
    || /connection (?:terminated|closed|reset)/i.test(message)
    || /pooler|pool timeout/i.test(message)
    || /ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i.test(message);
}

async function withFreshPrismaRetry<T>(label: string, action: (client: PrismaClient) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= READINESS_RETRY_ATTEMPTS; attempt += 1) {
    const client = new PrismaClient();
    try {
      const result = await withTimeout(label, `fresh Prisma attempt ${attempt}`, STEP_TIMEOUT_MS, () => action(client));
      if (attempt > 1) {
        logFixture("pass", `${label} retry`, { attempt, maxAttempts: READINESS_RETRY_ATTEMPTS });
      }
      return result;
    } catch (error) {
      lastError = error;
      if (!isTransientPrismaConnectionError(error) || attempt >= READINESS_RETRY_ATTEMPTS) throw error;
      logFixture("retry", label, {
        attempt,
        maxAttempts: READINESS_RETRY_ATTEMPTS,
        delayMs: READINESS_RETRY_DELAY_MS,
        error: error instanceof Error ? error.message : String(error)
      });
      await sleep(READINESS_RETRY_DELAY_MS * attempt);
    } finally {
      await client.$disconnect().catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function hashPassword(password: string) {
  return `sha256:${createHash("sha256").update(password).digest("hex")}`;
}

function code(prefix: string) {
  return `${prefix}-${runId}`.toUpperCase();
}

async function main() {
  const overallTimer = setTimeout(() => {
    logFixture("fail", "business fixture overall timeout", {
      timeoutMs: OVERALL_TIMEOUT_MS,
      error: `business fixture timed out after ${OVERALL_TIMEOUT_MS}ms`
    });
    process.exit(1);
  }, OVERALL_TIMEOUT_MS);

  const prisma = new PrismaClient();
  const app = buildApp();
  let appClosed = false;

  try {
    assertFixtureEnvironment();

    const adminUsername = requireEnv("ADMIN_USERNAME");
    const adminPassword = process.env.E2E_FIXTURE_ADMIN_PASSWORD ?? process.env.SMOKE_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
    if (!adminPassword) throw new Error("E2E_FIXTURE_ADMIN_PASSWORD, SMOKE_ADMIN_PASSWORD, or ADMIN_PASSWORD is required");
    if (!fixtureSamplePassword) throw new Error("E2E_FIXTURE_SAMPLE_PASSWORD or ADMIN_PASSWORD is required for RBAC sample accounts");

    const existingMarker = await withFreshPrismaRetry("business fixture existing marker lookup", (client) =>
      client.auditLog.findUnique({ where: { idempotencyKey: runMarkerKey } })
    );
    if (existingMarker) {
      if (process.env.E2E_FIXTURE_REUSE_EXISTING === "true" || process.env.E2E_FIXTURE_REPAIR_EXISTING === "true") {
        let readiness: Awaited<ReturnType<typeof verifyFixtureReadiness>>;
        try {
          readiness = await withFreshPrismaRetry("business fixture existing readiness", (client) => verifyFixtureReadiness(client, existingMarker.afterJson));
        } catch (error) {
          if (process.env.E2E_FIXTURE_REPAIR_EXISTING !== "true") throw error;
          await withFreshPrismaRetry("business fixture relation repair", (client) => repairExistingFixtureMerchantRelations(client, existingMarker.afterJson));
          readiness = await withFreshPrismaRetry("business fixture repaired readiness", (client) => verifyFixtureReadiness(client, existingMarker.afterJson));
          await withFreshPrismaRetry("business fixture repaired marker", (client) => writeFixtureMarker(client, {
            ...(existingMarker.afterJson && typeof existingMarker.afterJson === "object" && !Array.isArray(existingMarker.afterJson)
              ? existingMarker.afterJson as Record<string, unknown>
              : {}),
            readiness
          }));
        }
        logFixture("pass", "business fixture existing run reused", {
          ok: true,
          runId,
          readiness
        });
        return;
      }
      throw new Error(`business fixture runId ${runId} already exists; set E2E_FIXTURE_REUSE_EXISTING=true to verify/reuse it or choose a new E2E_FIXTURE_RUN_ID`);
    }

    await createRbacSamples(prisma, fixtureSamplePassword);

    const adminSession = await injectJson(app, "fixture admin login", {
      method: "POST",
      url: "/api/auth/admin/login",
      payload: { username: adminUsername, password: adminPassword }
    });
    const adminHeaders = authHeaders(adminSession.token);

    await injectJson(app, "fixture admin session", {
      method: "GET",
      url: "/api/auth/admin/session",
      headers: adminHeaders
    });

    const m1 = await createManualMerchant(app, adminHeaders, "M1", true);
    const m1p = await createManualMerchant(app, adminHeaders, "M1P", false);
    await loginMerchant(app, m1);
    await loginMerchant(app, m1p);

    await injectJson(app, "M1 channel authorization approve", {
      method: "POST",
      url: `/api/admin/merchant-supply/${m1.merchant.id}/review`,
      headers: adminHeaders,
      payload: { approved: true, reason: "controlled business fixture" }
    });

    const m2 = await createInvitedMerchant(app, adminHeaders, m1, "M2", true);
    const m2p = await createInvitedMerchant(app, adminHeaders, m1, "M2P", false);
    const firstSecondRelation = await injectJson(app, "M1-M2 channel relation active", {
      method: "POST",
      url: "/api/admin/merchant-supply/relations",
      headers: adminHeaders,
      payload: {
        firstTierMerchantId: m1.merchant.id,
        secondTierMerchantId: m2.merchant.id,
        reason: "controlled business fixture"
      }
    });

    const m3 = await createInvitedMerchant(app, adminHeaders, m2, "M3", true);
    const m3p = await createInvitedMerchant(app, adminHeaders, m2, "M3P", false);
    const firstSecondThirdRelation = await injectJson(app, "M1-M2-M3 channel relation active", {
      method: "POST",
      url: "/api/admin/merchant-supply/relations",
      headers: adminHeaders,
      payload: {
        firstTierMerchantId: m1.merchant.id,
        secondTierMerchantId: m2.merchant.id,
        thirdTierMerchantId: m3.merchant.id,
        reason: "controlled business fixture"
      }
    });

    await injectErrorCode(app, "M3 fourth-tier invite rejected", {
      method: "POST",
      url: "/api/merchant/invite-codes",
      headers: m3.headers,
      payload: { code: code("FIX-M4") }
    }, 400, "FOURTH_TIER_FORBIDDEN");

    const p1 = await createPlatformProduct(app, adminHeaders, "P1", "code_pool", "1000", "1200", "1500");
    const p2 = await createPlatformProduct(app, adminHeaders, "P2", "manual", "2000", "2500", "3000");
    const p3 = await createPlatformProduct(app, adminHeaders, "P3", "code_pool", "3000", "3500", "4200");

    await ensurePlatformRightsCodes(app, adminHeaders, p1.id, "P1", 8, 12);
    await injectJson(app, "P3 rights code import 0/1", {
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: adminHeaders,
      payload: { productId: p3.id, batchNo: `P3-${runId}`, codes: [`P3-${runId}-001`] }
    });
    await injectErrorCode(app, "duplicate rights code sample rejected", {
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: adminHeaders,
      payload: { productId: p1.id, batchNo: `P1-DUP-${runId}`, codes: [`P1-${runId}-001`, `P1-${runId}-001`] }
    }, 400, "RIGHTS_CODE_EMPTY");
    await injectErrorCode(app, "illegal blank rights code sample rejected", {
      method: "POST",
      url: "/api/admin/rights-codes/import",
      headers: adminHeaders,
      payload: { productId: p1.id, batchNo: `P1-BAD-${runId}`, codes: [" ", ""] }
    }, 400, "RIGHTS_CODE_EMPTY");

    await injectJson(app, "M1-M2 transfer offer", {
      method: "POST",
      url: "/api/admin/merchant-supply/offers",
      headers: adminHeaders,
      payload: {
        channelRelationId: firstSecondRelation.id,
        platformProductId: p1.id,
        resellSupplyPriceCents: "1250",
        status: "listed"
      }
    });
    await injectJson(app, "M2-M3 transfer offer", {
      method: "POST",
      url: "/api/admin/merchant-supply/offers",
      headers: adminHeaders,
      payload: {
        channelRelationId: firstSecondThirdRelation.id,
        platformProductId: p1.id,
        resellSupplyPriceCents: "1350",
        status: "listed"
      }
    });

    const o1 = await createOwnProduct(app, adminHeaders, m1, "O1", "code_pool", "5600", 5);
    const o2 = await createOwnProduct(app, adminHeaders, m2, "O2", "manual", "6600", 0);
    const o3 = await createOwnProduct(app, adminHeaders, m3, "O3", "code_pool", "7600", 5);

    for (const merchant of [m1, m2, m3]) {
      await createPaymentMethodStates(app, prisma, merchant);
    }

    const coupons = await createCouponFixtures(app, prisma, adminHeaders, p1.id);

    const fixtureSummary = {
      runId,
      merchants: {
        M1: m1.merchant.id,
        M2: m2.merchant.id,
        M3: m3.merchant.id,
        M1P: m1p.merchant.id,
        M2P: m2p.merchant.id,
        M3P: m3p.merchant.id
      },
      shops: {
        M1: m1.shop.id,
        M2: m2.shop.id,
        M3: m3.shop.id,
        M1P: m1p.shop.id,
        M2P: m2p.shop.id,
        M3P: m3p.shop.id
      },
      platformProducts: { P1: p1.id, P2: p2.id, P3: p3.id },
      ownProducts: { O1: o1.merchantProductListing.id, O2: o2.merchantProductListing.id, O3: o3.merchantProductListing.id },
      channelRelations: {
        M1_M2: firstSecondRelation.id,
        M1_M2_M3: firstSecondThirdRelation.id
      },
      coupons,
      counts: {
        p1RightsCodes: 8,
        p3RightsCodes: 1,
        o1RightsCodes: 5,
        o3RightsCodes: 5,
        paymentMethodsPerMerchant: 4
      }
    };
    const readiness = await withFreshPrismaRetry("business fixture readiness", (client) => verifyFixtureReadiness(client, fixtureSummary));
    await withFreshPrismaRetry("business fixture marker", (client) => writeFixtureMarker(client, {
      ...fixtureSummary,
      readiness
    }));

    await closeApp(app, "close fixture app");
    appClosed = true;

    logFixture("pass", "business fixture summary", {
      ok: true,
      runId,
      businessFixturesCreated: true,
      fixtureTarget: process.env.E2E_FIXTURE_TARGET,
      marker: `audit_logs.idempotency_key=${latestMarkerKey}`,
      readiness,
      ids: {
        merchants: {
          M1: m1.merchant.id,
          M2: m2.merchant.id,
          M3: m3.merchant.id,
          M1P: m1p.merchant.id,
          M2P: m2p.merchant.id,
          M3P: m3p.merchant.id
        },
        platformProducts: { P1: p1.id, P2: p2.id, P3: p3.id },
        ownProducts: { O1: o1.merchantProductListing.id, O2: o2.merchantProductListing.id, O3: o3.merchantProductListing.id }
      },
      readinessChecks: [
        "GET /api/admin/audit-logs contains action=database.business_fixtures and businessFixturesCreated=true",
        "GET /api/admin/products includes P1/P2/P3 fixture product ids",
        "GET /api/admin/rights-codes?productId=<P1>&status=available returns at least 8",
        "GET /api/merchant/rights-codes?merchantProductListingId=<O1>&status=available returns at least 5",
        "GET /api/merchant/rights-codes?merchantProductListingId=<O3>&status=available returns at least 5",
        "GET /api/admin/payment-methods includes enabled/pending/paused/disabled fixture methods"
      ]
    });
  } finally {
    clearTimeout(overallTimer);
    if (!appClosed) {
      await closeApp(app, "close fixture app after failure").catch((error) => {
        logFixture("fail", "close fixture app after failure", { error: error instanceof Error ? error.message : String(error) });
      });
    }
    await prisma.$disconnect();
  }
}

function assertFixtureEnvironment() {
  requireEnv("DATABASE_URL");
  requireEnv("AUTH_TOKEN_SECRET");
  if (process.env.ALLOW_E2E_BUSINESS_FIXTURES !== "true") {
    throw new Error("ALLOW_E2E_BUSINESS_FIXTURES=true is required");
  }
  if (!["staging", "e2e"].includes(process.env.E2E_FIXTURE_TARGET ?? "")) {
    throw new Error("E2E_FIXTURE_TARGET must be staging or e2e");
  }
  const usesPrismaApiPath = process.env.APP_ENV === "production"
    || process.env.NODE_ENV === "production"
    || process.env.VERCEL_ENV === "production";
  if (!usesPrismaApiPath) {
    throw new Error("APP_ENV=production is required so fixture APIs write to the configured PostgreSQL database");
  }
  if (process.env.VERCEL_ENV === "production") {
    throw new Error("business fixtures are blocked when VERCEL_ENV=production");
  }
  if (process.env.NODE_ENV === "production" && process.env.E2E_FIXTURE_ALLOW_NODE_ENV_PRODUCTION !== "true") {
    throw new Error("business fixtures require E2E_FIXTURE_ALLOW_NODE_ENV_PRODUCTION=true when NODE_ENV=production");
  }
}

async function createRbacSamples(prisma: PrismaClient, password: string) {
  const passwordHash = hashPassword(password);
  await prisma.permission.createMany({
    data: requiredPermissions.map((code) => ({ code, name: code })),
    skipDuplicates: true
  });
  const permissions = await prisma.permission.findMany({
    where: { code: { in: requiredPermissions } },
    select: { id: true, code: true }
  });
  const permissionIds = new Map(permissions.map((permission) => [permission.code, permission.id]));

  const samples = [
    { username: `fixture-admin-${runId}`, displayName: `Fixture Admin ${runId}`, roleCode: "admin", roleName: "Fixture Admin" },
    { username: `fixture-operator-${runId}`, displayName: `Fixture Operator ${runId}`, roleCode: "operator", roleName: "Fixture Operator" },
    { username: `fixture-finance-${runId}`, displayName: `Fixture Finance ${runId}`, roleCode: "finance", roleName: "Fixture Finance" }
  ];

  for (const sample of samples) {
    const [adminUser, role] = await Promise.all([
      prisma.adminUser.upsert({
        where: { username: sample.username },
        update: { passwordHash, displayName: sample.displayName, status: "active" },
        create: { username: sample.username, passwordHash, displayName: sample.displayName, status: "active" }
      }),
      prisma.role.upsert({
        where: { code: sample.roleCode },
        update: { name: sample.roleName },
        create: { code: sample.roleCode, name: sample.roleName }
      })
    ]);
    await prisma.adminUserRole.createMany({
      data: [{ adminUserId: adminUser.id, roleId: role.id }],
      skipDuplicates: true
    });
  }

  const restrictedSamples = [
    { suffix: "no-code-secret", excluded: ["rights_code.secret.read"] },
    { suffix: "no-refund", excluded: ["after_sale.arbitrate"] },
    { suffix: "no-clearing", excluded: ["settlement.generate", "settlement.confirm", "payout.confirm", "settlement.manage"] },
    { suffix: "no-product", excluded: ["product.manage"] }
  ];
  for (const sample of restrictedSamples) {
    const roleCode = `fixture-${sample.suffix}-${runId}`;
    const role = await prisma.role.upsert({
      where: { code: roleCode },
      update: { name: `Fixture ${sample.suffix}` },
      create: { code: roleCode, name: `Fixture ${sample.suffix}` }
    });
    await prisma.rolePermission.createMany({
      data: requiredPermissions
        .filter((code) => !sample.excluded.includes(code))
        .map((code) => ({ roleId: role.id, permissionId: permissionIds.get(code)! })),
      skipDuplicates: true
    });
    const adminUser = await prisma.adminUser.upsert({
      where: { username: `fixture-${sample.suffix}-${runId}` },
      update: { passwordHash, displayName: `Fixture ${sample.suffix}`, status: "active" },
      create: { username: `fixture-${sample.suffix}-${runId}`, passwordHash, displayName: `Fixture ${sample.suffix}`, status: "active" }
    });
    await prisma.adminUserRole.createMany({
      data: [{ adminUserId: adminUser.id, roleId: role.id }],
      skipDuplicates: true
    });
  }
}

async function createManualMerchant(app: FixtureApp, adminHeaders: Record<string, string>, label: string, depositPaid: boolean): Promise<MerchantFixture> {
  const merchant = await injectJson(app, `${label} manual merchant create`, {
    method: "POST",
    url: "/api/admin/merchants/manual",
    headers: adminHeaders,
    payload: {
      name: `${label} Fixture Merchant ${runId}`,
      shopName: `${label} Fixture Shop ${runId}`,
      customerServiceWechat: `${label.toLowerCase()}_service_${runId}`,
      initialPassword: `${label}-${runId}-Pwd`,
      depositRequiredAmountCents: fixtureDepositCents,
      depositPaid: false,
      depositAmountCents: "0"
    }
  });

  if (depositPaid) {
    await confirmDeposit(app, adminHeaders, `${label} deposit confirm`, merchant.merchant.id);
  }

  return { label, merchant: merchant.merchant, shop: merchant.shop, credential: merchant.credential };
}

async function createInvitedMerchant(
  app: FixtureApp,
  adminHeaders: Record<string, string>,
  issuer: MerchantFixture,
  label: string,
  depositPaid: boolean
): Promise<MerchantFixture> {
  if (!issuer.headers) throw new Error(`${issuer.label} must be logged in before creating invites`);
  const invite = await injectJson(app, `${label} invite create`, {
    method: "POST",
    url: "/api/merchant/invite-codes",
    headers: issuer.headers,
    payload: {
      code: code(`FIX-${label}`),
      depositRequiredAmountCents: fixtureDepositCents
    }
  });
  const registered = await injectJson(app, `${label} invite register`, {
    method: "POST",
    url: "/api/merchant/register-by-invite",
    payload: {
      inviteCode: invite.code,
      name: `${label} Fixture Merchant ${runId}`,
      shopName: `${label} Fixture Shop ${runId}`,
      customerServiceWechat: `${label.toLowerCase()}_service_${runId}`
    }
  });
  await injectJson(app, `${label} review approve`, {
    method: "POST",
    url: `/api/admin/merchants/${registered.merchant.id}/review`,
    headers: adminHeaders,
    payload: { approved: true, reason: "controlled business fixture" }
  });
  if (depositPaid) {
    await confirmDeposit(app, adminHeaders, `${label} deposit confirm`, registered.merchant.id);
  }
  const merchant = { label, merchant: registered.merchant, shop: registered.shop, credential: registered.credential };
  await loginMerchant(app, merchant);
  return merchant;
}

async function loginMerchant(app: FixtureApp, merchant: MerchantFixture) {
  const login = await injectJson(app, `${merchant.label} merchant login`, {
    method: "POST",
    url: "/api/auth/merchant/login",
    payload: {
      account: merchant.credential.account,
      password: merchant.credential.initialPassword
    }
  });
  merchant.headers = authHeaders(login.token);
  return login;
}

async function confirmDeposit(app: FixtureApp, adminHeaders: Record<string, string>, label: string, merchantId: string) {
  return injectJson(app, label, {
    method: "POST",
    url: `/api/admin/deposits/${merchantId}/confirm`,
    headers: adminHeaders,
    payload: {
      amountCents: fixtureDepositCents,
      voucherUrl: `fixture://deposit/${runId}/${merchantId}`
    }
  });
}

async function createPlatformProduct(
  app: FixtureApp,
  adminHeaders: Record<string, string>,
  label: string,
  fulfillmentMode: "manual" | "code_pool",
  supplyPriceCents: string,
  minSalePriceCents: string,
  suggestedSalePriceCents: string
) {
  return injectJson(app, `${label} platform product create`, {
    method: "POST",
    url: "/api/admin/products",
    headers: adminHeaders,
    payload: {
      name: `${label} Fixture Platform Product ${runId}`,
      category: "fixture",
      tags: ["fixture", label],
      supplyPriceCents,
      minSalePriceCents,
      suggestedSalePriceCents,
      fulfillmentMode
    }
  });
}

async function ensurePlatformRightsCodes(
  app: FixtureApp,
  adminHeaders: Record<string, string>,
  productId: string,
  label: string,
  requiredAvailableCount: number,
  initialImportCount: number
) {
  await importPlatformRightsCodes(app, adminHeaders, productId, `${label} rights code import >= ${requiredAvailableCount}`, label, initialImportCount, 1);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const available = await withFreshPrismaRetry(`${label} rights code readiness precheck`, (client) => (
      client.rightsCode.count({ where: { productId, status: "available" } })
    ));
    if (available >= requiredAvailableCount) return;
    const missing = requiredAvailableCount - available;
    await importPlatformRightsCodes(
      app,
      adminHeaders,
      productId,
      `${label} rights code top-up ${attempt}`,
      `${label}-TOPUP-${attempt}`,
      missing + 2,
      initialImportCount + (attempt * 100)
    );
  }
  const finalAvailable = await withFreshPrismaRetry(`${label} rights code final precheck`, (client) => (
    client.rightsCode.count({ where: { productId, status: "available" } })
  ));
  if (finalAvailable < requiredAvailableCount) {
    throw new Error(`${label} rights code fixture expected at least ${requiredAvailableCount} available codes, got ${finalAvailable}`);
  }
}

async function importPlatformRightsCodes(
  app: FixtureApp,
  adminHeaders: Record<string, string>,
  productId: string,
  stepLabel: string,
  codePrefix: string,
  count: number,
  startIndex: number
) {
  await injectJson(app, stepLabel, {
    method: "POST",
    url: "/api/admin/rights-codes/import",
    headers: adminHeaders,
    payload: {
      productId,
      batchNo: `${codePrefix}-${runId}`,
      codes: Array.from({ length: count }, (_unused, index) => `${codePrefix}-${runId}-${String(startIndex + index).padStart(3, "0")}`)
    }
  });
}

async function createOwnProduct(
  app: FixtureApp,
  adminHeaders: Record<string, string>,
  merchant: MerchantFixture,
  label: string,
  fulfillmentMode: "manual" | "code_pool",
  salePriceCents: string,
  rightsCodeCount: number
) {
  if (!merchant.headers) throw new Error(`${merchant.label} must be logged in before creating own products`);
  const review = await injectJson(app, `${merchant.label}/${label} own product submit`, {
    method: "POST",
    url: "/api/merchant/products/own",
    headers: merchant.headers,
    payload: {
      name: `${merchant.label} ${label} Fixture Own Product ${runId}`,
      salePriceCents,
      minSalePriceCents: "1000",
      fulfillmentMode
    }
  });
  const approved = await injectJson(app, `${merchant.label}/${label} own product review`, {
    method: "POST",
    url: `/api/admin/merchant-products/reviews/${review.id}/review`,
    headers: adminHeaders,
    payload: { approved: true, reason: "controlled business fixture" }
  });
  if (rightsCodeCount > 0) {
    await injectJson(app, `${merchant.label}/${label} own rights code import`, {
      method: "POST",
      url: "/api/merchant/rights-codes/import",
      headers: merchant.headers,
      payload: {
        merchantProductListingId: approved.merchantProductListing.id,
        batchNo: `${merchant.label}-${label}-${runId}`,
        codes: Array.from({ length: rightsCodeCount }, (_unused, index) => `${merchant.label}-${label}-${runId}-${String(index + 1).padStart(3, "0")}`)
      }
    });
  }
  return approved;
}

async function createPaymentMethodStates(
  app: FixtureApp,
  prisma: PrismaClient,
  merchant: MerchantFixture
) {
  if (!merchant.headers) throw new Error(`${merchant.label} must be logged in before creating payment methods`);
  const states = [
    { suffix: "active", status: "enabled", enabled: true },
    { suffix: "pending", status: "pending_test", enabled: false },
    { suffix: "rejected", status: "paused", enabled: false },
    { suffix: "disabled", status: "disabled", enabled: false }
  ];

  for (const state of states) {
    const method = await injectJson(app, `${merchant.label} payment method ${state.suffix} upsert`, {
      method: "POST",
      url: "/api/merchant/payment-methods",
      headers: merchant.headers,
      payload: {
        provider: "personal_alipay",
        displayName: `${merchant.label} ${state.suffix} ${runId}`,
        accountName: `${merchant.label} Payee ${runId}`,
        qrUrl: `https://example.test/fixtures/${runId}/${merchant.label}-${state.suffix}.png`,
        isDefault: state.suffix === "active",
        enabled: state.enabled,
        status: state.status
      }
    });
    if (state.suffix === "disabled") {
      await prisma.collectionPaymentConfig.update({
        where: { id: method.id },
        data: {
          status: "disabled",
          isDefault: false,
          instruction: "controlled business fixture disabled state"
        }
      });
    }
  }
}

async function createCouponFixtures(app: FixtureApp, prisma: PrismaClient, adminHeaders: Record<string, string>, platformProductId: string) {
  const firstRegistration = await injectJson(app, "coupon first-registration fixture", {
    method: "POST",
    url: "/api/admin/coupons",
    headers: adminHeaders,
    payload: {
      name: `Fixture First Register ${runId}`,
      discountCents: "100",
      validDays: 7,
      grantOnFirstRegister: true,
      status: "active"
    }
  });
  const scoped = await injectJson(app, "coupon scoped fixture", {
    method: "POST",
    url: "/api/admin/coupons",
    headers: adminHeaders,
    payload: {
      name: `Fixture Scoped ${runId}`,
      discountCents: "150",
      productIds: [platformProductId],
      validDays: 14,
      status: "active"
    }
  });
  const expired = await injectJson(app, "coupon expired fixture create", {
    method: "POST",
    url: "/api/admin/coupons",
    headers: adminHeaders,
    payload: {
      name: `Fixture Expired ${runId}`,
      discountCents: "120",
      validDays: 1,
      status: "active"
    }
  });
  const notYetValid = await injectJson(app, "coupon future fixture create", {
    method: "POST",
    url: "/api/admin/coupons",
    headers: adminHeaders,
    payload: {
      name: `Fixture Future ${runId}`,
      discountCents: "130",
      validDays: 7,
      status: "active"
    }
  });
  const inactive = await injectJson(app, "coupon inactive fixture", {
    method: "POST",
    url: "/api/admin/coupons",
    headers: adminHeaders,
    payload: {
      name: `Fixture Inactive ${runId}`,
      discountCents: "140",
      validDays: 7,
      status: "inactive"
    }
  });
  const oversized = await injectJson(app, "coupon oversized fixture", {
    method: "POST",
    url: "/api/admin/coupons",
    headers: adminHeaders,
    payload: {
      name: `Fixture Oversized ${runId}`,
      discountCents: "999999",
      validDays: 7,
      status: "active"
    }
  });
  const registered = await injectJson(app, "coupon registered user fixture", {
    method: "POST",
    url: "/api/auth/h5/register",
    payload: {
      phone: fixturePhone("166"),
      displayName: `Fixture Coupon User ${runId}`
    }
  });
  const noCouponUser = await injectJson(app, "no coupon registered user fixture", {
    method: "POST",
    url: "/api/auth/h5/register",
    payload: {
      phone: fixturePhone("177"),
      displayName: `Fixture No Coupon User ${runId}`
    }
  });

  const now = new Date();
  await prisma.couponTemplate.update({
    where: { id: expired.id },
    data: {
      validFrom: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
      validTo: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    }
  });
  await prisma.couponTemplate.update({
    where: { id: notYetValid.id },
    data: {
      validFrom: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      validTo: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
    }
  });

  return {
    firstRegistration: firstRegistration.id,
    scoped: scoped.id,
    expired: expired.id,
    notYetValid: notYetValid.id,
    inactive: inactive.id,
    oversized: oversized.id,
    registeredUser: registered.user?.userId,
    registeredUserCoupon: registered.grantedCoupon?.id,
    noCouponUser: noCouponUser.user?.userId
  };
}

function fixturePhone(prefix: string) {
  const digits = createHash("sha256").update(`${prefix}:${runId}`).digest("hex").replace(/\D/g, "").padEnd(8, "0").slice(0, 8);
  return `${prefix}${digits}`;
}

async function writeFixtureMarker(prisma: PrismaClient, summary: Record<string, unknown>) {
  const now = new Date();
  const afterJson = {
    businessFixturesCreated: true,
    fixtureTarget: process.env.E2E_FIXTURE_TARGET,
    createdAt: now.toISOString(),
    ...summary
  };

  await prisma.auditLog.upsert({
    where: { idempotencyKey: runMarkerKey },
    update: { afterJson },
    create: {
      actorType: "system",
      actorId: "business-fixture",
      action: "database.business_fixtures",
      targetType: "system_config",
      targetId: "business-fixtures",
      afterJson,
      idempotencyKey: runMarkerKey,
      requestId: `business-fixture:${runId}`
    }
  });
  await prisma.auditLog.upsert({
    where: { idempotencyKey: latestMarkerKey },
    update: { afterJson, requestId: `business-fixture:${runId}` },
    create: {
      actorType: "system",
      actorId: "business-fixture",
      action: "database.business_fixtures",
      targetType: "system_config",
      targetId: "business-fixtures-latest",
      afterJson,
      idempotencyKey: latestMarkerKey,
      requestId: `business-fixture:${runId}`
    }
  });

  const setup = await prisma.auditLog.findUnique({
    where: { idempotencyKey: "e2e-setup:admin-rbac-payment-config" },
    select: { afterJson: true }
  });
  const setupAfter = setup?.afterJson && typeof setup.afterJson === "object" && !Array.isArray(setup.afterJson)
    ? { ...(setup.afterJson as Record<string, unknown>) }
    : {};
  await prisma.auditLog.updateMany({
    where: { idempotencyKey: "e2e-setup:admin-rbac-payment-config" },
    data: {
      afterJson: {
        ...setupAfter,
        businessFixturesCreated: true,
        businessFixturesRunId: runId,
        businessFixturesMarker: latestMarkerKey
      }
    }
  });
}

async function repairExistingFixtureMerchantRelations(prisma: PrismaClient, rawSummary: unknown) {
  void prisma;
  void rawSummary;
  logFixture("pass", "business fixture merchant relation repair skipped", {
    reason: "merchants-only schema no longer persists legacy relation tables"
  });
}

async function verifyFixtureReadiness(prisma: PrismaClient, rawSummary: unknown) {
  const summary = rawSummary && typeof rawSummary === "object" && !Array.isArray(rawSummary)
    ? rawSummary as Record<string, any>
    : {};
  const merchants = summary.merchants ?? {};
  const platformProducts = summary.platformProducts ?? {};
  const ownProducts = summary.ownProducts ?? {};
  const coupons = summary.coupons ?? {};
  const merchantIds = Object.values(merchants).filter((value): value is string => typeof value === "string");
  const ownProductIds = Object.values(ownProducts).filter((value): value is string => typeof value === "string");
  const couponIds = Object.values(coupons).filter((value): value is string => typeof value === "string");
  const platformProductIds = Object.values(platformProducts).filter((value): value is string => typeof value === "string");
  const registeredUserIds = [coupons.registeredUser].filter((value): value is string => typeof value === "string");
  const restrictedRoleCodes = ["no-code-secret", "no-refund", "no-clearing", "no-product"].map((suffix) => `fixture-${suffix}-${runId}`);

  const merchantCount = await countRowsByIds(prisma, "merchants", "id", merchantIds);
  const paidDeposits = await countRowsByIds(prisma, "deposit_accounts", "merchant_id", merchantIds, Prisma.sql`status = 'paid'`);
  const pendingDeposits = await countRowsByIds(prisma, "deposit_accounts", "merchant_id", merchantIds, Prisma.sql`status = 'pending_payment'`);
  const platformProductCount = await prisma.platformProduct.count({ where: { id: { in: platformProductIds } } });
  const ownProductCount = await countRowsByIds(prisma, "merchant_products", "id", ownProductIds, Prisma.sql`product_type = 'merchant_owned'`);
  const p1RightsCodes = typeof platformProducts.P1 === "string"
    ? await prisma.rightsCode.count({ where: { productId: platformProducts.P1, status: "available" } })
    : 0;
  const p3RightsCodes = typeof platformProducts.P3 === "string"
    ? await prisma.rightsCode.count({ where: { productId: platformProducts.P3, status: "available" } })
    : 0;
  const o1RightsCodes = typeof ownProducts.O1 === "string"
    ? await prisma.rightsCode.count({ where: { merchantProductListingId: ownProducts.O1, status: "available" } })
    : 0;
  const o3RightsCodes = typeof ownProducts.O3 === "string"
    ? await prisma.rightsCode.count({ where: { merchantProductListingId: ownProducts.O3, status: "available" } })
    : 0;
  const activeChannels = await countCollectionPaymentConfigs(prisma, "active");
  const pendingChannels = await countCollectionPaymentConfigs(prisma, "pending_test");
  const rejectedChannels = await countCollectionPaymentConfigs(prisma, "paused");
  const disabledChannels = await countCollectionPaymentConfigs(prisma, "disabled");
  const couponTemplateCount = await prisma.couponTemplate.count({ where: { id: { in: couponIds } } });
  const userCouponCount = await prisma.userCoupon.count({ where: { userId: { in: registeredUserIds } } });
  const rbacRestrictedRoles = await prisma.role.count({ where: { code: { in: restrictedRoleCodes } } });
  const readiness = {
    merchants: merchantCount,
    deposits: { paid: paidDeposits, pending: pendingDeposits },
    products: { platform: platformProductCount, own: ownProductCount },
    rightsCodes: { P1: p1RightsCodes, P3: p3RightsCodes, O1: o1RightsCodes, O3: o3RightsCodes },
    paymentMethods: { active: activeChannels, pending: pendingChannels, rejected: rejectedChannels, disabled: disabledChannels },
    coupons: { templates: couponTemplateCount, userCoupons: userCouponCount },
    rbacRestrictedRoles
  };
  const failures = [
    merchantCount >= 6,
    paidDeposits >= 3,
    pendingDeposits >= 3,
    platformProductCount >= 3,
    ownProductCount >= 3,
    p1RightsCodes >= 8,
    p3RightsCodes >= 1,
    o1RightsCodes >= 5,
    o3RightsCodes >= 5,
    activeChannels >= 3,
    pendingChannels >= 1,
    rejectedChannels >= 1,
    disabledChannels >= 1,
    couponTemplateCount >= 6,
    userCouponCount >= 1,
    rbacRestrictedRoles >= 4
  ].filter((passed) => !passed);
  if (failures.length > 0) {
    throw new Error(`business fixture readiness check failed: ${JSON.stringify(readiness)}`);
  }
  return readiness;
}

async function countRowsByIds(
  prisma: PrismaClient,
  tableName: string,
  columnName: string,
  ids: string[],
  extraWhere?: Prisma.Sql
) {
  if (ids.length === 0) return 0;
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count
      FROM ${Prisma.raw(tableName)}
     WHERE ${Prisma.raw(columnName)} IN (${Prisma.join(ids)})
       ${extraWhere ? Prisma.sql`AND ${extraWhere}` : Prisma.empty}
  `);
  return Number(rows[0]?.count ?? 0n);
}

async function countCollectionPaymentConfigs(prisma: PrismaClient, status: "active" | "pending_test" | "paused" | "disabled") {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count
      FROM collection_payment_configs
     WHERE account_masked LIKE ${`%${runId}%`}
       AND status = ${status}
  `);
  return Number(rows[0]?.count ?? 0n);
}

async function closeApp(app: FixtureApp, label: string) {
  logFixture("start", label, { timeoutMs: STEP_TIMEOUT_MS });
  const startedAt = Date.now();
  try {
    await withTimeout(label, "app.close()", STEP_TIMEOUT_MS, () => app.close());
    logFixture("pass", label, { durationMs: Date.now() - startedAt });
  } catch (error) {
    logFixture("fail", label, {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

main().catch((error) => {
  logFixture("fail", "business fixture", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

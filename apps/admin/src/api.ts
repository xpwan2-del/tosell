const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? "http://localhost:3000" : "");

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

type AdminRole = "operator" | "finance" | "admin";

export type JsonRecord = Record<string, unknown>;
export type AdminSession = {
  token: string;
  expiresAt: number;
  admin: JsonRecord;
};
export type MerchantSession = {
  token: string;
  expiresAt: number;
  merchant: JsonRecord;
  shop: JsonRecord;
};
export type PaymentMethodInput = {
  id?: string;
  provider: string;
  displayName: string;
  productType?: string;
  merchantNo?: string;
  appId?: string;
  serviceProviderId?: string;
  gatewayUrl?: string;
  apiMode?: "mapi_first" | "submit" | "hupijiao_direct";
  accountName?: string;
  qrUrl?: string;
  paymentUrl?: string;
  note?: string;
  returnUrl?: string;
  enabled?: boolean;
  status?: string;
  isDefault?: boolean;
  signingSecret?: string;
  privateKey?: string;
  publicKey?: string;
  certificate?: string;
};
export type PaymentQueryInput = {
  providerTradeNo: string;
  amountCents: string;
  merchantNo?: string;
  appId?: string;
  serviceProviderId?: string;
  tradeStatus: string;
  signature: string;
};

export type MerchantListingDisplayInput = {
  salePriceCents: string;
  status?: string;
  displayName?: string;
  displaySubtitle?: string;
  displayDescription?: string;
  displayUsageGuide?: string;
  displayImageUrl?: string;
  displayCategory?: string;
  displayTags?: string;
  displaySpecs?: string;
  displayDetailSections?: string;
};

export type ProductImageUploadInput = {
  filename?: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  dataBase64: string;
};

export class ApiClientError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...options.headers
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? 25_000);
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiClientError(408, "REQUEST_TIMEOUT", "请求超时，请检查网络或稍后重试");
    }
    if (error instanceof TypeError) {
      throw new ApiClientError(0, "NETWORK_ERROR", "无法连接 API，或本次保存内容过大。请刷新页面后重试；如果刚保存过图片，请确认 API 服务已重启。");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.message === "string" ? data.message : `HTTP ${response.status}`;
    const code = typeof data.code === "string" ? data.code : "HTTP_ERROR";
    throw new ApiClientError(response.status, code, message);
  }
  return data as T;
}

function adminHeaders(): Record<string, string> {
  const session = currentAdminSession();
  return session?.token ? { authorization: `Bearer ${session.token}` } : {};
}

function merchantHeaders(): Record<string, string> {
  const session = currentMerchantSession();
  if (session?.token) return { authorization: `Bearer ${session.token}` };
  return {};
}

function buyerHeaders(): Record<string, string> {
  if (!import.meta.env.DEV || import.meta.env.VITE_ALLOW_DEMO_BUYER_HEADERS !== "true") {
    return {};
  }
  return { "x-user-id": runtimeValue("tosell_buyer_id", "VITE_BUYER_ID") };
}

function requireText(value: string | undefined, fieldName: string): string {
  const text = value?.trim();
  if (!text) throw new ApiClientError(400, "CLIENT_INPUT_REQUIRED", `${fieldName} 必填`);
  return text;
}

function requireNonNegativeInteger(value: string | undefined, fieldName: string): number {
  const text = requireText(value, fieldName);
  if (!/^\d+$/.test(text)) throw new ApiClientError(400, "CLIENT_INPUT_INVALID", `${fieldName} 必须是非负整数`);
  return Number(text);
}

function requirePositiveIntegerString(value: string | undefined, fieldName: string): string {
  const text = requireText(value, fieldName);
  if (!/^[1-9]\d*$/.test(text)) throw new ApiClientError(400, "CLIENT_INPUT_INVALID", `${fieldName} 必须是正整数`);
  return text;
}

function requirePositiveCents(value: string | undefined, fieldName: string): string {
  const text = requireText(value, fieldName);
  if (!/^[1-9]\d*$/.test(text)) throw new ApiClientError(400, "CLIENT_INPUT_INVALID", `${fieldName} 必须是正整数分`);
  return text;
}

function requireNonNegativeCents(value: string | undefined, fieldName: string): string {
  const text = requireText(value, fieldName);
  if (!/^\d+$/.test(text)) throw new ApiClientError(400, "CLIENT_INPUT_INVALID", `${fieldName} 必须是非负整数分`);
  return text;
}

function requireSnapshotCents(value: unknown, fieldName: string): string {
  if (typeof value === "string") return requirePositiveCents(value, fieldName);
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === "bigint" && value > 0n) return String(value);
  throw new ApiClientError(400, "CLIENT_INPUT_REQUIRED", `${fieldName} 缺失或非法`);
}

function paymentMethodPayload(input: PaymentMethodInput): JsonRecord {
  return {
    provider: requireText(input.provider, "收款方式"),
    displayName: requireText(input.displayName, "展示名称"),
    productType: input.productType || undefined,
    merchantNo: unmaskedOrUndefined(input.merchantNo),
    appId: unmaskedOrUndefined(input.appId),
    serviceProviderId: unmaskedOrUndefined(input.serviceProviderId),
    gatewayUrl: input.gatewayUrl || undefined,
    apiMode: input.apiMode || undefined,
    accountName: input.accountName || undefined,
    qrUrl: input.qrUrl || undefined,
    paymentUrl: input.paymentUrl || undefined,
    note: input.note || undefined,
    returnUrl: input.returnUrl || undefined,
    enabled: input.enabled,
    status: input.status || undefined,
    isDefault: input.isDefault,
    signingSecret: input.signingSecret || undefined,
    privateKey: input.privateKey || undefined,
    publicKey: input.publicKey || undefined,
    certificate: input.certificate || undefined
  };
}

function unmaskedOrUndefined(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.includes("***")) return undefined;
  return trimmed;
}

export const api = {
  baseUrl: API_BASE_URL || "同源 /api",
  assetUrl: (value: unknown) => {
    const raw = text(value, "");
    if (!raw) return "";
    if (raw.startsWith("/uploads/") && API_BASE_URL) return `${API_BASE_URL}${raw}`;
    return raw;
  },
  currentAdminSession,
  saveAdminSession,
  clearAdminSession,
  currentMerchantSession,
  saveMerchantSession,
  clearMerchantSession,
  adminLogin: (input: { username: string; password: string; requestedRole?: AdminRole }) => request<AdminSession>("/api/auth/admin/login", {
    method: "POST",
    body: input
  }),
  adminSession: () => request<JsonRecord>("/api/auth/admin/session", {
    headers: adminHeaders()
  }),
  merchantLogin: (input: { account: string; password: string }) => request<MerchantSession>("/api/auth/merchant/login", {
    method: "POST",
    body: input
  }),
  merchantSession: () => request<JsonRecord>("/api/auth/merchant/session", {
    headers: merchantHeaders()
  }),
  health: () => request<JsonRecord>("/api/health"),
  reconciliationSummary: () => request<JsonRecord>("/api/exports/reconciliation-summary", {
    headers: adminHeaders()
  }),
  merchantDashboard: () => request<JsonRecord>("/api/merchant/dashboard", {
    headers: merchantHeaders()
  }),
  riskDashboard: () => request<JsonRecord>("/api/admin/risk-dashboard", {
    headers: adminHeaders()
  }),
  salesDashboard: () => request<JsonRecord>("/api/admin/sales-dashboard", {
    headers: adminHeaders()
  }),
  paymentGuide: () => request<JsonRecord>("/api/admin/payment-onboarding-guide", {
    headers: adminHeaders()
  }),
  platformServiceFee: () => request<JsonRecord>("/api/admin/platform-service-fee", {
    headers: adminHeaders()
  }),
  updatePlatformServiceFee: (input: { enabled: boolean; feeBps: string }) => request<JsonRecord>("/api/admin/platform-service-fee", {
    method: "PATCH",
    headers: adminHeaders(),
    body: {
      enabled: input.enabled,
      feeBps: requireNonNegativeInteger(input.feeBps, "平台服务费比例")
    }
  }),
  wallets: () => request<JsonRecord[]>("/api/admin/wallets", {
    headers: adminHeaders()
  }),
  walletRecharges: () => request<JsonRecord[]>("/api/admin/wallet-recharges", {
    headers: adminHeaders()
  }),
  walletTransactions: () => request<JsonRecord[]>("/api/admin/wallet-transactions", {
    headers: adminHeaders()
  }),
  confirmWalletRecharge: (rechargeNo: string, note?: string) => request<JsonRecord>(`/api/admin/wallet-recharges/${encodeURIComponent(requireText(rechargeNo, "充值单号"))}/confirm`, {
    method: "POST",
    headers: adminHeaders(),
    body: { note: note || "后台确认充值到账" }
  }),
  adminPaymentMethods: () => request<JsonRecord[]>("/api/admin/payment-methods", {
    headers: adminHeaders()
  }),
  merchantPaymentMethods: () => request<JsonRecord[]>("/api/merchant/payment-methods", {
    headers: merchantHeaders()
  }),
  saveAdminPaymentMethod: (input: PaymentMethodInput) => request<JsonRecord>(input.id ? `/api/admin/payment-methods/${encodeURIComponent(input.id)}` : "/api/admin/payment-methods", {
    method: input.id ? "PATCH" : "POST",
    headers: adminHeaders(),
    body: paymentMethodPayload(input)
  }),
  saveMerchantPaymentMethod: (input: PaymentMethodInput) => request<JsonRecord>(input.id ? `/api/merchant/payment-methods/${encodeURIComponent(input.id)}` : "/api/merchant/payment-methods", {
    method: input.id ? "PATCH" : "POST",
    headers: merchantHeaders(),
    body: paymentMethodPayload(input)
  }),
  disableAdminPaymentMethod: (methodId: string) => request<JsonRecord>(`/api/admin/payment-methods/${encodeURIComponent(requireText(methodId, "收款方式"))}`, {
    method: "DELETE",
    headers: adminHeaders()
  }),
  disableMerchantPaymentMethod: (methodId: string) => request<JsonRecord>(`/api/merchant/payment-methods/${encodeURIComponent(requireText(methodId, "收款方式"))}`, {
    method: "DELETE",
    headers: merchantHeaders()
  }),
  setAdminPaymentMethodDefault: (methodId: string) => request<JsonRecord>(`/api/admin/payment-methods/${encodeURIComponent(requireText(methodId, "收款方式"))}/default`, {
    method: "POST",
    headers: adminHeaders()
  }),
  setMerchantPaymentMethodDefault: (methodId: string) => request<JsonRecord>(`/api/merchant/payment-methods/${encodeURIComponent(requireText(methodId, "收款方式"))}/default`, {
    method: "POST",
    headers: merchantHeaders()
  }),
  testAdminPaymentMethod: (methodId: string) => request<JsonRecord>(`/api/admin/payment-methods/${encodeURIComponent(requireText(methodId, "收款方式"))}/test`, {
    method: "POST",
    headers: adminHeaders()
  }),
  testMerchantPaymentMethod: (methodId: string) => request<JsonRecord>(`/api/merchant/payment-methods/${encodeURIComponent(requireText(methodId, "收款方式"))}/test`, {
    method: "POST",
    headers: merchantHeaders()
  }),
  paymentCallbacks: () => request<JsonRecord[]>("/api/admin/payment-callbacks", {
    headers: adminHeaders()
  }),
  paymentExceptions: () => request<JsonRecord[]>("/api/admin/payment-exceptions", {
    headers: adminHeaders()
  }),
  handlePaymentException: (exceptionId: string, input: { action: "mark_handled" | "keep_exception"; note?: string }) => request<JsonRecord>(`/api/admin/payment-exceptions/${encodeURIComponent(requireText(exceptionId, "异常记录"))}/handle`, {
    method: "POST",
    headers: adminHeaders(),
    body: { action: input.action, note: input.note || undefined }
  }),
  queryOrderPayment: (orderNo: string, input: PaymentQueryInput) => request<JsonRecord>(`/api/admin/orders/${encodeURIComponent(requireText(orderNo, "订单号"))}/payment-query`, {
    method: "POST",
    headers: adminHeaders(),
    body: {
      providerTradeNo: requireText(input.providerTradeNo, "渠道交易号"),
      amountCents: requirePositiveCents(input.amountCents, "查单金额"),
      merchantNo: input.merchantNo || undefined,
      appId: input.appId || undefined,
      serviceProviderId: input.serviceProviderId || undefined,
      tradeStatus: input.tradeStatus || "TRADE_SUCCESS",
      signature: requireText(input.signature, "签名")
    }
  }),
  paymentVouchers: () => request<JsonRecord[]>("/api/admin/payment-vouchers", {
    headers: adminHeaders()
  }),
  merchantPaymentVouchers: () => request<JsonRecord[]>("/api/merchant/payment-vouchers", {
    headers: merchantHeaders()
  }),
  reviewPaymentVoucher: (voucherId: string, approved: boolean, reason: string) => request<JsonRecord>(`/api/admin/payment-vouchers/${encodeURIComponent(voucherId)}/review`, {
    method: "POST",
    headers: adminHeaders(),
    body: { approved, reason: reason || undefined }
  }),
  adminOrders: () => request<JsonRecord[]>("/api/admin/orders", {
    headers: adminHeaders()
  }),
  merchantApplications: () => request<JsonRecord[]>("/api/admin/merchant-applications", {
    headers: adminHeaders()
  }),
  inviteCodes: () => request<JsonRecord[]>("/api/admin/invite-codes", {
    headers: adminHeaders()
  }),
  merchantInviteCodes: () => request<JsonRecord[]>("/api/merchant/invite-codes", {
    headers: merchantHeaders()
  }),
  createInviteCode: (input: { code: string; targetTier: string; maxUses: string; expiresAt: string; depositRequiredAmountCents: string }) => request<JsonRecord>("/api/admin/invite-codes", {
    method: "POST",
    headers: adminHeaders(),
    body: {
      code: input.code || undefined,
      targetTier: input.targetTier || "first_tier",
      maxUses: input.maxUses ? Number(requirePositiveIntegerString(input.maxUses, "最大使用次数")) : undefined,
      expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : undefined,
      depositRequiredAmountCents: requirePositiveCents(input.depositRequiredAmountCents, "应缴保证金金额")
    }
  }),
  createMerchantInviteCode: (input: { code: string; maxUses: string; expiresAt: string; depositRequiredAmountCents: string }) => request<JsonRecord>("/api/merchant/invite-codes", {
    method: "POST",
    headers: merchantHeaders(),
    body: {
      code: input.code || undefined,
      maxUses: input.maxUses ? Number(requirePositiveIntegerString(input.maxUses, "最大使用次数")) : undefined,
      expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : undefined,
      depositRequiredAmountCents: input.depositRequiredAmountCents ? requirePositiveCents(input.depositRequiredAmountCents, "应缴保证金金额") : undefined
    }
  }),
  createManualMerchant: (input: { name: string; shopName: string; contactPhone: string; customerServiceWechat: string; initialPassword: string; depositRequiredAmountCents: string; depositPaid: boolean }) => request<JsonRecord>("/api/admin/merchants/manual", {
    method: "POST",
    headers: adminHeaders(),
    body: {
      name: input.name,
      shopName: input.shopName,
      contactPhone: input.contactPhone,
      customerServiceWechat: input.customerServiceWechat,
      initialPassword: input.initialPassword || undefined,
      targetTier: "first_tier",
      depositRequiredAmountCents: requirePositiveCents(input.depositRequiredAmountCents, "应缴保证金金额"),
      depositPaid: input.depositPaid
    }
  }),
  adminAfterSales: () => request<JsonRecord[]>("/api/admin/after-sales", {
    headers: adminHeaders()
  }),
  adminRefunds: () => request<JsonRecord[]>("/api/admin/refunds", {
    headers: adminHeaders()
  }),
  adminSettlements: () => request<JsonRecord[]>("/api/admin/settlements", {
    headers: adminHeaders()
  }),
  adminDeposits: () => request<JsonRecord[]>("/api/admin/deposits", {
    headers: adminHeaders()
  }),
  adminChannels: () => request<JsonRecord>("/api/admin/merchant-supply", {
    headers: adminHeaders()
  }),
  createChannelRelation: (input: { firstTierMerchantId: string; secondTierMerchantId: string; thirdTierMerchantId?: string }) => request<JsonRecord>("/api/admin/merchant-supply/relations", {
    method: "POST",
    headers: adminHeaders(),
    body: {
      firstTierMerchantId: requireText(input.firstTierMerchantId, "一级商户ID"),
      secondTierMerchantId: requireText(input.secondTierMerchantId, "二级商户ID"),
      thirdTierMerchantId: input.thirdTierMerchantId?.trim() || undefined,
      reason: input.thirdTierMerchantId?.trim() ? "受控三级供货关系" : "受控二级供货关系"
    }
  }),
  upsertChannelOffer: (channelRelationId: string, platformProductId: string, resellSupplyPriceCents: string) => request<JsonRecord>("/api/admin/merchant-supply/offers", {
    method: "POST",
    headers: adminHeaders(),
    body: { channelRelationId, platformProductId, resellSupplyPriceCents: requirePositiveCents(resellSupplyPriceCents, "转供价") }
  }),
  reviewChannel: (merchantId: string) => request<JsonRecord>(`/api/admin/merchant-supply/${merchantId}/review`, {
    method: "POST",
    headers: adminHeaders(),
    body: { approved: true, reason: "开通受控二级供货能力" }
  }),
  serviceQrCodes: () => request<JsonRecord[]>("/api/admin/service-qrcodes", {
    headers: adminHeaders()
  }),
  riskFreezes: () => request<JsonRecord[]>("/api/admin/risk-freezes", {
    headers: adminHeaders()
  }),
  auditLogs: () => request<JsonRecord[]>("/api/admin/audit-logs", {
    headers: adminHeaders()
  }),
  ledgerEntries: () => request<JsonRecord[]>("/api/admin/ledger-entries", {
    headers: adminHeaders()
  }),
  reviewMerchant: (merchantId: string, approved: boolean, reason?: string) => request<JsonRecord>(`/api/admin/merchants/${merchantId}/review`, {
    method: "POST",
    headers: adminHeaders(),
    body: { approved, reason }
  }),
  confirmDeposit: (merchantId: string, amountCents: string, requiredAmountCents?: string) => request<JsonRecord>(`/api/admin/deposits/${merchantId}/confirm`, {
    method: "POST",
    headers: adminHeaders(),
    body: {
      amountCents: requirePositiveCents(amountCents, "确认保证金金额"),
      requiredAmountCents: requiredAmountCents ? requirePositiveCents(requiredAmountCents, "应缴保证金金额") : undefined,
      voucherUrl: `manual://deposit/${merchantId}/${Date.now()}`
    }
  }),
  createPlatformProduct: (input: { name: string; category?: string; tags?: string; subtitle?: string; description?: string; usageGuide?: string; imageUrl?: string; specs?: string; detailSections?: string; stockCount: string; soldCount?: string; fulfillmentMode: string; credentialType?: string; supplyPriceCents: string; minSalePriceCents: string; suggestedSalePriceCents: string }) => {
    const stockCount = requireNonNegativeInteger(input.stockCount, "库存");
    const soldCount = input.soldCount ? requireNonNegativeInteger(input.soldCount, "销量") : undefined;
    const supplyPriceCents = requirePositiveCents(input.supplyPriceCents, "供货价");
    const minSalePriceCents = requirePositiveCents(input.minSalePriceCents, "最低售价");
    const suggestedSalePriceCents = requirePositiveCents(input.suggestedSalePriceCents, "建议售价");
    return request<JsonRecord>("/api/admin/products", {
      method: "POST",
      headers: adminHeaders(),
      body: {
        name: requireText(input.name, "商品名称"),
        category: input.category || undefined,
        tags: input.tags ? input.tags.split(/,|，/).map((item) => item.trim()).filter(Boolean) : undefined,
        subtitle: input.subtitle,
        description: input.description,
        usageGuide: input.usageGuide,
        imageUrl: input.imageUrl,
        specs: splitLines(input.specs),
        detailSections: parseDetailSections(input.detailSections),
        stockCount,
        soldCount,
        fulfillmentMode: input.fulfillmentMode,
        credentialType: input.fulfillmentMode === "code_pool" ? input.credentialType || "code" : undefined,
        supplyPriceCents,
        minSalePriceCents,
        suggestedSalePriceCents
      }
    });
  },
  fulfillOrder: (orderNo: string, attemptNo: number) => request<JsonRecord>(`/api/admin/fulfillment/${orderNo}`, {
    method: "POST",
    headers: adminHeaders(),
    body: { status: "success", evidence: `manual-evidence-${attemptNo}`, attemptNo }
  }),
  confirmOfflinePayment: (orderNo: string, amountCents: string) => request<JsonRecord>(`/api/admin/orders/${orderNo}/offline-payment`, {
    method: "POST",
    headers: adminHeaders(),
    body: {
      amountCents: requirePositiveCents(amountCents, "确认收款金额"),
      voucherUrl: `manual://offline-payment/${orderNo}/${Date.now()}`,
      note: "后台人工确认收款"
    }
  }),
  confirmMerchantPayment: (orderNo: string, amountCents: string) => request<JsonRecord>(`/api/merchant/orders/${orderNo}/confirm-payment`, {
    method: "POST",
    headers: merchantHeaders(),
    body: {
      amountCents: requirePositiveCents(amountCents, "确认收款金额"),
      voucherUrl: `manual://merchant-offline-payment/${orderNo}/${Date.now()}`,
      note: "商户后台人工确认收款"
    }
  }),
  allocateRefund: (order: JsonRecord, refundAmountCents: string, responsibility: "platform" | "merchant" | "user" | "mixed") => {
    const snapshot = order.snapshot as JsonRecord | undefined;
    const amount = snapshot?.amountSnapshot as JsonRecord | undefined;
    const refundCents = requirePositiveCents(refundAmountCents, "退款金额");
    const split = mixedSplit(refundCents);
    return request<JsonRecord>("/api/admin/refunds/allocate", {
      method: "POST",
      headers: adminHeaders(),
      body: {
        paidAmountCents: requireSnapshotCents(amount?.paidAmountCents, "订单实付金额快照"),
        supplyAmountCents: requireSnapshotCents(amount?.supplyAmountCents, "订单供货金额快照"),
        merchantIncomeCents: requireSnapshotCents(amount?.merchantExpectedIncomeCents ?? amount?.merchantExpectedIncomeCents, "商户收入金额快照"),
        refundAmountCents: refundCents,
        responsibility: responsibility,
        platformBearCents: responsibility === "mixed" ? split.platformBearCents : undefined,
        merchantBearCents: responsibility === "mixed" ? split.merchantBearCents : undefined
      }
    });
  },
  generateSettlement: (merchantId: string) => request<JsonRecord>("/api/admin/settlements/generate", {
    method: "POST",
    headers: adminHeaders(),
    body: { merchantId, now: "2030-01-01T00:00:00.000Z", batchNo: `ui-${Date.now()}` }
  }),
  confirmPayout: (settlementNo: string) => request<JsonRecord>(`/api/admin/settlements/${settlementNo}/payouts`, {
    method: "POST",
    headers: adminHeaders(),
    body: {
      payoutMethod: "manual_bank_transfer",
      voucherUrl: `manual://payout/${settlementNo}/${Date.now()}`
    }
  }),
  deductDeposit: (merchantId: string, amountCents: string) => request<JsonRecord>(`/api/admin/deposits/${merchantId}/deduct`, {
    method: "POST",
    headers: adminHeaders(),
    body: {
      amountCents: requirePositiveCents(amountCents, "扣减保证金金额"),
      sourceType: "manual",
      sourceId: `ui-${Date.now()}`,
      reasonCode: "risk_compensation"
    }
  }),
  riskFreeze: (targetType: "order" | "shop", targetId: string) => request<JsonRecord>("/api/admin/risk-freezes", {
    method: "POST",
    headers: adminHeaders(),
    body: {
      targetType,
      targetId,
      freezeType: targetType === "order" ? "order_frozen" : "shop_frozen",
      reasonCode: "manual_risk"
    }
  }),
  shop: (shopId: string) => request<JsonRecord>(`/api/user/shops/${shopId}`, {
    headers: buyerHeaders()
  }),
  shopProducts: (shopId: string) => request<JsonRecord[]>(`/api/user/shops/${shopId}/products`, {
    headers: buyerHeaders()
  }),
  quoteOrder: (shopId: string, merchantProductListingId: string) => request<JsonRecord>("/api/user/orders/quote", {
    method: "POST",
    headers: buyerHeaders(),
    body: { shopId, merchantProductListingId }
  }),
  createOrder: (shopId: string, merchantProductListingId: string, clientPaidAmountCents?: string, buyerEmail?: string) => request<JsonRecord>("/api/user/orders", {
    method: "POST",
    headers: buyerHeaders(),
    body: { shopId, merchantProductListingId, clientPaidAmountCents, buyerEmail }
  }),
  createAfterSale: (orderNo: string, requestedRefundCents: string) => request<JsonRecord>("/api/user/after-sales", {
    method: "POST",
    headers: buyerHeaders(),
    body: {
      orderNo,
      reasonCode: "fulfillment_issue",
      requestedRefundCents: requirePositiveCents(requestedRefundCents, "退款金额"),
      description: "后台提交售后申请"
    }
  }),
  createRefund: (afterSaleNo: string, order: JsonRecord, refundAmountCents: string, responsibility: "platform" | "merchant" | "user" | "mixed") => {
    const refundCents = requirePositiveCents(refundAmountCents, "退款金额");
    const split = mixedSplit(refundCents);
    return request<JsonRecord>(`/api/admin/after-sales/${afterSaleNo}/refunds`, {
      method: "POST",
      headers: adminHeaders(),
      body: {
        refundAmountCents: refundCents,
        responsibility: responsibility,
        platformBearCents: responsibility === "mixed" ? split.platformBearCents : undefined,
        merchantBearCents: responsibility === "mixed" ? split.merchantBearCents : undefined
      }
    });
  },
  confirmRefund: (refundNo: string, voucherUrl: string) => request<JsonRecord>(`/api/admin/refunds/${refundNo}/manual-confirm`, {
    method: "POST",
    headers: adminHeaders(),
    body: {
      channel: "manual",
      channelRefundNo: requireText(voucherUrl, "人工退款凭证")
    }
  }),
  merchantShop: () => request<JsonRecord>("/api/merchant/shop", {
    headers: merchantHeaders()
  }),
  saveShopDecor: (input?: { themeColor?: string; bannerUrl?: string; shareTitle?: string; productGroups?: Array<{ name: string; merchantProductListingIds: string[] }> }) => request<JsonRecord>("/api/merchant/shop/decor", {
    method: "PATCH",
    headers: merchantHeaders(),
    body: input ?? {}
  }),
  saveMerchantShop: (name: string, announcement: string, customerServiceWechat: string, customerServiceQrUrl: string) => request<JsonRecord>("/api/merchant/shop", {
    method: "PATCH",
    headers: merchantHeaders(),
    body: { name, announcement, customerServiceWechat, customerServiceQrUrl }
  }),
  submitMerchantApplication: (input: { contactPhone: string; customerServiceWechat: string; inviteCode?: string }) => request<JsonRecord>("/api/merchant/applications", {
    method: "POST",
    headers: merchantHeaders(),
    body: { contactPhone: input.contactPhone, customerServiceWechat: input.customerServiceWechat, inviteCode: input.inviteCode || undefined }
  }),
  platformProducts: () => request<JsonRecord[]>("/api/merchant/products/platform", {
    headers: merchantHeaders()
  }),
  adminPlatformProducts: () => request<JsonRecord[]>("/api/admin/products", {
    headers: adminHeaders()
  }),
  uploadProductImage: (input: ProductImageUploadInput) => request<JsonRecord>("/api/admin/product-images", {
    method: "POST",
    headers: adminHeaders(),
    body: input,
    timeoutMs: 45_000
  }),
  updatePlatformProduct: (productId: string, input: Partial<{ name: string; category: string; tags: string; subtitle: string; description: string; usageGuide: string; imageUrl: string; specs: string; detailSections: string; stockCount: string; soldCount: string; fulfillmentMode: string; credentialType: string; supplyPriceCents: string; minSalePriceCents: string; suggestedSalePriceCents: string; status: string }>) => {
    const stockCount = input.stockCount !== undefined ? requireNonNegativeInteger(input.stockCount, "库存") : undefined;
    const soldCount = input.soldCount ? requireNonNegativeInteger(input.soldCount, "销量") : undefined;
    return request<JsonRecord>(`/api/admin/products/${encodeURIComponent(requireText(productId, "商品ID"))}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: {
        name: input.name !== undefined ? requireText(input.name, "商品名称") : undefined,
        category: input.category !== undefined ? input.category || undefined : undefined,
        tags: input.tags !== undefined ? input.tags.split(/,|，/).map((item) => item.trim()).filter(Boolean) : undefined,
        subtitle: input.subtitle !== undefined ? input.subtitle || undefined : undefined,
        description: input.description !== undefined ? input.description || undefined : undefined,
        usageGuide: input.usageGuide !== undefined ? input.usageGuide || undefined : undefined,
        imageUrl: input.imageUrl !== undefined ? input.imageUrl || undefined : undefined,
        specs: input.specs !== undefined ? splitLines(input.specs) : undefined,
        detailSections: input.detailSections !== undefined ? parseDetailSections(input.detailSections) : undefined,
        stockCount,
        soldCount,
        fulfillmentMode: input.fulfillmentMode !== undefined ? requireText(input.fulfillmentMode, "履约方式") : undefined,
        credentialType: input.fulfillmentMode === "code_pool" ? input.credentialType || "code" : undefined,
        supplyPriceCents: input.supplyPriceCents !== undefined ? requirePositiveCents(input.supplyPriceCents, "供货价") : undefined,
        minSalePriceCents: input.minSalePriceCents !== undefined ? requirePositiveCents(input.minSalePriceCents, "最低售价") : undefined,
        suggestedSalePriceCents: input.suggestedSalePriceCents !== undefined ? requirePositiveCents(input.suggestedSalePriceCents, "建议售价") : undefined,
        status: input.status !== undefined ? requireText(input.status, "商品状态") : undefined
      }
    });
  },
  adminPlatformShopProducts: () => request<JsonRecord[]>("/api/admin/platform-shop-products", {
    headers: adminHeaders()
  }),
  adminCoupons: () => request<JsonRecord[]>("/api/admin/coupons", {
    headers: adminHeaders()
  }),
  createCouponTemplate: (input: { name: string; discountCents: string; productIds: string; validDays: string; grantOnFirstRegister: boolean; status: string }) => request<JsonRecord>("/api/admin/coupons", {
    method: "POST",
    headers: adminHeaders(),
    body: {
      name: requireText(input.name, "优惠券名称"),
      discountCents: requirePositiveCents(input.discountCents, "抵扣金额"),
      productIds: splitLines(input.productIds),
      validDays: Number(requirePositiveIntegerString(input.validDays, "有效天数")),
      grantOnFirstRegister: input.grantOnFirstRegister,
      status: requireText(input.status, "优惠券状态")
    }
  }),
  updateCouponTemplateStatus: (couponId: string, status: string) => request<JsonRecord>(`/api/admin/coupons/${couponId}/status`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: { status }
  }),
  grantCouponTemplate: (couponId: string, input: { target: string; userId: string; phone: string }) => request<JsonRecord>(`/api/admin/coupons/${encodeURIComponent(requireText(couponId, "优惠券"))}/grants`, {
    method: "POST",
    headers: adminHeaders(),
    body: {
      target: input.target,
      userId: input.userId.trim() || undefined,
      phone: input.phone.trim() || undefined
    }
  }),
  upsertPlatformShopProduct: (shopId: string, platformProductId: string, salePriceCents: string, fulfillmentCostCents: string, status = "listed") => request<JsonRecord>("/api/admin/platform-shop-products", {
    method: "POST",
    headers: adminHeaders(),
    body: {
      shopId,
      platformProductId,
      salePriceCents: requirePositiveCents(salePriceCents, "店铺售价"),
      fulfillmentCostCents: requireNonNegativeCents(fulfillmentCostCents, "履约成本"),
      status: requireText(status, "上架状态")
    }
  }),
  updatePlatformShopProduct: (shopProductId: string, input: { salePriceCents: string; fulfillmentCostCents: string; status: string }) => request<JsonRecord>(`/api/admin/platform-shop-products/${encodeURIComponent(requireText(shopProductId, "自营商品ID"))}`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: {
      salePriceCents: requirePositiveCents(input.salePriceCents, "平台自营售价"),
      fulfillmentCostCents: requireNonNegativeCents(input.fulfillmentCostCents, "履约成本"),
      status: requireText(input.status, "上架状态")
    }
  }),
  batchSelectProducts: (items: Array<{ platformProductId: string; salePriceCents: string }>) => request<JsonRecord>("/api/merchant/products/platform/batch", {
    method: "POST",
    headers: merchantHeaders(),
    body: { items }
  }),
  selectPlatformProduct: (platformProductId: string, input: MerchantListingDisplayInput) => request<JsonRecord>("/api/merchant/products/platform", {
    method: "POST",
    headers: merchantHeaders(),
    body: merchantListingPayload(platformProductId, input)
  }),
  updateMerchantProductDetail: (merchantProductListingId: string, input: MerchantListingDisplayInput) => request<JsonRecord>(`/api/merchant/products/${encodeURIComponent(requireText(merchantProductListingId, "店铺商品"))}`, {
    method: "PATCH",
    headers: merchantHeaders(),
    body: merchantListingPayload(undefined, input)
  }),
  upsertMerchantChannelOffer: (downstreamMerchantId: string, platformProductId: string, resellSupplyPriceCents: string) => request<JsonRecord>("/api/merchant/supply/offers", {
    method: "POST",
    headers: merchantHeaders(),
    body: {
      downstreamMerchantId: requireText(downstreamMerchantId, "下游商户ID"),
      platformProductId: requireText(platformProductId, "平台商品ID"),
      resellSupplyPriceCents: requirePositiveCents(resellSupplyPriceCents, "转供价")
    }
  }),
  rightsCodes: () => request<JsonRecord[]>("/api/admin/rights-codes", {
    headers: adminHeaders()
  }).then((rows) => rows.map(stripRightsCodePlaintext)),
  merchantRightsCodes: (merchantProductListingId?: string) => {
    const params = new URLSearchParams();
    if (merchantProductListingId) params.set("merchantProductListingId", merchantProductListingId);
    return request<JsonRecord[]>(`/api/merchant/rights-codes${params.size ? `?${params.toString()}` : ""}`, {
      headers: merchantHeaders()
    }).then((rows) => rows.map(stripRightsCodePlaintext));
  },
  rightsCodesPlaintext: (filters: { productId?: string; orderNo?: string; status?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.productId) params.set("productId", filters.productId);
    if (filters.orderNo) params.set("orderNo", filters.orderNo);
    if (filters.status) params.set("status", filters.status);
    return request<JsonRecord[]>(`/api/admin/rights-codes/plaintext${params.size ? `?${params.toString()}` : ""}`, {
    headers: adminHeaders()
    });
  },
  importRightsCodes: (input: { productId: string; batchNo: string; codes: string[]; credentialType?: string }) => request<JsonRecord>("/api/admin/rights-codes/import", {
    method: "POST",
    headers: adminHeaders(),
    body: {
      productId: input.productId,
      batchNo: input.batchNo,
      codes: input.codes,
      credentialType: input.credentialType || undefined
    }
  }),
  importMerchantRightsCodes: (input: { merchantProductListingId: string; batchNo: string; codes: string[]; credentialType?: string }) => request<JsonRecord>("/api/merchant/rights-codes/import", {
    method: "POST",
    headers: merchantHeaders(),
    body: {
      merchantProductListingId: input.merchantProductListingId,
      batchNo: input.batchNo,
      codes: input.codes,
      credentialType: input.credentialType || undefined
    }
  }),
  notifications: () => request<JsonRecord[]>("/api/merchant/notifications", {
    headers: merchantHeaders()
  }),
  merchantProducts: () => request<JsonRecord[]>("/api/merchant/products", {
    headers: merchantHeaders()
  }),
  ownProducts: () => request<JsonRecord[]>("/api/merchant/products/own", {
    headers: merchantHeaders()
  }),
  adminOwnProductReviews: () => request<JsonRecord[]>("/api/admin/merchant-products/reviews", {
    headers: adminHeaders()
  }),
  submitOwnProduct: (input: { name: string; category?: string; tags?: string; subtitle?: string; description?: string; usageGuide?: string; imageUrl?: string; specs?: string; detailSections?: string; salePriceCents: string; minSalePriceCents: string; fulfillmentMode: string; credentialType?: string }) => request<JsonRecord>("/api/merchant/products/own", {
    method: "POST",
    headers: merchantHeaders(),
    body: {
      name: requireText(input.name, "商品名称"),
      category: input.category || undefined,
      tags: input.tags ? input.tags.split(/,|，/).map((item) => item.trim()).filter(Boolean) : undefined,
      subtitle: input.subtitle || undefined,
      description: input.description || undefined,
      usageGuide: input.usageGuide || undefined,
      imageUrl: input.imageUrl || undefined,
      specs: splitLines(input.specs),
      detailSections: parseDetailSections(input.detailSections),
      salePriceCents: requirePositiveCents(input.salePriceCents, "售价"),
      minSalePriceCents: input.minSalePriceCents ? requirePositiveCents(input.minSalePriceCents, "最低价") : undefined,
      fulfillmentMode: requireText(input.fulfillmentMode, "交付方式"),
      credentialType: input.fulfillmentMode === "code_pool" ? input.credentialType || "code" : undefined
    }
  }),
  reviewOwnProduct: (ownProductId: string, approved = true) => request<JsonRecord>(`/api/admin/merchant-products/reviews/${ownProductId}/review`, {
    method: "POST",
    headers: adminHeaders(),
    body: {
      approved,
      reason: approved ? "资料符合虚拟商品规则" : "资料需补充"
    }
  }),
  updateMerchantProductPrice: (merchantProductListingId: string, salePriceCents: string) => request<JsonRecord>(`/api/merchant/products/${merchantProductListingId}/price`, {
    method: "PATCH",
    headers: merchantHeaders(),
    body: { salePriceCents }
  }),
  merchantOrders: () => request<JsonRecord[]>("/api/merchant/orders", {
    headers: merchantHeaders()
  }),
  fulfillMerchantOrder: (orderNo: string, attemptNo: number) => request<JsonRecord>(`/api/merchant/orders/${orderNo}/fulfillment`, {
    method: "POST",
    headers: merchantHeaders(),
    body: { status: "success", evidence: `merchant-evidence-${attemptNo}`, attemptNo }
  }),
  merchantAfterSales: () => request<JsonRecord[]>("/api/merchant/after-sales", {
    headers: merchantHeaders()
  }),
  assistMerchantAfterSale: (afterSaleNo: string, note: string) => request<JsonRecord>(`/api/merchant/after-sales/${afterSaleNo}/assist`, {
    method: "POST",
    headers: merchantHeaders(),
    body: { note: requireText(note, "协处理说明") }
  }),
  merchantSettlements: () => request<JsonRecord[]>("/api/merchant/settlements", {
    headers: merchantHeaders()
  }),
  merchantClawbacks: () => request<JsonRecord[]>("/api/merchant/clawbacks", {
    headers: merchantHeaders()
  }),
  merchantDepositTransactions: () => request<JsonRecord[]>("/api/merchant/deposit-transactions", {
    headers: merchantHeaders()
  })
};

export function cents(value: unknown): string {
  const numeric = Number(value ?? 0);
  return `¥${(numeric / 100).toFixed(2)}`;
}

export function text(value: unknown, fallback = "-"): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function mixedSplit(refundAmountCents: string): { platformBearCents: string; merchantBearCents: string } {
  const refundAmount = Number(refundAmountCents);
  const platformBear = Math.floor(refundAmount / 2);
  return {
    platformBearCents: String(platformBear),
    merchantBearCents: String(refundAmount - platformBear)
  };
}

function runtimeValue(storageKey: string, envKey: "VITE_BUYER_ID"): string {
  const stored = typeof window === "undefined" ? null : window.localStorage.getItem(storageKey);
  return stored || String(import.meta.env[envKey] ?? "");
}

function currentAdminSession(): AdminSession | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem("tosell_admin_session");
    if (!raw) return undefined;
    const session = JSON.parse(raw) as AdminSession;
    if (!session.token || session.expiresAt * 1000 <= Date.now() + 30_000) return undefined;
    return session;
  } catch {
    return undefined;
  }
}

function saveAdminSession(session: AdminSession) {
  window.localStorage.setItem("tosell_admin_session", JSON.stringify(session));
}

function clearAdminSession() {
  window.localStorage.removeItem("tosell_admin_session");
}

function currentMerchantSession(): MerchantSession | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem("tosell_merchant_session");
    if (!raw) return undefined;
    const session = JSON.parse(raw) as MerchantSession;
    if (!session.token || session.expiresAt * 1000 <= Date.now() + 30_000) return undefined;
    return session;
  } catch {
    return undefined;
  }
}

function saveMerchantSession(session: MerchantSession) {
  window.localStorage.setItem("tosell_merchant_session", JSON.stringify(session));
}

function clearMerchantSession() {
  window.localStorage.removeItem("tosell_merchant_session");
}

function stripRightsCodePlaintext(row: JsonRecord): JsonRecord {
  const { code: _code, rightsCode: _rightsCode, codeCiphertext: _codeCiphertext, ...safe } = row;
  return safe;
}

function splitLines(value?: string): string[] {
  return (value ?? "")
    .split(/\n|,|，/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDetailSections(value?: string): Array<{ title: string; items: string[] }> {
  return (value ?? "")
    .split(/\n+/)
    .map((line) => {
      const [title, content = ""] = line.split(/:|：/, 2);
      return {
        title: title.trim(),
        items: content.split(/;|；/).map((item) => item.trim()).filter(Boolean)
      };
    })
    .filter((section) => section.title && section.items.length > 0);
}

function merchantListingPayload(platformProductId: string | undefined, input: MerchantListingDisplayInput): JsonRecord {
  return {
    ...(platformProductId ? { platformProductId: requireText(platformProductId, "平台商品ID") } : {}),
    salePriceCents: requirePositiveCents(input.salePriceCents, "销售价"),
    ...(input.status ? { status: requireText(input.status, "上架状态") } : {}),
    displayName: input.displayName?.trim() ?? "",
    displaySubtitle: input.displaySubtitle?.trim() ?? "",
    displayDescription: input.displayDescription?.trim() ?? "",
    displayUsageGuide: input.displayUsageGuide?.trim() ?? "",
    displayImageUrl: input.displayImageUrl?.trim() ?? "",
    displayCategory: input.displayCategory?.trim() ?? "",
    displayTags: splitLines(input.displayTags),
    displaySpecs: splitLines(input.displaySpecs),
    displayDetailSections: parseDetailSections(input.displayDetailSections)
  };
}

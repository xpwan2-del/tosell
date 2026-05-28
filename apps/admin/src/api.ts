const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? "http://localhost:3000" : "");

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  headers?: Record<string, string>;
};

type AdminRole = "operator" | "finance" | "admin";

export type JsonRecord = Record<string, unknown>;
export type AdminSession = {
  token: string;
  expiresAt: number;
  admin: JsonRecord;
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
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

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

function agentHeaders(): Record<string, string> {
  if (!import.meta.env.DEV || import.meta.env.VITE_ALLOW_DEMO_AGENT_HEADERS !== "true") {
    return {};
  }
  return {
    "x-agent-id": runtimeValue("tosell_agent_id", "VITE_AGENT_ID"),
    "x-shop-id": runtimeValue("tosell_shop_id", "VITE_SHOP_ID")
  };
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

export const api = {
  baseUrl: API_BASE_URL || "同源 /api",
  currentAdminSession,
  saveAdminSession,
  clearAdminSession,
  adminLogin: (input: { username: string; password: string; requestedRole?: AdminRole }) => request<AdminSession>("/api/auth/admin/login", {
    method: "POST",
    body: input
  }),
  adminSession: () => request<JsonRecord>("/api/auth/admin/session", {
    headers: adminHeaders()
  }),
  health: () => request<JsonRecord>("/api/health"),
  reconciliationSummary: () => request<JsonRecord>("/api/exports/reconciliation-summary", {
    headers: adminHeaders()
  }),
  agentDashboard: () => request<JsonRecord>("/api/agent/dashboard", {
    headers: agentHeaders()
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
  paymentConfigStatus: () => request<JsonRecord[]>("/api/admin/payment-config/status", {
    headers: adminHeaders()
  }),
  paymentConfigCheck: () => request<JsonRecord>("/api/admin/payment-config/check", {
    method: "POST",
    headers: adminHeaders()
  }),
  updatePaymentConfig: () => request<JsonRecord>("/api/admin/payment-config/metadata", {
    method: "PATCH",
    headers: adminHeaders(),
    body: { channel: "wechat_h5", enabled: false, statusNote: "等待微信/支付宝商户收款能力开通" }
  }),
  adminOrders: () => request<JsonRecord[]>("/api/admin/orders", {
    headers: adminHeaders()
  }),
  agentApplications: () => request<JsonRecord[]>("/api/admin/agent-applications", {
    headers: adminHeaders()
  }),
  createManualAgent: (input: { name: string; shopName: string; contactPhone: string; customerServiceWechat: string; initialPassword: string; depositRequiredAmountCents: string; depositPaid: boolean }) => request<JsonRecord>("/api/admin/agents/manual", {
    method: "POST",
    headers: adminHeaders(),
    body: {
      name: input.name,
      shopName: input.shopName,
      contactPhone: input.contactPhone,
      customerServiceWechat: input.customerServiceWechat,
      initialPassword: input.initialPassword,
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
  adminChannels: () => request<JsonRecord>("/api/admin/channels", {
    headers: adminHeaders()
  }),
  createChannelRelation: (firstTierAgentId: string, secondTierAgentId: string) => request<JsonRecord>("/api/admin/channels/relations", {
    method: "POST",
    headers: adminHeaders(),
    body: { firstTierAgentId, secondTierAgentId, reason: "受控二级供货关系" }
  }),
  upsertChannelOffer: (channelRelationId: string, platformProductId: string, resellSupplyPriceCents: string) => request<JsonRecord>("/api/admin/channels/offers", {
    method: "POST",
    headers: adminHeaders(),
    body: { channelRelationId, platformProductId, resellSupplyPriceCents: requirePositiveCents(resellSupplyPriceCents, "转供价") }
  }),
  reviewChannel: (agentId: string) => request<JsonRecord>(`/api/admin/channels/${agentId}/review`, {
    method: "POST",
    headers: adminHeaders(),
    body: { approved: true, reason: "开通受控二级供货能力" }
  }),
  serviceQrCodes: () => request<JsonRecord[]>("/api/admin/service-qrcodes", {
    headers: adminHeaders()
  }),
  collectionChannels: () => request<JsonRecord[]>("/api/admin/collection-channels", {
    headers: adminHeaders()
  }),
  agentCollectionChannels: () => request<JsonRecord[]>("/api/agent/collection-channels", {
    headers: agentHeaders()
  }),
  submitCollectionChannel: (input: { channelType: string; displayName: string; accountName: string; qrUrl: string; paymentUrl: string }) => request<JsonRecord>("/api/agent/collection-channels", {
    method: "POST",
    headers: agentHeaders(),
    body: {
      channelType: input.channelType,
      displayName: input.displayName,
      accountName: input.accountName || undefined,
      qrUrl: input.qrUrl || undefined,
      paymentUrl: input.paymentUrl || undefined,
      isDefault: true
    }
  }),
  reviewCollectionChannel: (channelId: string, approved: boolean) => request<JsonRecord>(`/api/admin/collection-channels/${channelId}/review`, {
    method: "POST",
    headers: adminHeaders(),
    body: { approved, reason: approved ? "收款通道资料通过" : "收款通道资料需补充" }
  }),
  saveCollectionChannel: (shopId: string, collectionAccountName: string, collectionQrUrl: string, collectionNote: string) => request<JsonRecord>(`/api/admin/shops/${shopId}/collection`, {
    method: "PATCH",
    headers: adminHeaders(),
    body: { collectionAccountName, collectionQrUrl, collectionNote }
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
  reviewAgent: (agentId: string, approved: boolean, reason?: string) => request<JsonRecord>(`/api/admin/agents/${agentId}/review`, {
    method: "POST",
    headers: adminHeaders(),
    body: { approved, reason }
  }),
  confirmDeposit: (agentId: string, amountCents: string, requiredAmountCents?: string) => request<JsonRecord>(`/api/admin/deposits/${agentId}/confirm`, {
    method: "POST",
    headers: adminHeaders(),
    body: {
      amountCents: requirePositiveCents(amountCents, "确认保证金金额"),
      requiredAmountCents: requiredAmountCents ? requirePositiveCents(requiredAmountCents, "应缴保证金金额") : undefined,
      voucherUrl: `manual://deposit/${agentId}/${Date.now()}`
    }
  }),
  createPlatformProduct: (input: { name: string; category?: string; tags?: string; subtitle?: string; description?: string; usageGuide?: string; imageUrl?: string; specs?: string; detailSections?: string; stockCount: string; soldCount?: string; fulfillmentMode: string; supplyPriceCents: string; minSalePriceCents: string; suggestedSalePriceCents: string }) => {
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
      note: "支付账号未开通阶段的后台人工确认收款"
    }
  }),
  allocateRefund: (order: JsonRecord, refundAmountCents: string, responsibility: "platform" | "agent" | "user" | "mixed") => {
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
        agentIncomeCents: requireSnapshotCents(amount?.agentExpectedIncomeCents, "商户收入金额快照"),
        refundAmountCents: refundCents,
        responsibility,
        platformBearCents: responsibility === "mixed" ? split.platformBearCents : undefined,
        agentBearCents: responsibility === "mixed" ? split.agentBearCents : undefined
      }
    });
  },
  generateSettlement: (agentId: string) => request<JsonRecord>("/api/admin/settlements/generate", {
    method: "POST",
    headers: adminHeaders(),
    body: { agentId, now: "2030-01-01T00:00:00.000Z", batchNo: `ui-${Date.now()}` }
  }),
  confirmPayout: (settlementNo: string) => request<JsonRecord>(`/api/admin/settlements/${settlementNo}/payouts`, {
    method: "POST",
    headers: adminHeaders(),
    body: {
      payoutMethod: "manual_bank_transfer",
      voucherUrl: `manual://payout/${settlementNo}/${Date.now()}`
    }
  }),
  deductDeposit: (agentId: string, amountCents: string) => request<JsonRecord>(`/api/admin/deposits/${agentId}/deduct`, {
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
  quoteOrder: (shopId: string, agentProductId: string) => request<JsonRecord>("/api/user/orders/quote", {
    method: "POST",
    headers: buyerHeaders(),
    body: { shopId, agentProductId }
  }),
  createOrder: (shopId: string, agentProductId: string, clientPaidAmountCents?: string, buyerEmail?: string) => request<JsonRecord>("/api/user/orders", {
    method: "POST",
    headers: buyerHeaders(),
    body: { shopId, agentProductId, clientPaidAmountCents, buyerEmail }
  }),
  createAfterSale: (orderNo: string, requestedRefundCents: string) => request<JsonRecord>("/api/user/after-sales", {
    method: "POST",
    headers: buyerHeaders(),
    body: {
      orderNo,
      reasonCode: "fulfillment_issue",
      requestedRefundCents: requirePositiveCents(requestedRefundCents, "退款金额"),
      description: "用户端售后申请演示"
    }
  }),
  createRefund: (afterSaleNo: string, order: JsonRecord, refundAmountCents: string, responsibility: "platform" | "agent" | "user" | "mixed") => {
    const refundCents = requirePositiveCents(refundAmountCents, "退款金额");
    const split = mixedSplit(refundCents);
    return request<JsonRecord>(`/api/admin/after-sales/${afterSaleNo}/refunds`, {
      method: "POST",
      headers: adminHeaders(),
      body: {
        refundAmountCents: refundCents,
        responsibility,
        platformBearCents: responsibility === "mixed" ? split.platformBearCents : undefined,
        agentBearCents: responsibility === "mixed" ? split.agentBearCents : undefined
      }
    });
  },
  agentShop: () => request<JsonRecord>("/api/agent/shop", {
    headers: agentHeaders()
  }),
  saveShopDecor: (input?: { themeColor?: string; bannerUrl?: string; shareTitle?: string; productGroups?: Array<{ name: string; agentProductIds: string[] }> }) => request<JsonRecord>("/api/agent/shop/decor", {
    method: "PATCH",
    headers: agentHeaders(),
    body: input ?? {}
  }),
  saveAgentShop: (name: string, announcement: string, customerServiceWechat: string, customerServiceQrUrl: string) => request<JsonRecord>("/api/agent/shop", {
    method: "PATCH",
    headers: agentHeaders(),
    body: { name, announcement, customerServiceWechat, customerServiceQrUrl }
  }),
  submitAgentApplication: (input: { contactPhone: string; customerServiceWechat: string; inviteCode?: string }) => request<JsonRecord>("/api/agent/applications", {
    method: "POST",
    headers: agentHeaders(),
    body: { contactPhone: input.contactPhone, customerServiceWechat: input.customerServiceWechat, inviteCode: input.inviteCode || undefined }
  }),
  platformProducts: () => request<JsonRecord[]>("/api/agent/products/platform", {
    headers: agentHeaders()
  }),
  adminPlatformProducts: () => request<JsonRecord[]>("/api/admin/products", {
    headers: adminHeaders()
  }),
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
  upsertPlatformShopProduct: (shopId: string, platformProductId: string, salePriceCents: string, fulfillmentCostCents: string) => request<JsonRecord>("/api/admin/platform-shop-products", {
    method: "POST",
    headers: adminHeaders(),
    body: {
      shopId,
      platformProductId,
      salePriceCents: requirePositiveCents(salePriceCents, "店铺售价"),
      fulfillmentCostCents: requireNonNegativeCents(fulfillmentCostCents, "履约成本"),
      status: "listed"
    }
  }),
  batchSelectProducts: (items: Array<{ platformProductId: string; salePriceCents: string }>) => request<JsonRecord>("/api/agent/products/platform/batch", {
    method: "POST",
    headers: agentHeaders(),
    body: { items }
  }),
  rightsCodes: () => request<JsonRecord[]>("/api/admin/rights-codes", {
    headers: adminHeaders()
  }),
  importRightsCodes: (input: { productId: string; batchNo: string; codes: string[] }) => request<JsonRecord>("/api/admin/rights-codes/import", {
    method: "POST",
    headers: adminHeaders(),
    body: {
      productId: input.productId,
      batchNo: input.batchNo,
      codes: input.codes
    }
  }),
  notifications: () => request<JsonRecord[]>("/api/agent/notifications", {
    headers: agentHeaders()
  }),
  agentProducts: () => request<JsonRecord[]>("/api/agent/products", {
    headers: agentHeaders()
  }),
  ownProducts: () => request<JsonRecord[]>("/api/agent/products/own", {
    headers: agentHeaders()
  }),
  submitOwnProduct: (input: { name: string; salePriceCents: string; minSalePriceCents: string; fulfillmentMode: string }) => request<JsonRecord>("/api/agent/products/own", {
    method: "POST",
    headers: agentHeaders(),
    body: {
      name: input.name,
      salePriceCents: input.salePriceCents,
      minSalePriceCents: input.minSalePriceCents,
      fulfillmentMode: input.fulfillmentMode
    }
  }),
  reviewOwnProduct: (ownProductId: string, approved = true) => request<JsonRecord>(`/api/admin/agent-products/reviews/${ownProductId}/review`, {
    method: "POST",
    headers: adminHeaders(),
    body: {
      approved,
      reason: approved ? "资料符合虚拟商品规则" : "资料需补充"
    }
  }),
  updateAgentProductPrice: (agentProductId: string, salePriceCents: string) => request<JsonRecord>(`/api/agent/products/${agentProductId}/price`, {
    method: "PATCH",
    headers: agentHeaders(),
    body: { salePriceCents }
  }),
  agentOrders: () => request<JsonRecord[]>("/api/agent/orders", {
    headers: agentHeaders()
  }),
  agentSettlements: () => request<JsonRecord[]>("/api/agent/settlements", {
    headers: agentHeaders()
  }),
  agentClawbacks: () => request<JsonRecord[]>("/api/agent/clawbacks", {
    headers: agentHeaders()
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

function mixedSplit(refundAmountCents: string): { platformBearCents: string; agentBearCents: string } {
  const refundAmount = Number(refundAmountCents);
  const platformBear = Math.floor(refundAmount / 2);
  return {
    platformBearCents: String(platformBear),
    agentBearCents: String(refundAmount - platformBear)
  };
}

function runtimeValue(storageKey: string, envKey: "VITE_AGENT_ID" | "VITE_SHOP_ID" | "VITE_BUYER_ID"): string {
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

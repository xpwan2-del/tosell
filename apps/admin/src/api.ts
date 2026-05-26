const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  headers?: Record<string, string>;
};

type AdminRole = "operator" | "finance" | "admin";

export type JsonRecord = Record<string, unknown>;

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...options.headers
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data.message === "string" ? data.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

function adminHeaders(role: AdminRole): Record<string, string> {
  return {
    "x-admin-id": `${role}-demo`,
    "x-admin-role": role
  };
}

const agentHeaders = {
  "x-agent-id": "agent-1",
  "x-shop-id": "shop-1"
};

const userHeaders = {
  "x-user-id": "user-1"
};

export const api = {
  baseUrl: API_BASE_URL,
  health: () => request<JsonRecord>("/health"),
  reconciliationSummary: () => request<JsonRecord>("/api/exports/reconciliation-summary", {
    headers: adminHeaders("finance")
  }),
  agentDashboard: () => request<JsonRecord>("/api/agent/dashboard", {
    headers: agentHeaders
  }),
  riskDashboard: () => request<JsonRecord>("/api/admin/risk-dashboard", {
    headers: adminHeaders("operator")
  }),
  paymentGuide: () => request<JsonRecord>("/api/admin/payment-onboarding-guide", {
    headers: adminHeaders("operator")
  }),
  paymentConfigStatus: () => request<JsonRecord[]>("/api/admin/payment-config/status", {
    headers: adminHeaders("operator")
  }),
  paymentConfigCheck: () => request<JsonRecord>("/api/admin/payment-config/check", {
    method: "POST",
    headers: adminHeaders("operator")
  }),
  updatePaymentConfig: () => request<JsonRecord>("/api/admin/payment-config/metadata", {
    method: "PATCH",
    headers: adminHeaders("finance"),
    body: { channel: "wechat_miniprogram", enabled: false, statusNote: "等待微信支付商户号开通" }
  }),
  adminOrders: () => request<JsonRecord[]>("/api/admin/orders", {
    headers: adminHeaders("operator")
  }),
  agentApplications: () => request<JsonRecord[]>("/api/admin/agent-applications", {
    headers: adminHeaders("operator")
  }),
  adminAfterSales: () => request<JsonRecord[]>("/api/admin/after-sales", {
    headers: adminHeaders("operator")
  }),
  adminRefunds: () => request<JsonRecord[]>("/api/admin/refunds", {
    headers: adminHeaders("operator")
  }),
  adminSettlements: () => request<JsonRecord[]>("/api/admin/settlements", {
    headers: adminHeaders("finance")
  }),
  adminDeposits: () => request<JsonRecord[]>("/api/admin/deposits", {
    headers: adminHeaders("finance")
  }),
  adminChannels: () => request<JsonRecord>("/api/admin/channels", {
    headers: adminHeaders("operator")
  }),
  createChannelRelation: () => request<JsonRecord>("/api/admin/channels/relations", {
    method: "POST",
    headers: adminHeaders("operator"),
    body: { firstTierAgentId: "agent-1", secondTierAgentId: "agent-2", reason: "受控二级供货关系" }
  }),
  upsertChannelOffer: () => request<JsonRecord>("/api/admin/channels/offers", {
    method: "POST",
    headers: adminHeaders("operator"),
    body: { channelRelationId: "channel-rel-1", platformProductId: "prod-1", resellSupplyPriceCents: "11000" }
  }),
  reviewChannel: (agentId = "agent-2") => request<JsonRecord>(`/api/admin/channels/${agentId}/review`, {
    method: "POST",
    headers: adminHeaders("operator"),
    body: { approved: true, reason: "开通受控二级供货能力" }
  }),
  serviceQrCodes: () => request<JsonRecord[]>("/api/admin/service-qrcodes", {
    headers: adminHeaders("operator")
  }),
  saveServiceQrCode: () => request<JsonRecord>("/api/admin/shops/shop-1/service-qrcode", {
    method: "PATCH",
    headers: adminHeaders("operator"),
    body: { customerServiceQrUrl: "https://example.test/admin-qr.png" }
  }),
  riskFreezes: () => request<JsonRecord[]>("/api/admin/risk-freezes", {
    headers: adminHeaders("operator")
  }),
  auditLogs: () => request<JsonRecord[]>("/api/admin/audit-logs", {
    headers: adminHeaders("operator")
  }),
  ledgerEntries: () => request<JsonRecord[]>("/api/admin/ledger-entries", {
    headers: adminHeaders("finance")
  }),
  reviewAgent: (agentId: string, approved: boolean, reason?: string) => request<JsonRecord>(`/api/admin/agents/${agentId}/review`, {
    method: "POST",
    headers: adminHeaders("operator"),
    body: { approved, reason }
  }),
  confirmDeposit: (agentId = "agent-new", amountCents = "50000") => request<JsonRecord>(`/api/admin/deposits/${agentId}/confirm`, {
    method: "POST",
    headers: adminHeaders("finance"),
    body: {
      amountCents,
      requiredAmountCents: "50000",
      voucherUrl: `manual://deposit/${agentId}/${Date.now()}`
    }
  }),
  createPlatformProduct: () => request<JsonRecord>("/api/admin/products", {
    method: "POST",
    headers: adminHeaders("operator"),
    body: {
      name: `后台新增虚拟权益 ${new Date().getMinutes()}`,
      supplyPriceCents: "9000",
      minSalePriceCents: "11000",
      suggestedSalePriceCents: "15000"
    }
  }),
  fulfillOrder: (orderNo: string, attemptNo: number) => request<JsonRecord>(`/api/admin/fulfillment/${orderNo}`, {
    method: "POST",
    headers: adminHeaders("operator"),
    body: { status: "success", evidence: `manual-evidence-${attemptNo}`, attemptNo }
  }),
  allocateRefund: (order: JsonRecord, refundAmountCents: string, responsibility: "platform" | "agent" | "user" | "mixed") => {
    const snapshot = order.snapshot as JsonRecord | undefined;
    const amount = snapshot?.amountSnapshot as JsonRecord | undefined;
    return request<JsonRecord>("/api/admin/refunds/allocate", {
      method: "POST",
      headers: adminHeaders("operator"),
      body: {
        paidAmountCents: amount?.paidAmountCents ?? "15000",
        supplyAmountCents: amount?.supplyAmountCents ?? "10000",
        agentIncomeCents: amount?.agentExpectedIncomeCents ?? "4925",
        refundAmountCents,
        responsibility,
        platformBearCents: responsibility === "mixed" ? "3000" : undefined,
        agentBearCents: responsibility === "mixed" ? String(Number(refundAmountCents) - 3000) : undefined
      }
    });
  },
  generateSettlement: () => request<JsonRecord>("/api/admin/settlements/generate", {
    method: "POST",
    headers: adminHeaders("finance"),
    body: { agentId: "agent-1", now: "2030-01-01T00:00:00.000Z", batchNo: `ui-${Date.now()}` }
  }),
  confirmPayout: (settlementNo: string) => request<JsonRecord>(`/api/admin/settlements/${settlementNo}/payouts`, {
    method: "POST",
    headers: adminHeaders("finance"),
    body: {
      payoutMethod: "manual_bank_transfer",
      voucherUrl: `manual://payout/${settlementNo}/${Date.now()}`
    }
  }),
  deductDeposit: () => request<JsonRecord>("/api/admin/deposits/agent-1/deduct", {
    method: "POST",
    headers: adminHeaders("finance"),
    body: {
      amountCents: "1000",
      sourceType: "manual",
      sourceId: `ui-${Date.now()}`,
      reasonCode: "risk_compensation"
    }
  }),
  riskFreeze: (targetType: "order" | "shop", targetId: string) => request<JsonRecord>("/api/admin/risk-freezes", {
    method: "POST",
    headers: adminHeaders("operator"),
    body: {
      targetType,
      targetId,
      freezeType: targetType === "order" ? "order_frozen" : "shop_frozen",
      reasonCode: "manual_risk"
    }
  }),
  shop: (shopId = "shop-1") => request<JsonRecord>(`/api/user/shops/${shopId}`, {
    headers: userHeaders
  }),
  shopProducts: (shopId = "shop-1") => request<JsonRecord[]>(`/api/user/shops/${shopId}/products`, {
    headers: userHeaders
  }),
  quoteOrder: (shopId: string, agentProductId: string) => request<JsonRecord>("/api/user/orders/quote", {
    method: "POST",
    headers: userHeaders,
    body: { shopId, agentProductId }
  }),
  createOrder: (shopId: string, agentProductId: string, clientPaidAmountCents?: string) => request<JsonRecord>("/api/user/orders", {
    method: "POST",
    headers: userHeaders,
    body: { shopId, agentProductId, clientPaidAmountCents }
  }),
  createAfterSale: (orderNo: string, requestedRefundCents: string) => request<JsonRecord>("/api/user/after-sales", {
    method: "POST",
    headers: userHeaders,
    body: {
      orderNo,
      reasonCode: "fulfillment_issue",
      requestedRefundCents,
      description: "用户端售后申请演示"
    }
  }),
  createRefund: (afterSaleNo: string, order: JsonRecord, refundAmountCents: string, responsibility: "platform" | "agent" | "user" | "mixed") => {
    const split = mixedSplit(refundAmountCents);
    return request<JsonRecord>(`/api/admin/after-sales/${afterSaleNo}/refunds`, {
      method: "POST",
      headers: adminHeaders("operator"),
      body: {
        refundAmountCents,
        responsibility,
        platformBearCents: responsibility === "mixed" ? split.platformBearCents : undefined,
        agentBearCents: responsibility === "mixed" ? split.agentBearCents : undefined
      }
    });
  },
  mockPayment: (orderNo: string, amountCents: string) => request<JsonRecord>("/api/callbacks/payments/mock", {
    method: "POST",
    body: {
      channel: "mock",
      channelTradeNo: `ui-pay-${orderNo}-${Date.now()}`,
      orderNo,
      amountCents
    }
  }),
  mockRefund: (refundNo: string) => request<JsonRecord>("/api/callbacks/refunds/mock", {
    method: "POST",
    body: {
      channel: "mock",
      channelRefundNo: `ui-refund-${refundNo}-${Date.now()}`,
      refundNo
    }
  }),
  agentShop: () => request<JsonRecord>("/api/agent/shop", {
    headers: agentHeaders
  }),
  saveShopDecor: () => request<JsonRecord>("/api/agent/shop/decor", {
    method: "PATCH",
    headers: agentHeaders,
    body: {
      themeColor: "#00aa88",
      bannerUrl: "https://example.test/banner.png",
      shareTitle: "代理 A 精选权益",
      productGroups: [{ name: "自动履约", agentProductIds: ["ap-code"] }]
    }
  }),
  saveAgentShop: (name: string, announcement: string, customerServiceWechat = "agent_a_service", customerServiceQrUrl = "https://example.test/qr-agent-a.png") => request<JsonRecord>("/api/agent/shop", {
    method: "PATCH",
    headers: agentHeaders,
    body: { name, announcement, customerServiceWechat, customerServiceQrUrl }
  }),
  submitAgentApplication: () => request<JsonRecord>("/api/agent/applications", {
    method: "POST",
    headers: agentHeaders,
    body: { contactPhone: "13800000000", customerServiceWechat: "agent_a_service" }
  }),
  platformProducts: () => request<JsonRecord[]>("/api/agent/products/platform", {
    headers: agentHeaders
  }),
  adminPlatformProducts: () => request<JsonRecord[]>("/api/admin/products", {
    headers: adminHeaders("operator")
  }),
  adminPlatformShopProducts: () => request<JsonRecord[]>("/api/admin/platform-shop-products", {
    headers: adminHeaders("operator")
  }),
  upsertPlatformShopProduct: () => request<JsonRecord>("/api/admin/platform-shop-products", {
    method: "POST",
    headers: adminHeaders("operator"),
    body: {
      shopId: "shop-platform",
      platformProductId: "prod-1",
      salePriceCents: "14900",
      fulfillmentCostCents: "10000",
      status: "listed"
    }
  }),
  batchSelectProducts: () => request<JsonRecord>("/api/agent/products/platform/batch", {
    method: "POST",
    headers: agentHeaders,
    body: {
      items: [
        { platformProductId: "prod-1", salePriceCents: "15000" },
        { platformProductId: "prod-code", salePriceCents: "4900" }
      ]
    }
  }),
  rightsCodes: () => request<JsonRecord[]>("/api/admin/rights-codes", {
    headers: adminHeaders("operator")
  }),
  importRightsCodes: () => request<JsonRecord>("/api/admin/rights-codes/import", {
    method: "POST",
    headers: adminHeaders("operator"),
    body: {
      productId: "prod-code",
      batchNo: `ui-${Date.now()}`,
      codes: [`UI-CODE-${Date.now()}-1`, `UI-CODE-${Date.now()}-2`]
    }
  }),
  notifications: () => request<JsonRecord[]>("/api/agent/notifications", {
    headers: agentHeaders
  }),
  agentProducts: () => request<JsonRecord[]>("/api/agent/products", {
    headers: agentHeaders
  }),
  ownProducts: () => request<JsonRecord[]>("/api/agent/products/own", {
    headers: agentHeaders
  }),
  submitOwnProduct: () => request<JsonRecord>("/api/agent/products/own", {
    method: "POST",
    headers: agentHeaders,
    body: {
      name: `代理自有虚拟商品 ${new Date().getMinutes()}`,
      salePriceCents: "19900",
      minSalePriceCents: "9900",
      fulfillmentMode: "manual"
    }
  }),
  reviewOwnProduct: (ownProductId: string, approved = true) => request<JsonRecord>(`/api/admin/agent-products/reviews/${ownProductId}/review`, {
    method: "POST",
    headers: adminHeaders("operator"),
    body: {
      approved,
      reason: approved ? "资料符合虚拟商品规则" : "资料需补充"
    }
  }),
  updateAgentProductPrice: (agentProductId: string, salePriceCents: string) => request<JsonRecord>(`/api/agent/products/${agentProductId}/price`, {
    method: "PATCH",
    headers: agentHeaders,
    body: { salePriceCents }
  }),
  agentOrders: () => request<JsonRecord[]>("/api/agent/orders", {
    headers: agentHeaders
  }),
  agentSettlements: () => request<JsonRecord[]>("/api/agent/settlements", {
    headers: agentHeaders
  }),
  agentClawbacks: () => request<JsonRecord[]>("/api/agent/clawbacks", {
    headers: agentHeaders
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

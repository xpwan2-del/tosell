type Method = "GET" | "POST" | "PATCH";
type Mode = "user" | "agent" | "admin";

type RequestOptions = {
  method?: Method;
  mode?: Mode;
  body?: Record<string, unknown>;
};

type AppShape = {
  globalData: {
    apiBaseUrl: string;
    userId: string;
    agentId: string;
    shopId: string;
  };
};

function headers(mode: Mode): Record<string, string> {
  const app = getApp<AppShape>();
  if (mode === "agent") {
    return {
      "content-type": "application/json",
      "x-agent-id": app.globalData.agentId,
      "x-shop-id": app.globalData.shopId
    };
  }
  if (mode === "admin") {
    return {
      "content-type": "application/json",
      "x-admin-id": "operator-demo",
      "x-admin-role": "operator"
    };
  }
  return {
    "content-type": "application/json",
    "x-user-id": app.globalData.userId
  };
}

export function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const app = getApp<AppShape>();
  return new Promise((resolve, reject) => {
    wx.request<T>({
      url: `${app.globalData.apiBaseUrl}${path}`,
      method: options.method ?? "GET",
      header: headers(options.mode ?? "user"),
      data: options.body,
      success(result) {
        if (result.statusCode >= 200 && result.statusCode < 300) {
          resolve(result.data);
          return;
        }
        const data = result.data as Record<string, unknown>;
        reject(new Error(typeof data?.message === "string" ? data.message : `HTTP ${result.statusCode}`));
      },
      fail(error) {
        reject(new Error(error.errMsg));
      }
    });
  });
}

export function cents(value: unknown): string {
  return (Number(value ?? 0) / 100).toFixed(2);
}

export function text(value: unknown, fallback = "-"): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export const api = {
  shop: (shopId: string) => request<Record<string, unknown>>(`/api/user/shops/${shopId}`),
  shopProducts: (shopId: string) => request<Array<Record<string, unknown>>>(`/api/user/shops/${shopId}/products`),
  product: (agentProductId: string) => request<Record<string, unknown>>(`/api/user/products/${agentProductId}`),
  quote: (shopId: string, agentProductId: string) => request<Record<string, unknown>>("/api/user/orders/quote", {
    method: "POST",
    body: { shopId, agentProductId }
  }),
  createOrder: (shopId: string, agentProductId: string, clientPaidAmountCents?: string) => request<Record<string, unknown>>("/api/user/orders", {
    method: "POST",
    body: { shopId, agentProductId, clientPaidAmountCents }
  }),
  mockPayment: (orderNo: string, amountCents: string) => request<Record<string, unknown>>("/api/callbacks/payments/mock", {
    method: "POST",
    body: {
      channel: "mock",
      channelTradeNo: `mini-pay-${orderNo}-${Date.now()}`,
      orderNo,
      amountCents
    }
  }),
  order: (orderNo: string) => request<Record<string, unknown>>(`/api/user/orders/${orderNo}`),
  orders: () => request<Array<Record<string, unknown>>>("/api/user/orders"),
  createAfterSale: (orderNo: string, requestedRefundCents: string) => request<Record<string, unknown>>("/api/user/after-sales", {
    method: "POST",
    body: {
      orderNo,
      reasonCode: "fulfillment_issue",
      requestedRefundCents,
      description: "用户发起售后"
    }
  }),
  createAfterSaleWithReason: (orderNo: string, requestedRefundCents: string, reasonCode: string, description: string) => request<Record<string, unknown>>("/api/user/after-sales", {
    method: "POST",
    body: { orderNo, reasonCode, requestedRefundCents, description }
  }),
  agentShop: () => request<Record<string, unknown>>("/api/agent/shop", { mode: "agent" }),
  agentDashboard: () => request<Record<string, unknown>>("/api/agent/dashboard", { mode: "agent" }),
  saveAgentShop: (name: string, announcement: string, customerServiceWechat?: string) => request<Record<string, unknown>>("/api/agent/shop", {
    method: "PATCH",
    mode: "agent",
    body: { name, announcement, customerServiceWechat }
  }),
  saveShopDecor: (themeColor: string, shareTitle: string, bannerUrl: string) => request<Record<string, unknown>>("/api/agent/shop/decor", {
    method: "PATCH",
    mode: "agent",
    body: {
      themeColor,
      shareTitle,
      bannerUrl,
      productGroups: [{ name: "推荐权益", agentProductIds: ["ap-1", "ap-code"] }]
    }
  }),
  submitApplication: (contactPhone = "13800000000", customerServiceWechat = "agent_a_service") => request<Record<string, unknown>>("/api/agent/applications", {
    method: "POST",
    mode: "agent",
    body: { contactPhone, customerServiceWechat }
  }),
  platformProducts: () => request<Array<Record<string, unknown>>>("/api/agent/products/platform", { mode: "agent" }),
  agentProducts: () => request<Array<Record<string, unknown>>>("/api/agent/products", { mode: "agent" }),
  batchSelectPlatformProducts: () => request<Record<string, unknown>>("/api/agent/products/platform/batch", {
    method: "POST",
    mode: "agent",
    body: {
      items: [
        { platformProductId: "prod-1", salePriceCents: "15000" },
        { platformProductId: "prod-code", salePriceCents: "4900" }
      ]
    }
  }),
  selectPlatformProduct: (platformProductId: string, salePriceCents: string) => request<Record<string, unknown>>("/api/agent/products/platform", {
    method: "POST",
    mode: "agent",
    body: { platformProductId, salePriceCents }
  }),
  submitOwnProduct: (name: string, salePriceCents: string, minSalePriceCents: string) => request<Record<string, unknown>>("/api/agent/products/own", {
    method: "POST",
    mode: "agent",
    body: { name, salePriceCents, minSalePriceCents, fulfillmentMode: "manual" }
  }),
  updatePrice: (agentProductId: string, salePriceCents: string) => request<Record<string, unknown>>(`/api/agent/products/${agentProductId}/price`, {
    method: "PATCH",
    mode: "agent",
    body: { salePriceCents }
  }),
  agentOrders: () => request<Array<Record<string, unknown>>>("/api/agent/orders", { mode: "agent" }),
  settlements: () => request<Array<Record<string, unknown>>>("/api/agent/settlements", { mode: "agent" }),
  clawbacks: () => request<Array<Record<string, unknown>>>("/api/agent/clawbacks", { mode: "agent" }),
  notifications: () => request<Array<Record<string, unknown>>>("/api/agent/notifications", { mode: "agent" })
};

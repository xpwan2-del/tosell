const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? "http://localhost:3000" : "");

export type JsonRecord = Record<string, unknown>;

async function request<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-user-id": h5UserId()
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.message === "string" ? data.message : `HTTP ${response.status}`);
  }
  return data as T;
}

function h5UserId(): string {
  const existing = localStorage.getItem("tosell_h5_user_id");
  if (existing) return existing;
  const generated = `h5-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
  localStorage.setItem("tosell_h5_user_id", generated);
  return generated;
}

export const api = {
  baseUrl: API_BASE_URL,
  shop: (shopId: string) => request<JsonRecord>(`/api/user/shops/${shopId}`),
  products: (shopId: string) => request<JsonRecord[]>(`/api/user/shops/${shopId}/products`),
  quote: (shopId: string, productId: string) => request<JsonRecord>("/api/user/orders/quote", {
    method: "POST",
    body: { shopId, agentProductId: productId }
  }),
  createOrder: (shopId: string, productId: string, clientPaidAmountCents: string) => request<JsonRecord>("/api/user/orders", {
    method: "POST",
    body: { shopId, agentProductId: productId, clientPaidAmountCents }
  }),
  mockPayment: (orderNo: string, amountCents: string) => request<JsonRecord>("/api/callbacks/payments/mock", {
    method: "POST",
    body: {
      channel: "mock",
      channelTradeNo: `h5-pay-${orderNo}-${Date.now()}`,
      orderNo,
      amountCents
    }
  }),
  createAfterSale: (orderNo: string, requestedRefundCents: string) => request<JsonRecord>("/api/user/after-sales", {
    method: "POST",
    body: {
      orderNo,
      reasonCode: "fulfillment_issue",
      requestedRefundCents,
      description: "H5 用户售后申请"
    }
  }),
  orders: () => request<JsonRecord[]>("/api/user/orders")
};

export function cents(value: unknown): string {
  return `¥${(Number(value ?? 0) / 100).toFixed(2)}`;
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

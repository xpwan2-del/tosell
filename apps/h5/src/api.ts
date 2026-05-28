const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? "http://localhost:3000" : "");

export type JsonRecord = Record<string, unknown>;
export type AuthSession = {
  token: string;
  user: JsonRecord;
  expiresAt: number;
  grantedCoupon?: JsonRecord;
};

async function request<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const token = path.startsWith("/api/auth/") ? "" : await authToken();
  const headers: Record<string, string> = {
    ...(token ? { authorization: `Bearer ${token}` } : { "x-user-id": h5UserId() })
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
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
  authGuest: () => request<AuthSession>("/api/auth/h5/guest", { method: "POST" }),
  authRegister: (phone: string, displayName?: string) => request<AuthSession>("/api/auth/h5/register", {
    method: "POST",
    body: { phone, displayName }
  }),
  registerMerchantByInvite: (input: {
    inviteCode: string;
    name: string;
    shopName?: string;
    contactPhone?: string;
    customerServiceWechat?: string;
  }) => request<JsonRecord>("/api/agent/register-by-invite", {
    method: "POST",
    body: {
      inviteCode: input.inviteCode,
      name: input.name,
      shopName: input.shopName || undefined,
      contactPhone: input.contactPhone || undefined,
      customerServiceWechat: input.customerServiceWechat || undefined
    }
  }),
  currentSession,
  saveSession,
  logout,
  shop: (shopId: string) => request<JsonRecord>(`/api/user/shops/${shopId}`),
  products: (shopId: string) => request<JsonRecord[]>(`/api/user/shops/${shopId}/products`),
  collectionChannels: (shopId: string) => request<JsonRecord[]>(`/api/user/shops/${shopId}/collection-channels`),
  coupons: (shopId: string, productId?: string) => {
    const params = new URLSearchParams({ shopId });
    if (productId) params.set("agentProductId", productId);
    return request<JsonRecord[]>(`/api/user/coupons?${params.toString()}`);
  },
  quote: (shopId: string, productId: string, couponId?: string) => request<JsonRecord>("/api/user/orders/quote", {
    method: "POST",
    body: { shopId, agentProductId: productId, couponId }
  }),
  createOrder: (shopId: string, productId: string, clientPaidAmountCents: string, input: { extractionCode?: string; couponId?: string; buyerEmail?: string; collectionChannelId?: string } = {}) => request<JsonRecord>("/api/user/orders", {
    method: "POST",
    body: {
      shopId,
      agentProductId: productId,
      clientPaidAmountCents,
      extractionCode: input.extractionCode || undefined,
      couponId: input.couponId || undefined,
      buyerEmail: input.buyerEmail || undefined,
      collectionChannelId: input.collectionChannelId || undefined
    }
  }),
  createAfterSale: (orderNo: string, requestedRefundCents: string, description = "H5 用户售后申请") => request<JsonRecord>("/api/user/after-sales", {
    method: "POST",
    body: {
      orderNo,
      reasonCode: "fulfillment_issue",
      requestedRefundCents,
      description
    }
  }),
  orders: () => request<JsonRecord[]>("/api/user/orders")
  ,
  order: (orderNo: string) => request<JsonRecord>(`/api/user/orders/${orderNo}`),
  extractOrder: (orderNo: string, extractionCode: string) => request<JsonRecord>(`/api/user/orders/${orderNo}/extract`, {
    method: "POST",
    body: { extractionCode }
  })
};

async function authToken(): Promise<string> {
  const session = currentSession();
  if (session?.token && session.expiresAt * 1000 > Date.now() + 60_000) return session.token;
  const guest = await request<AuthSession>("/api/auth/h5/guest", { method: "POST" });
  saveSession(guest);
  return guest.token;
}

function currentSession(): AuthSession | undefined {
  try {
    const raw = localStorage.getItem("tosell_h5_auth");
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as AuthSession;
    return parsed?.token ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function saveSession(session: AuthSession) {
  localStorage.setItem("tosell_h5_auth", JSON.stringify(session));
  const userId = typeof session.user.userId === "string" ? session.user.userId : "";
  if (userId) localStorage.setItem("tosell_h5_user_id", userId);
}

function logout() {
  localStorage.removeItem("tosell_h5_auth");
}

export function cents(value: unknown): string {
  return `¥${(Number(value ?? 0) / 100).toFixed(2)}`;
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

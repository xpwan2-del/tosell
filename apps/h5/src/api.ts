const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? "http://localhost:3000" : "");

export type JsonRecord = Record<string, unknown>;
export type AuthSession = {
  token: string;
  user: JsonRecord;
  expiresAt: number;
  grantedCoupon?: JsonRecord;
};

async function request<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown; retryAuth?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const token = path.startsWith("/api/auth/") ? "" : await authToken();
  const headers: Record<string, string> = {
    ...(token ? { authorization: `Bearer ${token}` } : { "x-user-id": h5UserId() })
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
      throw new Error("请求超时，请检查网络或稍后重试");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && token && options.retryAuth !== false) {
      logout();
      return request<T>(path, { ...options, retryAuth: false });
    }
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
  }) => request<JsonRecord>("/api/merchant/register-by-invite", {
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
  product: (productId: string) => request<JsonRecord>(`/api/user/products/${encodeURIComponent(productId)}`),
  paymentMethods: (shopId: string) => request<JsonRecord[]>(`/api/user/shops/${shopId}/payment-methods`),
  coupons: (shopId: string, productId?: string) => {
    const params = new URLSearchParams({ shopId });
    if (productId) params.set("merchantProductListingId", productId);
    return request<JsonRecord[]>(`/api/user/coupons?${params.toString()}`);
  },
  quote: (shopId: string, productId: string, couponId?: string) => request<JsonRecord>("/api/user/orders/quote", {
    method: "POST",
    body: { shopId, merchantProductListingId: productId, couponId }
  }),
  createOrder: (shopId: string, productId: string, clientPaidAmountCents: string, input: { purchasePassword?: string; extractionCode?: string; couponId?: string; buyerEmail?: string; buyerPhone?: string; paymentMethodId?: string } = {}) => request<JsonRecord>("/api/user/orders", {
    method: "POST",
    body: {
      shopId,
      merchantProductListingId: productId,
      clientPaidAmountCents,
      purchasePassword: input.purchasePassword || input.extractionCode || undefined,
      couponId: input.couponId || undefined,
      buyerEmail: input.buyerEmail || undefined,
      buyerPhone: input.buyerPhone || undefined,
      paymentMethodId: input.paymentMethodId || undefined
    }
  }),
  createPayment: (orderNo: string, paymentMethodId?: string) => request<JsonRecord>(`/api/user/orders/${encodeURIComponent(orderNo)}/payments`, {
    method: "POST",
    body: { paymentMethodId: paymentMethodId || undefined }
  }),
  wallet: () => request<JsonRecord>("/api/user/wallet"),
  createWalletRecharge: (amountCents: string, paymentMethodId?: string) => request<JsonRecord>("/api/user/wallet/recharges", {
    method: "POST",
    body: { amountCents, paymentMethodId: paymentMethodId || undefined }
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
  submitPaymentVoucher: (orderNo: string, input: { channel?: string; payerName?: string; voucherUrl?: string; note?: string }) => request<JsonRecord>(`/api/user/orders/${encodeURIComponent(orderNo)}/payment-vouchers`, {
    method: "POST",
    body: {
      channel: input.channel || undefined,
      payerName: input.payerName || undefined,
      voucherUrl: input.voucherUrl || undefined,
      note: input.note || undefined
    }
  }),
  orders: () => request<JsonRecord[]>("/api/user/orders")
  ,
  order: (orderNo: string) => request<JsonRecord>(`/api/user/orders/${orderNo}`),
  extractOrder: (orderNo: string, purchasePassword: string) => request<JsonRecord>(`/api/user/orders/${orderNo}/extract`, {
    method: "POST",
    body: { purchasePassword }
  }),
  extractWithToken: (token: string, purchasePassword: string) => request<JsonRecord>(`/api/user/extractions/${encodeURIComponent(token)}`, {
    method: "POST",
    body: { purchasePassword }
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
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return fallback;
}

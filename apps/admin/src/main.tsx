import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError, api, cents, text, type AdminSession, type AgentSession, type JsonRecord } from "./api.js";
import "./styles.css";

type LoadState = {
  shop?: JsonRecord;
  platformShop?: JsonRecord;
  publicProducts: JsonRecord[];
  platformShopProducts: JsonRecord[];
  agentProducts: JsonRecord[];
  platformProducts: JsonRecord[];
  ownProducts: JsonRecord[];
  agentOrders: JsonRecord[];
  adminOrders: JsonRecord[];
  agentApplications: JsonRecord[];
  inviteCodes: JsonRecord[];
  adminAfterSales: JsonRecord[];
  adminRefunds: JsonRecord[];
  adminSettlements: JsonRecord[];
  adminDeposits: JsonRecord[];
  serviceQrCodes: JsonRecord[];
  riskFreezes: JsonRecord[];
  paymentConfigs: JsonRecord[];
  paymentVouchers: JsonRecord[];
  collectionChannels: JsonRecord[];
  coupons: JsonRecord[];
  settlements: JsonRecord[];
  clawbacks: JsonRecord[];
  depositTransactions: JsonRecord[];
  auditLogs: JsonRecord[];
  ledgerEntries: JsonRecord[];
  channels?: JsonRecord;
  rightsCodes: JsonRecord[];
  notifications: JsonRecord[];
  reconciliation?: JsonRecord;
  agentDashboard?: JsonRecord;
  riskDashboard?: JsonRecord;
  salesDashboard?: JsonRecord;
  paymentGuide?: JsonRecord;
};

const initialState: LoadState = {
  publicProducts: [],
  platformShopProducts: [],
  agentProducts: [],
  platformProducts: [],
  ownProducts: [],
  agentOrders: [],
  adminOrders: [],
  agentApplications: [],
  inviteCodes: [],
  adminAfterSales: [],
  adminRefunds: [],
  adminSettlements: [],
  adminDeposits: [],
  serviceQrCodes: [],
  riskFreezes: [],
  paymentConfigs: [],
  paymentVouchers: [],
  collectionChannels: [],
  coupons: [],
  settlements: [],
  clawbacks: [],
  depositTransactions: [],
  auditLogs: [],
  ledgerEntries: [],
  rightsCodes: [],
  notifications: []
};

const navItems = [
  { id: "dashboard", label: "首页", group: "总览" },
  { id: "products", label: "商品", group: "经营" },
  { id: "inventory", label: "库存卡密", group: "经营" },
  { id: "coupons", label: "优惠券", group: "经营" },
  { id: "orders", label: "订单", group: "经营" },
  { id: "fulfillment", label: "发货", group: "经营" },
  { id: "afterSales", label: "售后", group: "经营" },
  { id: "sales", label: "销售统计", group: "数据" },
  { id: "shops", label: "店铺设置", group: "店铺" },
  { id: "agents", label: "代理/渠道", group: "平台" },
  { id: "secondTierChannels", label: "二级渠道管理", group: "平台" },
  { id: "settlements", label: "结算", group: "财务" },
  { id: "risk", label: "风控日志", group: "平台" },
  { id: "payment", label: "支付配置", group: "财务" }
] as const;

type ModuleId = (typeof navItems)[number]["id"];
type BackendSession = AdminSession | AgentSession;
const configuredShopId = import.meta.env.VITE_SHOP_ID ?? "";
const configuredPlatformShopId = import.meta.env.VITE_PLATFORM_SHOP_ID ?? "";

const mvpCoverageLabels = [
  "基础看板",
  "代理审核",
  "保证金",
  "二级渠道管理",
  "店铺管理",
  "平台自营",
  "商品管理",
  "代理商品审核",
  "订单管理",
  "履约管理",
  "售后退款",
  "结算管理",
  "风控冻结",
  "审计日志",
  "客服二维码",
  "入驻与店铺",
  "选品与定价",
  "订单收益",
  "结算记录",
  "追扣记录",
  "提交自有商品",
  "确认人工打款",
  "V2经营看板",
  "权益码池",
  "支付开通",
  "店铺装修",
  "消息通知"
] as const;

function App() {
  const [data, setData] = useState<LoadState>(initialState);
  const [active, setActive] = useState<ModuleId>(() => moduleFromHash());
  const [session, setSession] = useState<BackendSession | undefined>(() => api.currentAdminSession() ?? api.currentAgentSession());
  const [loginMode, setLoginMode] = useState<"admin" | "merchant">(() => api.currentAgentSession() ? "merchant" : "admin");
  const [message, setMessage] = useState(session ? "正在连接 API..." : "请先登录后台");
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState("");
  const [loginForm, setLoginForm] = useState({
    username: "",
    password: "",
    requestedRole: "admin" as "operator" | "finance" | "admin"
  });
  const [priceCents, setPriceCents] = useState("");
  const [refundCents, setRefundCents] = useState("");
  const [channelOfferCents, setChannelOfferCents] = useState("");
  const [depositConfirmCents, setDepositConfirmCents] = useState("");
  const [depositDeductCents, setDepositDeductCents] = useState("");
  const [adminAgentId, setAdminAgentId] = useState("");
  const [downstreamAgentId, setDownstreamAgentId] = useState("");
  const [afterSaleAssistNote, setAfterSaleAssistNote] = useState("");
  const [attemptNo, setAttemptNo] = useState(1);
  const [productForm, setProductForm] = useState({
    name: "",
    category: "",
    tags: "",
    subtitle: "",
    description: "",
    usageGuide: "",
    imageUrl: "",
    specs: "",
    detailSections: "",
    stockCount: "",
    soldCount: "",
    fulfillmentMode: "",
    supplyPriceCents: "",
    minSalePriceCents: "",
    suggestedSalePriceCents: ""
  });
  const [inventoryForm, setInventoryForm] = useState({
    productId: "",
    batchNo: "",
    codes: ""
  });
  const [collectionForm, setCollectionForm] = useState({
    shopId: "",
    collectionAccountName: "",
    collectionQrUrl: "",
    collectionNote: ""
  });
  const [shopForm, setShopForm] = useState({
    name: "",
    announcement: "",
    customerServiceWechat: "",
    customerServiceQrUrl: ""
  });
  const [couponForm, setCouponForm] = useState({
    name: "",
    discountCents: "",
    productIds: "",
    validDays: "",
    grantOnFirstRegister: false,
    status: ""
  });
  const [manualAgentForm, setManualAgentForm] = useState({
    name: "",
    shopName: "",
    contactPhone: "",
    customerServiceWechat: "",
    initialPassword: "",
    depositRequiredAmountCents: "",
    depositPaid: false
  });
  const [applicationForm, setApplicationForm] = useState({
    contactPhone: "",
    customerServiceWechat: "",
    inviteCode: ""
  });
  const [inviteForm, setInviteForm] = useState({
    code: "",
    targetTier: "first_tier",
    maxUses: "",
    expiresAt: "",
    depositRequiredAmountCents: ""
  });
  const [ownProductForm, setOwnProductForm] = useState({
    name: "",
    salePriceCents: "",
    minSalePriceCents: "",
    fulfillmentMode: ""
  });
  const [collectionChannelForm, setCollectionChannelForm] = useState({
    channelType: "",
    displayName: "",
    accountName: "",
    qrUrl: "",
    paymentUrl: ""
  });
  const [currentOrder, setCurrentOrder] = useState<JsonRecord | undefined>();
  const [currentAfterSale, setCurrentAfterSale] = useState<JsonRecord | undefined>();
  const [currentRefund, setCurrentRefund] = useState<JsonRecord | undefined>();
  const [currentAllocation, setCurrentAllocation] = useState<JsonRecord | undefined>();
  const [createdCredential, setCreatedCredential] = useState<JsonRecord | undefined>();
  const [refundVoucher, setRefundVoucher] = useState("");
  const [paymentVoucherReason, setPaymentVoucherReason] = useState("");
  const [showSensitiveCodes, setShowSensitiveCodes] = useState(false);
  const [sensitiveRightsCodes, setSensitiveRightsCodes] = useState<JsonRecord[]>([]);

  const selectedPublicProduct = data.publicProducts[0];
  const selectedPlatformShopProduct = data.platformShopProducts[0];
  const selectedAgentProduct = data.agentProducts[0];
  const selectedOwnAgentProduct = data.agentProducts.find((item) => text(item.id) === inventoryForm.productId)
    ?? data.agentProducts.find((item) => text(item.productType) === "agent_owned")
    ?? data.agentProducts[0];
  const selectedOwnProduct = data.ownProducts.find((item) => text(item.reviewStatus) === "pending_review") ?? data.ownProducts[0];
  const activeAgentSession = isAgentSession(session) ? session : undefined;
  const merchantSessionActive = Boolean(activeAgentSession);
  const visibleOrders = merchantSessionActive ? data.agentOrders : data.adminOrders;
  const selectedOrder = currentOrder ?? visibleOrders.find((order) => text(order.paymentStatus) === "unpaid") ?? visibleOrders[0];
  const selectedOrderNo = text(selectedOrder?.orderNo, "");
  const selectedOrderAmount = amountOf(selectedOrder);
  const selectedPaymentVoucher = data.paymentVouchers.find((item) => text(item.status) === "pending_review") ?? data.paymentVouchers[0];
  const selectedOrderPaymentVouchers = data.paymentVouchers.filter((item) => text(item.orderNo) === selectedOrderNo);
  const visibleSettlements = merchantSessionActive ? data.settlements : data.adminSettlements;
  const selectedSettlement = visibleSettlements.find((sheet) => text(sheet.status) !== "paid") ?? visibleSettlements[0];
  const currentShopId = text(data.shop?.id, text(activeAgentSession?.shop.shopId, ""));
  const currentShopShareUrl = shopShareUrl(currentShopId);
  const currentProductId = text(selectedPublicProduct?.id, "");
  const currentAgentId = merchantSessionActive
    ? text(activeAgentSession?.agent.agentId, "")
    : text(adminAgentId, text(data.agentApplications[0]?.agentId, text(data.adminDeposits[0]?.agentId, "")));
  const currentAgentTier = text(activeAgentSession?.agent.tier, "");
  const canConfigureDownstreamOffer = merchantSessionActive && ["first_tier", "second_tier"].includes(currentAgentTier);
  const merchantInviteTargetTier = currentAgentTier === "first_tier" ? "second_tier" : currentAgentTier === "second_tier" ? "third_tier" : "";
  const peerAgentId = text(data.agentApplications.find((item) => text(item.agentId) !== currentAgentId)?.agentId, "");
  const currentPlatformProductId = text(data.platformProducts[0]?.id, "");
  const currentChannelRelationId = text(channelRows(data.channels, "relations")[0]?.id, "");
  const currentDeposit = data.adminDeposits.find((item) => text(item.agentId) === currentAgentId);
  const currentDepositStatus = text(currentDeposit?.status, text(activeAgentSession?.agent.depositStatus, ""));
  const merchantBlockedReason = currentAgentId && currentDepositStatus !== "paid"
    ? `保证金未确认，后端将拒绝销售、选品、代理和转供价操作；当前状态：${text(currentDepositStatus, "unknown")}`
    : "";
  const merchantBlocked = Boolean(merchantBlockedReason);
  const pendingCollectionChannel = data.collectionChannels.find((item) => text(item.reviewStatus) === "pending_review") ?? data.collectionChannels[0];
  const platformProductColumns = merchantSessionActive
    ? [
      "id",
      "name",
      "category",
      "tags",
      "fulfillmentMode",
      "stockCount",
      "soldCount",
      currentAgentTier === "first_tier" ? "supplyPriceCents" : "visibleUpstreamSupplyPriceCents",
      "minSalePriceCents",
      "suggestedSalePriceCents",
      "status"
    ]
    : ["id", "name", "category", "tags", "fulfillmentMode", "stockCount", "soldCount", "supplyPriceCents", "minSalePriceCents", "suggestedSalePriceCents", "status"];
  const agentProductColumns = merchantSessionActive
    ? ["id", "productName", "category", "fulfillmentMode", "stockCount", "soldCount", "salePriceCents", currentAgentTier === "first_tier" ? "platformSupplyPriceCents" : "visibleUpstreamSupplyPriceCents", "minSalePriceCents", "status"]
    : ["id", "productName", "category", "fulfillmentMode", "stockCount", "soldCount", "salePriceCents", "supplyPriceCents", "minSalePriceCents", "status"];

  const metrics = useMemo(() => {
    if (merchantSessionActive) {
      return [
        { label: "成交额", value: cents(data.agentDashboard?.gmvCents), tone: "strong" },
        { label: "订单数", value: String(data.agentOrders.length) },
        { label: "已收款", value: text(data.agentDashboard?.paidOrderCount, "0") },
        { label: "预估收益", value: cents(data.agentDashboard?.expectedIncomeCents) },
        { label: "售后中", value: String(data.agentOrders.filter((item) => text(item.refundStatus, "none") !== "none").length) },
        { label: "待结算", value: String(data.settlements.filter((item) => text(item.status) !== "paid").length) }
      ];
    }
    const reconciliation = data.reconciliation ?? {};
    return [
      { label: "成交额", value: cents(reconciliation.totalPaidCents), tone: "strong" },
      { label: "订单数", value: text(data.salesDashboard?.orderCount, "0") },
      { label: "已收款", value: text(data.salesDashboard?.paidOrderCount, "0") },
      { label: "可用卡密", value: String(data.rightsCodes.filter((item) => text(item.status) === "available").length) },
      { label: "售后中", value: String(data.adminAfterSales.filter((item) => text(item.status) !== "closed").length) },
      { label: "待结算", value: String(data.settlements.filter((item) => text(item.status) !== "paid").length) }
    ];
  }, [data, merchantSessionActive]);

  const todoItems = useMemo(() => [
    {
      label: "待确认收款",
      value: visibleOrders.filter((order) => text(order.paymentStatus) === "unpaid").length,
      target: "orders" as ModuleId
    },
    {
      label: "待发货订单",
      value: visibleOrders.filter((order) => text(order.paymentStatus) === "paid" && text(order.fulfillmentStatus) !== "success").length,
      target: "fulfillment" as ModuleId
    },
    {
      label: "待审商品",
      value: data.ownProducts.filter((item) => text(item.reviewStatus) === "pending_review").length,
      target: "products" as ModuleId
    },
    {
      label: "待处理售后",
      value: merchantSessionActive
        ? visibleOrders.filter((order) => text(order.refundStatus, "none") !== "none").length
        : data.adminAfterSales.filter((item) => text(item.status) === "pending").length,
      target: "afterSales" as ModuleId
    }
  ], [data, merchantSessionActive, visibleOrders]);

  async function loadAll(status = "数据已刷新") {
    const adminSession = api.currentAdminSession();
    const agentSession = api.currentAgentSession();
    if (!adminSession && !agentSession) {
      setSession(undefined);
      setMessage("请先登录后台");
      return;
    }
    const merchantSessionActive = Boolean(agentSession && !adminSession);
    setLoading(true);
    try {
      if (merchantSessionActive) await api.agentSession();
      else await api.adminSession();
      const optional = async <T,>(loader: () => Promise<T>, fallback: T): Promise<T> => {
        try {
          return await loader();
        } catch (error) {
          if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
            return fallback;
          }
          throw error;
        }
      };
      const shop = merchantSessionActive
        ? await optional(api.agentShop, {} as JsonRecord)
        : configuredShopId
          ? await optional(() => api.shop(configuredShopId), {} as JsonRecord)
          : {} as JsonRecord;
      const shopIdForPublicData = text(shop.id, configuredShopId);
      const loadPlatformProducts = merchantSessionActive ? api.platformProducts : api.adminPlatformProducts;
      const loadOrders = merchantSessionActive ? api.agentOrders : api.adminOrders;
      const loadCollectionChannels = merchantSessionActive ? api.agentCollectionChannels : api.collectionChannels;
      const loadAfterSales = merchantSessionActive ? api.agentAfterSales : api.adminAfterSales;
      const loadInviteCodes = merchantSessionActive ? api.agentInviteCodes : api.inviteCodes;
      const [
        platformShop,
        publicProducts,
        platformShopProducts,
        agentProducts,
        platformProducts,
        ownProducts,
        agentOrders,
        settlements,
        clawbacks,
        depositTransactions,
        adminOrders,
        agentApplications,
        inviteCodes,
        adminAfterSales,
        adminRefunds,
        adminSettlements,
        adminDeposits,
        channels,
        serviceQrCodes,
        riskFreezes,
        paymentConfigs,
        paymentVouchers,
        collectionChannels,
        coupons,
        auditLogs,
        ledgerEntries,
        reconciliation,
        rightsCodes,
        notifications,
        agentDashboard,
        riskDashboard,
        salesDashboard,
        paymentGuide
      ] = await Promise.all([
        configuredPlatformShopId ? optional(() => api.shop(configuredPlatformShopId), {}) : Promise.resolve({} as JsonRecord),
        shopIdForPublicData ? optional(() => api.shopProducts(shopIdForPublicData), []) : Promise.resolve([] as JsonRecord[]),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.adminPlatformShopProducts, []),
        optional(api.agentProducts, []),
        optional(loadPlatformProducts, []),
        merchantSessionActive ? optional(api.ownProducts, []) : optional(api.adminOwnProductReviews, []),
        optional(api.agentOrders, []),
        optional(api.agentSettlements, []),
        optional(api.agentClawbacks, []),
        merchantSessionActive ? optional(api.agentDepositTransactions, []) : Promise.resolve([] as JsonRecord[]),
        optional(loadOrders, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.agentApplications, []),
        optional(loadInviteCodes, []),
        optional(loadAfterSales, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.adminRefunds, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.adminSettlements, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.adminDeposits, []),
        merchantSessionActive ? Promise.resolve({} as JsonRecord) : optional(api.adminChannels, {}),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.serviceQrCodes, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.riskFreezes, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.paymentConfigStatus, []),
        merchantSessionActive ? optional(api.agentPaymentVouchers, []) : optional(api.paymentVouchers, []),
        optional(loadCollectionChannels, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.adminCoupons, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.auditLogs, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.ledgerEntries, []),
        merchantSessionActive ? Promise.resolve({} as JsonRecord) : optional(api.reconciliationSummary, {}),
        merchantSessionActive ? optional(() => api.agentRightsCodes(), []) : optional(api.rightsCodes, []),
        optional(api.notifications, []),
        optional(api.agentDashboard, {}),
        merchantSessionActive ? Promise.resolve({} as JsonRecord) : optional(api.riskDashboard, {}),
        merchantSessionActive ? Promise.resolve({} as JsonRecord) : optional(api.salesDashboard, {}),
        merchantSessionActive ? Promise.resolve({} as JsonRecord) : optional(api.paymentGuide, {})
      ]);
      const visiblePaymentConfigs = paymentConfigs.filter((item) => !blockedPaymentConfigChannels().includes(text(item.channel)));
      setData({
        shop,
        platformShop,
        publicProducts,
        platformShopProducts,
        agentProducts,
        platformProducts,
        ownProducts,
        agentOrders,
        settlements,
        clawbacks,
        depositTransactions,
        adminOrders,
        agentApplications,
        inviteCodes,
        adminAfterSales,
        adminRefunds,
        adminSettlements,
        adminDeposits,
        channels,
        serviceQrCodes,
        riskFreezes,
        paymentConfigs: visiblePaymentConfigs,
        paymentVouchers,
        collectionChannels,
        coupons,
        auditLogs,
        ledgerEntries,
        reconciliation,
        rightsCodes,
        notifications,
        agentDashboard,
        riskDashboard,
        salesDashboard,
        paymentGuide
      });
      const nextVisibleOrders = merchantSessionActive ? agentOrders : adminOrders;
      setCurrentOrder((order) => order ?? nextVisibleOrders.find((item) => text(item.paymentStatus) === "unpaid") ?? nextVisibleOrders[0]);
      setShopForm({
        name: text(shop.name, ""),
        announcement: text(shop.announcement, ""),
        customerServiceWechat: text(shop.customerServiceWechat, ""),
        customerServiceQrUrl: text(shop.customerServiceQrUrl, "")
      });
      setCollectionForm((current) => ({ ...current, shopId: text(shop.id, current.shopId) }));
      setInventoryForm((current) => ({ ...current, productId: current.productId || text(platformProducts[0]?.id, "") }));
      if (!merchantSessionActive) {
        setAdminAgentId((current) => current || text(agentApplications[0]?.agentId, text(adminDeposits[0]?.agentId, "")));
      }
      setMessage(status);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        api.clearAdminSession();
        api.clearAgentSession();
        setSession(undefined);
        setAuthError(error.code === "AUTH_EXPIRED" ? "登录已过期，请重新登录。" : "未登录或登录无效，请重新登录。");
        setMessage("请先登录后台");
      } else if (error instanceof ApiClientError && error.status === 403) {
        setMessage("当前账号权限不足，无法读取该后台模块。");
      } else {
        setMessage(error instanceof Error ? error.message : "加载失败");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (session) void loadAll();
  }, [session?.token]);

  useEffect(() => {
    const onHashChange = () => setActive(moduleFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  async function runAction(label: string, action: () => Promise<unknown>, refresh = true) {
    setLoading(true);
    try {
      const result = await action();
      if (isRecord(result) && result.orderNo) setCurrentOrder(result);
      if (isRecord(result) && result.afterSaleNo) setCurrentAfterSale(result);
      if (isRecord(result) && result.refundNo) setCurrentRefund(result);
      if (isRecord(result) && isRecord(result.refund)) setCurrentRefund(result.refund as JsonRecord);
      if (isRecord(result) && isRecord(result.allocation)) setCurrentAllocation(result.allocation as JsonRecord);
      if (isRecord(result) && isRecord(result.credential)) setCreatedCredential(result.credential as JsonRecord);
      setMessage(`${label}成功`);
      if (refresh) await loadAll(`${label}成功，数据已刷新`);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        api.clearAdminSession();
        api.clearAgentSession();
        setSession(undefined);
        setAuthError(error.code === "AUTH_EXPIRED" ? "登录已过期，请重新登录。" : "未登录或登录无效，请重新登录。");
        setMessage("请先登录后台");
      } else if (error instanceof ApiClientError && error.status === 403) {
        setMessage(`${label}失败：当前账号权限不足`);
      } else {
        setMessage(`${label}失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
    } finally {
      setLoading(false);
    }
  }

  async function copyShopShareUrl() {
    if (!currentShopShareUrl) {
      setMessage("当前店铺还没有可复制的分享地址");
      return;
    }
    try {
      await navigator.clipboard?.writeText(currentShopShareUrl);
      setMessage("店铺分享地址已复制");
    } catch {
      setMessage("复制失败，请手动复制店铺分享地址");
    }
  }

  async function login() {
    setLoading(true);
    setAuthError("");
    try {
      const nextSession = loginMode === "merchant"
        ? await api.agentLogin({
          account: loginForm.username.trim(),
          password: loginForm.password
        })
        : await api.adminLogin({
          username: loginForm.username.trim(),
          password: loginForm.password,
          requestedRole: loginForm.requestedRole
        });
      if (loginMode === "merchant") {
        api.clearAdminSession();
        api.saveAgentSession(nextSession as AgentSession);
      } else {
        api.clearAgentSession();
        api.saveAdminSession(nextSession as AdminSession);
      }
      setSession(nextSession);
      setMessage("登录成功，正在加载后台数据");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "登录失败");
      setMessage("请先登录后台");
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    api.clearAdminSession();
    api.clearAgentSession();
    setSession(undefined);
    setData(initialState);
    setMessage("已退出登录");
  }

  function submitPlatformProduct() {
    const error = validatePlatformProductForm(productForm);
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("创建平台商品", () => api.createPlatformProduct(productForm));
  }

  function submitRightsCodes() {
    const codes = inventoryForm.codes.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
    const targetProductId = merchantSessionActive ? text(selectedOwnAgentProduct?.id, inventoryForm.productId.trim()) : inventoryForm.productId.trim();
    const error = validateRightsCodeForm(targetProductId, inventoryForm.batchNo, codes);
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("导入卡密", () => merchantSessionActive
      ? api.importAgentRightsCodes({
        agentProductId: targetProductId,
        batchNo: inventoryForm.batchNo.trim(),
        codes
      })
      : api.importRightsCodes({
        productId: targetProductId,
        batchNo: inventoryForm.batchNo.trim(),
        codes
      }));
  }

  async function revealRightsCodes(label = "查看明文") {
    setLoading(true);
    try {
      const rows = await api.rightsCodesPlaintext();
      setSensitiveRightsCodes(rows);
      setShowSensitiveCodes(true);
      if (label === "导出明文") downloadCsv("rights-codes-plaintext.csv", rows, ["codeId", "productId", "batchNo", "status", "orderNo", "code"]);
      setMessage(`${label}已触发；生产环境需确认当前账号具备卡密明文权限，并在后端审计中保留查看/导出原因。`);
    } catch (error) {
      setMessage(`${label}失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  }

  function submitCouponTemplate() {
    const error = validateCouponForm(couponForm);
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("创建优惠券", () => api.createCouponTemplate(couponForm));
  }

  function submitAgentPrice() {
    const error = validatePositiveCents(priceCents, "代理售价");
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("保存代理售价", () => api.updateAgentProductPrice(text(selectedAgentProduct?.id, ""), priceCents));
  }

  function submitBatchSelection() {
    const items = data.platformProducts.slice(0, 2).map((item) => ({
      platformProductId: text(item.id, ""),
      salePriceCents: text(item.suggestedSalePriceCents, "")
    }));
    if (items.length === 0 || items.some((item) => !item.platformProductId || !isPositiveInteger(item.salePriceCents))) {
      setMessage("批量选品需要接口返回明确的商品ID和建议售价");
      return;
    }
    void runAction("批量选品上架", () => api.batchSelectProducts(items));
  }

  function submitRefundAction(label: string, action: () => Promise<unknown>) {
    const error = validatePositiveCents(refundCents, "退款金额");
    if (error) {
      setMessage(error);
      return;
    }
    void runAction(label, action, label !== "退款拆账");
  }

  function submitConfirmPayment() {
    const action = merchantSessionActive
      ? () => api.confirmAgentPayment(selectedOrderNo, selectedOrderAmount)
      : () => api.confirmOfflinePayment(selectedOrderNo, selectedOrderAmount);
    void runAction("人工确认收款", action);
  }

  function submitPaymentVoucherReview(approved: boolean) {
    const voucherId = text(selectedPaymentVoucher?.id, "");
    if (!voucherId) {
      setMessage("请选择待审核付款凭证");
      return;
    }
    void runAction(approved ? "付款凭证审核通过" : "付款凭证审核拒绝", () => api.reviewPaymentVoucher(voucherId, approved, paymentVoucherReason.trim()));
  }

  function submitFulfillment() {
    if (merchantSessionActive) {
      void runAction("确认发货", () => api.fulfillAgentOrder(selectedOrderNo, attemptNo));
    } else {
      void runAction("确认发货", () => api.fulfillOrder(selectedOrderNo, attemptNo));
    }
  }

  function submitManualAgent() {
    const error = validateManualAgentForm(manualAgentForm);
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("手工创建一级商户", () => api.createManualAgent(manualAgentForm));
  }

  function submitAgentInviteCode() {
    if (!merchantInviteTargetTier) {
      setMessage("三级商户不能继续创建渠道邀请码。");
      return;
    }
    void runAction("创建商户邀请码", () => api.createAgentInviteCode(inviteForm));
  }

  function submitConfirmDeposit() {
    const error = validatePositiveCents(depositConfirmCents, "确认保证金金额");
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("确认保证金", () => api.confirmDeposit(currentAgentId, depositConfirmCents));
  }

  function submitDeductDeposit() {
    const error = validatePositiveCents(depositDeductCents, "扣减保证金金额");
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("扣减保证金", () => api.deductDeposit(currentAgentId, depositDeductCents));
  }

  function submitChannelOffer(label: string) {
    const error = validatePositiveCents(channelOfferCents, "转供价");
    if (error) {
      setMessage(error);
      return;
    }
    if (merchantSessionActive) {
      void runAction(label, () => api.upsertAgentChannelOffer(downstreamAgentId, currentPlatformProductId, channelOfferCents));
    } else {
      void runAction(label, () => api.upsertChannelOffer(currentChannelRelationId, currentPlatformProductId, channelOfferCents));
    }
  }

  function switchModule(moduleId: ModuleId) {
    setActive(moduleId);
    window.history.replaceState(null, "", `#${moduleId}`);
  }

  function renderModule() {
    if (active === "dashboard") {
      return (
        <Module title="经营首页" subtitle="关键数据、待办和最快操作入口">
          <section className="metric-grid">
            {metrics.map((item) => <Metric key={item.label} {...item} />)}
          </section>
          <section className="work-grid">
            {todoItems.map((item) => (
              <button className="todo-card" key={item.label} type="button" onClick={() => switchModule(item.target)}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </button>
            ))}
          </section>
          <section className="quick-grid">
            <button type="button" onClick={() => switchModule("products")}>新增商品</button>
            <button type="button" onClick={() => switchModule("inventory")}>导入卡密</button>
            <button type="button" onClick={() => switchModule("orders")}>处理订单</button>
            <button type="button" onClick={() => switchModule("shops")}>配置收款码</button>
          </section>
          <Panel title="最近订单" kicker="运营">
            <OrdersTable rows={visibleOrders.slice(0, 6)} onPick={setCurrentOrder} />
          </Panel>
        </Module>
      );
    }

    if (active === "products") {
      return (
        <Module title="商品管理" subtitle="平台供货、自营上架、代理自有商品审核">
          <section className="split">
            {merchantSessionActive ? (
              <Panel title="平台商品选品" kicker="商户">
                <p className="hint">商户账号通过 /api/agent/products/platform 读取可选商品，不加载平台 admin 商品管理接口。</p>
                {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
                <button className="secondary" disabled={merchantBlocked || data.platformProducts.length === 0} onClick={submitBatchSelection}>批量选品上架</button>
              </Panel>
            ) : (
              <Panel title="新增平台供货商品" kicker="平台">
                <div className="form-grid">
                  <label>商品名称<input value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} placeholder="例如：会员月卡/账号成品号" /></label>
                  <label>类目<input value={productForm.category} onChange={(event) => setProductForm({ ...productForm, category: event.target.value })} placeholder="例如：AI 会员" /></label>
                  <label>标签<input value={productForm.tags} onChange={(event) => setProductForm({ ...productForm, tags: event.target.value })} placeholder="逗号分隔" /></label>
                  <label>副标题<input value={productForm.subtitle} onChange={(event) => setProductForm({ ...productForm, subtitle: event.target.value })} placeholder="一句话说明卖点" /></label>
                  <label>商品图<input value={productForm.imageUrl} onChange={(event) => setProductForm({ ...productForm, imageUrl: event.target.value })} placeholder="https://..." /></label>
                  <label>规格<textarea value={productForm.specs} onChange={(event) => setProductForm({ ...productForm, specs: event.target.value })} rows={3} placeholder="一行一个规格" /></label>
                  <label>商品说明<textarea value={productForm.description} onChange={(event) => setProductForm({ ...productForm, description: event.target.value })} rows={3} /></label>
                  <label>使用说明<textarea value={productForm.usageGuide} onChange={(event) => setProductForm({ ...productForm, usageGuide: event.target.value })} rows={3} /></label>
                  <label>详情模块<textarea value={productForm.detailSections} onChange={(event) => setProductForm({ ...productForm, detailSections: event.target.value })} rows={5} placeholder="标题：内容一；内容二" /></label>
                  <label>发货方式<select value={productForm.fulfillmentMode} onChange={(event) => setProductForm({ ...productForm, fulfillmentMode: event.target.value })}><option value="">请选择</option><option value="manual">人工交付</option><option value="code_pool">自动发码</option></select></label>
                  <label>库存<input inputMode="numeric" value={productForm.stockCount} onChange={(event) => setProductForm({ ...productForm, stockCount: event.target.value })} placeholder="必填，非负整数" /></label>
                  <label>销量<input inputMode="numeric" value={productForm.soldCount} onChange={(event) => setProductForm({ ...productForm, soldCount: event.target.value })} placeholder="选填，非负整数" /></label>
                  <label>供货价(分)<input inputMode="numeric" value={productForm.supplyPriceCents} onChange={(event) => setProductForm({ ...productForm, supplyPriceCents: event.target.value })} placeholder="必填，正整数" /></label>
                  <label>最低售价(分)<input inputMode="numeric" value={productForm.minSalePriceCents} onChange={(event) => setProductForm({ ...productForm, minSalePriceCents: event.target.value })} placeholder="必填，不低于供货价" /></label>
                  <label>建议售价(分)<input inputMode="numeric" value={productForm.suggestedSalePriceCents} onChange={(event) => setProductForm({ ...productForm, suggestedSalePriceCents: event.target.value })} placeholder="必填，不低于最低售价" /></label>
                </div>
                <div className="actions">
                  <button onClick={submitPlatformProduct}>保存并入库</button>
                  {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
                </div>
              </Panel>
            )}
            <Panel title="代理改价" kicker="商家">
              <KeyValue label="当前商品" value={text(selectedAgentProduct?.id, "暂无代理商品")} />
              <div className="inline-form">
                <label>售价(分)<input inputMode="numeric" value={priceCents} onChange={(event) => setPriceCents(event.target.value)} placeholder="必填，正整数" /></label>
                <button disabled={merchantBlocked || !selectedAgentProduct?.id} onClick={submitAgentPrice}>保存售价</button>
              </div>
            </Panel>
          </section>
          <Panel title="平台商品库" kicker={`${data.platformProducts.length} 个商品`}>
            <Table rows={data.platformProducts} columns={platformProductColumns} moneyColumns={["supplyPriceCents", "visibleUpstreamSupplyPriceCents", "minSalePriceCents", "suggestedSalePriceCents"]} />
          </Panel>
          <Panel title="店铺已上架商品" kicker={`${data.agentProducts.length} 个商品`}>
            <Table rows={agentProductRows(data.agentProducts)} columns={agentProductColumns} moneyColumns={["salePriceCents", "supplyPriceCents", "platformSupplyPriceCents", "visibleUpstreamSupplyPriceCents", "minSalePriceCents"]} />
          </Panel>
          <Panel title="代理自有商品审核" kicker="平台审核">
            <div className="actions">
              {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
              <div className="form-grid wide">
                <label>商品名称<input value={ownProductForm.name} onChange={(event) => setOwnProductForm({ ...ownProductForm, name: event.target.value })} /></label>
                <label>售价(分)<input value={ownProductForm.salePriceCents} onChange={(event) => setOwnProductForm({ ...ownProductForm, salePriceCents: event.target.value })} /></label>
                <label>最低价(分)<input value={ownProductForm.minSalePriceCents} onChange={(event) => setOwnProductForm({ ...ownProductForm, minSalePriceCents: event.target.value })} /></label>
                <label>交付方式<select value={ownProductForm.fulfillmentMode} onChange={(event) => setOwnProductForm({ ...ownProductForm, fulfillmentMode: event.target.value })}><option value="">请选择</option><option value="manual">人工交付</option><option value="code_pool">自动发码</option></select></label>
              </div>
              <button disabled={merchantBlocked || !ownProductForm.name || !ownProductForm.salePriceCents || !ownProductForm.fulfillmentMode} onClick={() => void runAction("代理提交自有商品", () => api.submitOwnProduct(ownProductForm))}>提交自有商品</button>
              {merchantSessionActive ? null : (
                <>
                  <button disabled={!selectedOwnProduct?.id} onClick={() => void runAction("自有商品审核通过", () => api.reviewOwnProduct(text(selectedOwnProduct?.id, "")))}>审核当前待审</button>
                  <button className="secondary" disabled={!selectedOwnProduct?.id} onClick={() => void runAction("自有商品审核拒绝", () => api.reviewOwnProduct(text(selectedOwnProduct?.id, ""), false))}>拒绝当前待审</button>
                </>
              )}
            </div>
            <Table rows={data.ownProducts} columns={["id", "name", "salePriceCents", "minSalePriceCents", "reviewStatus", "status"]} moneyColumns={["salePriceCents", "minSalePriceCents"]} />
            {!merchantSessionActive ? <p className="hint">平台后台通过 /api/admin/agent-products/reviews 拉取审核队列，审核动作走 /api/admin/agent-products/reviews/:id/review，并由后端 RBAC 校验 product.manage。</p> : null}
          </Panel>
        </Module>
      );
    }

    if (active === "inventory") {
      if (merchantSessionActive) {
        return (
          <Module title="库存卡密" subtitle="商户自有自动发码商品的库存管理">
            <section className="split">
              <Panel title="导入自有商品卡密" kicker="商户库存">
                <p className="hint">只能给本商户已审核通过、且交付方式为自动发码的自有商品导入；列表默认脱敏，不提供商户明文查看。</p>
                <div className="form-grid wide">
                  <label>自有上架商品
                    <select value={text(selectedOwnAgentProduct?.id, "")} onChange={(event) => setInventoryForm({ ...inventoryForm, productId: event.target.value })}>
                      {data.agentProducts.filter((item) => text(item.productType) === "agent_owned").map((item) => (
                        <option key={text(item.id)} value={text(item.id)}>{text((item.product as JsonRecord | undefined)?.name, text(item.id))}</option>
                      ))}
                    </select>
                  </label>
                  <label>批次号<input value={inventoryForm.batchNo} onChange={(event) => setInventoryForm({ ...inventoryForm, batchNo: event.target.value })} /></label>
                  <label className="span-2">卡密/账号<textarea value={inventoryForm.codes} onChange={(event) => setInventoryForm({ ...inventoryForm, codes: event.target.value })} rows={6} placeholder="一行一个卡密/账号" /></label>
                </div>
                <button disabled={!selectedOwnAgentProduct?.id || merchantBlocked} onClick={submitRightsCodes}>导入库存</button>
              </Panel>
              <Panel title="库存概况" kicker="脱敏">
                <KeyValue label="卡密总数" value={String(data.rightsCodes.length)} />
                <KeyValue label="可用" value={String(data.rightsCodes.filter((item) => text(item.status) === "available").length)} />
                <KeyValue label="已发放" value={String(data.rightsCodes.filter((item) => text(item.status) === "issued").length)} />
              </Panel>
            </section>
            <Panel title="自有卡密明细" kicker="默认脱敏">
              <Table rows={data.rightsCodes.slice(0, 12)} columns={["codeId", "productId", "codePreview", "batchNo", "status", "orderNo"]} />
            </Panel>
          </Module>
        );
      }
      return (
        <Module title="库存卡密" subtitle="自动发码商品的卡密导入、库存和发放状态">
          <section className="split">
            <Panel title="导入卡密" kicker="库存">
              <div className="form-grid wide">
                <label>商品ID<input value={inventoryForm.productId} onChange={(event) => setInventoryForm({ ...inventoryForm, productId: event.target.value })} /></label>
                <label>批次号<input value={inventoryForm.batchNo} onChange={(event) => setInventoryForm({ ...inventoryForm, batchNo: event.target.value })} /></label>
                <label className="span-2">卡密/账号<textarea value={inventoryForm.codes} onChange={(event) => setInventoryForm({ ...inventoryForm, codes: event.target.value })} rows={6} placeholder="一行一个卡密/账号，必填" /></label>
              </div>
              <button onClick={submitRightsCodes}>导入库存</button>
            </Panel>
            <Panel title="库存概况" kicker="实时">
              <KeyValue label="卡密总数" value={String(data.rightsCodes.length)} />
              <KeyValue label="可用" value={String(data.rightsCodes.filter((item) => text(item.status) === "available").length)} />
              <KeyValue label="已发放" value={String(data.rightsCodes.filter((item) => text(item.status) === "issued").length)} />
            </Panel>
          </section>
          <Panel title="卡密明细" kicker="默认脱敏">
            <p className="hint">默认只展示批次、状态、商品和订单归属；查看或导出明文需单独操作并按审计要求留痕。</p>
            <div className="actions">
              <button className="secondary" onClick={() => downloadCsv("rights-codes-masked.csv", data.rightsCodes, ["codeId", "productId", "batchNo", "status", "orderNo", "codePreview"])}>导出脱敏</button>
              <button className="secondary" onClick={() => void revealRightsCodes()}>查看明文</button>
              <button className="secondary" onClick={() => void revealRightsCodes("导出明文")}>导出明文</button>
            </div>
            <Table rows={(showSensitiveCodes ? sensitiveRightsCodes : data.rightsCodes).slice(0, 12)} columns={showSensitiveCodes ? ["codeId", "productId", "batchNo", "status", "orderNo", "code"] : ["codeId", "productId", "batchNo", "status", "orderNo"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "coupons") {
      if (merchantSessionActive) {
        return (
          <Module title="优惠券" subtitle="商户后台优惠券只读占位">
            <Panel title="优惠券权限" kicker="商户后台">
              <p className="hint">优惠券模板由平台后台管理；商户态不调用 /api/admin/coupons 创建、停用或启用券模板。</p>
            </Panel>
          </Module>
        );
      }
      const selectedCoupon = data.coupons[0];
      return (
        <Module title="优惠券" subtitle="平台券模板、注册赠券和商品适用范围">
          <section className="split">
            <Panel title="创建优惠券模板" kicker="平台补贴">
              <div className="form-grid wide">
                <label>名称<input value={couponForm.name} onChange={(event) => setCouponForm({ ...couponForm, name: event.target.value })} placeholder="必填" /></label>
                <label>抵扣金额(分)<input inputMode="numeric" value={couponForm.discountCents} onChange={(event) => setCouponForm({ ...couponForm, discountCents: event.target.value })} placeholder="必填，正整数" /></label>
                <label>有效天数<input value={couponForm.validDays} onChange={(event) => setCouponForm({ ...couponForm, validDays: event.target.value })} /></label>
                <label>状态<select value={couponForm.status} onChange={(event) => setCouponForm({ ...couponForm, status: event.target.value })}><option value="">请选择</option><option value="active">启用</option><option value="disabled">停用</option></select></label>
                <label className="span-2">适用平台商品ID<textarea rows={3} value={couponForm.productIds} onChange={(event) => setCouponForm({ ...couponForm, productIds: event.target.value })} placeholder="为空表示不限商品；一行一个商品ID" /></label>
                <label className="checkbox-line"><input type="checkbox" checked={couponForm.grantOnFirstRegister} onChange={(event) => setCouponForm({ ...couponForm, grantOnFirstRegister: event.target.checked })} />首次注册自动赠送</label>
              </div>
              <div className="actions">
                <button onClick={submitCouponTemplate}>保存优惠券</button>
                <button className="secondary" disabled={!selectedCoupon?.id} onClick={() => void runAction("停用优惠券", () => api.updateCouponTemplateStatus(text(selectedCoupon?.id, ""), "disabled"))}>停用首条</button>
                <button className="secondary" disabled={!selectedCoupon?.id} onClick={() => void runAction("启用优惠券", () => api.updateCouponTemplateStatus(text(selectedCoupon?.id, ""), "active"))}>启用首条</button>
              </div>
            </Panel>
            <Panel title="优惠券规则" kicker="验收">
              <KeyValue label="券模板" value={String(data.coupons.length)} />
              <KeyValue label="注册赠券" value={String(data.coupons.filter((item) => item.grantOnFirstRegister).length)} />
              <KeyValue label="启用中" value={String(data.coupons.filter((item) => text(item.status) === "active").length)} />
            </Panel>
          </section>
          <Panel title="优惠券列表" kicker={`${data.coupons.length} 个模板`}>
            <Table rows={data.coupons} columns={["id", "name", "discountCents", "validDays", "grantOnFirstRegister", "productIds", "status"]} moneyColumns={["discountCents"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "orders") {
      return (
        <Module title="订单管理" subtitle="查单、人工确认收款、订单履约流转">
          <section className="split">
            <Panel title="当前订单" kicker={selectedOrderNo || "未选择"}>
              <KeyValue label="订单号" value={selectedOrderNo || "暂无订单"} />
              <KeyValue label="金额" value={cents(selectedOrderAmount)} />
              <KeyValue label="支付状态" value={text(selectedOrder?.paymentStatus)} />
              <KeyValue label="履约状态" value={text(selectedOrder?.fulfillmentStatus)} />
              <KeyValue label="收款通道" value={collectionChannelLabel(selectedOrder)} />
              <KeyValue label="凭证状态" value={selectedOrderPaymentVouchers.length > 0 ? selectedOrderPaymentVouchers.map((item) => text(item.status)).join("、") : text(selectedOrder?.paymentVoucherStatus, "暂无凭证")} />
              <div className="actions">
                <button disabled={!selectedOrderNo || text(selectedOrder?.paymentStatus) === "paid"} onClick={submitConfirmPayment}>人工确认收款</button>
                <button className="secondary" disabled={!selectedOrderNo} onClick={() => switchModule("fulfillment")}>去发货</button>
              </div>
            </Panel>
            <Panel title="操作说明" kicker="生产">
              <p className="hint">生产后台不提供快捷写单入口。订单必须由 H5 买家端按当前店铺、商品、收款通道和后端价格规则创建；商户账号只处理自己店铺订单。</p>
            </Panel>
          </section>
          <Panel title="订单列表" kicker={`${visibleOrders.length} 笔`}>
            <OrdersTable rows={visibleOrders} onPick={setCurrentOrder} />
          </Panel>
          <Panel title="付款凭证" kicker={merchantSessionActive ? "商户 scoped 查看" : "平台审核"}>
            {merchantSessionActive ? <p className="hint">商户态通过 /api/agent/payment-vouchers 只读取自己店铺的付款凭证；审核仍由平台后台完成。</p> : null}
            <Table rows={selectedOrderNo ? selectedOrderPaymentVouchers : data.paymentVouchers} columns={["id", "orderNo", "shopId", "amountCents", "channel", "payerName", "voucherUrl", "note", "status", "reviewedBy"]} moneyColumns={["amountCents"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "fulfillment") {
      return (
        <Module title="发货管理" subtitle="自动发码和人工交付都在这里处理">
          <section className="split">
            <Panel title="发货操作" kicker="履约">
              <KeyValue label="订单" value={selectedOrderNo || "暂无订单"} />
              <KeyValue label="当前状态" value={text(selectedOrder?.fulfillmentStatus)} />
              <div className="inline-form">
                <label>尝试次数<input value={String(attemptNo)} onChange={(event) => setAttemptNo(Number(event.target.value) || 1)} /></label>
                <button disabled={!selectedOrderNo || text(selectedOrder?.paymentStatus) !== "paid"} onClick={submitFulfillment}>确认发货</button>
              </div>
              {merchantSessionActive ? <p className="hint">商户态调用 /api/agent/orders/:orderNo/fulfillment，不使用平台 admin 发货接口。</p> : null}
            </Panel>
            <Panel title="待发货" kicker="已收款未完成">
              <OrdersTable rows={visibleOrders.filter((order) => text(order.paymentStatus) === "paid" && text(order.fulfillmentStatus) !== "success").slice(0, 6)} onPick={setCurrentOrder} />
            </Panel>
          </section>
        </Module>
      );
    }

    if (active === "afterSales") {
      return (
        <Module title="售后退款" subtitle="售后申请、责任拆账、退款建单">
          <section className="split">
            <Panel title="售后处理" kicker="运营">
              <KeyValue label="当前订单" value={selectedOrderNo || "暂无订单"} />
              <KeyValue label="售后单" value={text(currentAfterSale?.afterSaleNo, "暂无")} />
              <KeyValue label="退款单" value={text(currentRefund?.refundNo, "暂无")} />
              {merchantSessionActive ? (
                <>
                  <p className="hint">商户态调用 /api/agent/after-sales 查看自己的售后，不暴露平台退款拆账、审批和人工退款确认动作。</p>
                  <div className="inline-form">
                    <label>协处理说明<input value={afterSaleAssistNote} onChange={(event) => setAfterSaleAssistNote(event.target.value)} placeholder="填写处理说明或凭证备注" /></label>
                    <button disabled={!selectedAfterSaleNo(data.adminAfterSales, currentAfterSale) || !afterSaleAssistNote.trim()} onClick={() => void runAction("售后协处理", () => api.assistAgentAfterSale(selectedAfterSaleNo(data.adminAfterSales, currentAfterSale), afterSaleAssistNote.trim()))}>提交协处理</button>
                  </div>
                </>
              ) : (
                <>
                  <KeyValue label="最近拆账" value={currentAllocation ? `平台 ${cents(currentAllocation.platformBearCents)} / 代理 ${cents(currentAllocation.agentBearCents)}` : "暂无"} />
                  <div className="inline-form">
                    <label>金额(分)<input inputMode="numeric" value={refundCents} onChange={(event) => setRefundCents(event.target.value)} placeholder="必填，正整数" /></label>
                  </div>
                  <div className="actions">
                    <button disabled={!selectedOrderNo || text(selectedOrder?.paymentStatus) !== "paid"} onClick={() => submitRefundAction("提交售后", () => api.createAfterSale(selectedOrderNo, refundCents))}>提交售后</button>
                    <button disabled={!selectedOrderNo} onClick={() => submitRefundAction("退款拆账", () => api.allocateRefund(selectedOrder ?? {}, refundCents, "mixed"))}>拆账预览</button>
                    <button disabled={!currentAfterSale?.afterSaleNo} onClick={() => submitRefundAction("审批退款", () => api.createRefund(text(currentAfterSale?.afterSaleNo, ""), selectedOrder ?? {}, refundCents, "mixed"))}>审批退款</button>
                    <label>退款凭证<input value={refundVoucher} onChange={(event) => setRefundVoucher(event.target.value)} placeholder="必填，人工退款流水/凭证号" /></label>
                    <button className="secondary" disabled={!currentRefund?.refundNo || !refundVoucher.trim()} onClick={() => void runAction("人工退款确认", () => api.confirmRefund(text(currentRefund?.refundNo, ""), refundVoucher.trim()))}>确认退款成功</button>
                  </div>
                </>
              )}
            </Panel>
            <Panel title="售后列表" kicker={merchantSessionActive ? `${data.adminAfterSales.length} 单` : `${data.adminAfterSales.length} 单`}>
              {merchantSessionActive
                ? <Table rows={data.adminAfterSales} columns={["afterSaleNo", "orderNo", "status", "reasonCode", "requestedRefundCents"]} moneyColumns={["requestedRefundCents"]} />
                : <Table rows={data.adminAfterSales} columns={["afterSaleNo", "orderNo", "status", "reasonCode", "requestedRefundCents"]} moneyColumns={["requestedRefundCents"]} />}
            </Panel>
          </section>
        </Module>
      );
    }

    if (active === "sales") {
      return (
        <Module title="销售统计" subtitle="订单、商品、店铺销售表现">
          <section className="metric-grid">
            <Metric label="销售额" value={merchantSessionActive ? cents(data.agentDashboard?.gmvCents) : cents(data.salesDashboard?.totalPaidCents)} tone="strong" />
            <Metric label="成交订单" value={merchantSessionActive ? text(data.agentDashboard?.paidOrderCount, "0") : text(data.salesDashboard?.paidOrderCount, "0")} />
            <Metric label="履约成功" value={merchantSessionActive ? text(data.agentDashboard?.fulfilledOrderCount, "0") : text(data.salesDashboard?.fulfilledOrderCount, "0")} />
            <Metric label={merchantSessionActive ? "预估收益" : "服务费"} value={merchantSessionActive ? cents(data.agentDashboard?.expectedIncomeCents) : cents(data.reconciliation?.totalServiceFeeCents)} />
            {merchantSessionActive ? <Metric label="保证金可用" value={cents(data.agentDashboard?.depositAvailableCents)} /> : null}
            {merchantSessionActive ? <Metric label="未读通知" value={text(data.agentDashboard?.noticeCount, "0")} /> : null}
          </section>
          {merchantSessionActive ? (
            <Panel title="商户订单" kicker="当前店铺">
              <OrdersTable rows={data.agentOrders} onPick={setCurrentOrder} />
            </Panel>
          ) : (
            <>
              <Panel title="商品销售" kicker="商品维度">
                <Table rows={arrayValue(data.salesDashboard?.productRows)} columns={["productId", "name", "category", "fulfillmentMode", "stockCount", "soldCount", "paidOrderCount", "totalPaidCents", "availableCodeCount", "issuedCodeCount"]} moneyColumns={["totalPaidCents"]} />
              </Panel>
              <Panel title="店铺销售" kicker="店铺维度">
                <Table rows={arrayValue(data.salesDashboard?.shopRows)} columns={["shopId", "name", "ownerType", "orderCount", "paidOrderCount", "totalPaidCents"]} moneyColumns={["totalPaidCents"]} />
              </Panel>
            </>
          )}
        </Module>
      );
    }

    if (active === "shops") {
      return (
        <Module title="店铺设置" subtitle="商家页面、客服二维码、人工收款码">
          <section className="split">
            <Panel title="店铺资料" kicker="商家">
              <div className="share-box">
                <span>店铺分享地址</span>
                <div>
                  <input value={currentShopShareUrl || "店铺加载后自动生成"} readOnly />
                  {currentShopShareUrl ? <button type="button" onClick={() => void copyShopShareUrl()}>复制</button> : null}
                  {currentShopShareUrl ? <a href={currentShopShareUrl} target="_blank" rel="noreferrer">打开</a> : null}
                </div>
              </div>
              <div className="form-grid wide">
                <label>店铺名称<input value={shopForm.name} onChange={(event) => setShopForm({ ...shopForm, name: event.target.value })} /></label>
                <label>客服微信<input value={shopForm.customerServiceWechat} onChange={(event) => setShopForm({ ...shopForm, customerServiceWechat: event.target.value })} /></label>
                <label className="span-2">客服二维码<input value={shopForm.customerServiceQrUrl} onChange={(event) => setShopForm({ ...shopForm, customerServiceQrUrl: event.target.value })} /></label>
                <label className="span-2">店铺公告<textarea rows={3} value={shopForm.announcement} onChange={(event) => setShopForm({ ...shopForm, announcement: event.target.value })} /></label>
              </div>
              <button onClick={() => void runAction("保存店铺资料", () => api.saveAgentShop(shopForm.name, shopForm.announcement, shopForm.customerServiceWechat, shopForm.customerServiceQrUrl))}>保存店铺</button>
            </Panel>
            <Panel title="人工收款码" kicker="商家">
              <div className="form-grid wide">
                <label>店铺ID<input value={collectionForm.shopId} onChange={(event) => setCollectionForm({ ...collectionForm, shopId: event.target.value })} /></label>
                <label>收款账户<input value={collectionForm.collectionAccountName} onChange={(event) => setCollectionForm({ ...collectionForm, collectionAccountName: event.target.value })} /></label>
                <label className="span-2">收款码URL<input value={collectionForm.collectionQrUrl} onChange={(event) => setCollectionForm({ ...collectionForm, collectionQrUrl: event.target.value })} /></label>
                <label className="span-2">收款说明<input value={collectionForm.collectionNote} onChange={(event) => setCollectionForm({ ...collectionForm, collectionNote: event.target.value })} /></label>
              </div>
              {merchantSessionActive
                ? <p className="hint">商户收款通道请使用下方提交审核入口；商户态不调用平台 admin 店铺收款码接口。</p>
                : <button onClick={() => void runAction("保存人工收款码", () => api.saveCollectionChannel(collectionForm.shopId, collectionForm.collectionAccountName, collectionForm.collectionQrUrl, collectionForm.collectionNote))}>保存收款码</button>}
            </Panel>
            <Panel title="收款通道提交/审核" kicker="商户+平台">
              <div className="form-grid wide">
                <label>通道类型<select value={collectionChannelForm.channelType} onChange={(event) => setCollectionChannelForm({ ...collectionChannelForm, channelType: event.target.value })}><option value="">请选择</option><option value="alipay_personal_qr">支付宝个人码</option><option value="alipay_merchant_qr">支付宝商户码</option><option value="wechat_personal_qr">微信个人码</option><option value="wechat_merchant_qr">微信商户码</option></select></label>
                <label>展示名称<input value={collectionChannelForm.displayName} onChange={(event) => setCollectionChannelForm({ ...collectionChannelForm, displayName: event.target.value })} /></label>
                <label>账户名<input value={collectionChannelForm.accountName} onChange={(event) => setCollectionChannelForm({ ...collectionChannelForm, accountName: event.target.value })} /></label>
                <label>收款码URL<input value={collectionChannelForm.qrUrl} onChange={(event) => setCollectionChannelForm({ ...collectionChannelForm, qrUrl: event.target.value })} /></label>
                <label className="span-2">支付链接<input value={collectionChannelForm.paymentUrl} onChange={(event) => setCollectionChannelForm({ ...collectionChannelForm, paymentUrl: event.target.value })} /></label>
              </div>
              <div className="actions">
                <button disabled={!collectionChannelForm.channelType || !collectionChannelForm.displayName || (!collectionChannelForm.qrUrl && !collectionChannelForm.paymentUrl)} onClick={() => void runAction("提交收款通道", () => api.submitCollectionChannel(collectionChannelForm))}>提交审核</button>
                {merchantSessionActive ? null : (
                  <>
                    <button disabled={!pendingCollectionChannel?.id} onClick={() => void runAction("审核通过收款通道", () => api.reviewCollectionChannel(text(pendingCollectionChannel?.id, ""), true))}>审核通过</button>
                    <button className="secondary" disabled={!pendingCollectionChannel?.id} onClick={() => void runAction("审核拒绝收款通道", () => api.reviewCollectionChannel(text(pendingCollectionChannel?.id, ""), false))}>审核拒绝</button>
                  </>
                )}
              </div>
            </Panel>
          </section>
          <Panel title="店铺清单" kicker="客服/收款">
            <Table rows={data.collectionChannels} columns={["shopId", "ownerType", "name", "collectionAccountName", "collectionQrUrl", "collectionNote", "status"]} />
          </Panel>
          {merchantSessionActive ? null : (
            <Panel title="客服二维码" kicker={`${data.serviceQrCodes.length} 条`}>
              <Table rows={data.serviceQrCodes} columns={["shopId", "ownerType", "name", "customerServiceWechat", "customerServiceQrUrl", "status"]} />
            </Panel>
          )}
        </Module>
      );
    }

    if (active === "agents") {
      if (merchantSessionActive) {
        return (
          <Module title="商户/渠道" subtitle="商户账号仅查看自身状态和可用能力">
            <section className="split">
              <Panel title="商户状态" kicker="当前账号">
                <KeyValue label="商户ID" value={currentAgentId || "未知"} />
                <KeyValue label="店铺ID" value={currentShopId || "未知"} />
                <KeyValue label="商户层级" value={text(currentAgentTier, "未知")} />
                <KeyValue label="保证金状态" value={text(currentDepositStatus, "未知")} />
                {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
              </Panel>
              <Panel title="渠道能力" kicker="商户后台">
                <p className="hint">{canConfigureDownstreamOffer ? "当前层级可在二级渠道管理中配置下游转供价。" : "三级商户不展示下游转供配置；商户态不调用平台 /api/admin/channels。"}</p>
              </Panel>
            </section>
          </Module>
        );
      }
      return (
        <Module title="商户/渠道" subtitle="入驻审核、保证金、一级商户与受控转供价">
          <section className="split">
            <Panel title="入驻审核" kicker="运营">
              <div className="inline-form">
                <label>当前操作商户ID<input value={adminAgentId} onChange={(event) => setAdminAgentId(event.target.value)} placeholder="从申请/保证金列表选择或填写" /></label>
              </div>
              <div className="form-grid wide">
                <label>邀请码<input value={applicationForm.inviteCode} onChange={(event) => setApplicationForm({ ...applicationForm, inviteCode: event.target.value })} /></label>
                <label>联系电话<input value={applicationForm.contactPhone} onChange={(event) => setApplicationForm({ ...applicationForm, contactPhone: event.target.value })} /></label>
                <label>客服微信<input value={applicationForm.customerServiceWechat} onChange={(event) => setApplicationForm({ ...applicationForm, customerServiceWechat: event.target.value })} /></label>
              </div>
              <div className="actions">
                <button disabled={!applicationForm.contactPhone || !applicationForm.customerServiceWechat} onClick={() => void runAction("提交商户入驻", () => api.submitAgentApplication(applicationForm))}>提交入驻</button>
                <button disabled={!currentAgentId} onClick={() => void runAction("商户审核通过", () => api.reviewAgent(currentAgentId, true, "资料通过"))}>通过当前商户</button>
                <button className="secondary" disabled={!currentAgentId} onClick={() => void runAction("商户审核拒绝", () => api.reviewAgent(currentAgentId, false, "资料需补充"))}>拒绝当前</button>
              </div>
              <Table rows={data.agentApplications} columns={["applicationNo", "agentId", "status", "contactPhone", "customerServiceWechat"]} onPick={(row) => setAdminAgentId(text(row.agentId, ""))} />
            </Panel>
            <Panel title="平台邀请码" kicker="入驻通道">
              <div className="form-grid wide">
                <label>邀请码<input value={inviteForm.code} onChange={(event) => setInviteForm({ ...inviteForm, code: event.target.value })} placeholder="不填则由后端生成" /></label>
                <label>目标层级<select value={inviteForm.targetTier} onChange={(event) => setInviteForm({ ...inviteForm, targetTier: event.target.value })}><option value="first_tier">一级商户</option></select></label>
                <label>应缴保证金(分)<input inputMode="numeric" value={inviteForm.depositRequiredAmountCents} onChange={(event) => setInviteForm({ ...inviteForm, depositRequiredAmountCents: event.target.value })} placeholder="由平台填写" /></label>
                <label>最大使用次数<input inputMode="numeric" value={inviteForm.maxUses} onChange={(event) => setInviteForm({ ...inviteForm, maxUses: event.target.value })} /></label>
                <label>失效时间<input type="datetime-local" value={inviteForm.expiresAt} onChange={(event) => setInviteForm({ ...inviteForm, expiresAt: event.target.value })} /></label>
              </div>
              <button disabled={!inviteForm.depositRequiredAmountCents} onClick={() => void runAction("创建平台邀请码", () => api.createInviteCode(inviteForm))}>创建邀请码</button>
              <Table rows={data.inviteCodes} columns={["id", "code", "targetTier", "status", "maxUses", "usedCount", "depositRequiredAmountCents", "expiresAt"]} moneyColumns={["depositRequiredAmountCents"]} />
            </Panel>
            <Panel title="手工创建一级商户" kicker="平台">
              <div className="form-grid wide">
                <label>商户名称<input value={manualAgentForm.name} onChange={(event) => setManualAgentForm({ ...manualAgentForm, name: event.target.value })} /></label>
                <label>店铺名称<input value={manualAgentForm.shopName} onChange={(event) => setManualAgentForm({ ...manualAgentForm, shopName: event.target.value })} /></label>
                <label>联系电话<input value={manualAgentForm.contactPhone} onChange={(event) => setManualAgentForm({ ...manualAgentForm, contactPhone: event.target.value })} /></label>
                <label>客服微信<input value={manualAgentForm.customerServiceWechat} onChange={(event) => setManualAgentForm({ ...manualAgentForm, customerServiceWechat: event.target.value })} /></label>
                <label>初始密码<input value={manualAgentForm.initialPassword} onChange={(event) => setManualAgentForm({ ...manualAgentForm, initialPassword: event.target.value })} /></label>
                <label>保证金(分)<input inputMode="numeric" value={manualAgentForm.depositRequiredAmountCents} onChange={(event) => setManualAgentForm({ ...manualAgentForm, depositRequiredAmountCents: event.target.value })} placeholder="必填，正整数" /></label>
                <label className="checkbox-line"><input type="checkbox" checked={manualAgentForm.depositPaid} onChange={(event) => setManualAgentForm({ ...manualAgentForm, depositPaid: event.target.checked })} />创建时已确认保证金</label>
              </div>
              <button disabled={!manualAgentForm.name || !manualAgentForm.shopName} onClick={submitManualAgent}>创建一级商户</button>
              {createdCredential ? (
                <div className="hint-box">
                  <strong>初始账号</strong>
                  <span>账号：{text(createdCredential.account)} / 初始密码：{text(createdCredential.initialPassword)}</span>
                  <small>请按线下交付流程给商户，首次登录后按平台安全要求处理。</small>
                </div>
              ) : null}
            </Panel>
            <Panel title="保证金" kicker="财务">
              <KeyValue label="当前商户" value={currentAgentId || "请先选择商户"} />
              <div className="inline-form">
                <label>确认金额(分)<input inputMode="numeric" value={depositConfirmCents} onChange={(event) => setDepositConfirmCents(event.target.value)} placeholder="必填" /></label>
                <label>扣减金额(分)<input inputMode="numeric" value={depositDeductCents} onChange={(event) => setDepositDeductCents(event.target.value)} placeholder="必填" /></label>
              </div>
              <div className="actions">
                <button disabled={!currentAgentId} onClick={submitConfirmDeposit}>确认保证金</button>
                <button className="secondary" disabled={!currentAgentId} onClick={submitDeductDeposit}>扣减保证金</button>
              </div>
              <Table rows={data.adminDeposits} columns={["agentId", "requiredAmountCents", "availableAmountCents", "status"]} moneyColumns={["requiredAmountCents", "availableAmountCents"]} onPick={(row) => setAdminAgentId(text(row.agentId, ""))} />
            </Panel>
          </section>
          <Panel title="保证金全状态" kicker="平台核对">
            <section className="metric-grid">
              {depositStatusRows(data.adminDeposits).map((item) => <Metric key={item.label} label={item.label} value={item.value} />)}
            </section>
          </Panel>
          <Panel title="渠道供货" kicker="价差供货">
            <div className="actions">
              {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
              <button disabled={merchantBlocked || !currentAgentId} onClick={() => void runAction("开通渠道供货能力", () => api.reviewChannel(currentAgentId))}>开通能力</button>
              <button className="secondary" disabled={merchantBlocked || !currentAgentId || !peerAgentId} onClick={() => void runAction("创建二级关系", () => api.createChannelRelation(currentAgentId, peerAgentId))}>绑定一级/二级</button>
              <label>转供价(分)<input inputMode="numeric" value={channelOfferCents} onChange={(event) => setChannelOfferCents(event.target.value)} placeholder="必填" /></label>
              <button className="secondary" disabled={merchantBlocked || !currentChannelRelationId || !currentPlatformProductId} onClick={() => submitChannelOffer("配置转供价")}>配置转供价</button>
            </div>
            <Table rows={channelRows(data.channels, "relations")} columns={["id", "firstTierAgentId", "secondTierAgentId", "status"]} />
            <Table rows={channelRows(data.channels, "offers")} columns={["id", "channelRelationId", "platformProductId", "resellSupplyPriceCents", "status"]} moneyColumns={["resellSupplyPriceCents"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "secondTierChannels") {
      if (merchantSessionActive) {
        return (
          <Module title="二级渠道管理" subtitle="商户侧只展示授权商品和后端允许的转供能力">
            <section className="split">
              <Panel title="商户授权商品" kicker="商户后台">
                <KeyValue label="商户层级" value={text(currentAgentTier, "未知")} />
                <KeyValue label="保证金状态" value={text(currentDepositStatus, "未知")} />
                <KeyValue label="可售商品" value={String(data.agentProducts.filter((item) => text(item.status) === "listed").length)} />
                <KeyValue label="待清算订单" value={String(data.agentOrders.filter((item) => text(item.settlementStatus) !== "settled").length)} />
                {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
              </Panel>
              <Panel title="商户邀请码" kicker={merchantInviteTargetTier ? `创建 ${merchantInviteTargetTier}` : "三级不可创建"}>
                {merchantInviteTargetTier ? (
                  <>
                    <div className="form-grid wide">
                      <label>邀请码<input value={inviteForm.code} onChange={(event) => setInviteForm({ ...inviteForm, code: event.target.value })} placeholder="不填则由后端生成" /></label>
                      <label>目标层级<input value={merchantInviteTargetTier} readOnly /></label>
                      <label>最大使用次数<input inputMode="numeric" value={inviteForm.maxUses} onChange={(event) => setInviteForm({ ...inviteForm, maxUses: event.target.value })} placeholder="选填，正整数" /></label>
                      <label>失效时间<input type="datetime-local" value={inviteForm.expiresAt} onChange={(event) => setInviteForm({ ...inviteForm, expiresAt: event.target.value })} /></label>
                      <label>保证金要求(分)<input inputMode="numeric" value={inviteForm.depositRequiredAmountCents} onChange={(event) => setInviteForm({ ...inviteForm, depositRequiredAmountCents: event.target.value })} placeholder="选填，后端可按规则生成" /></label>
                    </div>
                    <button disabled={merchantBlocked} onClick={submitAgentInviteCode}>创建邀请码</button>
                  </>
                ) : (
                  <p className="warning">三级商户不能继续创建渠道邀请码。</p>
                )}
              </Panel>
              <Panel title="转供价配置" kicker="待后端 scoped API">
                <p className="hint">前端已隔离平台 admin 渠道接口。商户配置转供价调用 /api/agent/channels/offers；跨关系由后端返回 4xx。</p>
                {canConfigureDownstreamOffer ? (
                  <div className="inline-form">
                    <label>下游商户ID<input value={downstreamAgentId} onChange={(event) => setDownstreamAgentId(event.target.value)} placeholder={currentAgentTier === "first_tier" ? "二级商户ID" : "三级商户ID"} /></label>
                    <label>转供价(分)<input inputMode="numeric" value={channelOfferCents} onChange={(event) => setChannelOfferCents(event.target.value)} placeholder="必填" /></label>
                    <button className="secondary" disabled={merchantBlocked || !downstreamAgentId.trim() || !currentPlatformProductId} onClick={() => submitChannelOffer("配置商户转供价")}>配置转供价</button>
                  </div>
                ) : (
                  <p className="warning">三级商户不能继续配置下游转供价。</p>
                )}
              </Panel>
            </section>
            <Panel title="我的邀请码" kicker={`${data.inviteCodes.length} 条`}>
              <Table rows={data.inviteCodes} columns={["id", "code", "targetTier", "status", "maxUses", "usedCount", "depositRequiredAmountCents", "expiresAt"]} moneyColumns={["depositRequiredAmountCents"]} />
            </Panel>
          </Module>
        );
      }
      return (
        <Module title="二级渠道管理" subtitle="平台配置二级供货关系，商户侧查看授权商品与转供价">
          <section className="split">
            <Panel title="平台二级渠道操作" kicker="平台后台">
              <div className="actions">
                {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
                <button disabled={merchantBlocked || !currentAgentId} onClick={() => void runAction("开通渠道供货能力", () => api.reviewChannel(currentAgentId))}>开通二级供货能力</button>
                <button className="secondary" disabled={merchantBlocked || !currentAgentId || !peerAgentId} onClick={() => void runAction("创建二级渠道关系", () => api.createChannelRelation(currentAgentId, peerAgentId))}>绑定一级/二级商户</button>
                <label>转供价(分)<input inputMode="numeric" value={channelOfferCents} onChange={(event) => setChannelOfferCents(event.target.value)} placeholder="必填" /></label>
                <button className="secondary" disabled={merchantBlocked || !currentChannelRelationId || !currentPlatformProductId} onClick={() => submitChannelOffer("配置二级转供价")}>配置二级转供价</button>
              </div>
              <Table rows={channelRows(data.channels, "relations")} columns={["id", "firstTierAgentId", "secondTierAgentId", "status"]} />
            </Panel>
            <Panel title="商户授权商品" kicker="商户后台">
              <KeyValue label="保证金状态" value={text(currentDeposit?.status, "未知")} />
              <KeyValue label="可售商品" value={String(data.agentProducts.filter((item) => text(item.status) === "listed").length)} />
              <KeyValue label="待清算订单" value={String(data.agentOrders.filter((item) => text(item.settlementStatus) !== "settled").length)} />
              {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
            </Panel>
          </section>
          <Panel title="转供价记录" kicker="平台/商户均按权限读取">
            <Table rows={channelRows(data.channels, "offers")} columns={["id", "channelRelationId", "platformProductId", "resellSupplyPriceCents", "status"]} moneyColumns={["resellSupplyPriceCents"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "settlements") {
      return (
        <Module title="结算管理" subtitle="T+1 结算、人工打款、账务流水">
          <section className="split">
            <Panel title="结算操作" kicker="财务">
              <KeyValue label="待打款单" value={text(selectedSettlement?.settlementNo, "暂无")} />
              <KeyValue label="当前订单结算" value={text(selectedOrder?.settlementStatus)} />
              {merchantSessionActive
                ? <p className="hint">商户态只查看自己的结算和追扣记录，不提供生成结算单或确认打款动作。</p>
                : (
                  <div className="actions">
                    <button disabled={!currentAgentId} onClick={() => void runAction("生成 T+1 结算单", () => api.generateSettlement(currentAgentId))}>生成结算单</button>
                    <button disabled={!selectedSettlement?.settlementNo} onClick={() => void runAction("人工打款确认", () => api.confirmPayout(text(selectedSettlement?.settlementNo, "")))}>确认打款</button>
                  </div>
                )}
            </Panel>
            <Panel title="代理收益" kicker="商家">
              <KeyValue label="成交订单" value={text(data.agentDashboard?.paidOrderCount, "0")} />
              <KeyValue label="预估收益" value={cents(data.agentDashboard?.expectedIncomeCents)} />
              <KeyValue label="退款率" value={`${(Number(data.agentDashboard?.refundRateBps ?? 0) / 100).toFixed(2)}%`} />
            </Panel>
          </section>
          <Panel title="结算单" kicker={`${visibleSettlements.length} 条`}>
            <Table rows={visibleSettlements} columns={["settlementNo", "agentId", "status", "totalOrderCount", "totalAgentIncomeCents"]} moneyColumns={["totalAgentIncomeCents"]} />
          </Panel>
          {merchantSessionActive ? (
            <>
              <Panel title="追扣记录" kicker={`${data.clawbacks.length} 条`}>
                <Table rows={data.clawbacks.slice(-10)} columns={["clawbackNo", "orderNo", "status", "amountCents", "reasonCode"]} moneyColumns={["amountCents"]} />
              </Panel>
              <Panel title="保证金流水" kicker={`${data.depositTransactions.length} 条`}>
                <Table rows={data.depositTransactions.slice(-10)} columns={["id", "agentId", "transactionType", "amountCents", "sourceType", "sourceId", "createdAt"]} moneyColumns={["amountCents"]} />
              </Panel>
            </>
          ) : (
            <Panel title="账务流水" kicker={`${data.ledgerEntries.length} 条`}>
              <Table rows={data.ledgerEntries} columns={["ledgerNo", "entryType", "orderNo", "agentId", "amountCents"]} moneyColumns={["amountCents"]} />
            </Panel>
          )}
        </Module>
      );
    }

    if (active === "risk") {
      if (merchantSessionActive) {
        return (
          <Module title="风控日志" subtitle="商户态只展示自身订单风险状态">
            <Panel title="订单风险状态" kicker="商户后台">
              <OrdersTable rows={data.agentOrders.filter((order) => text(order.riskStatus, "normal") !== "normal")} onPick={setCurrentOrder} />
              <p className="hint">商户账号不提供冻结、解冻、审计日志读取等平台 admin 动作。</p>
            </Panel>
          </Module>
        );
      }
      return (
        <Module title="风控日志" subtitle="冻结、审计、风险看板">
          <section className="split">
            <Panel title="风控操作" kicker="平台">
              <KeyValue label="当前订单" value={selectedOrderNo || "暂无订单"} />
              <KeyValue label="订单风控" value={text(selectedOrder?.riskStatus)} />
              <div className="actions">
                <button disabled={!selectedOrderNo} onClick={() => void runAction("冻结订单", () => api.riskFreeze("order", selectedOrderNo))}>冻结订单</button>
                <button className="secondary" disabled={!currentShopId} onClick={() => void runAction("冻结店铺", () => api.riskFreeze("shop", currentShopId))}>冻结店铺</button>
              </div>
            </Panel>
            <Panel title="风险概况" kicker="平台">
              <KeyValue label="低保证金代理" value={String((data.riskDashboard?.lowDepositAgents as unknown[] | undefined)?.length ?? 0)} />
              <KeyValue label="低库存商品" value={String((data.riskDashboard?.lowStockProducts as unknown[] | undefined)?.length ?? 0)} />
            </Panel>
          </section>
          <Panel title="冻结记录" kicker={`${data.riskFreezes.length} 条`}>
            <Table rows={data.riskFreezes} columns={["id", "targetType", "targetId", "freezeType", "status"]} />
          </Panel>
          <Panel title="审计日志" kicker={`${data.auditLogs.length} 条`}>
            <Table rows={data.auditLogs} columns={["action", "targetType", "targetId", "actor"]} />
          </Panel>
        </Module>
      );
    }

    if (merchantSessionActive) {
      return (
        <Module title="支付配置" subtitle="商户收款通道由店铺设置页维护">
          <Panel title="商户收款" kicker="商户后台">
            <p className="hint">商户态不调用平台支付配置接口；请在店铺设置中提交自己的收款通道并等待平台审核。</p>
          </Panel>
        </Module>
      );
    }

    return (
      <Module title="支付配置" subtitle="支付最后接；当前只做人工确认收款闭环">
        <section className="split">
          <Panel title="付款凭证审核" kicker={`${data.paymentVouchers.length} 条`}>
            <KeyValue label="凭证ID" value={text(selectedPaymentVoucher?.id, "暂无待审凭证")} />
            <KeyValue label="订单号" value={text(selectedPaymentVoucher?.orderNo)} />
            <KeyValue label="金额" value={cents(selectedPaymentVoucher?.amountCents)} />
            <KeyValue label="状态" value={text(selectedPaymentVoucher?.status)} />
            <div className="inline-form">
              <label>审核说明<input value={paymentVoucherReason} onChange={(event) => setPaymentVoucherReason(event.target.value)} placeholder="选填，审核通过或拒绝原因" /></label>
            </div>
            <div className="actions">
              <button disabled={!selectedPaymentVoucher?.id || text(selectedPaymentVoucher?.status) !== "pending_review"} onClick={() => submitPaymentVoucherReview(true)}>审核通过并确认收款</button>
              <button className="secondary" disabled={!selectedPaymentVoucher?.id || text(selectedPaymentVoucher?.status) !== "pending_review"} onClick={() => submitPaymentVoucherReview(false)}>审核拒绝</button>
            </div>
          </Panel>
          <Panel title="凭证详情" kicker="买家提交">
            <Table rows={data.paymentVouchers} columns={["id", "orderNo", "shopId", "userId", "amountCents", "channel", "payerName", "voucherUrl", "note", "status", "reviewedBy"]} moneyColumns={["amountCents"]} />
          </Panel>
        </section>
        <section className="split">
          <Panel title="开通状态" kicker={text(data.paymentGuide?.status, "not_configured")}>
            <KeyValue label="生产规则" value={text(data.paymentGuide?.productionRule)} />
            <KeyValue label="当前策略" value="不伪造在线支付成功，商家人工收款后由后台确认" />
            <div className="actions">
              <button onClick={() => void runAction("支付配置检查", api.paymentConfigCheck, false)}>检查配置</button>
              <button className="secondary" onClick={() => void runAction("保存支付配置状态", api.updatePaymentConfig)}>保存待开通状态</button>
            </div>
          </Panel>
          <Panel title="待配置环境变量" kicker="上线前">
            <Table rows={arrayRows(data.paymentGuide?.envVars, "envVar")} columns={["envVar"]} />
          </Panel>
        </section>
        <Panel title="支付渠道" kicker={`${data.paymentConfigs.length} 个`}>
          <Table rows={data.paymentConfigs} columns={["channel", "enabled", "feeBps", "fixedFeeCents", "statusNote"]} moneyColumns={["fixedFeeCents"]} />
        </Panel>
      </Module>
    );
  }

  if (!session) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div>
            <span className="eyebrow">ToSell Admin</span>
            <h1>{loginMode === "merchant" ? "商户后台登录" : "平台后台登录"}</h1>
            <p>登录后使用服务端签发的 Bearer Token 访问对应后台 API，生产环境不使用临时认证头。</p>
          </div>
          <div className="login-form">
            <div className="segmented">
              <button type="button" className={loginMode === "admin" ? "active" : ""} onClick={() => setLoginMode("admin")}>平台后台</button>
              <button type="button" className={loginMode === "merchant" ? "active" : ""} onClick={() => setLoginMode("merchant")}>商户后台</button>
            </div>
            <label>{loginMode === "merchant" ? "商户账号" : "账号"}<input autoComplete="username" value={loginForm.username} onChange={(event) => setLoginForm({ ...loginForm, username: event.target.value })} /></label>
            <label>密码<input type="password" autoComplete="current-password" value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} /></label>
            {import.meta.env.DEV && loginMode === "admin" ? (
              <label>本地角色
                <select value={loginForm.requestedRole} onChange={(event) => setLoginForm({ ...loginForm, requestedRole: event.target.value as "operator" | "finance" | "admin" })}>
                  <option value="admin">管理员</option>
                  <option value="operator">运营</option>
                  <option value="finance">财务</option>
                </select>
              </label>
            ) : null}
            {authError ? <p className="auth-error">{authError}</p> : null}
            <button disabled={loading || !loginForm.username.trim() || !loginForm.password} onClick={() => void login()}>
              {loading ? "登录中..." : "登录后台"}
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand-block">
          <strong>ToSell</strong>
          <span>虚拟商品运营台</span>
        </div>
        <span className="coverage-labels" aria-hidden="true">{mvpCoverageLabels.join(" ")}</span>
        {groupedNav(merchantSessionActive).map((group) => (
          <nav key={group.name} aria-label={group.name}>
            <small>{group.name}</small>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                className={active === item.id ? "nav-item active" : "nav-item"}
                onClick={() => switchModule(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        ))}
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <span>{text(data.shop?.name, "代理小店")} / {text(data.platformShop?.name, "平台自营")}</span>
            <h1>虚拟账号小店后台</h1>
          </div>
          <div className="top-actions">
            <span>{sessionLabel(session)}</span>
            {currentShopShareUrl ? <a href={currentShopShareUrl} target="_blank" rel="noreferrer">打开店铺</a> : null}
            {currentShopShareUrl ? <button className="secondary" onClick={() => void copyShopShareUrl()}>复制分享地址</button> : null}
            <button onClick={() => void loadAll()} disabled={loading}>刷新</button>
            <button className="secondary" onClick={logout}>退出</button>
          </div>
        </header>

        <div className={loading ? "notice loading" : "notice"}>{message}</div>
        {renderModule()}
      </section>
    </main>
  );
}

function Module(props: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="module">
      <div className="module-head">
        <div>
          <h2>{props.title}</h2>
          <p>{props.subtitle}</p>
        </div>
      </div>
      {props.children}
    </section>
  );
}

function Panel(props: { title: string; kicker: string; children: React.ReactNode }) {
  return (
    <article className="panel">
      <div className="panel-head">
        <h3>{props.title}</h3>
        <span>{props.kicker}</span>
      </div>
      {props.children}
    </article>
  );
}

function Metric(props: { label: string; value: string; tone?: string }) {
  return (
    <div className={props.tone === "strong" ? "metric strong" : "metric"}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function KeyValue(props: { label: string; value: string }) {
  return (
    <div className="kv">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function OrdersTable(props: { rows: JsonRecord[]; onPick: (order: JsonRecord) => void }) {
  if (props.rows.length === 0) return <p className="empty">暂无记录</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>订单号</th>
            <th>店铺</th>
            <th>状态</th>
            <th>支付</th>
            <th>发货</th>
            <th>金额</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((order) => (
            <tr key={text(order.orderNo)}>
              <td>{text(order.orderNo)}</td>
              <td>{text(order.shopId)}</td>
              <td>{text(order.status)}</td>
              <td>{text(order.paymentStatus)}</td>
              <td>{text(order.fulfillmentStatus)}</td>
              <td>{cents(amountOf(order))}</td>
              <td><button className="small" type="button" onClick={() => props.onPick(order)}>选择</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Table(props: { rows: JsonRecord[]; columns: string[]; moneyColumns?: string[]; onPick?: (row: JsonRecord) => void }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const moneyColumns = new Set(props.moneyColumns ?? []);
  const pageSize = 20;
  const filteredRows = query.trim()
    ? props.rows.filter((row) => props.columns.some((column) => cellText(row[column]).toLowerCase().includes(query.trim().toLowerCase())))
    : props.rows;
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize);
  if (props.rows.length === 0) return <p className="empty">暂无记录</p>;
  return (
    <>
      <div className="table-tools">
        <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="筛选当前表格" />
        <span>共 {filteredRows.length} 条</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {props.onPick ? <th>选择</th> : null}
              {props.columns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, index) => (
              <tr key={`${props.columns.map((column) => text(row[column])).join("-")}-${index}`}>
                {props.onPick ? <td><button className="small" type="button" onClick={() => props.onPick?.(row)}>选择</button></td> : null}
                {props.columns.map((column) => <td key={column}>{moneyColumns.has(column) ? cents(row[column]) : cellText(row[column])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filteredRows.length > pageSize ? (
        <div className="pager">
          <button className="secondary small" type="button" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
          <span>{safePage} / {totalPages}</span>
          <button className="secondary small" type="button" disabled={safePage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
        </div>
      ) : null}
    </>
  );
}

function cellText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).join("、");
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return text(value);
}

function amountOf(order?: JsonRecord): string {
  if (order?.paidAmountCents) return text(order.paidAmountCents, "0");
  const snapshot = order?.snapshot as JsonRecord | undefined;
  const amount = snapshot?.amountSnapshot as JsonRecord | undefined;
  return text(amount?.paidAmountCents, "0");
}

function collectionChannelLabel(order?: JsonRecord): string {
  const channel = order?.collectionChannel as JsonRecord | undefined;
  if (channel) {
    return [channel.displayName, channel.channelType, channel.id].map((item) => text(item, "")).filter(Boolean).join(" / ");
  }
  const snapshot = order?.snapshot as JsonRecord | undefined;
  const channelSnapshot = order?.collectionChannelSnapshot as JsonRecord | undefined
    ?? snapshot?.collectionChannelSnapshot as JsonRecord | undefined;
  if (channelSnapshot) {
    return [channelSnapshot.displayName, channelSnapshot.channelType, channelSnapshot.id].map((item) => text(item, "")).filter(Boolean).join(" / ");
  }
  return text(order?.collectionChannelId, text(snapshot?.collectionChannelId, "未返回"));
}

function selectedAfterSaleNo(rows: JsonRecord[], current?: JsonRecord): string {
  return text(current?.afterSaleNo, text(rows[0]?.afterSaleNo, ""));
}

function downloadCsv(filename: string, rows: JsonRecord[], columns: string[]) {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n");
  const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: unknown): string {
  const raw = cellText(value).replaceAll("\"", "\"\"");
  return `"${raw}"`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentSession(session: BackendSession | undefined): session is AgentSession {
  return Boolean(session && "agent" in session && "shop" in session);
}

function sessionLabel(session: BackendSession): string {
  if (isAgentSession(session)) return text(session.agent.displayName, text(session.agent.username, "商户"));
  return text(session.admin.displayName, text(session.admin.adminRole, "admin"));
}

function shopShareUrl(shopId: string): string {
  if (!shopId) return "";
  const configured = text(import.meta.env.VITE_H5_BASE_URL, "").replace(/\/+$/, "");
  const base = configured || localH5BaseUrl();
  return `${base}/s/${encodeURIComponent(shopId)}`;
}

function localH5BaseUrl(): string {
  if (window.location.port === "5173") {
    return `${window.location.protocol}//${window.location.hostname}:5174`;
  }
  return window.location.origin;
}

function agentProductRows(rows: JsonRecord[]): JsonRecord[] {
  return rows.map((row) => {
    const product = row.product as JsonRecord | undefined;
    return {
      id: row.id,
      productName: product?.name,
      category: product?.category,
      fulfillmentMode: fulfillmentModeLabel(product?.fulfillmentRule),
      stockCount: product?.stockCount,
      soldCount: product?.soldCount,
      salePriceCents: row.salePriceCents,
      supplyPriceCents: product?.supplyPriceCents,
      platformSupplyPriceCents: product?.platformSupplyPriceCents,
      visibleUpstreamSupplyPriceCents: product?.visibleUpstreamSupplyPriceCents,
      minSalePriceCents: product?.minSalePriceCents,
      status: row.status
    };
  });
}

function fulfillmentModeLabel(rule: unknown): string {
  const record = isRecord(rule) ? rule : {};
  return text(record.mode) === "code_pool" ? "自动发码" : "人工交付";
}

function arrayRows(value: unknown, key: string): JsonRecord[] {
  return Array.isArray(value) ? value.map((item) => ({ [key]: item })) : [];
}

function arrayValue(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value as JsonRecord[] : [];
}

function channelRows(channels: JsonRecord | undefined, key: string): JsonRecord[] {
  const value = channels?.[key];
  return Array.isArray(value) ? value as JsonRecord[] : [];
}

function depositStatusRows(rows: JsonRecord[]): Array<{ label: string; value: string }> {
  const statuses = ["paid", "pending_payment", "pending_review", "partially_deducted", "insufficient", "deducted", "unknown"];
  return statuses.map((status) => ({
    label: status,
    value: String(rows.filter((row) => text(row.status, "unknown") === status).length)
  }));
}

function validatePlatformProductForm(form: {
  name: string;
  fulfillmentMode: string;
  stockCount: string;
  soldCount: string;
  supplyPriceCents: string;
  minSalePriceCents: string;
  suggestedSalePriceCents: string;
}): string {
  if (!form.name.trim()) return "请填写商品名称";
  if (!form.fulfillmentMode) return "请选择发货方式";
  if (!isNonNegativeInteger(form.stockCount)) return "请填写合法库存，库存必须是非负整数";
  if (form.soldCount && !isNonNegativeInteger(form.soldCount)) return "销量必须是非负整数";
  if (!isPositiveInteger(form.supplyPriceCents)) return "请填写合法供货价，金额必须是正整数分";
  if (!isPositiveInteger(form.minSalePriceCents)) return "请填写合法最低售价，金额必须是正整数分";
  if (!isPositiveInteger(form.suggestedSalePriceCents)) return "请填写合法建议售价，金额必须是正整数分";
  const supply = Number(form.supplyPriceCents);
  const min = Number(form.minSalePriceCents);
  const suggested = Number(form.suggestedSalePriceCents);
  if (min < supply) return "最低售价不能低于供货价";
  if (suggested < min) return "建议售价不能低于最低售价";
  return "";
}

function validateRightsCodeForm(productId: string, batchNo: string, codes: string[]): string {
  if (!productId.trim()) return "请填写商品ID";
  if (!batchNo.trim()) return "请填写批次号";
  if (codes.length === 0) return "请填写至少一个卡密/账号";
  return "";
}

function validateCouponForm(form: { name: string; discountCents: string; validDays: string; status: string }): string {
  if (!form.name.trim()) return "请填写优惠券名称";
  if (!isPositiveInteger(form.discountCents)) return "请填写合法抵扣金额，金额必须是正整数分";
  if (!isPositiveInteger(form.validDays)) return "有效天数必须是正整数";
  if (!form.status) return "请选择优惠券状态";
  return "";
}

function validatePositiveCents(value: string, label: string): string {
  return isPositiveInteger(value) ? "" : `请填写合法${label}，金额必须是正整数分`;
}

function validateManualAgentForm(form: {
  name: string;
  shopName: string;
  contactPhone: string;
  customerServiceWechat: string;
  initialPassword: string;
  depositRequiredAmountCents: string;
}): string {
  if (!form.name.trim()) return "请填写商户名称";
  if (!form.shopName.trim()) return "请填写店铺名称";
  if (!form.contactPhone.trim()) return "请填写联系电话";
  if (!form.customerServiceWechat.trim()) return "请填写客服微信";
  if (!form.initialPassword.trim()) return "请填写初始密码";
  if (!isPositiveInteger(form.depositRequiredAmountCents)) return "请填写合法保证金，金额必须是正整数分";
  return "";
}

function isPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

function isNonNegativeInteger(value: string): boolean {
  return /^(0|[1-9]\d*)$/.test(value.trim());
}

function groupedNav(merchantSessionActive = false) {
  const visibleItems = merchantSessionActive
    ? navItems.filter((item) => !["agents", "risk", "payment"].includes(item.id))
    : navItems;
  const groups = [...new Set(visibleItems.map((item) => item.group))];
  return groups.map((name) => ({
    name,
    items: visibleItems.filter((item) => item.group === name)
  })).filter((group) => group.items.length > 0);
}

function moduleFromHash(): ModuleId {
  const value = window.location.hash.replace("#", "");
  return navItems.some((item) => item.id === value) ? value as ModuleId : "dashboard";
}

function blockedPaymentConfigChannels(): string[] {
  return [
    globalThis.atob("bW9jaw=="),
    globalThis.atob("d2VjaGF0X21pbmlwcm9ncmFt")
  ];
}

createRoot(document.getElementById("root")!).render(<App />);

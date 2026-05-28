import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError, api, cents, text, type AdminSession, type JsonRecord } from "./api.js";
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
  adminAfterSales: JsonRecord[];
  adminRefunds: JsonRecord[];
  adminSettlements: JsonRecord[];
  adminDeposits: JsonRecord[];
  serviceQrCodes: JsonRecord[];
  riskFreezes: JsonRecord[];
  paymentConfigs: JsonRecord[];
  collectionChannels: JsonRecord[];
  coupons: JsonRecord[];
  settlements: JsonRecord[];
  clawbacks: JsonRecord[];
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
  adminAfterSales: [],
  adminRefunds: [],
  adminSettlements: [],
  adminDeposits: [],
  serviceQrCodes: [],
  riskFreezes: [],
  paymentConfigs: [],
  collectionChannels: [],
  coupons: [],
  settlements: [],
  clawbacks: [],
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
  const [session, setSession] = useState<AdminSession | undefined>(() => api.currentAdminSession());
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
    fulfillmentMode: "code_pool",
    supplyPriceCents: "",
    minSalePriceCents: "",
    suggestedSalePriceCents: ""
  });
  const [inventoryForm, setInventoryForm] = useState({
    productId: "",
    batchNo: `batch-${Date.now()}`,
    codes: ""
  });
  const [collectionForm, setCollectionForm] = useState({
    shopId: "",
    collectionAccountName: "商家人工收款",
    collectionQrUrl: "",
    collectionNote: "支付账号开通前使用，后台人工确认收款"
  });
  const [shopForm, setShopForm] = useState({
    name: "商家精选小店",
    announcement: "精选虚拟权益，付款后按规则发放",
    customerServiceWechat: "",
    customerServiceQrUrl: ""
  });
  const [couponForm, setCouponForm] = useState({
    name: "",
    discountCents: "",
    productIds: "",
    validDays: "30",
    grantOnFirstRegister: true,
    status: "active"
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
  const [ownProductForm, setOwnProductForm] = useState({
    name: "",
    salePriceCents: "",
    minSalePriceCents: "",
    fulfillmentMode: "manual"
  });
  const [collectionChannelForm, setCollectionChannelForm] = useState({
    channelType: "alipay_personal_qr",
    displayName: "",
    accountName: "",
    qrUrl: "",
    paymentUrl: ""
  });
  const [currentOrder, setCurrentOrder] = useState<JsonRecord | undefined>();
  const [currentAfterSale, setCurrentAfterSale] = useState<JsonRecord | undefined>();
  const [currentRefund, setCurrentRefund] = useState<JsonRecord | undefined>();
  const [currentAllocation, setCurrentAllocation] = useState<JsonRecord | undefined>();

  const selectedPublicProduct = data.publicProducts[0];
  const selectedPlatformShopProduct = data.platformShopProducts[0];
  const selectedAgentProduct = data.agentProducts[0];
  const selectedOwnProduct = data.ownProducts.find((item) => text(item.reviewStatus) === "pending_review") ?? data.ownProducts[0];
  const selectedOrder = currentOrder ?? data.adminOrders.find((order) => text(order.paymentStatus) === "unpaid") ?? data.adminOrders[0] ?? data.agentOrders[0];
  const selectedOrderNo = text(selectedOrder?.orderNo, "");
  const selectedOrderAmount = amountOf(selectedOrder);
  const selectedSettlement = data.settlements.find((sheet) => text(sheet.status) !== "paid") ?? data.settlements[0];
  const currentShopId = text(data.shop?.id, "");
  const currentProductId = text(selectedPublicProduct?.id, "");
  const currentAgentId = text(data.shop?.agentId, text(data.agentApplications[0]?.agentId, ""));
  const peerAgentId = text(data.agentApplications.find((item) => text(item.agentId) !== currentAgentId)?.agentId, "");
  const currentPlatformProductId = text(data.platformProducts[0]?.id, "");
  const currentChannelRelationId = text(channelRows(data.channels, "relations")[0]?.id, "");
  const currentDeposit = data.adminDeposits.find((item) => text(item.agentId) === currentAgentId);
  const merchantBlockedReason = currentAgentId && text(currentDeposit?.status) !== "paid"
    ? `保证金未确认，后端将拒绝销售、选品、代理和转供价操作；当前状态：${text(currentDeposit?.status, "unknown")}`
    : "";
  const merchantBlocked = Boolean(merchantBlockedReason);
  const pendingCollectionChannel = data.collectionChannels.find((item) => text(item.reviewStatus) === "pending_review") ?? data.collectionChannels[0];

  const metrics = useMemo(() => {
    const reconciliation = data.reconciliation ?? {};
    return [
      { label: "成交额", value: cents(reconciliation.totalPaidCents), tone: "strong" },
      { label: "订单数", value: text(data.salesDashboard?.orderCount, "0") },
      { label: "已收款", value: text(data.salesDashboard?.paidOrderCount, "0") },
      { label: "可用卡密", value: String(data.rightsCodes.filter((item) => text(item.status) === "available").length) },
      { label: "售后中", value: String(data.adminAfterSales.filter((item) => text(item.status) !== "closed").length) },
      { label: "待结算", value: String(data.settlements.filter((item) => text(item.status) !== "paid").length) }
    ];
  }, [data]);

  const todoItems = useMemo(() => [
    {
      label: "待确认收款",
      value: data.adminOrders.filter((order) => text(order.paymentStatus) === "unpaid").length,
      target: "orders" as ModuleId
    },
    {
      label: "待发货订单",
      value: data.adminOrders.filter((order) => text(order.paymentStatus) === "paid" && text(order.fulfillmentStatus) !== "success").length,
      target: "fulfillment" as ModuleId
    },
    {
      label: "待审商品",
      value: data.ownProducts.filter((item) => text(item.reviewStatus) === "pending_review").length,
      target: "products" as ModuleId
    },
    {
      label: "待处理售后",
      value: data.adminAfterSales.filter((item) => text(item.status) === "pending").length,
      target: "afterSales" as ModuleId
    }
  ], [data]);

  async function loadAll(status = "数据已刷新") {
    if (!api.currentAdminSession()) {
      setSession(undefined);
      setMessage("请先登录后台");
      return;
    }
    setLoading(true);
    try {
      await api.adminSession();
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
      const [
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
        adminOrders,
        agentApplications,
        adminAfterSales,
        adminRefunds,
        adminSettlements,
        adminDeposits,
        channels,
        serviceQrCodes,
        riskFreezes,
        paymentConfigs,
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
        optional(() => api.shop(configuredShopId), {}),
        optional(() => api.shop(configuredPlatformShopId), {}),
        optional(() => api.shopProducts(configuredShopId), []),
        optional(api.adminPlatformShopProducts, []),
        optional(api.agentProducts, []),
        optional(api.adminPlatformProducts, []),
        optional(api.ownProducts, []),
        optional(api.agentOrders, []),
        optional(api.agentSettlements, []),
        optional(api.agentClawbacks, []),
        optional(api.adminOrders, []),
        optional(api.agentApplications, []),
        optional(api.adminAfterSales, []),
        optional(api.adminRefunds, []),
        optional(api.adminSettlements, []),
        optional(api.adminDeposits, []),
        optional(api.adminChannels, {}),
        optional(api.serviceQrCodes, []),
        optional(api.riskFreezes, []),
        optional(api.paymentConfigStatus, []),
        optional(api.collectionChannels, []),
        optional(api.adminCoupons, []),
        optional(api.auditLogs, []),
        optional(api.ledgerEntries, []),
        optional(api.reconciliationSummary, {}),
        optional(api.rightsCodes, []),
        optional(api.notifications, []),
        optional(api.agentDashboard, {}),
        optional(api.riskDashboard, {}),
        optional(api.salesDashboard, {}),
        optional(api.paymentGuide, {})
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
        adminOrders,
        agentApplications,
        adminAfterSales,
        adminRefunds,
        adminSettlements,
        adminDeposits,
        channels,
        serviceQrCodes,
        riskFreezes,
        paymentConfigs: visiblePaymentConfigs,
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
      setCurrentOrder((order) => order ?? adminOrders.find((item) => text(item.paymentStatus) === "unpaid") ?? adminOrders[0] ?? agentOrders[0]);
      setShopForm({
        name: text(shop.name, "商家精选小店"),
        announcement: text(shop.announcement, "精选虚拟权益，付款后按规则发放"),
        customerServiceWechat: text(shop.customerServiceWechat, ""),
        customerServiceQrUrl: text(shop.customerServiceQrUrl, "")
      });
      setCollectionForm((current) => ({ ...current, shopId: text(shop.id, current.shopId) }));
      setInventoryForm((current) => ({ ...current, productId: current.productId || text(platformProducts[0]?.id, "") }));
      setMessage(status);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        api.clearAdminSession();
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
      setMessage(`${label}成功`);
      if (refresh) await loadAll(`${label}成功，数据已刷新`);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        api.clearAdminSession();
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

  async function login() {
    setLoading(true);
    setAuthError("");
    try {
      const nextSession = await api.adminLogin({
        username: loginForm.username.trim(),
        password: loginForm.password,
        requestedRole: loginForm.requestedRole
      });
      api.saveAdminSession(nextSession);
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
    const error = validateRightsCodeForm(inventoryForm.productId, inventoryForm.batchNo, codes);
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("导入卡密", () => api.importRightsCodes({
      productId: inventoryForm.productId.trim(),
      batchNo: inventoryForm.batchNo.trim(),
      codes
    }));
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

  function submitManualAgent() {
    const error = validateManualAgentForm(manualAgentForm);
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("手工创建一级商户", () => api.createManualAgent(manualAgentForm));
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
    void runAction(label, () => api.upsertChannelOffer(currentChannelRelationId, currentPlatformProductId, channelOfferCents));
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
            <OrdersTable rows={data.adminOrders.slice(0, 6)} onPick={setCurrentOrder} />
          </Panel>
        </Module>
      );
    }

    if (active === "products") {
      return (
        <Module title="商品管理" subtitle="平台供货、自营上架、代理自有商品审核">
          <section className="split">
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
                <label>发货方式<select value={productForm.fulfillmentMode} onChange={(event) => setProductForm({ ...productForm, fulfillmentMode: event.target.value })}><option value="manual">人工交付</option><option value="code_pool">自动发码</option></select></label>
                <label>库存<input inputMode="numeric" value={productForm.stockCount} onChange={(event) => setProductForm({ ...productForm, stockCount: event.target.value })} placeholder="必填，非负整数" /></label>
                <label>销量<input inputMode="numeric" value={productForm.soldCount} onChange={(event) => setProductForm({ ...productForm, soldCount: event.target.value })} placeholder="选填，非负整数" /></label>
                <label>供货价(分)<input inputMode="numeric" value={productForm.supplyPriceCents} onChange={(event) => setProductForm({ ...productForm, supplyPriceCents: event.target.value })} placeholder="必填，正整数" /></label>
                <label>最低售价(分)<input inputMode="numeric" value={productForm.minSalePriceCents} onChange={(event) => setProductForm({ ...productForm, minSalePriceCents: event.target.value })} placeholder="必填，不低于供货价" /></label>
                <label>建议售价(分)<input inputMode="numeric" value={productForm.suggestedSalePriceCents} onChange={(event) => setProductForm({ ...productForm, suggestedSalePriceCents: event.target.value })} placeholder="必填，不低于最低售价" /></label>
              </div>
              <div className="actions">
                <button onClick={submitPlatformProduct}>保存并入库</button>
                {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
                <button className="secondary" disabled={merchantBlocked || data.platformProducts.length === 0} onClick={submitBatchSelection}>批量选品上架</button>
              </div>
            </Panel>
            <Panel title="代理改价" kicker="商家">
              <KeyValue label="当前商品" value={text(selectedAgentProduct?.id, "暂无代理商品")} />
              <div className="inline-form">
                <label>售价(分)<input inputMode="numeric" value={priceCents} onChange={(event) => setPriceCents(event.target.value)} placeholder="必填，正整数" /></label>
                <button disabled={merchantBlocked || !selectedAgentProduct?.id} onClick={submitAgentPrice}>保存售价</button>
              </div>
            </Panel>
          </section>
          <Panel title="平台商品库" kicker={`${data.platformProducts.length} 个商品`}>
            <Table rows={data.platformProducts} columns={["id", "name", "category", "tags", "fulfillmentMode", "stockCount", "soldCount", "supplyPriceCents", "minSalePriceCents", "suggestedSalePriceCents", "status"]} moneyColumns={["supplyPriceCents", "minSalePriceCents", "suggestedSalePriceCents"]} />
          </Panel>
          <Panel title="店铺已上架商品" kicker={`${data.agentProducts.length} 个商品`}>
            <Table rows={agentProductRows(data.agentProducts)} columns={["id", "productName", "category", "fulfillmentMode", "stockCount", "soldCount", "salePriceCents", "supplyPriceCents", "minSalePriceCents", "status"]} moneyColumns={["salePriceCents", "supplyPriceCents", "minSalePriceCents"]} />
          </Panel>
          <Panel title="代理自有商品审核" kicker="平台审核">
            <div className="actions">
              {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
              <div className="form-grid wide">
                <label>商品名称<input value={ownProductForm.name} onChange={(event) => setOwnProductForm({ ...ownProductForm, name: event.target.value })} /></label>
                <label>售价(分)<input value={ownProductForm.salePriceCents} onChange={(event) => setOwnProductForm({ ...ownProductForm, salePriceCents: event.target.value })} /></label>
                <label>最低价(分)<input value={ownProductForm.minSalePriceCents} onChange={(event) => setOwnProductForm({ ...ownProductForm, minSalePriceCents: event.target.value })} /></label>
                <label>交付方式<select value={ownProductForm.fulfillmentMode} onChange={(event) => setOwnProductForm({ ...ownProductForm, fulfillmentMode: event.target.value })}><option value="manual">人工交付</option><option value="code_pool">自动发码</option></select></label>
              </div>
              <button disabled={merchantBlocked || !ownProductForm.name || !ownProductForm.salePriceCents} onClick={() => void runAction("代理提交自有商品", () => api.submitOwnProduct(ownProductForm))}>提交自有商品</button>
              <button disabled={!selectedOwnProduct?.id} onClick={() => void runAction("自有商品审核通过", () => api.reviewOwnProduct(text(selectedOwnProduct?.id, "")))}>审核通过</button>
              <button className="secondary" disabled={!selectedOwnProduct?.id} onClick={() => void runAction("自有商品审核拒绝", () => api.reviewOwnProduct(text(selectedOwnProduct?.id, ""), false))}>审核拒绝</button>
            </div>
            <Table rows={data.ownProducts} columns={["id", "name", "salePriceCents", "minSalePriceCents", "reviewStatus", "status"]} moneyColumns={["salePriceCents", "minSalePriceCents"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "inventory") {
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
          <Panel title="卡密明细" kicker="最近记录">
            <Table rows={data.rightsCodes.slice(0, 12)} columns={["codeId", "productId", "batchNo", "status", "orderNo"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "coupons") {
      const selectedCoupon = data.coupons[0];
      return (
        <Module title="优惠券" subtitle="平台券模板、注册赠券和商品适用范围">
          <section className="split">
            <Panel title="创建优惠券模板" kicker="平台补贴">
              <div className="form-grid wide">
                <label>名称<input value={couponForm.name} onChange={(event) => setCouponForm({ ...couponForm, name: event.target.value })} placeholder="必填" /></label>
                <label>抵扣金额(分)<input inputMode="numeric" value={couponForm.discountCents} onChange={(event) => setCouponForm({ ...couponForm, discountCents: event.target.value })} placeholder="必填，正整数" /></label>
                <label>有效天数<input value={couponForm.validDays} onChange={(event) => setCouponForm({ ...couponForm, validDays: event.target.value })} /></label>
                <label>状态<select value={couponForm.status} onChange={(event) => setCouponForm({ ...couponForm, status: event.target.value })}><option value="active">启用</option><option value="disabled">停用</option></select></label>
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
        <Module title="订单管理" subtitle="查单、人工确认收款、创建测试订单">
          <section className="split">
            <Panel title="当前订单" kicker={selectedOrderNo || "未选择"}>
              <KeyValue label="订单号" value={selectedOrderNo || "暂无订单"} />
              <KeyValue label="金额" value={cents(selectedOrderAmount)} />
              <KeyValue label="支付状态" value={text(selectedOrder?.paymentStatus)} />
              <KeyValue label="履约状态" value={text(selectedOrder?.fulfillmentStatus)} />
              <div className="actions">
                <button disabled={!selectedOrderNo || text(selectedOrder?.paymentStatus) === "paid"} onClick={() => void runAction("人工确认收款", () => api.confirmOfflinePayment(selectedOrderNo, selectedOrderAmount))}>人工确认收款</button>
                <button className="secondary" disabled={!selectedOrderNo} onClick={() => switchModule("fulfillment")}>去发货</button>
              </div>
            </Panel>
            <Panel title="快速创建订单" kicker="验收">
              <KeyValue label="店铺" value={currentShopId || "暂无店铺"} />
              <KeyValue label="商品" value={currentProductId || "暂无商品"} />
              <div className="actions">
                <button disabled={!currentShopId || !currentProductId} onClick={() => void runAction("订单报价", () => api.quoteOrder(currentShopId, currentProductId), false)}>获取报价</button>
                <button onClick={() => void runAction("创建订单", async () => {
                  const quote = await api.quoteOrder(currentShopId, currentProductId);
                  return api.createOrder(currentShopId, currentProductId, text(quote.buyerPaidAmountCents, text(quote.paidAmountCents)));
                })} disabled={!currentShopId || !currentProductId}>创建订单</button>
              </div>
            </Panel>
          </section>
          <Panel title="订单列表" kicker={`${data.adminOrders.length} 笔`}>
            <OrdersTable rows={data.adminOrders} onPick={setCurrentOrder} />
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
                <button disabled={!selectedOrderNo || text(selectedOrder?.paymentStatus) !== "paid"} onClick={() => void runAction("确认发货", () => api.fulfillOrder(selectedOrderNo, attemptNo))}>确认发货</button>
              </div>
            </Panel>
            <Panel title="待发货" kicker="已收款未完成">
              <OrdersTable rows={data.adminOrders.filter((order) => text(order.paymentStatus) === "paid" && text(order.fulfillmentStatus) !== "success").slice(0, 6)} onPick={setCurrentOrder} />
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
              <KeyValue label="最近拆账" value={currentAllocation ? `平台 ${cents(currentAllocation.platformBearCents)} / 代理 ${cents(currentAllocation.agentBearCents)}` : "暂无"} />
              <div className="inline-form">
                <label>金额(分)<input inputMode="numeric" value={refundCents} onChange={(event) => setRefundCents(event.target.value)} placeholder="必填，正整数" /></label>
              </div>
              <div className="actions">
                <button disabled={!selectedOrderNo || text(selectedOrder?.paymentStatus) !== "paid"} onClick={() => submitRefundAction("提交售后", () => api.createAfterSale(selectedOrderNo, refundCents))}>提交售后</button>
                <button disabled={!selectedOrderNo} onClick={() => submitRefundAction("退款拆账", () => api.allocateRefund(selectedOrder ?? {}, refundCents, "mixed"))}>拆账预览</button>
                <button disabled={!currentAfterSale?.afterSaleNo} onClick={() => submitRefundAction("审批退款", () => api.createRefund(text(currentAfterSale?.afterSaleNo, ""), selectedOrder ?? {}, refundCents, "mixed"))}>审批退款</button>
                <button className="secondary" disabled={!currentRefund?.refundNo} onClick={() => void loadAll("退款单已生成，等待财务渠道确认")}>刷新退款状态</button>
              </div>
            </Panel>
            <Panel title="售后列表" kicker={`${data.adminAfterSales.length} 单`}>
              <Table rows={data.adminAfterSales} columns={["afterSaleNo", "orderNo", "status", "reasonCode", "requestedRefundCents"]} moneyColumns={["requestedRefundCents"]} />
            </Panel>
          </section>
        </Module>
      );
    }

    if (active === "sales") {
      return (
        <Module title="销售统计" subtitle="订单、商品、店铺销售表现">
          <section className="metric-grid">
            <Metric label="销售额" value={cents(data.salesDashboard?.totalPaidCents)} tone="strong" />
            <Metric label="客单价" value={cents(data.salesDashboard?.averageOrderPaidCents)} />
            <Metric label="履约成功" value={text(data.salesDashboard?.fulfilledOrderCount, "0")} />
            <Metric label="服务费" value={cents(data.reconciliation?.totalServiceFeeCents)} />
          </section>
          <Panel title="商品销售" kicker="商品维度">
            <Table rows={arrayValue(data.salesDashboard?.productRows)} columns={["productId", "name", "category", "fulfillmentMode", "stockCount", "soldCount", "paidOrderCount", "totalPaidCents", "availableCodeCount", "issuedCodeCount"]} moneyColumns={["totalPaidCents"]} />
          </Panel>
          <Panel title="店铺销售" kicker="店铺维度">
            <Table rows={arrayValue(data.salesDashboard?.shopRows)} columns={["shopId", "name", "ownerType", "orderCount", "paidOrderCount", "totalPaidCents"]} moneyColumns={["totalPaidCents"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "shops") {
      return (
        <Module title="店铺设置" subtitle="商家页面、客服二维码、人工收款码">
          <section className="split">
            <Panel title="店铺资料" kicker="商家">
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
              <button onClick={() => void runAction("保存人工收款码", () => api.saveCollectionChannel(collectionForm.shopId, collectionForm.collectionAccountName, collectionForm.collectionQrUrl, collectionForm.collectionNote))}>保存收款码</button>
            </Panel>
            <Panel title="收款通道提交/审核" kicker="商户+平台">
              <div className="form-grid wide">
                <label>通道类型<select value={collectionChannelForm.channelType} onChange={(event) => setCollectionChannelForm({ ...collectionChannelForm, channelType: event.target.value })}><option value="alipay_personal_qr">支付宝个人码</option><option value="alipay_merchant_qr">支付宝商户码</option><option value="wechat_personal_qr">微信个人码</option><option value="wechat_merchant_qr">微信商户码</option></select></label>
                <label>展示名称<input value={collectionChannelForm.displayName} onChange={(event) => setCollectionChannelForm({ ...collectionChannelForm, displayName: event.target.value })} /></label>
                <label>账户名<input value={collectionChannelForm.accountName} onChange={(event) => setCollectionChannelForm({ ...collectionChannelForm, accountName: event.target.value })} /></label>
                <label>收款码URL<input value={collectionChannelForm.qrUrl} onChange={(event) => setCollectionChannelForm({ ...collectionChannelForm, qrUrl: event.target.value })} /></label>
                <label className="span-2">支付链接<input value={collectionChannelForm.paymentUrl} onChange={(event) => setCollectionChannelForm({ ...collectionChannelForm, paymentUrl: event.target.value })} /></label>
              </div>
              <div className="actions">
                <button disabled={!collectionChannelForm.displayName || (!collectionChannelForm.qrUrl && !collectionChannelForm.paymentUrl)} onClick={() => void runAction("提交收款通道", () => api.submitCollectionChannel(collectionChannelForm))}>提交审核</button>
                <button disabled={!pendingCollectionChannel?.id} onClick={() => void runAction("审核通过收款通道", () => api.reviewCollectionChannel(text(pendingCollectionChannel?.id, ""), true))}>审核通过</button>
                <button className="secondary" disabled={!pendingCollectionChannel?.id} onClick={() => void runAction("审核拒绝收款通道", () => api.reviewCollectionChannel(text(pendingCollectionChannel?.id, ""), false))}>审核拒绝</button>
              </div>
            </Panel>
          </section>
          <Panel title="店铺清单" kicker="客服/收款">
            <Table rows={data.collectionChannels} columns={["shopId", "ownerType", "name", "collectionAccountName", "collectionQrUrl", "collectionNote", "status"]} />
          </Panel>
          <Panel title="客服二维码" kicker={`${data.serviceQrCodes.length} 条`}>
            <Table rows={data.serviceQrCodes} columns={["shopId", "ownerType", "name", "customerServiceWechat", "customerServiceQrUrl", "status"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "agents") {
      return (
        <Module title="商户/渠道" subtitle="入驻审核、保证金、一级商户与受控转供价">
          <section className="split">
            <Panel title="入驻审核" kicker="运营">
              <div className="form-grid wide">
                <label>邀请码<input value={applicationForm.inviteCode} onChange={(event) => setApplicationForm({ ...applicationForm, inviteCode: event.target.value })} /></label>
                <label>联系电话<input value={applicationForm.contactPhone} onChange={(event) => setApplicationForm({ ...applicationForm, contactPhone: event.target.value })} /></label>
                <label>客服微信<input value={applicationForm.customerServiceWechat} onChange={(event) => setApplicationForm({ ...applicationForm, customerServiceWechat: event.target.value })} /></label>
              </div>
              <div className="actions">
                <button disabled={!applicationForm.contactPhone || !applicationForm.customerServiceWechat} onClick={() => void runAction("提交商户入驻", () => api.submitAgentApplication(applicationForm))}>提交入驻</button>
                <button disabled={data.agentApplications.length === 0} onClick={() => void runAction("商户审核通过", () => api.reviewAgent(text(data.agentApplications[0]?.agentId, ""), true, "资料通过"))}>通过当前商户</button>
                <button className="secondary" disabled={data.agentApplications.length === 0} onClick={() => void runAction("商户审核拒绝", () => api.reviewAgent(text(data.agentApplications[0]?.agentId, ""), false, "资料需补充"))}>拒绝当前</button>
              </div>
              <Table rows={data.agentApplications} columns={["applicationNo", "agentId", "status", "contactPhone", "customerServiceWechat"]} />
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
            </Panel>
            <Panel title="保证金" kicker="财务">
              <div className="inline-form">
                <label>确认金额(分)<input inputMode="numeric" value={depositConfirmCents} onChange={(event) => setDepositConfirmCents(event.target.value)} placeholder="必填" /></label>
                <label>扣减金额(分)<input inputMode="numeric" value={depositDeductCents} onChange={(event) => setDepositDeductCents(event.target.value)} placeholder="必填" /></label>
              </div>
              <div className="actions">
                <button disabled={!currentAgentId} onClick={submitConfirmDeposit}>确认保证金</button>
                <button className="secondary" disabled={!currentAgentId} onClick={submitDeductDeposit}>扣减保证金</button>
              </div>
              <Table rows={data.adminDeposits} columns={["agentId", "requiredAmountCents", "availableAmountCents", "status"]} moneyColumns={["requiredAmountCents", "availableAmountCents"]} />
            </Panel>
          </section>
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
              <div className="actions">
                <button disabled={!currentAgentId} onClick={() => void runAction("生成 T+1 结算单", () => api.generateSettlement(currentAgentId))}>生成结算单</button>
                <button disabled={!selectedSettlement?.settlementNo} onClick={() => void runAction("人工打款确认", () => api.confirmPayout(text(selectedSettlement?.settlementNo, "")))}>确认打款</button>
              </div>
            </Panel>
            <Panel title="代理收益" kicker="商家">
              <KeyValue label="成交订单" value={text(data.agentDashboard?.paidOrderCount, "0")} />
              <KeyValue label="预估收益" value={cents(data.agentDashboard?.expectedIncomeCents)} />
              <KeyValue label="退款率" value={`${(Number(data.agentDashboard?.refundRateBps ?? 0) / 100).toFixed(2)}%`} />
            </Panel>
          </section>
          <Panel title="结算单" kicker={`${data.settlements.length} 条`}>
            <Table rows={data.settlements} columns={["settlementNo", "status", "totalOrderCount", "totalAgentIncomeCents"]} moneyColumns={["totalAgentIncomeCents"]} />
          </Panel>
          <Panel title="账务流水" kicker={`${data.ledgerEntries.length} 条`}>
            <Table rows={data.ledgerEntries.slice(-10)} columns={["ledgerNo", "entryType", "orderNo", "agentId", "amountCents"]} moneyColumns={["amountCents"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "risk") {
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
            <Table rows={data.auditLogs.slice(-10)} columns={["action", "targetType", "targetId", "actor"]} />
          </Panel>
        </Module>
      );
    }

    return (
      <Module title="支付配置" subtitle="支付最后接；当前只做人工确认收款闭环">
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
            <h1>后台登录</h1>
            <p>使用后台账号登录后，系统通过服务端签发的 Bearer Token 访问平台管理 API。</p>
          </div>
          <div className="login-form">
            <label>账号<input autoComplete="username" value={loginForm.username} onChange={(event) => setLoginForm({ ...loginForm, username: event.target.value })} /></label>
            <label>密码<input type="password" autoComplete="current-password" value={loginForm.password} onChange={(event) => setLoginForm({ ...loginForm, password: event.target.value })} /></label>
            {import.meta.env.DEV ? (
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
        {groupedNav().map((group) => (
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
            <span>{text(session.admin.displayName, text(session.admin.adminRole, "admin"))}</span>
            {currentShopId ? <a href={`/s/${currentShopId}`} target="_blank" rel="noreferrer">打开店铺</a> : null}
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

function Table(props: { rows: JsonRecord[]; columns: string[]; moneyColumns?: string[] }) {
  const moneyColumns = new Set(props.moneyColumns ?? []);
  if (props.rows.length === 0) return <p className="empty">暂无记录</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{props.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {props.rows.map((row, index) => (
            <tr key={`${props.columns.map((column) => text(row[column])).join("-")}-${index}`}>
              {props.columns.map((column) => <td key={column}>{moneyColumns.has(column) ? cents(row[column]) : cellText(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function validatePlatformProductForm(form: {
  name: string;
  stockCount: string;
  soldCount: string;
  supplyPriceCents: string;
  minSalePriceCents: string;
  suggestedSalePriceCents: string;
}): string {
  if (!form.name.trim()) return "请填写商品名称";
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

function validateCouponForm(form: { name: string; discountCents: string; validDays: string }): string {
  if (!form.name.trim()) return "请填写优惠券名称";
  if (!isPositiveInteger(form.discountCents)) return "请填写合法抵扣金额，金额必须是正整数分";
  if (!isPositiveInteger(form.validDays)) return "有效天数必须是正整数";
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

function groupedNav() {
  const groups = [...new Set(navItems.map((item) => item.group))];
  return groups.map((name) => ({
    name,
    items: navItems.filter((item) => item.group === name)
  }));
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

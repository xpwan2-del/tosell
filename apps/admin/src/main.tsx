import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiClientError, api, cents, text, type AdminSession, type MerchantListingDisplayInput, type MerchantSession, type JsonRecord, type PaymentMethodInput, type PaymentQueryInput } from "./api.js";
import "./styles.css";

type LoadState = {
  shop?: JsonRecord;
  platformShop?: JsonRecord;
  publicProducts: JsonRecord[];
  platformShopProducts: JsonRecord[];
  merchantProducts: JsonRecord[];
  platformProducts: JsonRecord[];
  ownProducts: JsonRecord[];
  merchantOrders: JsonRecord[];
  adminOrders: JsonRecord[];
  merchantApplications: JsonRecord[];
  inviteCodes: JsonRecord[];
  adminAfterSales: JsonRecord[];
  adminRefunds: JsonRecord[];
  adminSettlements: JsonRecord[];
  adminDeposits: JsonRecord[];
  serviceQrCodes: JsonRecord[];
  riskFreezes: JsonRecord[];
  paymentMethods: JsonRecord[];
  paymentCallbacks: JsonRecord[];
  paymentExceptions: JsonRecord[];
  paymentVouchers: JsonRecord[];
  wallets: JsonRecord[];
  walletRecharges: JsonRecord[];
  walletTransactions: JsonRecord[];
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
  merchantDashboard?: JsonRecord;
  riskDashboard?: JsonRecord;
  salesDashboard?: JsonRecord;
  paymentGuide?: JsonRecord;
  platformServiceFee?: JsonRecord;
};

const initialState: LoadState = {
  publicProducts: [],
  platformShopProducts: [],
  merchantProducts: [],
  platformProducts: [],
  ownProducts: [],
  merchantOrders: [],
  adminOrders: [],
  merchantApplications: [],
  inviteCodes: [],
  adminAfterSales: [],
  adminRefunds: [],
  adminSettlements: [],
  adminDeposits: [],
  serviceQrCodes: [],
  riskFreezes: [],
  paymentMethods: [],
  paymentCallbacks: [],
  paymentExceptions: [],
  paymentVouchers: [],
  wallets: [],
  walletRecharges: [],
  walletTransactions: [],
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
  { id: "inventory", label: "自动发货库存", group: "经营" },
  { id: "coupons", label: "优惠券", group: "经营" },
  { id: "orders", label: "订单", group: "经营" },
  { id: "fulfillment", label: "发货", group: "经营" },
  { id: "afterSales", label: "售后", group: "经营" },
  { id: "sales", label: "销售统计", group: "数据" },
  { id: "shops", label: "店铺设置", group: "店铺" },
  { id: "merchants", label: "商户管理", group: "平台" },
  { id: "secondTierChannels", label: "下级供货", group: "平台" },
  { id: "settlements", label: "结算", group: "财务" },
  { id: "risk", label: "风控日志", group: "平台" },
  { id: "payment", label: "收款配置", group: "财务" }
] as const;

type ModuleId = (typeof navItems)[number]["id"];
type BackendSession = AdminSession | MerchantSession;
type RightsCodePrecheckResult = {
  totalLines: number;
  validCodes: string[];
  blankLines: number[];
  duplicateCodes: string[];
  invalidRows: Array<{ line: number; value: string; reason: string }>;
};
type ConfirmRow = {
  label: string;
  before?: string;
  value: string;
  kind?: "text" | "image";
};
type ConfirmAction = {
  title: string;
  description: string;
  rows: ConfirmRow[];
  confirmText: string;
  actionLabel: string;
  run: () => Promise<unknown>;
};
type ProductFormState = {
  name: string;
  category: string;
  tags: string;
  subtitle: string;
  description: string;
  usageGuide: string;
  imageUrl: string;
  specs: string;
  detailSections: string;
  stockCount: string;
  soldCount: string;
  fulfillmentMode: string;
  credentialType: string;
  supplyPriceCents: string;
  minSalePriceCents: string;
  suggestedSalePriceCents: string;
  status: string;
};
type MerchantListingFormState = MerchantListingDisplayInput;
type PlatformShopProductFormState = {
  shopId: string;
  platformProductId: string;
  salePriceCents: string;
  fulfillmentCostCents: string;
  status: string;
};
const configuredShopId = import.meta.env.VITE_SHOP_ID ?? "";
const configuredPlatformShopId = import.meta.env.VITE_PLATFORM_SHOP_ID ?? "";

const mvpCoverageLabels = [
  "基础看板",
  "商户审核",
  "保证金",
  "下级供货",
  "店铺管理",
  "平台自营",
  "商品管理",
  "商户自有商品审核",
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

const moduleHelp: Record<string, string[]> = {
  首页: ["这里是工作台，只放今天要处理的事。", "先处理待办，再看最近订单；经营数据请去销售统计。"],
  商品: ["商品列表点击“选择”会带出商品详情进行修改。", "自动发货商品去自动发货库存导入兑换码、卡密或账号密码；人工交付商品只维护交付说明和客服信息。"],
  自动发货库存: ["先选择自动发货商品，再按商品的凭证类型导入兑换码/卡密或账号密码。", "默认只看内容预览，平台查看完整库存内容会写入审计。"],
  优惠券: ["平台统一创建、启用、停用优惠券。", "注册赠券和退款后作废规则由后端处理，前台不能绕过。"],
  订单管理: ["先看待办，再处理订单；列表里的按钮会直接告诉你下一步该做什么。", "官方支付订单等回调或查单；只有个人支付宝订单才人工确认到账。"],
  发货管理: ["自动发货订单在确认收款后自动发出库存凭证。", "人工交付订单由商户按客服/交付说明处理后确认发货。"],
  售后退款: ["先选择订单或售后单，再做拆账、审批和人工退款确认。", "退款完成后客户不能再查看已发出的库存凭证。"],
  销售统计: ["这里单独看经营数据，不处理订单。", "金额以已支付订单和 ledger 为准。"],
  店铺设置: ["维护买家能看到的店铺名称、公告、客服微信/QQ 和收款信息。", "平台不做在线客服，只展示联系方式和二维码。"],
  商户管理: ["平台创建或审核商户，确认保证金后商户才可以经营。", "上游商户只能看下游经营汇总，不能操作下游商户数据。"],
  下级供货: ["用于维护一级给二级、二级给三级的供货关系和转供价。", "三级不能再创建四级。"],
  结算: ["生成结算单后再人工确认打款。", "退款和追扣会影响可结算金额。"],
  风控日志: ["冻结订单或店铺用于紧急止损。", "所有风控动作都要能在审计中追溯。"],
  收款配置: ["这里绑定收钱方式，不在这里设置商品怎么发货。", "支付宝商户、微信商户、e支付靠回调/查单确认；个人支付宝只能人工确认。"]
};

const fieldLabels: Record<string, string> = {
  id: "编号",
  codeId: "库存编号",
  productId: "商品编号",
  platformProductId: "平台商品",
  merchantProductListingId: "店铺商品",
  ownProductId: "自有商品",
  shopId: "店铺",
  merchantId: "商户",
  merchantTier: "商户等级",
  firstTierMerchantId: "一级商户",
  secondTierMerchantId: "二级商户",
  thirdTierMerchantId: "三级商户",
  downstreamMerchantId: "下游商户",
  channelRelationId: "供货关系",
  userId: "买家",
  reviewedBy: "审核人",
  createdBy: "创建人",
  orderNo: "订单号",
  afterSaleNo: "售后单号",
  refundNo: "退款单号",
  settlementNo: "结算单号",
  payoutNo: "打款单号",
  clawbackNo: "追扣单号",
  transactionNo: "流水号",
  walletNo: "钱包号",
  rechargeNo: "充值单号",
  applicationNo: "申请单号",
  name: "名称",
  productName: "商品名称",
  shopName: "店铺名称",
  category: "类目",
  tags: "标签",
  subtitle: "副标题",
  description: "商品说明",
  usageGuide: "使用说明",
  fulfillmentMode: "发货方式",
  status: "状态",
  reviewStatus: "审核状态",
  paymentStatus: "支付状态",
  fulfillmentStatus: "发货状态",
  refundStatus: "退款状态",
  settlementStatus: "结算状态",
  riskStatus: "风控状态",
  stockCount: "库存",
  soldCount: "销量",
  salePriceCents: "售价",
  fulfillmentCostCents: "履约成本",
  supplyPriceCents: "供货价",
  platformSupplyPriceCents: "平台供货价",
  visibleUpstreamSupplyPriceCents: "上游供货价",
  minSalePriceCents: "最低售价",
  suggestedSalePriceCents: "建议售价",
  resellSupplyPriceCents: "转供价",
  totalPaidCents: "成交额",
  paidOrderCount: "已支付订单",
  orderCount: "订单数",
  totalOrderCount: "订单数",
  totalMerchantIncomeCents: "商户收益",
  requiredAmountCents: "应缴保证金",
  availableAmountCents: "可用保证金",
  amountCents: "金额",
  requestedRefundCents: "申请退款",
  discountCents: "抵扣金额",
  validDays: "有效天数",
  grantOnFirstRegister: "注册赠送",
  productIds: "适用商品",
  channel: "支付渠道",
  provider: "支付类型",
  collectionAccountName: "收款账户",
  collectionQrUrl: "收款二维码",
  collectionNote: "收款说明",
  displayName: "展示名称",
  accountName: "账户名",
  qrUrl: "二维码",
  voucherUrl: "异常材料",
  payerName: "付款人",
  note: "备注",
  customerServiceWechat: "客服微信",
  customerServiceQrUrl: "微信二维码",
  customerServiceQq: "客服 QQ",
  customerServiceQqQrUrl: "QQ 二维码",
  ownerType: "归属",
  targetType: "对象类型",
  targetId: "对象",
  freezeType: "冻结类型",
  entryType: "账务类型",
  sourceType: "来源类型",
  sourceId: "来源",
  availableBalanceCents: "可用余额",
  frozenBalanceCents: "冻结余额",
  totalRechargeCents: "累计充值",
  totalSpendCents: "累计消费",
  balanceBeforeCents: "变动前余额",
  balanceAfterCents: "变动后余额",
  type: "类型",
  direction: "方向",
  reasonCode: "原因",
  maxUses: "最多使用",
  usedCount: "已使用",
  expiresAt: "过期时间",
  reviewedAt: "审核时间",
  createdAt: "创建时间",
  updatedAt: "更新时间",
  batchNo: "批次",
  productCode: "商品编号",
  credentialLabel: "凭证类型",
  credentialType: "凭证类型",
  codePreview: "内容预览",
  code: "完整内容",
  envVar: "配置项"
};

const valueLabels: Record<string, string> = {
  pending: "待处理",
  pending_review: "待审核",
  approved: "已通过",
  rejected: "已拒绝",
  active: "启用",
  listed: "上架",
  disabled: "停用",
  frozen: "冻结",
  open: "营业中",
  not_opened: "未开店",
  paid: "已支付",
  unpaid: "待付款",
  pending_payment: "待付款",
  fulfilled: "已完成",
  fulfilling: "发货中",
  not_started: "未发货",
  success: "成功",
  failed: "失败",
  processing: "处理中",
  refunded: "已退款",
  refunding: "退款中",
  none: "无",
  manual: "人工交付",
  code_pool: "自动发库存凭证",
  platform: "平台",
  merchant: "商户",
  user: "买家",
  recharge: "充值",
  payment_capture: "支付扣款",
  payment_hold: "支付冻结",
  payment_release: "释放冻结",
  adjustment: "人工调整",
  credit: "入账",
  debit: "出账",
  mixed: "共同承担",
  available: "可用",
  issued: "已发放",
  voided: "已作废",
  voided_after_refund: "退款后作废",
  first_tier: "一级商户",
  second_tier: "二级商户",
  third_tier: "三级商户",
  alipay_personal_qr: "支付宝个人码",
  alipay_merchant_qr: "支付宝商户码",
  alipay_merchant_link: "支付宝链接",
  wechat_personal_qr: "微信个人码",
  wechat_merchant_qr: "微信商户码",
  wechat_merchant_link: "微信链接",
  platform_self_operated: "平台自营",
  single_merchant: "单商户销售",
  merchant_owned: "商户自有",
  normal: "正常",
  enabled: "已启用",
  pending_manual_confirmation: "待人工确认",
  created: "已创建",
  paying: "付款中",
  provider_not_configured: "收款方式未配置",
  not_configured: "未配置",
  callback_query: "回调/查单确认",
  manual_confirm: "人工确认",
  alipay_merchant: "支付宝商户",
  wechat_merchant: "微信/腾讯商户",
  epay: "e支付",
  personal_alipay: "个人支付宝",
  alipay_wap: "支付宝",
  accepted: "已接收",
  processed: "已处理",
  ignored_duplicate: "重复通知已忽略"
};

function App() {
  const [data, setData] = useState<LoadState>(initialState);
  const [active, setActive] = useState<ModuleId>(() => moduleFromHash());
  const [session, setSession] = useState<BackendSession | undefined>(() => api.currentAdminSession() ?? api.currentMerchantSession());
  const [loginMode, setLoginMode] = useState<"admin" | "merchant">(() => api.currentMerchantSession() ? "merchant" : "admin");
  const [message, setMessage] = useState(session ? "正在连接 API..." : "请先登录后台");
  const [loading, setLoading] = useState(false);
  const [actionLabel, setActionLabel] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | undefined>();
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
  const [adminMerchantId, setAdminMerchantId] = useState("");
  const [channelRelationForm, setChannelRelationForm] = useState({
    firstTierMerchantId: "",
    secondTierMerchantId: "",
    thirdTierMerchantId: ""
  });
  const [selectedChannelRelationId, setSelectedChannelRelationId] = useState("");
  const [selectedChannelProductId, setSelectedChannelProductId] = useState("");
  const [downstreamMerchantId, setDownstreamMerchantId] = useState("");
  const [afterSaleAssistNote, setAfterSaleAssistNote] = useState("");
  const [attemptNo, setAttemptNo] = useState(1);
  const [selectedPlatformProduct, setSelectedPlatformProduct] = useState<JsonRecord | undefined>();
  const [selectedListingPlatformProduct, setSelectedListingPlatformProduct] = useState<JsonRecord | undefined>();
  const [selectedPlatformShopProductOverride, setSelectedPlatformShopProductOverride] = useState<JsonRecord | undefined>();
  const [selectedMerchantProductOverride, setSelectedMerchantProductOverride] = useState<JsonRecord | undefined>();
  const [selectedOwnProductReview, setSelectedOwnProductReview] = useState<JsonRecord | undefined>();
  const [productDetailTab, setProductDetailTab] = useState<"base" | "codes" | "audit">("base");
  const [rightsPrecheck, setRightsPrecheck] = useState<RightsCodePrecheckResult | undefined>();
  const [productForm, setProductForm] = useState<ProductFormState>({
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
    credentialType: "code",
    supplyPriceCents: "",
    minSalePriceCents: "",
    suggestedSalePriceCents: "",
    status: "active"
  });
  const [merchantListingForm, setMerchantListingForm] = useState<MerchantListingFormState>({
    salePriceCents: "",
    status: "listed",
    displayName: "",
    displaySubtitle: "",
    displayDescription: "",
    displayUsageGuide: "",
    displayImageUrl: "",
    displayCategory: "",
    displayTags: "",
    displaySpecs: "",
    displayDetailSections: ""
  });
  const [platformShopProductForm, setPlatformShopProductForm] = useState<PlatformShopProductFormState>({
    shopId: "",
    platformProductId: "",
    salePriceCents: "",
    fulfillmentCostCents: "",
    status: "listed"
  });
  const [inventoryForm, setInventoryForm] = useState({
    productId: "",
    batchNo: "",
    codes: ""
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
  const [couponGrantForm, setCouponGrantForm] = useState({
    couponId: "",
    target: "all_users",
    userId: "",
    phone: ""
  });
  const [manualMerchantForm, setManualMerchantForm] = useState({
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
    category: "",
    tags: "",
    subtitle: "",
    description: "",
    usageGuide: "",
    imageUrl: "",
    specs: "",
    detailSections: "",
    salePriceCents: "",
    minSalePriceCents: "",
    fulfillmentMode: "",
    credentialType: "code"
  });
  const [paymentMethodForm, setPaymentMethodForm] = useState({
    provider: "",
    displayName: "",
    accountName: "",
    qrUrl: "",
    paymentUrl: "",
    productType: "",
    merchantNo: "",
    appId: "",
    serviceProviderId: "",
    gatewayUrl: "",
    apiMode: "submit",
    returnUrl: "",
    note: "",
    signingSecret: "",
    privateKey: "",
    publicKey: "",
    certificate: "",
    enabled: true,
    isDefault: false
  });
  const [paymentExceptionNote, setPaymentExceptionNote] = useState("");
  const [paymentMethodFeedback, setPaymentMethodFeedback] = useState("");
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState("");
  const [paymentQueryForm, setPaymentQueryForm] = useState<PaymentQueryInput>({
    providerTradeNo: "",
    amountCents: "",
    merchantNo: "",
    appId: "",
    serviceProviderId: "",
    tradeStatus: "TRADE_SUCCESS",
    signature: ""
  });
  const [serviceFeeForm, setServiceFeeForm] = useState({ enabled: true, feeBps: "50" });
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
  const selectedPlatformShopProduct = selectedPlatformShopProductOverride ?? data.platformShopProducts[0];
  const selectedMerchantProduct = selectedMerchantProductOverride ?? data.merchantProducts[0];
  const selectedListingExistingProduct = selectedListingPlatformProduct
    ? data.merchantProducts.find((item) => text(item.platformProductId) === text(selectedListingPlatformProduct.id))
    : undefined;
  const selectedOwnMerchantProduct = data.merchantProducts.find((item) => text(item.id) === inventoryForm.productId)
    ?? data.merchantProducts.find((item) => text(item.productType) === "merchant_owned")
    ?? data.merchantProducts[0];
  const selectedOwnProduct = selectedOwnProductReview ?? data.ownProducts.find((item) => text(item.reviewStatus) === "pending_review") ?? data.ownProducts[0];
  const activeMerchantSession = isMerchantSession(session) ? session : undefined;
  const merchantSessionActive = Boolean(activeMerchantSession);
  const visibleOrders = merchantSessionActive ? data.merchantOrders : data.adminOrders;
  const selectedOrder = currentOrder ?? visibleOrders.find((order) => text(order.paymentStatus) === "unpaid") ?? visibleOrders[0];
  const selectedOrderNo = text(selectedOrder?.orderNo, "");
  const selectedOrderAmount = amountOf(selectedOrder);
  const selectedPaymentMethod = data.paymentMethods.find((item) => text(item.id) === selectedPaymentMethodId)
    ?? data.paymentMethods.find((item) => text(item.status) !== "disabled")
    ?? data.paymentMethods[0];
  const selectedPaymentException = data.paymentExceptions.find((item) => item.handled !== true) ?? data.paymentExceptions[0];
  const selectedPaymentVoucher = data.paymentVouchers.find((item) => text(item.status) === "pending_review") ?? data.paymentVouchers[0];
  const selectedWalletRecharge = data.walletRecharges.find((item) => text(item.status) === "pending_payment") ?? data.walletRecharges[0];
  const selectedOrderPaymentVouchers = data.paymentVouchers.filter((item) => text(item.orderNo) === selectedOrderNo);
  const visibleSettlements = merchantSessionActive ? data.settlements : data.adminSettlements;
  const selectedSettlement = visibleSettlements.find((sheet) => text(sheet.status) !== "paid") ?? visibleSettlements[0];
  const currentShopId = text(data.shop?.id, text(activeMerchantSession?.shop.shopId, ""));
  const currentShopShareUrl = shopShareUrl(currentShopId, data.shop);
  const currentProductId = text(selectedPublicProduct?.id, "");
  const currentMerchantId = merchantSessionActive
    ? text(activeMerchantSession?.merchant.merchantId, "")
    : text(adminMerchantId, text(data.merchantApplications[0]?.merchantId, text(data.adminDeposits[0]?.merchantId, "")));
  const currentMerchantTier = text(activeMerchantSession?.merchant.tier, "");
  const canConfigureDownstreamOffer = merchantSessionActive && ["first_tier", "second_tier"].includes(currentMerchantTier);
  const merchantInviteTargetTier = currentMerchantTier === "first_tier" ? "second_tier" : currentMerchantTier === "second_tier" ? "third_tier" : "";
  const peerMerchantId = text(data.merchantApplications.find((item) => text(item.merchantId) !== currentMerchantId)?.merchantId, "");
  const currentPlatformProductId = selectedChannelProductId || text(selectedPlatformProduct?.id, text(data.platformProducts[0]?.id, ""));
  const currentChannelRelationId = selectedChannelRelationId || text(channelRows(data.channels, "relations")[0]?.id, "");
  const currentDeposit = data.adminDeposits.find((item) => text(item.merchantId) === currentMerchantId);
  const currentDepositStatus = text(currentDeposit?.status, text(activeMerchantSession?.merchant.depositStatus, ""));
  const merchantBlockedReason = currentMerchantId && currentDepositStatus !== "paid"
    ? `保证金未确认，后端将拒绝销售、选品、选品和转供价操作；当前状态：${text(currentDepositStatus, "unknown")}`
    : "";
  const merchantBlocked = Boolean(merchantBlockedReason);
  const platformProductColumns = merchantSessionActive
    ? [
      "id",
      "name",
      "category",
      "tags",
      "fulfillmentMode",
      "stockCount",
      "soldCount",
      currentMerchantTier === "first_tier" ? "supplyPriceCents" : "visibleUpstreamSupplyPriceCents",
      "minSalePriceCents",
      "suggestedSalePriceCents",
      "status"
    ]
    : ["id", "name", "category", "tags", "fulfillmentMode", "stockCount", "soldCount", "supplyPriceCents", "minSalePriceCents", "suggestedSalePriceCents", "status"];
  const merchantProductColumns = merchantSessionActive
    ? ["id", "productName", "category", "fulfillmentMode", "stockCount", "soldCount", "salePriceCents", currentMerchantTier === "first_tier" ? "platformSupplyPriceCents" : "visibleUpstreamSupplyPriceCents", "minSalePriceCents", "status"]
    : ["id", "productName", "category", "fulfillmentMode", "stockCount", "soldCount", "salePriceCents", "supplyPriceCents", "minSalePriceCents", "status"];

  const metrics = useMemo(() => {
    if (merchantSessionActive) {
      return [
        { label: "成交额", value: cents(data.merchantDashboard?.gmvCents), tone: "strong" },
        { label: "订单数", value: String(data.merchantOrders.length) },
        { label: "已收款", value: text(data.merchantDashboard?.paidOrderCount, "0") },
        { label: "预估收益", value: cents(data.merchantDashboard?.expectedIncomeCents) },
        { label: "售后中", value: String(data.merchantOrders.filter((item) => text(item.refundStatus, "none") !== "none").length) },
        { label: "待结算", value: String(data.settlements.filter((item) => text(item.status) !== "paid").length) }
      ];
    }
    const reconciliation = data.reconciliation ?? {};
    return [
      { label: "成交额", value: cents(reconciliation.totalPaidCents), tone: "strong" },
      { label: "订单数", value: text(data.salesDashboard?.orderCount, "0") },
      { label: "已收款", value: text(data.salesDashboard?.paidOrderCount, "0") },
      { label: "可发库存", value: String(data.rightsCodes.filter((item) => text(item.status) === "available").length) },
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
    const merchantSession = api.currentMerchantSession();
    if (!adminSession && !merchantSession) {
      setSession(undefined);
      setMessage("请先登录后台");
      return;
    }
    const merchantSessionActive = Boolean(merchantSession && !adminSession);
    setLoading(true);
    let partialLoadErrors = 0;
    try {
      if (merchantSessionActive) await api.merchantSession();
      else await api.adminSession();
      const optional = async <T,>(loader: () => Promise<T>, fallback: T): Promise<T> => {
        try {
          return await loader();
        } catch (error) {
          if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
            return fallback;
          }
          partialLoadErrors += 1;
          return fallback;
        }
      };
      const shop = merchantSessionActive
        ? await optional(api.merchantShop, {} as JsonRecord)
        : configuredShopId
          ? await optional(() => api.shop(configuredShopId), {} as JsonRecord)
          : {} as JsonRecord;
      const shopIdForPublicData = text(shop.id, configuredShopId);
      const loadPlatformProducts = merchantSessionActive ? api.platformProducts : api.adminPlatformProducts;
      const loadOrders = merchantSessionActive ? api.merchantOrders : api.adminOrders;
      const loadAfterSales = merchantSessionActive ? api.merchantAfterSales : api.adminAfterSales;
      const loadInviteCodes = merchantSessionActive ? api.merchantInviteCodes : api.inviteCodes;
      const [
        platformShop,
        publicProducts,
        platformShopProducts,
        merchantProducts,
        platformProducts,
        ownProducts,
        merchantOrders,
        settlements,
        clawbacks,
        depositTransactions,
        adminOrders,
        merchantApplications,
        inviteCodes,
        adminAfterSales,
        adminRefunds,
        adminSettlements,
        adminDeposits,
        channels,
        serviceQrCodes,
        riskFreezes,
        paymentMethods,
        paymentCallbacks,
        paymentExceptions,
        paymentVouchers,
        wallets,
        walletRecharges,
        walletTransactions,
        coupons,
        auditLogs,
        ledgerEntries,
        reconciliation,
        rightsCodes,
        notifications,
        merchantDashboard,
        riskDashboard,
        salesDashboard,
        paymentGuide,
        platformServiceFee
      ] = await Promise.all([
        configuredPlatformShopId ? optional(() => api.shop(configuredPlatformShopId), {}) : Promise.resolve({} as JsonRecord),
        shopIdForPublicData ? optional(() => api.shopProducts(shopIdForPublicData), []) : Promise.resolve([] as JsonRecord[]),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.adminPlatformShopProducts, []),
        merchantSessionActive ? optional(api.merchantProducts, []) : Promise.resolve([] as JsonRecord[]),
        optional(loadPlatformProducts, []),
        merchantSessionActive ? optional(api.ownProducts, []) : optional(api.adminOwnProductReviews, []),
        merchantSessionActive ? optional(api.merchantOrders, []) : Promise.resolve([] as JsonRecord[]),
        merchantSessionActive ? optional(api.merchantSettlements, []) : Promise.resolve([] as JsonRecord[]),
        merchantSessionActive ? optional(api.merchantClawbacks, []) : Promise.resolve([] as JsonRecord[]),
        merchantSessionActive ? optional(api.merchantDepositTransactions, []) : Promise.resolve([] as JsonRecord[]),
        optional(loadOrders, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.merchantApplications, []),
        optional(loadInviteCodes, []),
        optional(loadAfterSales, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.adminRefunds, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.adminSettlements, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.adminDeposits, []),
        merchantSessionActive ? Promise.resolve({} as JsonRecord) : optional(api.adminChannels, {}),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.serviceQrCodes, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.riskFreezes, []),
        merchantSessionActive ? optional(api.merchantPaymentMethods, []) : optional(api.adminPaymentMethods, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.paymentCallbacks, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.paymentExceptions, []),
        merchantSessionActive ? optional(api.merchantPaymentVouchers, []) : optional(api.paymentVouchers, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.wallets, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.walletRecharges, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.walletTransactions, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.adminCoupons, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.auditLogs, []),
        merchantSessionActive ? Promise.resolve([] as JsonRecord[]) : optional(api.ledgerEntries, []),
        merchantSessionActive ? Promise.resolve({} as JsonRecord) : optional(api.reconciliationSummary, {}),
        merchantSessionActive ? optional(() => api.merchantRightsCodes(), []) : optional(api.rightsCodes, []),
        merchantSessionActive ? optional(api.notifications, []) : Promise.resolve([] as JsonRecord[]),
        merchantSessionActive ? optional(api.merchantDashboard, {}) : Promise.resolve({} as JsonRecord),
        merchantSessionActive ? Promise.resolve({} as JsonRecord) : optional(api.riskDashboard, {}),
        merchantSessionActive ? Promise.resolve({} as JsonRecord) : optional(api.salesDashboard, {}),
        merchantSessionActive ? Promise.resolve({} as JsonRecord) : optional(api.paymentGuide, {}),
        merchantSessionActive ? Promise.resolve({} as JsonRecord) : optional(api.platformServiceFee, {})
      ]);
      setData({
        shop,
        platformShop,
        publicProducts,
        platformShopProducts,
        merchantProducts,
        platformProducts,
        ownProducts,
        merchantOrders,
        settlements,
        clawbacks,
        depositTransactions,
        adminOrders,
        merchantApplications,
        inviteCodes,
        adminAfterSales,
        adminRefunds,
        adminSettlements,
        adminDeposits,
        channels,
        serviceQrCodes,
        riskFreezes,
        paymentMethods,
        paymentCallbacks,
        paymentExceptions,
        paymentVouchers,
        wallets,
        walletRecharges,
        walletTransactions,
        coupons,
        auditLogs,
        ledgerEntries,
        reconciliation,
        rightsCodes,
        notifications,
        merchantDashboard,
        riskDashboard,
        salesDashboard,
        paymentGuide,
        platformServiceFee
      });
      const nextVisibleOrders = merchantSessionActive ? merchantOrders : adminOrders;
      setCurrentOrder((order) => order ?? nextVisibleOrders.find((item) => text(item.paymentStatus) === "unpaid") ?? nextVisibleOrders[0]);
      setSelectedPaymentMethodId((current) =>
        paymentMethods.some((method) => text(method.id) === current)
          ? current
          : text(paymentMethods.find((method) => text(method.status) !== "disabled")?.id, text(paymentMethods[0]?.id, ""))
      );
      setShopForm({
        name: text(shop.name, ""),
        announcement: text(shop.announcement, ""),
        customerServiceWechat: text(shop.customerServiceWechat, ""),
        customerServiceQrUrl: text(shop.customerServiceQrUrl, "")
      });
      setPaymentMethodForm((current) => current.provider ? current : paymentMethodToForm(paymentMethods[0]));
      setServiceFeeForm({
        enabled: dataBool(platformServiceFee.enabled, true),
        feeBps: text(platformServiceFee.feeBps, "50")
      });
      setInventoryForm((current) => ({
        ...current,
        productId: current.productId || text(platformProducts.find((item) => productFulfillmentMode(item) === "code_pool")?.id, "")
      }));
      if (!merchantSessionActive) {
        setAdminMerchantId((current) => current || text(merchantApplications[0]?.merchantId, text(adminDeposits[0]?.merchantId, "")));
      }
      setMessage(partialLoadErrors > 0 ? `${status}，${partialLoadErrors} 个非关键模块暂未加载` : status);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        api.clearAdminSession();
        api.clearMerchantSession();
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

  async function runAction(label: string, action: () => Promise<unknown>, refresh = true, options: { skipConfirm?: boolean } = {}) {
    if (loading) return false;
    if (!options.skipConfirm && requiresActionConfirmation(label) && !window.confirm(`${label}会写入后台数据并记录审计，确认继续？`)) {
      setMessage(`${label}已取消`);
      return false;
    }
    setLoading(true);
    setActionLabel(label);
    setMessage(`${label}处理中...`);
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
      return true;
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        api.clearAdminSession();
        api.clearMerchantSession();
        setSession(undefined);
        setAuthError(error.code === "AUTH_EXPIRED" ? "登录已过期，请重新登录。" : "未登录或登录无效，请重新登录。");
        setMessage("请先登录后台");
      } else if (error instanceof ApiClientError && error.status === 403) {
        setMessage(`${label}失败：当前账号权限不足`);
      } else {
        setMessage(`${label}失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
      return false;
    } finally {
      setLoading(false);
      setActionLabel("");
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
        ? await api.merchantLogin({
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
        api.saveMerchantSession(nextSession as MerchantSession);
      } else {
        api.clearMerchantSession();
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
    api.clearMerchantSession();
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

  function pickPlatformProduct(row: JsonRecord) {
    setSelectedPlatformProduct(row);
    setProductDetailTab("base");
    setRightsPrecheck(undefined);
    setPlatformShopProductForm((current) => ({
      ...current,
      shopId: text(data.platformShop?.id, configuredPlatformShopId || current.shopId),
      platformProductId: text(row.id, current.platformProductId),
      salePriceCents: text(row.suggestedSalePriceCents, current.salePriceCents),
      fulfillmentCostCents: text(row.supplyPriceCents, current.fulfillmentCostCents),
      status: current.status || "listed"
    }));
    const rule = row.fulfillmentRule as JsonRecord | undefined;
    setProductForm({
      name: text(row.name, ""),
      category: text(row.category, ""),
      tags: Array.isArray(row.tags) ? row.tags.map((item) => text(item, "")).filter(Boolean).join("，") : "",
      subtitle: text(row.subtitle, ""),
      description: text(row.description, ""),
      usageGuide: text(row.usageGuide, ""),
      imageUrl: text(row.imageUrl, ""),
      specs: Array.isArray(row.specs) ? row.specs.map((item) => text(item, "")).filter(Boolean).join("\n") : "",
      detailSections: formatDetailSections(row.detailSections),
      stockCount: text(row.stockCount, ""),
      soldCount: text(row.soldCount, ""),
      fulfillmentMode: text(rule?.mode, "manual"),
      credentialType: text(rule?.credentialType, "code"),
      supplyPriceCents: text(row.supplyPriceCents, ""),
      minSalePriceCents: text(row.minSalePriceCents, ""),
      suggestedSalePriceCents: text(row.suggestedSalePriceCents, ""),
      status: text(row.status, "active")
    });
    setMessage(`已选择平台商品：${text(row.name, text(row.id))}`);
  }

  function pickListingPlatformProduct(row: JsonRecord) {
    const existing = data.merchantProducts.find((item) => text(item.platformProductId) === text(row.id));
    const product = (existing?.product as JsonRecord | undefined) ?? row;
    const salePrice = text(existing?.salePriceCents, text(row.suggestedSalePriceCents, ""));
    setSelectedListingPlatformProduct(row);
    setSelectedMerchantProductOverride(existing);
    setMerchantListingForm({
      salePriceCents: salePrice,
      status: text(existing?.status, "listed"),
      displayName: text(product.name, text(row.name, "")),
      displaySubtitle: text(product.subtitle, text(row.subtitle, "")),
      displayDescription: text(product.description, text(row.description, "")),
      displayUsageGuide: text(product.usageGuide, text(row.usageGuide, "")),
      displayImageUrl: text(product.imageUrl, text(row.imageUrl, "")),
      displayCategory: text(product.category, text(row.category, "")),
      displayTags: Array.isArray(product.tags) ? product.tags.map((item) => text(item, "")).filter(Boolean).join("，") : "",
      displaySpecs: Array.isArray(product.specs) ? product.specs.map((item) => text(item, "")).filter(Boolean).join("\n") : "",
      displayDetailSections: formatDetailSections(product.detailSections)
    });
    setMessage(existing ? "已打开店铺商品编辑。" : "已打开选品上架编辑。");
  }

  function pickListedMerchantProduct(row: JsonRecord) {
    const existing = data.merchantProducts.find((item) => text(item.id) === text(row.id)) ?? row;
    setSelectedMerchantProductOverride(existing);
    const platformProductId = text(existing.platformProductId);
    const platformProduct = data.platformProducts.find((item) => text(item.id) === platformProductId);
    if (platformProduct) pickListingPlatformProduct(platformProduct);
  }

  function submitMerchantListing() {
    if (!selectedListingPlatformProduct?.id) {
      setMessage("请先从可店铺商品列表选择一个商品。");
      return;
    }
    const minPrice = Number(text(selectedListingPlatformProduct.visibleUpstreamSupplyPriceCents, text(selectedListingPlatformProduct.minSalePriceCents, "0")));
    const salePrice = Number(merchantListingForm.salePriceCents);
    if (!Number.isInteger(salePrice) || salePrice <= 0) {
      setMessage("销售价必须填写正整数分。");
      return;
    }
    if (minPrice > 0 && salePrice < minPrice) {
      setMessage(`销售价不能低于当前可见最低价 ${cents(String(minPrice))}。`);
      return;
    }
    const existing = selectedListingExistingProduct;
    const platformName = text(selectedListingPlatformProduct.name, text(selectedListingPlatformProduct.id));
    const displayName = text(merchantListingForm.displayName, platformName);
    const actionName = existing?.id ? "保存当前店铺商品" : "选品并上架";
    const action = existing?.id
      ? () => api.updateMerchantProductDetail(text(existing.id), merchantListingForm)
      : () => api.selectPlatformProduct(text(selectedListingPlatformProduct.id), merchantListingForm);
    const existingProduct = (existing?.product as JsonRecord | undefined) ?? selectedListingPlatformProduct;
    setConfirmAction({
      title: `确认${actionName}`,
      description: "这次保存只改当前店铺的商品展示和售价，不会修改平台原商品，也不会改变平台供货和结算归属。",
      confirmText: existing?.id ? "确认保存" : "确认上架",
      actionLabel: existing?.id ? "保存店铺商品" : "选品并上架",
      run: action,
      rows: [
        { label: "平台来源", value: platformName },
        { label: "店铺商品名称", before: existing?.id ? text(existingProduct.name, "-") : "未上架", value: displayName },
        { label: "销售价", before: existing?.id ? cents(existing.salePriceCents) : "-", value: cents(merchantListingForm.salePriceCents) },
        { label: "销售状态", before: existing?.id ? statusText(existing.status) : "未上架", value: statusText(merchantListingForm.status) },
        { label: "类目", before: existing?.id ? text(existingProduct.category, "-") : "-", value: text(merchantListingForm.displayCategory, text(selectedListingPlatformProduct.category, "-")) },
        { label: "副标题", before: existing?.id ? text(existingProduct.subtitle, "-") : "-", value: text(merchantListingForm.displaySubtitle, text(selectedListingPlatformProduct.subtitle, "-")) },
        { label: "缩略图", before: existing?.id ? shortUrl(text(existingProduct.imageUrl, "-")) : "-", value: shortUrl(text(merchantListingForm.displayImageUrl, text(selectedListingPlatformProduct.imageUrl, "-"))) }
      ]
    });
  }

  function pickPlatformShopProduct(row: JsonRecord) {
    setSelectedPlatformShopProductOverride(row);
    setPlatformShopProductForm({
      shopId: text(row.shopId, text(data.platformShop?.id, configuredPlatformShopId)),
      platformProductId: text(row.platformProductId, ""),
      salePriceCents: text(row.salePriceCents, ""),
      fulfillmentCostCents: text(row.fulfillmentCostCents, ""),
      status: text(row.status, "listed")
    });
    setMessage(`已选择平台自营商品：${text((row.product as JsonRecord | undefined)?.name, text(row.id))}`);
  }

  function fillPlatformShopProductFromSelectedProduct() {
    const product = selectedPlatformProduct ?? data.platformProducts[0];
    if (!product?.id) {
      setMessage("请先从平台商品库选择一个商品。");
      return;
    }
    setSelectedPlatformShopProductOverride(undefined);
    setPlatformShopProductForm({
      shopId: text(data.platformShop?.id, configuredPlatformShopId),
      platformProductId: text(product.id, ""),
      salePriceCents: text(product.suggestedSalePriceCents, ""),
      fulfillmentCostCents: text(product.supplyPriceCents, "0"),
      status: "listed"
    });
    setMessage("已带入平台商品，可填写平台自营对外售价。");
  }

  function pickOwnProductReview(row: JsonRecord) {
    setSelectedOwnProductReview(row);
    setMessage(`已打开自有商品审核详情：${text(row.name, text(row.id))}`);
  }

  function submitPlatformProductUpdate() {
    if (!selectedPlatformProduct?.id) {
      setMessage("请先从平台商品库选择商品。");
      return;
    }
    const error = validatePlatformProductForm(productForm);
    if (error) {
      setMessage(error);
      return;
    }
    const productId = text(selectedPlatformProduct.id, "");
    setConfirmAction({
      title: "确认保存平台商品详情",
      description: "请先核对本次修改。确认后才会写入平台商品库，并影响后续展示、新订单快照和自动发货库存关联。",
      confirmText: "确认修改",
      actionLabel: "保存平台商品详情",
      run: () => api.updatePlatformProduct(productId, platformProductUpdatePayload(selectedPlatformProduct, productForm)),
      rows: platformProductChangeRows(selectedPlatformProduct, productForm, { changedOnly: true })
    });
  }

  function uploadSelectedProductImage(file: File) {
    void runAction("上传商品图片", async () => {
      const result = await api.uploadProductImage({
        filename: file.name,
        contentType: file.type as "image/jpeg" | "image/png" | "image/webp",
        dataBase64: await readFileAsBase64(file)
      });
      setProductForm((form) => ({ ...form, imageUrl: text(result.imageUrl, form.imageUrl) }));
      return result;
    }, false, { skipConfirm: true });
  }

  function submitPlatformShopProduct() {
    const shopId = platformShopProductForm.shopId.trim();
    const platformProductId = platformShopProductForm.platformProductId.trim();
    if (!shopId) {
      setMessage("缺少平台自营店ID。请先确认已配置平台自营店。");
      return;
    }
    if (!platformProductId) {
      setMessage("请先选择要在平台自营店销售的平台商品。");
      return;
    }
    const priceError = validatePositiveCents(platformShopProductForm.salePriceCents, "平台自营售价");
    if (priceError) {
      setMessage(priceError);
      return;
    }
    if (!isNonNegativeInteger(platformShopProductForm.fulfillmentCostCents)) {
      setMessage("履约成本必须是非负整数分。");
      return;
    }
    const selectedId = text(selectedPlatformShopProductOverride?.id, "");
    const action = selectedId ? "保存平台自营售价" : "上架平台自营商品";
    void runAction(action, () => selectedId
      ? api.updatePlatformShopProduct(selectedId, platformShopProductForm)
      : api.upsertPlatformShopProduct(
        shopId,
        platformProductId,
        platformShopProductForm.salePriceCents,
        platformShopProductForm.fulfillmentCostCents,
        platformShopProductForm.status
      ));
  }

  function submitRightsCodes() {
    const selectedInventoryProduct = merchantSessionActive
      ? selectedOwnMerchantProduct
      : data.platformProducts.find((item) => text(item.id) === inventoryForm.productId) ?? data.platformProducts.find((item) => productFulfillmentMode(item) === "code_pool");
    const credentialType = productCredentialType(selectedInventoryProduct);
    const precheck = precheckRightsCodes(inventoryForm.codes, credentialType);
    setRightsPrecheck(precheck);
    const codes = precheck.validCodes;
    const targetProductId = merchantSessionActive ? text(selectedOwnMerchantProduct?.id, inventoryForm.productId.trim()) : inventoryForm.productId.trim();
    const error = validateRightsCodeForm(targetProductId, inventoryForm.batchNo, codes);
    if (error) {
      setMessage(error);
      return;
    }
    if (precheck.invalidRows.length > 0 || precheck.blankLines.length > 0 || precheck.duplicateCodes.length > 0) {
      setMessage("库存导入预检未通过：请先处理空行、重复或格式错误的行。");
      return;
    }
    void runAction("导入自动发货库存", () => merchantSessionActive
      ? api.importMerchantRightsCodes({
        merchantProductListingId: targetProductId,
        batchNo: inventoryForm.batchNo.trim(),
        codes,
        credentialType
      })
      : api.importRightsCodes({
        productId: targetProductId,
        batchNo: inventoryForm.batchNo.trim(),
        codes,
        credentialType
      }));
  }

  async function revealRightsCodes(label = "查看完整库存内容", filters: { productId?: string; orderNo?: string; status?: string } = {}) {
    if (loading) return;
    if (!window.confirm(`${label}会读取完整兑换码、卡密或账号密码，并写入审计。请确认当前账号有权限且业务需要。`)) {
      setMessage(`${label}已取消`);
      return;
    }
    setLoading(true);
    setActionLabel(label);
    setMessage(`${label}处理中...`);
    try {
      const rows = await api.rightsCodesPlaintext(filters);
      setSensitiveRightsCodes(rows);
      setShowSensitiveCodes(true);
      if (label === "下载完整库存表") downloadCsv("rights-codes-full.csv", rows, ["codeId", "productId", "credentialType", "batchNo", "status", "orderNo", "code", "account", "password", "note"]);
      setMessage(`${label}已完成；完整库存内容属于敏感数据，本次查看/下载会在后端审计中留痕。`);
    } catch (error) {
      setMessage(`${label}失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setLoading(false);
      setActionLabel("");
    }
  }

  function exportMaskedRightsCodes(filename: string, rows: JsonRecord[], columns: string[]) {
    if (loading) return;
    if (!window.confirm("确认导出库存核对表？文件只包含内容预览，不包含完整兑换码、卡密或账号密码。")) {
      setMessage("导出库存核对表已取消");
      return;
    }
    setLoading(true);
    setActionLabel("导出库存核对表");
    try {
      downloadCsv(filename, rows, columns);
      setMessage("导出库存核对表成功");
    } catch (error) {
      setMessage(`导出库存核对表失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setLoading(false);
      setActionLabel("");
    }
  }

  function downloadRightsCodeTemplate(productId = inventoryForm.productId || text(selectedPlatformProduct?.id, ""), credentialType = "code") {
    const common = { productId: productId || "从商品详情或下拉选择商品后自动带入", batchNo: "batch-20260602-001" };
    if (credentialType === "account_password") {
      downloadCsv("account-password-import-template.csv", [
        { ...common, account: "user1@example.com", password: "pass123456", note: "月卡" },
        { ...common, account: "user2@example.com", password: "pass654321", note: "备用账号" }
      ], ["productId", "batchNo", "account", "password", "note"]);
      setMessage("已下载账号密码导入模板：每行一组账号和密码，导入前请先预检。");
      return;
    }
    downloadCsv("credential-code-import-template.csv", [
      { ...common, credential: "CARD-EXAMPLE-001" },
      { ...common, credential: "CARD-EXAMPLE-002" }
    ], ["productId", "batchNo", "credential"]);
      setMessage("已下载兑换码/卡密导入模板：一行一个兑换码或卡密，导入前请先预检。");
  }

  function submitOwnProductReviewDecision(approved: boolean) {
    const ownProductId = text(selectedOwnProduct?.id, text(selectedOwnProduct?.ownProductId, ""));
    if (!ownProductId) {
      setMessage("请先打开自有商品审核详情。");
      return;
    }
    const actionLabel = approved ? "通过自有商品审核" : "拒绝自有商品审核";
    if (!window.confirm(`确认${approved ? "通过" : "拒绝"}该自有商品？本操作会写入平台审核记录。`)) return;
    void runAction(actionLabel, () => api.reviewOwnProduct(ownProductId, approved));
  }

  function submitCouponTemplate() {
    const error = validateCouponForm(couponForm);
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("创建优惠券", () => api.createCouponTemplate(couponForm));
  }

  function submitCouponGrant() {
    const couponId = couponGrantForm.couponId || text(data.coupons[0]?.id, "");
    if (!couponId) {
      setMessage("请先选择优惠券。");
      return;
    }
    if (couponGrantForm.target === "single_user" && !couponGrantForm.userId.trim() && !couponGrantForm.phone.trim()) {
      setMessage("发给个人时请填写手机号或用户ID。");
      return;
    }
    void runAction("发放优惠券", () => api.grantCouponTemplate(couponId, couponGrantForm));
  }

  function submitMerchantPrice() {
    const error = validatePositiveCents(priceCents, "店铺售价");
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("保存店铺售价", () => api.updateMerchantProductPrice(text(selectedMerchantProduct?.id, ""), priceCents));
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
    if (!canManuallyConfirmOrder(selectedOrder)) {
      setMessage("这笔订单不是个人支付宝人工收款订单，不能靠人工点确认；请走官方回调或主动查单。");
      return;
    }
    if (!window.confirm("确认这笔钱已经真实到账？确认后订单会进入发货流程。")) return;
    const action = merchantSessionActive
      ? () => api.confirmMerchantPayment(selectedOrderNo, selectedOrderAmount)
      : () => api.confirmOfflinePayment(selectedOrderNo, selectedOrderAmount);
    void runAction("人工确认收款", action);
  }

  function submitPaymentMethod(id?: string) {
    const input = paymentMethodFormInput(paymentMethodForm, id);
    if (input.provider === "personal_alipay" && !input.qrUrl) {
      setPaymentMethodFeedback("请先上传个人支付宝收款码。");
      setMessage("请先上传个人支付宝收款码");
      return;
    }
    setPaymentMethodFeedback(id ? "正在保存当前收款方式..." : "正在新增收款方式...");
    const action = merchantSessionActive ? () => api.saveMerchantPaymentMethod(input) : () => api.saveAdminPaymentMethod(input);
    void runPaymentMethodAction(id ? "保存收款方式" : "新增收款方式", action);
  }

  function pickPaymentMethod(method: JsonRecord) {
    const methodId = text(method.id);
    const fullMethod = data.paymentMethods.find((item) => text(item.id) === methodId) ?? method;
    if (!methodId) return;
    setSelectedPaymentMethodId(methodId);
    setPaymentMethodForm(paymentMethodToForm(fullMethod));
    setPaymentMethodFeedback(`已选中：${text(fullMethod.displayName, paymentProviderName(text(fullMethod.provider)))}`);
    setMessage("收款方式已带入表单，可修改后更新当前方式。");
  }

  function pickPaymentProvider(provider: string) {
    const method = data.paymentMethods.find((item) => text(item.provider) === provider && text(item.status) !== "disabled")
      ?? data.paymentMethods.find((item) => text(item.provider) === provider);
    if (!method) {
      setMessage(provider === "balance" ? "余额支付是系统能力，不需要配置密钥。" : "这个收款方式还没有可编辑配置，请先新增。");
      return;
    }
    pickPaymentMethod(method);
  }

  async function runPaymentMethodAction(label: string, action: () => Promise<unknown>) {
    if (loading) return;
    if (!window.confirm(`${label}会变更后台收款配置并记录审计，确认继续？`)) {
      setPaymentMethodFeedback(`${label}已取消`);
      setMessage(`${label}已取消`);
      return;
    }
    setLoading(true);
    setActionLabel(label);
    try {
      const result = await action();
      setPaymentMethodFeedback(`已保存：${text((result as JsonRecord)?.displayName, paymentMethodForm.displayName)}`);
      setMessage(`${label}成功`);
      await loadAll(`${label}成功，数据已刷新`);
    } catch (error) {
      const reason = error instanceof ApiClientError && error.status === 401
        ? "登录已过期，请重新登录"
        : error instanceof ApiClientError && error.status === 403
          ? "当前账号权限不足"
          : error instanceof Error
            ? error.message
            : "未知错误";
      if (error instanceof ApiClientError && error.status === 401) {
        api.clearAdminSession();
        api.clearMerchantSession();
        setSession(undefined);
        setAuthError(reason);
      }
      setPaymentMethodFeedback(`保存失败：${reason}`);
      setMessage(`${label}失败：${reason}`);
    } finally {
      setLoading(false);
      setActionLabel("");
    }
  }

  function disablePaymentMethod() {
    const methodId = text(selectedPaymentMethod?.id, "");
    const action = merchantSessionActive ? () => api.disableMerchantPaymentMethod(methodId) : () => api.disableAdminPaymentMethod(methodId);
    void runAction("停用收款方式", action);
  }

  function setPaymentMethodDefault() {
    const methodId = text(selectedPaymentMethod?.id, "");
    const action = merchantSessionActive ? () => api.setMerchantPaymentMethodDefault(methodId) : () => api.setAdminPaymentMethodDefault(methodId);
    void runAction("设为默认收款方式", action);
  }

  function testPaymentMethod() {
    const methodId = text(selectedPaymentMethod?.id, "");
    const action = merchantSessionActive ? () => api.testMerchantPaymentMethod(methodId) : () => api.testAdminPaymentMethod(methodId);
    void runAction("测试收款方式", action, false);
  }

  function querySelectedOrderPayment() {
    void runAction("主动查单", () => api.queryOrderPayment(selectedOrderNo, {
      ...paymentQueryForm,
      amountCents: paymentQueryForm.amountCents || selectedOrderAmount
    }));
  }

  function handleSelectedPaymentException(action: "mark_handled" | "keep_exception") {
    void runAction(action === "mark_handled" ? "标记异常已处理" : "保留异常状态", () => api.handlePaymentException(text(selectedPaymentException?.id, ""), {
      action,
      note: paymentExceptionNote.trim() || undefined
    }));
  }

  function savePlatformServiceFee() {
    void runAction("保存平台服务费", () => api.updatePlatformServiceFee(serviceFeeForm));
  }

  function confirmSelectedWalletRecharge() {
    const rechargeNo = text(selectedWalletRecharge?.rechargeNo, "");
    if (!rechargeNo) return;
    void runAction("确认充值到账", () => api.confirmWalletRecharge(rechargeNo));
  }

  function submitPaymentVoucherReview(approved: boolean) {
    const voucherId = text(selectedPaymentVoucher?.id, "");
    if (!voucherId) {
      setMessage("请选择待核实的异常材料");
      return;
    }
    if (approved) {
      setMessage("异常材料只做核实记录，不能在这里确认收款；请到订单页按收款方式处理。");
      return;
    }
    void runAction(approved ? "异常材料标记已核实" : "异常材料标记拒绝", () => api.reviewPaymentVoucher(voucherId, approved, paymentVoucherReason.trim()));
  }

  function submitFulfillment() {
    if (merchantSessionActive) {
      void runAction("确认发货", () => api.fulfillMerchantOrder(selectedOrderNo, attemptNo));
    } else {
      void runAction("确认发货", () => api.fulfillOrder(selectedOrderNo, attemptNo));
    }
  }

  function submitManualMerchant() {
    const error = validateManualMerchantForm(manualMerchantForm);
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("手工创建一级商户", () => api.createManualMerchant(manualMerchantForm));
  }

  function submitMerchantInviteCode() {
    if (!merchantInviteTargetTier) {
      setMessage("三级商户不能继续创建下级商户邀请码。");
      return;
    }
    void runAction("创建商户邀请码", () => api.createMerchantInviteCode(inviteForm));
  }

  function submitConfirmDeposit() {
    const error = validatePositiveCents(depositConfirmCents, "确认保证金金额");
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("确认保证金", () => api.confirmDeposit(currentMerchantId, depositConfirmCents));
  }

  function submitDeductDeposit() {
    const error = validatePositiveCents(depositDeductCents, "扣减保证金金额");
    if (error) {
      setMessage(error);
      return;
    }
    void runAction("扣减保证金", () => api.deductDeposit(currentMerchantId, depositDeductCents));
  }

  function submitChannelRelation() {
    if (!channelRelationForm.firstTierMerchantId.trim() || !channelRelationForm.secondTierMerchantId.trim()) {
      setMessage("请填写一级商户ID和二级商户ID。三级商户ID可选。");
      return;
    }
    const label = channelRelationForm.thirdTierMerchantId.trim() ? "创建三级供货关系" : "创建二级供货关系";
    void runAction(label, () => api.createChannelRelation(channelRelationForm));
  }

  function submitChannelOffer(label: string) {
    const error = validatePositiveCents(channelOfferCents, "转供价");
    if (error) {
      setMessage(error);
      return;
    }
    if (merchantSessionActive) {
      void runAction(label, () => api.upsertMerchantChannelOffer(downstreamMerchantId, currentPlatformProductId, channelOfferCents));
    } else {
      if (!currentChannelRelationId || !currentPlatformProductId) {
        setMessage("请先选择供货关系和平台商品。");
        return;
      }
      void runAction(label, () => api.upsertChannelOffer(currentChannelRelationId, currentPlatformProductId, channelOfferCents));
    }
  }

  function switchModule(moduleId: ModuleId) {
    setActive(moduleId);
    window.history.replaceState(null, "", `#${moduleId}`);
  }

  function openInventoryForPlatformProduct(product: JsonRecord) {
    const productId = text(product.id);
    setInventoryForm((current) => ({
      ...current,
      productId,
      batchNo: current.productId === productId ? current.batchNo : "",
      codes: current.productId === productId ? current.codes : ""
    }));
    setRightsPrecheck(undefined);
    setShowSensitiveCodes(false);
    setSensitiveRightsCodes([]);
    switchModule("inventory");
    setMessage(`已打开库存管理：${text(product.name, productId)}`);
  }

  function handleOrderNextAction(order: JsonRecord) {
    setCurrentOrder(order);
    const refundStatus = text(order.refundStatus, "none");
    const paymentStatus = text(order.paymentStatus);
    const fulfillmentStatus = text(order.fulfillmentStatus);
    if (refundStatus !== "none") {
      switchModule("afterSales");
      return;
    }
    if (paymentStatus !== "paid") {
      switchModule("orders");
      return;
    }
    if (fulfillmentStatus !== "success") {
      switchModule("fulfillment");
      return;
    }
    switchModule("orders");
  }

  function renderModule() {
    if (active === "dashboard") {
      return (
        <Module title="经营首页" subtitle="待办、最近订单和常用操作">
          <section className="dashboard-flow">
            <Panel title="今天先处理这些" kicker="待办">
              <section className="work-grid">
                {todoItems.map((item) => (
                  <button className="todo-card" key={item.label} type="button" onClick={() => switchModule(item.target)}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                    <em>{item.value > 0 ? "去处理" : "暂无待办"}</em>
                  </button>
                ))}
              </section>
            </Panel>
            <Panel title="最近订单" kicker="按状态处理">
              <OrdersTable rows={visibleOrders.slice(0, 6)} onPick={handleOrderNextAction} mode="next-action" />
            </Panel>
            <Panel title="常用入口" kicker="快捷操作">
              <section className="quick-grid">
                <button type="button" onClick={() => switchModule("orders")}>处理订单</button>
                <button type="button" onClick={() => switchModule("shops")}>配置收款码</button>
                <button type="button" onClick={() => switchModule("inventory")}>添加自动发货库存</button>
                <button type="button" onClick={() => switchModule("products")}>新增商品</button>
                <button className="secondary" type="button" onClick={() => switchModule("sales")}>查看经营数据</button>
              </section>
            </Panel>
          </section>
        </Module>
      );
    }

    if (active === "products") {
      return (
        <Module title="商品管理" subtitle={merchantSessionActive ? "平台店铺商品、自有商品上架、库存准备" : "平台供货、自营上架、商户自有商品审核"}>
          <section className="product-management-stack">
            <Panel title="平台商品库" kicker={`${data.platformProducts.length} 个商品`}>
              {merchantSessionActive
                ? <MerchantListingTable products={data.platformProducts} merchantProducts={data.merchantProducts} onPick={pickListingPlatformProduct} blocked={merchantBlocked || loading} tier={currentMerchantTier} loading={loading && actionLabel.includes("店铺商品")} />
                : <ProductCatalogList products={data.platformProducts} rightsCodes={data.rightsCodes} merchantProducts={data.merchantProducts} channels={data.channels} onPick={pickPlatformProduct} />}
            </Panel>
            {!merchantSessionActive ? (
              <Panel title="平台自营已上架" kicker={`${data.platformShopProducts.length} 个商品`}>
                <PlatformShopProductTable
                  rows={platformShopProductRows(data.platformShopProducts)}
                  onPick={(row) => {
                    const source = data.platformShopProducts.find((item) => text(item.id) === text(row.id)) ?? row;
                    pickPlatformShopProduct(source);
                  }}
                />
              </Panel>
            ) : null}
            <Panel title="店铺已上架商品" kicker={`${data.merchantProducts.length} 个商品`}>
              <Table rows={merchantProductRows(data.merchantProducts)} columns={merchantProductColumns} moneyColumns={["salePriceCents", "supplyPriceCents", "platformSupplyPriceCents", "visibleUpstreamSupplyPriceCents", "minSalePriceCents"]} onPick={merchantSessionActive ? pickListedMerchantProduct : (row) => setSelectedMerchantProductOverride(data.merchantProducts.find((item) => text(item.id) === text(row.id)) ?? row)} />
            </Panel>
            {!merchantSessionActive ? (
              <Panel title="商品审核" kicker={`${data.ownProducts.length} 条`}>
                <p className="hint">这里审核各级商户提交的自有商品。平台自营商品和平台供货商品不走这个入口。</p>
                <OwnProductReviewTable rows={data.ownProducts} onPick={pickOwnProductReview} />
              </Panel>
            ) : null}
          </section>
          <section className="split">
            {merchantSessionActive ? (
              <Panel title={selectedListingPlatformProduct ? "店铺商品编辑" : "选择平台店铺商品"} kicker="当前店铺">
                <p className="hint">从下面的可店铺商品列表点“选品”。保存后只改当前店铺展示和售价，不改平台原商品。</p>
                {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
                {selectedListingPlatformProduct ? (
                  <>
                    <section className="mini-metrics">
                      <KeyValue label="平台商品" value={text(selectedListingPlatformProduct.name, text(selectedListingPlatformProduct.id))} />
                      <KeyValue label="当前状态" value={selectedListingExistingProduct ? "已上架，可编辑" : "未上架，保存后上架"} />
                      <KeyValue label="最低可售" value={cents(text(selectedListingPlatformProduct.visibleUpstreamSupplyPriceCents, text(selectedListingPlatformProduct.minSalePriceCents, "0")))} />
                    </section>
                    <div className="form-grid wide">
                      <label>店铺商品名称<input value={text(merchantListingForm.displayName)} onChange={(event) => setMerchantListingForm({ ...merchantListingForm, displayName: event.target.value })} /></label>
                      <label>销售价(分)<input inputMode="numeric" value={merchantListingForm.salePriceCents} onChange={(event) => setMerchantListingForm({ ...merchantListingForm, salePriceCents: event.target.value })} /></label>
                      <label>类目<input value={text(merchantListingForm.displayCategory)} onChange={(event) => setMerchantListingForm({ ...merchantListingForm, displayCategory: event.target.value })} /></label>
                      <label>状态<select value={text(merchantListingForm.status, "listed")} onChange={(event) => setMerchantListingForm({ ...merchantListingForm, status: event.target.value })}><option value="listed">上架销售</option><option value="approved">保存但不上架</option><option value="delisted">下架</option></select></label>
                      <label className="span-2">缩略图<input value={text(merchantListingForm.displayImageUrl)} onChange={(event) => setMerchantListingForm({ ...merchantListingForm, displayImageUrl: event.target.value })} /></label>
                      <label className="span-2">副标题<input value={text(merchantListingForm.displaySubtitle)} onChange={(event) => setMerchantListingForm({ ...merchantListingForm, displaySubtitle: event.target.value })} /></label>
                      <label className="span-2">商品详情<textarea rows={4} value={text(merchantListingForm.displayDescription)} onChange={(event) => setMerchantListingForm({ ...merchantListingForm, displayDescription: event.target.value })} /></label>
                      <label className="span-2">使用说明<textarea rows={3} value={text(merchantListingForm.displayUsageGuide)} onChange={(event) => setMerchantListingForm({ ...merchantListingForm, displayUsageGuide: event.target.value })} /></label>
                      <label>标签<input value={text(merchantListingForm.displayTags)} onChange={(event) => setMerchantListingForm({ ...merchantListingForm, displayTags: event.target.value })} placeholder="逗号分隔" /></label>
                      <label>规格<textarea rows={3} value={text(merchantListingForm.displaySpecs)} onChange={(event) => setMerchantListingForm({ ...merchantListingForm, displaySpecs: event.target.value })} placeholder="一行一个" /></label>
                      <label className="span-2">详情模块<textarea rows={4} value={text(merchantListingForm.displayDetailSections)} onChange={(event) => setMerchantListingForm({ ...merchantListingForm, displayDetailSections: event.target.value })} placeholder="标题：内容一；内容二" /></label>
                    </div>
                    <div className="actions">
                      <button type="button" disabled={merchantBlocked || loading} onClick={submitMerchantListing}>
                        {loading && actionLabel.includes("店铺商品") ? "保存中..." : selectedListingExistingProduct ? "保存当前店铺商品" : "选品并上架"}
                      </button>
                      <button className="secondary" type="button" disabled={loading} onClick={() => setSelectedListingPlatformProduct(undefined)}>取消</button>
                    </div>
                  </>
                ) : <p className="empty">先从“可店铺商品列表”选择一个商品。</p>}
              </Panel>
            ) : (
              <Panel title={selectedPlatformProduct ? "平台商品详情" : "新增平台供货商品"} kicker={selectedPlatformProduct ? text(selectedPlatformProduct.id) : "平台"}>
                {selectedPlatformProduct ? <p className="hint">当前正在编辑已选平台商品。保存前请确认价格、履约方式和状态变更；后端会写入审计。</p> : null}
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
                  <label>发货方式<select value={productForm.fulfillmentMode} onChange={(event) => setProductForm({ ...productForm, fulfillmentMode: event.target.value })}><option value="">请选择</option><option value="manual">人工交付</option><option value="code_pool">自动发库存凭证</option></select></label>
                  {productForm.fulfillmentMode === "code_pool" ? <label>凭证类型<select value={productForm.credentialType} onChange={(event) => setProductForm({ ...productForm, credentialType: event.target.value })}><option value="code">兑换码/卡密</option><option value="account_password">账号密码</option></select></label> : null}
                  <label>商品状态<select value={productForm.status} onChange={(event) => setProductForm({ ...productForm, status: event.target.value })}><option value="active">上架</option><option value="listed">上架中</option><option value="disabled">下架</option><option value="frozen">冻结</option></select></label>
                  <label>库存<input inputMode="numeric" value={productForm.stockCount} onChange={(event) => setProductForm({ ...productForm, stockCount: event.target.value })} placeholder="必填，非负整数" /></label>
                  <label>销量<input inputMode="numeric" value={productForm.soldCount} onChange={(event) => setProductForm({ ...productForm, soldCount: event.target.value })} placeholder="选填，非负整数" /></label>
                  <label>供货价(分)<input inputMode="numeric" value={productForm.supplyPriceCents} onChange={(event) => setProductForm({ ...productForm, supplyPriceCents: event.target.value })} placeholder="必填，正整数" /></label>
                  <label>最低售价(分)<input inputMode="numeric" value={productForm.minSalePriceCents} onChange={(event) => setProductForm({ ...productForm, minSalePriceCents: event.target.value })} placeholder="必填，不低于供货价" /></label>
                  <label>建议售价(分)<input inputMode="numeric" value={productForm.suggestedSalePriceCents} onChange={(event) => setProductForm({ ...productForm, suggestedSalePriceCents: event.target.value })} placeholder="必填，不低于最低售价" /></label>
                </div>
                <div className="actions">
                  <button disabled={loading} onClick={selectedPlatformProduct ? submitPlatformProductUpdate : submitPlatformProduct}>{loading ? "处理中..." : selectedPlatformProduct ? "确认保存详情" : "保存并入库"}</button>
                  {selectedPlatformProduct ? <button className="secondary" type="button" disabled={loading} onClick={() => { setSelectedPlatformProduct(undefined); setMessage("已退出商品详情编辑"); }}>退出详情</button> : null}
                  {productForm.fulfillmentMode === "code_pool" && selectedPlatformProduct ? <button className="secondary" type="button" disabled={loading} onClick={() => openInventoryForPlatformProduct(selectedPlatformProduct)}>去库存管理补货</button> : null}
                  {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
                </div>
                {productForm.fulfillmentMode === "manual" ? <p className="hint">人工交付商品不能导入自动发货库存；请维护商品说明、使用说明和店铺客服信息。</p> : null}
              </Panel>
            )}
              {!merchantSessionActive ? (
                <Panel title="平台自营售价" kicker="平台对外销售">
                  <p className="hint">这里改的是平台自营店卖给客户的价格，不是供货价、最低售价或建议售价。</p>
                  <KeyValue label="平台自营店" value={text(data.platformShop?.name, text(data.platformShop?.id, "未配置"))} />
                  <div className="form-grid">
                    <label>平台自营店ID<input value={platformShopProductForm.shopId} onChange={(event) => setPlatformShopProductForm({ ...platformShopProductForm, shopId: event.target.value })} placeholder="平台自营店ID" /></label>
                    <label>平台商品ID<input value={platformShopProductForm.platformProductId} onChange={(event) => setPlatformShopProductForm({ ...platformShopProductForm, platformProductId: event.target.value })} placeholder="从平台商品库选择后自动带入" /></label>
                    <label>平台自营售价(分)<input inputMode="numeric" value={platformShopProductForm.salePriceCents} onChange={(event) => setPlatformShopProductForm({ ...platformShopProductForm, salePriceCents: event.target.value })} placeholder="客户看到的销售价" /></label>
                    <label>履约成本(分)<input inputMode="numeric" value={platformShopProductForm.fulfillmentCostCents} onChange={(event) => setPlatformShopProductForm({ ...platformShopProductForm, fulfillmentCostCents: event.target.value })} placeholder="可填0" /></label>
                    <label>销售状态<select value={platformShopProductForm.status} onChange={(event) => setPlatformShopProductForm({ ...platformShopProductForm, status: event.target.value })}><option value="listed">上架销售</option><option value="approved">审核通过未上架</option><option value="delisted">下架</option><option value="risk_removed">风控下架</option></select></label>
                  </div>
                  <div className="actions">
                    <button type="button" onClick={fillPlatformShopProductFromSelectedProduct}>带入已选平台商品</button>
                    <button type="button" onClick={submitPlatformShopProduct}>{selectedPlatformShopProductOverride?.id ? "保存自营售价" : "上架到平台自营店"}</button>
                    {selectedPlatformShopProductOverride?.id ? <button className="secondary" type="button" onClick={() => { setSelectedPlatformShopProductOverride(undefined); setMessage("已退出平台自营商品编辑"); }}>退出自营编辑</button> : null}
                  </div>
                </Panel>
              ) : null}
            </section>
          {merchantSessionActive ? (
            <Panel title="新增自有商品" kicker="提交平台审核">
              <p className="hint">这里发布你自己供货的商品，提交后等平台审核；平台供货商品请在上方“平台商品库”选择。</p>
              <div className="actions">
                {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
                <div className="form-grid wide">
                  <label>商品名称<input value={ownProductForm.name} onChange={(event) => setOwnProductForm({ ...ownProductForm, name: event.target.value })} /></label>
                  <label>类目<input value={ownProductForm.category} onChange={(event) => setOwnProductForm({ ...ownProductForm, category: event.target.value })} /></label>
                  <label>标签<input value={ownProductForm.tags} onChange={(event) => setOwnProductForm({ ...ownProductForm, tags: event.target.value })} placeholder="逗号分隔" /></label>
                  <label>商品图<input value={ownProductForm.imageUrl} onChange={(event) => setOwnProductForm({ ...ownProductForm, imageUrl: event.target.value })} placeholder="https://..." /></label>
                  <label className="span-2">商品说明<textarea rows={3} value={ownProductForm.description} onChange={(event) => setOwnProductForm({ ...ownProductForm, description: event.target.value })} /></label>
                  <label className="span-2">使用/人工交付说明<textarea rows={3} value={ownProductForm.usageGuide} onChange={(event) => setOwnProductForm({ ...ownProductForm, usageGuide: event.target.value })} placeholder="人工交付商品请填写交付说明，不要在这里填写完整兑换码、卡密或账号密码" /></label>
                  <label>售价(分)<input value={ownProductForm.salePriceCents} onChange={(event) => setOwnProductForm({ ...ownProductForm, salePriceCents: event.target.value })} /></label>
                  <label>最低价(分)<input value={ownProductForm.minSalePriceCents} onChange={(event) => setOwnProductForm({ ...ownProductForm, minSalePriceCents: event.target.value })} /></label>
                  <label>交付方式<select value={ownProductForm.fulfillmentMode} onChange={(event) => setOwnProductForm({ ...ownProductForm, fulfillmentMode: event.target.value })}><option value="">请选择</option><option value="manual">人工交付</option><option value="code_pool">自动发库存凭证</option></select></label>
                  {ownProductForm.fulfillmentMode === "code_pool" ? <label>凭证类型<select value={ownProductForm.credentialType} onChange={(event) => setOwnProductForm({ ...ownProductForm, credentialType: event.target.value })}><option value="code">兑换码/卡密</option><option value="account_password">账号密码</option></select></label> : null}
                </div>
                <button disabled={merchantBlocked || !ownProductForm.name || !ownProductForm.salePriceCents || !ownProductForm.fulfillmentMode} onClick={() => void runAction("提交自有商品审核", () => api.submitOwnProduct(ownProductForm))}>提交审核</button>
              </div>
              <Table rows={data.ownProducts} columns={["id", "name", "salePriceCents", "minSalePriceCents", "fulfillmentMode", "reviewStatus", "status"]} moneyColumns={["salePriceCents", "minSalePriceCents"]} />
            </Panel>
          ) : null}
          {!merchantSessionActive && selectedPlatformProduct ? (
            <PlatformProductDrawer
              product={selectedPlatformProduct}
              form={productForm}
              setForm={setProductForm}
              tab={productDetailTab}
              setTab={setProductDetailTab}
              rightsCodes={data.rightsCodes.filter((item) => text(item.productId) === text(selectedPlatformProduct.id) || text(item.platformProductId) === text(selectedPlatformProduct.id))}
              relatedMerchantProducts={data.merchantProducts.filter((item) => text(item.platformProductId) === text(selectedPlatformProduct.id))}
              channelRelations={channelRows(data.channels, "relations")}
              channelOffers={channelRows(data.channels, "offers").filter((item) => text(item.platformProductId) === text(selectedPlatformProduct.id))}
              onUploadImage={uploadSelectedProductImage}
              onSave={submitPlatformProductUpdate}
              busy={loading}
              onClose={() => setSelectedPlatformProduct(undefined)}
              onOpenInventory={() => openInventoryForPlatformProduct(selectedPlatformProduct)}
            />
          ) : null}
          {!merchantSessionActive && selectedOwnProductReview ? (
            <OwnProductReviewDrawer
              product={selectedOwnProduct}
              onApprove={() => submitOwnProductReviewDecision(true)}
              onReject={() => submitOwnProductReviewDecision(false)}
              onClose={() => setSelectedOwnProductReview(undefined)}
            />
          ) : null}
        </Module>
      );
    }

    if (active === "inventory") {
      if (merchantSessionActive) {
        const credentialType = productCredentialType(selectedOwnMerchantProduct);
        return (
          <Module title="自动发货库存" subtitle="管理付款后自动发给客户的兑换码、卡密或账号密码">
            <section className="split">
                <Panel title="添加自有商品库存" kicker="商户库存">
                  <p className="hint">只能给本商户已审核通过、且发货方式为自动发库存凭证的自有商品添加；列表默认只显示内容预览，商户不能查看完整库存内容。</p>
                  <ProductInventorySummary product={selectedOwnMerchantProduct} rightsCodes={data.rightsCodes.filter((item) => text(item.productId) === text(selectedOwnMerchantProduct?.id) || text(item.merchantProductId) === text(selectedOwnMerchantProduct?.id))} />
                  <p className="hint">当前商品按“{credentialTypeText(credentialType)}”导入。要改成账号密码自动发货，请到商品管理打开这个商品，在发货方式里选择“自动发库存凭证”，再把凭证类型改成“账号密码”。</p>
                  <div className="form-grid wide">
                    <label>自有上架商品
                      <select value={text(selectedOwnMerchantProduct?.id, "")} onChange={(event) => setInventoryForm({ ...inventoryForm, productId: event.target.value })}>
                      {data.merchantProducts.filter((item) => text(item.productType) === "merchant_owned").map((item) => (
                        <option key={text(item.id)} value={text(item.id)}>{text((item.product as JsonRecord | undefined)?.name, text(item.id))}</option>
                      ))}
                    </select>
                  </label>
                  <label>批次号<input value={inventoryForm.batchNo} onChange={(event) => setInventoryForm({ ...inventoryForm, batchNo: event.target.value })} /></label>
                    <label className="span-2">{credentialInputLabel(credentialType)}<textarea value={inventoryForm.codes} onChange={(event) => setInventoryForm({ ...inventoryForm, codes: event.target.value })} rows={6} placeholder={credentialInputPlaceholder(credentialType)} /></label>
                  </div>
                  <div className="actions">
                    <button className="secondary" type="button" disabled={loading} onClick={() => switchModule("products")}>去商品管理设置凭证类型</button>
                    <button className="secondary" type="button" disabled={loading} onClick={() => downloadRightsCodeTemplate(text(selectedOwnMerchantProduct?.id, inventoryForm.productId), credentialType)}>下载导入模板</button>
                    <button disabled={loading || !selectedOwnMerchantProduct?.id || merchantBlocked} onClick={submitRightsCodes}>{loading ? "导入中..." : "添加库存"}</button>
                  </div>
                </Panel>
              <Panel title="当前库存" kicker="实时">
                <KeyValue label="库存总数" value={String(data.rightsCodes.length)} />
                <KeyValue label="可发给客户" value={String(data.rightsCodes.filter((item) => text(item.status) === "available").length)} />
                <KeyValue label="已发给客户" value={String(data.rightsCodes.filter((item) => text(item.status) === "issued").length)} />
              </Panel>
            </section>
            <Panel title="自有库存明细" kicker="默认保护完整内容">
              <RightsCodeTable
                rows={data.rightsCodes}
                showSensitiveCodes={false}
                sensitiveRows={[]}
                canReveal={false}
                hideActions
              />
            </Panel>
          </Module>
        );
      }
      const autoInventoryProducts = data.platformProducts.filter((item) => productFulfillmentMode(item) === "code_pool");
      const selectedInventoryProduct = autoInventoryProducts.find((item) => text(item.id) === inventoryForm.productId) ?? autoInventoryProducts[0];
      const selectedInventoryProductId = text(selectedInventoryProduct?.id, "");
      const selectedInventoryRows = data.rightsCodes.filter((item) => text(item.productId) === selectedInventoryProductId || text(item.platformProductId) === selectedInventoryProductId);
      const credentialType = productCredentialType(selectedInventoryProduct);
      return (
          <Module title="自动发货库存" subtitle="管理付款后自动发给客户的兑换码、卡密或账号密码">
            <section className="inventory-workbench">
              <Panel title="自动发货商品" kicker={`${autoInventoryProducts.length} 个商品`}>
                <AutoInventoryProductList
                  products={autoInventoryProducts}
                  rightsCodes={data.rightsCodes}
                  selectedProductId={selectedInventoryProductId}
                  onSelect={(product) => {
                    const productId = text(product.id);
                    setInventoryForm((current) => ({
                      ...current,
                      productId,
                      batchNo: current.productId === productId ? current.batchNo : "",
                      codes: current.productId === productId ? current.codes : ""
                    }));
                    setRightsPrecheck(undefined);
                    setShowSensitiveCodes(false);
                    setSensitiveRightsCodes([]);
                  }}
                  onEditProduct={(product) => {
                    pickPlatformProduct(product);
                    switchModule("products");
                  }}
                />
              </Panel>
              <Panel title={selectedInventoryProduct ? `管理库存：${text(selectedInventoryProduct.name, selectedInventoryProductId)}` : "管理库存"} kicker="添加库存">
                {selectedInventoryProduct ? (
                  <>
                    <ProductInventorySummary product={selectedInventoryProduct} rightsCodes={selectedInventoryRows} />
                    <p className="hint">当前商品按“{credentialTypeText(credentialType)}”导入。要切换兑换码/卡密或账号密码，请到商品详情的“基础与价格”修改凭证类型。</p>
                    <div className="form-grid wide">
                      <label>批次号<input value={inventoryForm.batchNo} onChange={(event) => setInventoryForm({ ...inventoryForm, productId: selectedInventoryProductId, batchNo: event.target.value })} placeholder="例如 batch-20260602" /></label>
                      <label className="span-2">{credentialInputLabel(credentialType)}<textarea value={inventoryForm.codes} onChange={(event) => setInventoryForm({ ...inventoryForm, productId: selectedInventoryProductId, codes: event.target.value })} rows={6} placeholder={credentialInputPlaceholder(credentialType)} /></label>
                    </div>
                    <div className="actions">
                      <button className="secondary" type="button" disabled={loading} onClick={() => downloadRightsCodeTemplate(selectedInventoryProductId, credentialType)}>下载导入模板</button>
                      <button className="secondary" type="button" disabled={loading} onClick={() => setRightsPrecheck(precheckRightsCodes(inventoryForm.codes, credentialType))}>预检</button>
                      <button disabled={loading || !inventoryForm.batchNo.trim() || !inventoryForm.codes.trim()} onClick={submitRightsCodes}>{loading ? "导入中..." : "添加库存"}</button>
                    </div>
                    <RightsPrecheckPanel result={rightsPrecheck} />
                  </>
                ) : <p className="empty">暂无自动发货商品。请先到商品管理把商品发货方式设置为“自动发库存凭证”。</p>}
              </Panel>
            </section>
            <Panel title={selectedInventoryProduct ? `当前库存：${text(selectedInventoryProduct.name, selectedInventoryProductId)}` : "当前库存"} kicker="默认保护完整内容">
              <p className="hint">这里只展示当前商品库存。默认只看内容预览；查看或下载完整兑换码、卡密、账号密码会写入审计。</p>
              <RightsCodeTable
                rows={selectedInventoryRows}
                showSensitiveCodes={showSensitiveCodes}
                sensitiveRows={sensitiveRightsCodes}
                canReveal={Boolean(selectedInventoryProductId)}
                loading={loading}
                onExportMasked={(rows) => exportMaskedRightsCodes("rights-codes-inventory-check.csv", rows, ["codeId", "productId", "credentialType", "batchNo", "status", "orderNo", "codePreview"])}
                onReveal={() => void revealRightsCodes("查看完整库存内容", { productId: selectedInventoryProductId })}
                onExportPlain={() => void revealRightsCodes("下载完整库存表", { productId: selectedInventoryProductId })}
              />
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
      const selectedCoupon = data.coupons.find((item) => text(item.id) === couponGrantForm.couponId) ?? data.coupons[0];
      return (
        <Module title="优惠券" subtitle="平台统一金额券，支持发给所有用户或指定用户">
          <section className="split">
            <Panel title="创建优惠券" kicker="平台金额券">
              <div className="form-grid wide">
                <label>名称<input value={couponForm.name} onChange={(event) => setCouponForm({ ...couponForm, name: event.target.value })} placeholder="必填" /></label>
                <label>抵扣金额(分)<input inputMode="numeric" value={couponForm.discountCents} onChange={(event) => setCouponForm({ ...couponForm, discountCents: event.target.value })} placeholder="必填，正整数" /></label>
                <label>有效天数<input value={couponForm.validDays} onChange={(event) => setCouponForm({ ...couponForm, validDays: event.target.value })} /></label>
                <label>状态<select value={couponForm.status} onChange={(event) => setCouponForm({ ...couponForm, status: event.target.value })}><option value="">请选择</option><option value="active">启用</option><option value="inactive">停用</option></select></label>
              </div>
              <div className="actions">
                <button onClick={submitCouponTemplate}>保存优惠券</button>
                <button className="secondary" disabled={!selectedCoupon?.id} onClick={() => void runAction("停用优惠券", () => api.updateCouponTemplateStatus(text(selectedCoupon?.id, ""), "inactive"))}>停用当前</button>
                <button className="secondary" disabled={!selectedCoupon?.id} onClick={() => void runAction("启用优惠券", () => api.updateCouponTemplateStatus(text(selectedCoupon?.id, ""), "active"))}>启用当前</button>
              </div>
            </Panel>
            <Panel title="发放优惠券" kicker="平台发券">
              <div className="form-grid wide">
                <label className="span-2">选择优惠券
                  <select value={couponGrantForm.couponId || text(selectedCoupon?.id, "")} onChange={(event) => setCouponGrantForm({ ...couponGrantForm, couponId: event.target.value })}>
                    {data.coupons.map((coupon) => <option key={text(coupon.id)} value={text(coupon.id)}>{text(coupon.name)} {cents(coupon.discountCents)}</option>)}
                  </select>
                </label>
                <label>发放对象
                  <select value={couponGrantForm.target} onChange={(event) => setCouponGrantForm({ ...couponGrantForm, target: event.target.value })}>
                    <option value="all_users">所有用户</option>
                    <option value="single_user">指定用户</option>
                  </select>
                </label>
                <label>手机号<input value={couponGrantForm.phone} onChange={(event) => setCouponGrantForm({ ...couponGrantForm, phone: event.target.value })} placeholder="指定用户时填写" /></label>
                <label className="span-2">用户ID<input value={couponGrantForm.userId} onChange={(event) => setCouponGrantForm({ ...couponGrantForm, userId: event.target.value })} placeholder="可选，例如 h5-phone-手机号" /></label>
              </div>
              <div className="actions">
                <button disabled={!selectedCoupon?.id} onClick={submitCouponGrant}>发放优惠券</button>
              </div>
              <p className="hint">客户下单时只能选择一张优惠券，所有抵扣金额都由后端重新计算。</p>
            </Panel>
            <Panel title="优惠券规则" kicker="验收">
              <KeyValue label="券模板" value={String(data.coupons.length)} />
              <KeyValue label="金额券" value={String(data.coupons.length)} />
              <KeyValue label="启用中" value={String(data.coupons.filter((item) => text(item.status) === "active").length)} />
            </Panel>
          </section>
          <Panel title="优惠券列表" kicker={`${data.coupons.length} 个模板`}>
            <Table rows={data.coupons} columns={["id", "name", "discountCents", "validDays", "status", "createdAt"]} moneyColumns={["discountCents"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "orders") {
      const manualConfirmAllowed = canManuallyConfirmOrder(selectedOrder);
      const sortedOrders = sortOrdersNewestFirst(visibleOrders);
      return (
        <Module title="订单管理" subtitle="按订单时间、支付状态、发货状态处理订单">
          <OrderTodoSummary orders={sortedOrders} />
          <section className="order-workbench sticky-workbench">
            <Panel title="当前订单" kicker={selectedOrderNo ? orderTimeLabel(selectedOrder) : "未选择"}>
              {selectedOrder ? (
                <>
                  <div className="order-current-grid">
                    <KeyValue label="订单号" value={selectedOrderNo} />
                    <KeyValue label="下单时间" value={orderTimeLabel(selectedOrder)} />
                    <KeyValue label="店铺" value={orderShopLabel(selectedOrder)} />
                    <KeyValue label="客户" value={orderCustomerLabel(selectedOrder)} />
                    <KeyValue label="商品" value={orderProductLabel(selectedOrder)} />
                    <KeyValue label="金额" value={cents(selectedOrderAmount)} />
                    <KeyValue label="收款方式" value={orderPaymentMethodLabel(selectedOrder)} />
                    <div className="kv">
                      <span>支付状态</span>
                      <strong><OrderStatusBadge value={selectedOrder.paymentStatus} type="payment" /></strong>
                    </div>
                    <div className="kv">
                      <span>发货状态</span>
                      <strong><OrderStatusBadge value={selectedOrder.fulfillmentStatus} type="fulfillment" /></strong>
                    </div>
                    <div className="kv">
                      <span>订单状态</span>
                      <strong><OrderStatusBadge value={selectedOrder.status} type="order" /></strong>
                    </div>
                    <KeyValue label="异常材料" value={selectedOrderPaymentVouchers.length > 0 ? `${selectedOrderPaymentVouchers.length} 条，仅作核实` : "无"} />
                  </div>
                  <div className="order-next-box">
                    <span>下一步</span>
                    <strong>{orderNextStep(selectedOrder)}</strong>
                    <p>{orderNextStepHint(selectedOrder)}</p>
                  </div>
                  <div className="actions">
                    <button disabled={!selectedOrderNo || text(selectedOrder?.paymentStatus) === "paid" || !manualConfirmAllowed} onClick={submitConfirmPayment}>确认个人支付宝到账</button>
                    <button className="secondary" disabled={!selectedOrderNo || manualConfirmAllowed || text(selectedOrder?.paymentStatus) === "paid"} onClick={() => switchModule("payment")}>查单/看回调</button>
                    <button className="secondary" disabled={!selectedOrderNo || text(selectedOrder?.paymentStatus) !== "paid"} onClick={() => switchModule("fulfillment")}>去发货</button>
                  </div>
                </>
              ) : <p className="empty">暂无订单</p>}
            </Panel>
          </section>
          <Panel title="订单列表" kicker={`${sortedOrders.length} 笔，最新订单在前`}>
            <OrdersTable rows={sortedOrders} onPick={setCurrentOrder} mode="next-action" />
          </Panel>
          <Panel title="异常/争议材料" kicker={merchantSessionActive ? "当前店铺" : "全平台"}>
            <p className="hint">这里是买家补充的付款说明或凭证，只能用于人工核对，不能直接当作已收款。</p>
            <Table rows={paymentDisputeMaterialRows(selectedOrderNo ? selectedOrderPaymentVouchers : data.paymentVouchers)} columns={["orderNo", "amountCents", "channel", "payerName", "voucherUrl", "note", "status", "reviewedBy"]} moneyColumns={["amountCents"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "fulfillment") {
      return (
        <Module title="发货管理" subtitle="自动发货和人工交付都在这里处理">
          <section className="split">
            <Panel title="当前订单发货" kicker="履约">
              <KeyValue label="订单" value={selectedOrderNo || "暂无订单"} />
              <KeyValue label="支付状态" value={humanValue(selectedOrder?.paymentStatus)} />
              <KeyValue label="发货状态" value={humanValue(selectedOrder?.fulfillmentStatus)} />
              <KeyValue label="下一步" value={orderNextStep(selectedOrder)} />
              <div className="inline-form">
                <label>本次发货次数<input value={String(attemptNo)} onChange={(event) => setAttemptNo(Number(event.target.value) || 1)} /></label>
                <button disabled={!selectedOrderNo || text(selectedOrder?.paymentStatus) !== "paid"} onClick={submitFulfillment}>确认发货</button>
              </div>
              <p className="hint">自动发货商品会从库存凭证里扣一条发给客户；人工交付商品由客服按订单资料处理。</p>
            </Panel>
            <Panel title="待发货订单" kicker="已收款未完成">
              <OrdersTable rows={visibleOrders.filter((order) => text(order.paymentStatus) === "paid" && text(order.fulfillmentStatus) !== "success").slice(0, 6)} onPick={setCurrentOrder} />
            </Panel>
          </section>
        </Module>
      );
    }

    if (active === "afterSales") {
      return (
        <Module title="售后退款" subtitle="选择订单或售后单后，再处理拆账、审批和退款确认">
          <section className="split">
            <Panel title="售后工作台" kicker={merchantSessionActive ? "商户协处理" : "平台处理"}>
              <KeyValue label="当前订单" value={selectedOrderNo || "暂无订单"} />
              <KeyValue label="售后单" value={text(currentAfterSale?.afterSaleNo, "暂无")} />
              <KeyValue label="退款单" value={text(currentRefund?.refundNo, "暂无")} />
              {merchantSessionActive ? (
                <>
                  <p className="hint">商户在这里补充处理说明，平台财务负责最终退款审批和打款确认。</p>
                  <div className="inline-form">
                    <label>协处理说明<input value={afterSaleAssistNote} onChange={(event) => setAfterSaleAssistNote(event.target.value)} placeholder="填写处理说明或凭证备注" /></label>
                    <button disabled={!selectedAfterSaleNo(data.adminAfterSales, currentAfterSale) || !afterSaleAssistNote.trim()} onClick={() => void runAction("售后协处理", () => api.assistMerchantAfterSale(selectedAfterSaleNo(data.adminAfterSales, currentAfterSale), afterSaleAssistNote.trim()))}>提交协处理</button>
                  </div>
                </>
              ) : (
                <>
                  <KeyValue label="最近拆账" value={currentAllocation ? `平台 ${cents(currentAllocation.platformBearCents)} / 商户 ${cents(currentAllocation.merchantBearCents)}` : "暂无"} />
                  <div className="inline-form">
                    <label>退款金额(分)<input inputMode="numeric" value={refundCents} onChange={(event) => setRefundCents(event.target.value)} placeholder="例如 9900" /></label>
                  </div>
                  <div className="actions">
                    <button disabled={!selectedOrderNo || text(selectedOrder?.paymentStatus) !== "paid"} onClick={() => submitRefundAction("提交售后", () => api.createAfterSale(selectedOrderNo, refundCents))}>创建售后单</button>
                    <button disabled={!selectedOrderNo} onClick={() => submitRefundAction("退款拆账", () => api.allocateRefund(selectedOrder ?? {}, refundCents, "mixed"))}>拆账预览</button>
                    <button disabled={!currentAfterSale?.afterSaleNo} onClick={() => submitRefundAction("审批退款", () => api.createRefund(text(currentAfterSale?.afterSaleNo, ""), selectedOrder ?? {}, refundCents, "mixed"))}>审批退款</button>
                    <label>退款流水号<input value={refundVoucher} onChange={(event) => setRefundVoucher(event.target.value)} placeholder="填写转账流水或凭证号" /></label>
                    <button className="secondary" disabled={!currentRefund?.refundNo || !refundVoucher.trim()} onClick={() => void runAction("人工退款确认", () => api.confirmRefund(text(currentRefund?.refundNo, ""), refundVoucher.trim()))}>确认退款成功</button>
                  </div>
                </>
              )}
            </Panel>
            <Panel title="处理顺序" kicker="不要跳步">
              <ol className="steps">
                <li>先从订单列表选择要售后的订单，或从售后列表打开已有售后单。</li>
                <li>填写退款金额，先看拆账预览，再审批生成退款单。</li>
                <li>线下或人工退款完成后，填写退款流水号并确认完成。</li>
                <li>退款完成后，客户不应继续查看已发出的库存凭证。</li>
              </ol>
            </Panel>
          </section>
          <Panel title="售后列表" kicker={`${data.adminAfterSales.length} 单`}>
              {merchantSessionActive
                ? <Table rows={data.adminAfterSales} columns={["afterSaleNo", "orderNo", "status", "reasonCode", "requestedRefundCents"]} moneyColumns={["requestedRefundCents"]} onPick={(row) => setCurrentAfterSale(row)} />
                : <Table rows={data.adminAfterSales} columns={["afterSaleNo", "orderNo", "status", "reasonCode", "requestedRefundCents"]} moneyColumns={["requestedRefundCents"]} onPick={(row) => {
                  setCurrentAfterSale(row);
                  const order = visibleOrders.find((item) => text(item.orderNo) === text(row.orderNo));
                  if (order) setCurrentOrder(order);
                }} />}
          </Panel>
          <Panel title="可发起售后的订单" kicker="已收款订单">
            <OrdersTable rows={visibleOrders.filter((order) => text(order.paymentStatus) === "paid").slice(0, 8)} onPick={setCurrentOrder} />
          </Panel>
        </Module>
      );
    }

    if (active === "sales") {
      return (
        <Module title="销售统计" subtitle="订单、商品、店铺销售表现">
          <section className="metric-grid">
            <Metric label="销售额" value={merchantSessionActive ? cents(data.merchantDashboard?.gmvCents) : cents(data.salesDashboard?.totalPaidCents)} tone="strong" />
            <Metric label="成交订单" value={merchantSessionActive ? text(data.merchantDashboard?.paidOrderCount, "0") : text(data.salesDashboard?.paidOrderCount, "0")} />
            <Metric label="履约成功" value={merchantSessionActive ? text(data.merchantDashboard?.fulfilledOrderCount, "0") : text(data.salesDashboard?.fulfilledOrderCount, "0")} />
            <Metric label={merchantSessionActive ? "预估收益" : "服务费"} value={merchantSessionActive ? cents(data.merchantDashboard?.expectedIncomeCents) : cents(data.reconciliation?.totalServiceFeeCents)} />
            {merchantSessionActive ? <Metric label="保证金可用" value={cents(data.merchantDashboard?.depositAvailableCents)} /> : null}
            {merchantSessionActive ? <Metric label="未读通知" value={text(data.merchantDashboard?.noticeCount, "0")} /> : null}
          </section>
          {merchantSessionActive ? (
            <Panel title="商户订单" kicker="当前店铺">
              <OrdersTable rows={data.merchantOrders} onPick={setCurrentOrder} />
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
        <Module title="店铺设置" subtitle="店铺资料、客服二维码、收款配置入口">
          <section className="split">
            <Panel title="店铺资料" kicker="商户">
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
              <button onClick={() => void runAction("保存店铺资料", () => api.saveMerchantShop(shopForm.name, shopForm.announcement, shopForm.customerServiceWechat, shopForm.customerServiceQrUrl))}>保存店铺</button>
            </Panel>
            <Panel title="收款配置" kicker="独立配置">
              <p className="hint">收款方式由收款配置中心维护，读写 collection_payment_configs 权威数据；商户态只调用 /api/merchant/payment-methods。</p>
              <div className="actions">
                <button type="button" onClick={() => switchModule("payment")}>打开收款配置中心</button>
              </div>
            </Panel>
          </section>
          {merchantSessionActive ? null : (
            <Panel title="客服二维码" kicker={`${data.serviceQrCodes.length} 条`}>
              <Table rows={data.serviceQrCodes} columns={["shopId", "ownerType", "name", "customerServiceWechat", "customerServiceQrUrl", "status"]} />
            </Panel>
          )}
        </Module>
      );
    }

    if (active === "merchants") {
      if (merchantSessionActive) {
        return (
          <Module title="商户管理" subtitle="商户账号仅查看自身状态和可用能力">
            <section className="split">
              <Panel title="商户状态" kicker="当前账号">
                <KeyValue label="商户ID" value={currentMerchantId || "未知"} />
                <KeyValue label="店铺ID" value={currentShopId || "未知"} />
                <KeyValue label="商户层级" value={text(currentMerchantTier, "未知")} />
                <KeyValue label="保证金状态" value={text(currentDepositStatus, "未知")} />
                {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
              </Panel>
              <Panel title="下级供货能力" kicker="商户后台">
                <p className="hint">{canConfigureDownstreamOffer ? "当前层级可在下级供货中配置下游转供价。" : "三级商户不展示下游转供配置；商户态不调用平台 /api/admin/merchant-supply。"}</p>
              </Panel>
            </section>
          </Module>
        );
      }
      return (
        <Module title="商户管理" subtitle="入驻审核、保证金、一级商户与受控转供价">
          <section className="split">
            <Panel title="入驻审核" kicker="运营">
              <div className="inline-form">
                <label>当前操作商户ID<input value={adminMerchantId} onChange={(event) => setAdminMerchantId(event.target.value)} placeholder="从申请/保证金列表选择或填写" /></label>
              </div>
              <div className="form-grid wide">
                <label>邀请码<input value={applicationForm.inviteCode} onChange={(event) => setApplicationForm({ ...applicationForm, inviteCode: event.target.value })} /></label>
                <label>联系电话<input value={applicationForm.contactPhone} onChange={(event) => setApplicationForm({ ...applicationForm, contactPhone: event.target.value })} /></label>
                <label>客服微信<input value={applicationForm.customerServiceWechat} onChange={(event) => setApplicationForm({ ...applicationForm, customerServiceWechat: event.target.value })} /></label>
              </div>
              <div className="actions">
                <button disabled={!applicationForm.contactPhone || !applicationForm.customerServiceWechat} onClick={() => void runAction("提交商户入驻", () => api.submitMerchantApplication(applicationForm))}>提交入驻</button>
                <button disabled={!currentMerchantId} onClick={() => void runAction("商户审核通过", () => api.reviewMerchant(currentMerchantId, true, "资料通过"))}>通过当前商户</button>
                <button className="secondary" disabled={!currentMerchantId} onClick={() => void runAction("商户审核拒绝", () => api.reviewMerchant(currentMerchantId, false, "资料需补充"))}>拒绝当前</button>
              </div>
              <Table rows={data.merchantApplications} columns={["applicationNo", "merchantId", "status", "contactPhone", "customerServiceWechat"]} onPick={(row) => setAdminMerchantId(text(row.merchantId, ""))} />
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
                <label>商户名称<input value={manualMerchantForm.name} onChange={(event) => setManualMerchantForm({ ...manualMerchantForm, name: event.target.value })} /></label>
                <label>店铺名称<input value={manualMerchantForm.shopName} onChange={(event) => setManualMerchantForm({ ...manualMerchantForm, shopName: event.target.value })} /></label>
                <label>联系电话<input value={manualMerchantForm.contactPhone} onChange={(event) => setManualMerchantForm({ ...manualMerchantForm, contactPhone: event.target.value })} /></label>
                <label>客服微信<input value={manualMerchantForm.customerServiceWechat} onChange={(event) => setManualMerchantForm({ ...manualMerchantForm, customerServiceWechat: event.target.value })} /></label>
                <label>初始密码<input value={manualMerchantForm.initialPassword} onChange={(event) => setManualMerchantForm({ ...manualMerchantForm, initialPassword: event.target.value })} /></label>
                <label>保证金(分)<input inputMode="numeric" value={manualMerchantForm.depositRequiredAmountCents} onChange={(event) => setManualMerchantForm({ ...manualMerchantForm, depositRequiredAmountCents: event.target.value })} placeholder="必填，正整数" /></label>
                <label className="checkbox-line"><input type="checkbox" checked={manualMerchantForm.depositPaid} onChange={(event) => setManualMerchantForm({ ...manualMerchantForm, depositPaid: event.target.checked })} />创建时已确认保证金</label>
              </div>
              <button disabled={!manualMerchantForm.name || !manualMerchantForm.shopName} onClick={submitManualMerchant}>创建一级商户</button>
              {createdCredential ? (
                <div className="hint-box">
                  <strong>初始账号</strong>
                  <span>账号：{text(createdCredential.account)} / 初始密码：{text(createdCredential.initialPassword)}</span>
                  <small>请按线下交付流程给商户，首次登录后按平台安全要求处理。</small>
                </div>
              ) : null}
            </Panel>
            <Panel title="保证金" kicker="财务">
              <KeyValue label="当前商户" value={currentMerchantId || "请先选择商户"} />
              <div className="inline-form">
                <label>确认金额(分)<input inputMode="numeric" value={depositConfirmCents} onChange={(event) => setDepositConfirmCents(event.target.value)} placeholder="必填" /></label>
                <label>扣减金额(分)<input inputMode="numeric" value={depositDeductCents} onChange={(event) => setDepositDeductCents(event.target.value)} placeholder="必填" /></label>
              </div>
              <div className="actions">
                <button disabled={!currentMerchantId} onClick={submitConfirmDeposit}>确认保证金</button>
                <button className="secondary" disabled={!currentMerchantId} onClick={submitDeductDeposit}>扣减保证金</button>
              </div>
              <Table rows={data.adminDeposits} columns={["merchantId", "requiredAmountCents", "availableAmountCents", "status"]} moneyColumns={["requiredAmountCents", "availableAmountCents"]} onPick={(row) => setAdminMerchantId(text(row.merchantId, ""))} />
            </Panel>
          </section>
          <Panel title="保证金全状态" kicker="平台核对">
            <section className="metric-grid">
              {depositStatusRows(data.adminDeposits).map((item) => <Metric key={item.label} label={item.label} value={item.value} />)}
            </section>
          </Panel>
          <Panel title="下级供货" kicker="价差供货">
            <div className="actions">
              {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
              <button disabled={merchantBlocked || !currentMerchantId} onClick={() => void runAction("开通下级供货能力", () => api.reviewChannel(currentMerchantId))}>开通能力</button>
              <label>一级商户ID<input value={channelRelationForm.firstTierMerchantId} onChange={(event) => setChannelRelationForm({ ...channelRelationForm, firstTierMerchantId: event.target.value })} placeholder={currentMerchantId || "M1 merchantId"} /></label>
              <label>二级商户ID<input value={channelRelationForm.secondTierMerchantId} onChange={(event) => setChannelRelationForm({ ...channelRelationForm, secondTierMerchantId: event.target.value })} placeholder={peerMerchantId || "M2 merchantId"} /></label>
              <label>三级商户ID<input value={channelRelationForm.thirdTierMerchantId} onChange={(event) => setChannelRelationForm({ ...channelRelationForm, thirdTierMerchantId: event.target.value })} placeholder="选填，M3 merchantId" /></label>
              <button className="secondary" disabled={merchantBlocked || !channelRelationForm.firstTierMerchantId.trim() || !channelRelationForm.secondTierMerchantId.trim()} onClick={submitChannelRelation}>绑定供货关系</button>
            </div>
            <ChannelOfferEditor
              relations={channelRows(data.channels, "relations")}
              products={data.platformProducts}
              selectedRelationId={currentChannelRelationId}
              selectedProductId={currentPlatformProductId}
              priceCents={channelOfferCents}
              setSelectedRelationId={setSelectedChannelRelationId}
              setSelectedProductId={setSelectedChannelProductId}
              setPriceCents={setChannelOfferCents}
              disabled={merchantBlocked}
              onSubmit={() => submitChannelOffer("配置转供价")}
            />
            <Table rows={channelRows(data.channels, "relations")} columns={["id", "firstTierMerchantId", "secondTierMerchantId", "thirdTierMerchantId", "status"]} />
            <Table rows={channelRows(data.channels, "offers")} columns={["id", "channelRelationId", "platformProductId", "resellSupplyPriceCents", "status"]} moneyColumns={["resellSupplyPriceCents"]} />
          </Panel>
        </Module>
      );
    }

    if (active === "secondTierChannels") {
      if (merchantSessionActive) {
        return (
          <Module title="下级供货" subtitle="商户侧只展示授权商品和后端允许的转供能力">
            <section className="split">
              <Panel title="商户授权商品" kicker="商户后台">
                <KeyValue label="商户层级" value={text(currentMerchantTier, "未知")} />
                <KeyValue label="保证金状态" value={text(currentDepositStatus, "未知")} />
                <KeyValue label="可售商品" value={String(data.merchantProducts.filter((item) => text(item.status) === "listed").length)} />
                <KeyValue label="待清算订单" value={String(data.merchantOrders.filter((item) => text(item.settlementStatus) !== "settled").length)} />
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
                    <button disabled={merchantBlocked} onClick={submitMerchantInviteCode}>创建邀请码</button>
                  </>
                ) : (
                  <p className="warning">三级商户不能继续创建下级商户邀请码。</p>
                )}
              </Panel>
              <Panel title="转供价配置" kicker="待后端 scoped API">
                <p className="hint">前端已隔离平台 admin 供货接口。商户配置转供价调用 /api/merchant/supply/offers；跨关系由后端返回 4xx。</p>
                {canConfigureDownstreamOffer ? (
                  <div className="inline-form">
                    <label>下游商户ID<input value={downstreamMerchantId} onChange={(event) => setDownstreamMerchantId(event.target.value)} placeholder={currentMerchantTier === "first_tier" ? "二级商户ID" : "三级商户ID"} /></label>
                    <label>平台商品
                      <select value={currentPlatformProductId} onChange={(event) => setSelectedChannelProductId(event.target.value)}>
                        {data.platformProducts.map((product) => (
                          <option key={text(product.id)} value={text(product.id)}>{text(product.name, text(product.id))}</option>
                        ))}
                      </select>
                    </label>
                    <label>转供价(分)<input inputMode="numeric" value={channelOfferCents} onChange={(event) => setChannelOfferCents(event.target.value)} placeholder="必填" /></label>
                    <button className="secondary" disabled={merchantBlocked || !downstreamMerchantId.trim() || !currentPlatformProductId} onClick={() => submitChannelOffer("配置商户转供价")}>配置转供价</button>
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
        <Module title="下级供货" subtitle="平台配置下级供货关系，商户侧查看授权商品与转供价">
          <section className="split">
            <Panel title="平台下级供货操作" kicker="平台后台">
              <div className="actions">
                {merchantBlocked ? <p className="warning">{merchantBlockedReason}</p> : null}
                <button disabled={merchantBlocked || !currentMerchantId} onClick={() => void runAction("开通下级供货能力", () => api.reviewChannel(currentMerchantId))}>开通二级供货能力</button>
                <label>一级商户ID<input value={channelRelationForm.firstTierMerchantId} onChange={(event) => setChannelRelationForm({ ...channelRelationForm, firstTierMerchantId: event.target.value })} placeholder={currentMerchantId || "M1 merchantId"} /></label>
                <label>二级商户ID<input value={channelRelationForm.secondTierMerchantId} onChange={(event) => setChannelRelationForm({ ...channelRelationForm, secondTierMerchantId: event.target.value })} placeholder={peerMerchantId || "M2 merchantId"} /></label>
                <label>三级商户ID<input value={channelRelationForm.thirdTierMerchantId} onChange={(event) => setChannelRelationForm({ ...channelRelationForm, thirdTierMerchantId: event.target.value })} placeholder="选填，M3 merchantId" /></label>
                <button className="secondary" disabled={merchantBlocked || !channelRelationForm.firstTierMerchantId.trim() || !channelRelationForm.secondTierMerchantId.trim()} onClick={submitChannelRelation}>绑定供货关系</button>
              </div>
              <ChannelOfferEditor
                relations={channelRows(data.channels, "relations")}
                products={data.platformProducts}
                selectedRelationId={currentChannelRelationId}
                selectedProductId={currentPlatformProductId}
                priceCents={channelOfferCents}
                setSelectedRelationId={setSelectedChannelRelationId}
                setSelectedProductId={setSelectedChannelProductId}
                setPriceCents={setChannelOfferCents}
                disabled={merchantBlocked}
                onSubmit={() => submitChannelOffer("配置转供价")}
              />
              <Table rows={channelRows(data.channels, "relations")} columns={["id", "firstTierMerchantId", "secondTierMerchantId", "thirdTierMerchantId", "status"]} />
            </Panel>
            <Panel title="商户授权商品" kicker="商户后台">
              <KeyValue label="保证金状态" value={text(currentDeposit?.status, "未知")} />
              <KeyValue label="可售商品" value={String(data.merchantProducts.filter((item) => text(item.status) === "listed").length)} />
              <KeyValue label="待清算订单" value={String(data.merchantOrders.filter((item) => text(item.settlementStatus) !== "settled").length)} />
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
        <Module title="结算管理" subtitle="生成结算单、确认打款，并查看账务流水">
          <section className="split">
            <Panel title="结算操作" kicker="财务">
              <KeyValue label="待打款单" value={text(selectedSettlement?.settlementNo, "暂无")} />
              <KeyValue label="当前订单结算" value={text(selectedOrder?.settlementStatus)} />
              {merchantSessionActive
                ? <p className="hint">商户只能查看自己的结算、追扣和保证金流水，不能生成结算单或确认平台打款。</p>
                : (
                  <div className="actions">
                    <button disabled={!currentMerchantId} onClick={() => void runAction("生成 T+1 结算单", () => api.generateSettlement(currentMerchantId))}>生成结算单</button>
                    <button disabled={!selectedSettlement?.settlementNo} onClick={() => void runAction("人工打款确认", () => api.confirmPayout(text(selectedSettlement?.settlementNo, "")))}>确认打款</button>
                  </div>
                )}
            </Panel>
            <Panel title="结算摘要" kicker={merchantSessionActive ? "当前商户" : "当前选择"}>
              <KeyValue label="成交订单" value={text(data.merchantDashboard?.paidOrderCount, "0")} />
              <KeyValue label="预估收益" value={cents(data.merchantDashboard?.expectedIncomeCents)} />
              <KeyValue label="退款率" value={`${(Number(data.merchantDashboard?.refundRateBps ?? 0) / 100).toFixed(2)}%`} />
            </Panel>
          </section>
          <Panel title="结算单" kicker={`${visibleSettlements.length} 条`}>
            <Table rows={visibleSettlements} columns={["settlementNo", "merchantId", "status", "totalOrderCount", "totalMerchantIncomeCents"]} moneyColumns={["totalMerchantIncomeCents"]} />
          </Panel>
          {merchantSessionActive ? (
            <>
              <Panel title="追扣记录" kicker={`${data.clawbacks.length} 条`}>
                <Table rows={data.clawbacks.slice(-10)} columns={["clawbackNo", "orderNo", "status", "amountCents", "reasonCode"]} moneyColumns={["amountCents"]} />
              </Panel>
              <Panel title="保证金流水" kicker={`${data.depositTransactions.length} 条`}>
                <Table rows={data.depositTransactions.slice(-10)} columns={["id", "merchantId", "transactionType", "amountCents", "sourceType", "sourceId", "createdAt"]} moneyColumns={["amountCents"]} />
              </Panel>
            </>
          ) : (
            <Panel title="账务流水" kicker={`${data.ledgerEntries.length} 条`}>
              <Table rows={data.ledgerEntries} columns={["ledgerNo", "entryType", "orderNo", "merchantId", "amountCents"]} moneyColumns={["amountCents"]} />
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
              <OrdersTable rows={data.merchantOrders.filter((order) => text(order.riskStatus, "normal") !== "normal")} onPick={setCurrentOrder} />
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
              <KeyValue label="低保证金商户" value={String((data.riskDashboard?.lowDepositMerchants as unknown[] | undefined)?.length ?? 0)} />
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
        <Module title="收款配置中心" subtitle="配置店铺收款方式，并处理付款异常材料">
          <PaymentMethodCards methods={data.paymentMethods} exceptions={data.paymentExceptions} onPickProvider={pickPaymentProvider} />
          <section className="split">
            <Panel title="收款方式表单" kicker="当前店铺">
              <PaymentMethodForm form={paymentMethodForm} setForm={setPaymentMethodForm} />
              <div className="actions">
                <button disabled={loading || !paymentMethodForm.provider || !paymentMethodForm.displayName} onClick={() => submitPaymentMethod()}>{loading ? "保存中..." : "保存为新方式"}</button>
                <button className="secondary" disabled={loading || !selectedPaymentMethod?.id} onClick={() => submitPaymentMethod(text(selectedPaymentMethod?.id))}>更新当前方式</button>
                <button className="secondary" disabled={loading || !selectedPaymentMethod?.id} onClick={setPaymentMethodDefault}>设为默认</button>
                <button className="secondary" disabled={loading || !selectedPaymentMethod?.id} onClick={testPaymentMethod}>测试</button>
                <button className="secondary" disabled={loading || !selectedPaymentMethod?.id} onClick={disablePaymentMethod}>停用</button>
              </div>
              {paymentMethodFeedback ? <p className="inline-feedback">{paymentMethodFeedback}</p> : null}
            </Panel>
            <Panel title="收款方式列表" kicker={`${data.paymentMethods.length} 个`}>
              <Table rows={paymentMethodRows(data.paymentMethods)} columns={["method", "displayName", "merchant", "confirmMode", "enabled", "isDefault", "keyStatus", "lastTestResult", "lastCallbackAt"]} onPick={pickPaymentMethod} />
            </Panel>
          </section>
          <Panel title="异常材料" kicker={`${data.paymentVouchers.length} 条`}>
            <p className="hint">这里只看买家补充的说明或图片。它不能确认收款，也不会自动发货。</p>
            <Table rows={paymentDisputeMaterialRows(data.paymentVouchers)} columns={["orderNo", "amountCents", "channel", "payerName", "voucherUrl", "note", "status"]} moneyColumns={["amountCents"]} />
          </Panel>
        </Module>
      );
    }

    return (
      <Module title="收款配置中心" subtitle="支付宝、微信、e支付、个人码和余额统一管理">
        <PaymentMethodCards methods={data.paymentMethods} exceptions={data.paymentExceptions} onPickProvider={pickPaymentProvider} />
        <section className="split">
          <Panel title="平台服务费" kicker="新订单生效">
            <KeyValue label="当前状态" value={dataBool(data.platformServiceFee?.enabled, true) ? "收取服务费" : "不收服务费"} />
            <KeyValue label="当前比例" value={`${text(data.platformServiceFee?.feeBps, "50")} Bps`} />
            <div className="inline-form">
              <label>启用
                <select value={serviceFeeForm.enabled ? "yes" : "no"} onChange={(event) => setServiceFeeForm({ ...serviceFeeForm, enabled: event.target.value === "yes" })}>
                  <option value="yes">收取服务费</option>
                  <option value="no">关闭服务费</option>
                </select>
              </label>
              <label>比例 Bps<input inputMode="numeric" value={serviceFeeForm.feeBps} onChange={(event) => setServiceFeeForm({ ...serviceFeeForm, feeBps: event.target.value.replace(/\D/g, "") })} /></label>
              <button disabled={loading || !serviceFeeForm.feeBps} onClick={savePlatformServiceFee}>保存</button>
            </div>
            <p className="hint">千五就是 50 Bps。这里保存后，新订单会按当时配置写入订单快照。</p>
          </Panel>
          <Panel title="余额充值确认" kicker={`${data.walletRecharges.filter((item) => text(item.status) === "pending_payment").length} 待确认`}>
            <KeyValue label="充值单" value={text(selectedWalletRecharge?.rechargeNo, "暂无")} />
            <KeyValue label="用户" value={text(selectedWalletRecharge?.userId, "-")} />
            <KeyValue label="应付" value={cents(selectedWalletRecharge?.payableCents)} />
            <KeyValue label="状态" value={humanValue(text(selectedWalletRecharge?.status, "-"))} />
            <div className="actions">
              <button disabled={loading || !selectedWalletRecharge?.rechargeNo || text(selectedWalletRecharge?.status) !== "pending_payment"} onClick={confirmSelectedWalletRecharge}>确认到账</button>
            </div>
          </Panel>
        </section>
        <section className="split">
          <Panel title="当前收款方式" kicker={selectedPaymentMethod ? paymentProviderName(text(selectedPaymentMethod.provider)) : "未选择"}>
            <KeyValue label="名称" value={text(selectedPaymentMethod?.displayName, "暂无")} />
            <KeyValue label="确认方式" value={text(selectedPaymentMethod?.confirmationMode) === "manual" ? "人工确认到账" : "回调或查单确认"} />
            <KeyValue label="状态" value={paymentMethodEnabledText(selectedPaymentMethod)} />
            <KeyValue label="密钥" value={paymentKeyStatusText(selectedPaymentMethod)} />
            <div className="actions">
              <button disabled={!selectedPaymentMethod?.id} onClick={testPaymentMethod}>测试当前方式</button>
              <button className="secondary" disabled={!selectedPaymentMethod?.id} onClick={setPaymentMethodDefault}>设为默认</button>
              <button className="secondary" disabled={!selectedPaymentMethod?.id} onClick={disablePaymentMethod}>停用当前</button>
            </div>
            <p className="hint">如果是官方支付方式，订单要等回调或查单确认；如果是个人收款码，订单才进入人工确认到账。</p>
          </Panel>
          <Panel title="支付回调与异常" kicker="官方支付">
            <KeyValue label="回调记录" value={`${data.paymentCallbacks.length} 条`} />
            <KeyValue label="异常订单" value={`${data.paymentExceptions.filter((item) => item.handled !== true).length} 条待处理`} />
            <KeyValue label="截图材料" value="只做异常证据" />
            <div className="actions">
              <button className="secondary" disabled={!selectedOrderNo || !paymentQueryForm.providerTradeNo || !paymentQueryForm.signature} onClick={querySelectedOrderPayment}>主动查单</button>
              <button className="secondary" disabled={!selectedPaymentException?.id} onClick={() => handleSelectedPaymentException("mark_handled")}>异常已处理</button>
            </div>
          </Panel>
        </section>
        <section className="split">
          <Panel title="收款方式表单" kicker="新增或修改">
            <PaymentMethodForm form={paymentMethodForm} setForm={setPaymentMethodForm} />
            <div className="actions">
              <button disabled={loading || !paymentMethodForm.provider || !paymentMethodForm.displayName} onClick={() => submitPaymentMethod()}>{loading ? "保存中..." : "保存为新方式"}</button>
              <button className="secondary" disabled={loading || !selectedPaymentMethod?.id} onClick={() => submitPaymentMethod(text(selectedPaymentMethod?.id))}>更新当前方式</button>
            </div>
            {paymentMethodFeedback ? <p className="inline-feedback">{paymentMethodFeedback}</p> : null}
          </Panel>
          <Panel title="收款方式列表" kicker={`${data.paymentMethods.length} 个`}>
            <Table rows={paymentMethodRows(data.paymentMethods)} columns={["method", "displayName", "ownerType", "merchant", "confirmMode", "enabled", "isDefault", "keyStatus", "lastTestResult", "lastCallbackAt"]} onPick={pickPaymentMethod} />
          </Panel>
        </section>
        <Panel title="回调记录" kicker={`${data.paymentCallbacks.length} 条`}>
          <Table rows={paymentCallbackRows(data.paymentCallbacks)} columns={["source", "orderNo", "tradeNo", "notifiedAt", "signature", "amountCheck", "idempotency", "errorReason"]} />
        </Panel>
        <Panel title="异常订单" kicker={`${data.paymentExceptions.length} 条`}>
          <div className="inline-form">
            <label>渠道交易号<input value={paymentQueryForm.providerTradeNo} onChange={(event) => setPaymentQueryForm({ ...paymentQueryForm, providerTradeNo: event.target.value })} placeholder="由支付渠道返回" /></label>
            <label>查单金额分<input value={paymentQueryForm.amountCents} onChange={(event) => setPaymentQueryForm({ ...paymentQueryForm, amountCents: event.target.value.replace(/\D/g, "") })} placeholder={selectedOrderAmount || "订单金额"} /></label>
            <label>商户号<input value={paymentQueryForm.merchantNo} onChange={(event) => setPaymentQueryForm({ ...paymentQueryForm, merchantNo: event.target.value })} placeholder="选填" /></label>
            <label>AppID<input value={paymentQueryForm.appId} onChange={(event) => setPaymentQueryForm({ ...paymentQueryForm, appId: event.target.value })} placeholder="选填" /></label>
            <label>交易状态<input value={paymentQueryForm.tradeStatus} onChange={(event) => setPaymentQueryForm({ ...paymentQueryForm, tradeStatus: event.target.value })} /></label>
            <label>签名<input value={paymentQueryForm.signature} onChange={(event) => setPaymentQueryForm({ ...paymentQueryForm, signature: event.target.value })} placeholder="验签所需签名" /></label>
            <label>处理备注<input value={paymentExceptionNote} onChange={(event) => setPaymentExceptionNote(event.target.value)} placeholder="异常处理备注" /></label>
          </div>
          <div className="actions">
            <button disabled={!selectedOrderNo || !paymentQueryForm.providerTradeNo || !paymentQueryForm.signature} onClick={querySelectedOrderPayment}>主动查单</button>
            <button className="secondary" disabled={!selectedPaymentException?.id} onClick={() => handleSelectedPaymentException("mark_handled")}>标记处理</button>
            <button className="secondary" disabled={!selectedPaymentException?.id} onClick={() => handleSelectedPaymentException("keep_exception")}>保留异常</button>
          </div>
          <Table rows={paymentExceptionRows(data.paymentExceptions)} columns={["type", "orderNo", "amountCents", "status", "reason", "maskedPayload", "handled", "note"]} moneyColumns={["amountCents"]} />
        </Panel>
        <Panel title="异常材料" kicker="非主流程">
          <p className="hint">这些材料只帮运营核实争议，不能在这里确认收款，也不会自动发货。</p>
          <Table rows={paymentDisputeMaterialRows(data.paymentVouchers)} columns={["orderNo", "amountCents", "channel", "payerName", "voucherUrl", "note", "status"]} moneyColumns={["amountCents"]} />
        </Panel>
        <Panel title="钱包与余额流水" kicker={`${data.wallets.length} 个钱包`}>
          <Table rows={data.wallets} columns={["walletNo", "userId", "availableBalanceCents", "frozenBalanceCents", "totalRechargeCents", "totalSpendCents", "status"]} moneyColumns={["availableBalanceCents", "frozenBalanceCents", "totalRechargeCents", "totalSpendCents"]} />
          <Table rows={data.walletTransactions.slice(0, 20)} columns={["transactionNo", "userId", "type", "direction", "amountCents", "balanceBeforeCents", "balanceAfterCents", "sourceType", "sourceId"]} moneyColumns={["amountCents", "balanceBeforeCents", "balanceAfterCents"]} />
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
            <span>{text(data.shop?.name, "商户小店")} / {text(data.platformShop?.name, "平台自营")}</span>
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
        {confirmAction ? (
          <ConfirmModal
            action={confirmAction}
            busy={loading && actionLabel === confirmAction.actionLabel}
            message={actionLabel === confirmAction.actionLabel || message.includes(confirmAction.actionLabel) ? message : undefined}
            onCancel={() => {
              if (loading) return;
              setConfirmAction(undefined);
              setMessage("已取消保存");
            }}
            onConfirm={async () => {
              const succeeded = await runAction(confirmAction.actionLabel, confirmAction.run, false, { skipConfirm: true });
              if (succeeded) {
                setConfirmAction(undefined);
                void loadAll(`${confirmAction.actionLabel}成功，数据已刷新`);
              }
            }}
          />
        ) : null}
        {renderModule()}
      </section>
    </main>
  );
}

function ConfirmModal(props: {
  action: ConfirmAction;
  busy: boolean;
  message?: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-label={props.action.title}>
        <div className="confirm-head">
          <div>
            <span>操作确认</span>
            <h3>{props.action.title}</h3>
          </div>
          <button className="secondary small" type="button" disabled={props.busy} onClick={props.onCancel}>关闭</button>
        </div>
        <p>{props.action.description}</p>
        {props.message ? <p className={props.busy ? "modal-status loading" : "modal-status"}>{props.message}</p> : null}
        <div className="change-list">
          {props.action.rows.length ? props.action.rows.map((row) => (
            <div className={row.kind === "image" ? "change-row image-change-row" : "change-row"} key={`${row.label}-${row.value}`}>
              <span>{row.label}</span>
              {row.before !== undefined ? <ChangeValue row={row} value={row.before} previous /> : null}
              {row.before !== undefined ? <strong aria-hidden="true">→</strong> : null}
              <ChangeValue row={row} value={row.value} />
            </div>
          )) : <p className="empty">没有检测到字段变化。</p>}
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" disabled={props.busy} onClick={props.onCancel}>取消</button>
          <button type="button" disabled={props.busy} onClick={() => void props.onConfirm()}>
            {props.busy ? <span className="spinner" aria-hidden="true" /> : null}
            {props.busy ? "保存中..." : props.action.confirmText}
          </button>
        </div>
      </section>
    </div>
  );
}

function ChangeValue(props: { row: ConfirmRow; value: string; previous?: boolean }) {
  if (props.row.kind === "image") {
    return (
      <div className={props.previous ? "confirm-image previous" : "confirm-image"}>
        <ProductImage product={{ name: props.previous ? "修改前商品图片" : "修改后商品图片", imageUrl: props.value }} size="list" />
      </div>
    );
  }
  return props.previous ? <em>{props.value}</em> : <b>{props.value}</b>;
}

function Module(props: { title: string; subtitle: string; children: React.ReactNode }) {
  const help = moduleHelp[props.title] ?? [];
  return (
    <section className="module">
      <div className="module-head">
        <div>
          <h2>{props.title}</h2>
          <p>{props.subtitle}</p>
        </div>
      </div>
      {help.length > 0 ? (
        <div className="module-guide" aria-label={`${props.title}使用说明`}>
          <strong>怎么用</strong>
          <ul>
            {help.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}
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

function PaymentMethodForm(props: {
  form: {
    provider: string;
    displayName: string;
    accountName: string;
    qrUrl: string;
    paymentUrl: string;
    productType: string;
    merchantNo: string;
    appId: string;
    serviceProviderId: string;
    gatewayUrl: string;
    apiMode: string;
    returnUrl: string;
    note: string;
    signingSecret: string;
    privateKey: string;
    publicKey: string;
    certificate: string;
    enabled: boolean;
    isDefault: boolean;
  };
  setForm: React.Dispatch<React.SetStateAction<{
    provider: string;
    displayName: string;
    accountName: string;
    qrUrl: string;
    paymentUrl: string;
    productType: string;
    merchantNo: string;
    appId: string;
    serviceProviderId: string;
    gatewayUrl: string;
    apiMode: string;
    returnUrl: string;
    note: string;
    signingSecret: string;
    privateKey: string;
    publicKey: string;
    certificate: string;
    enabled: boolean;
    isDefault: boolean;
  }>>;
}) {
  const confirmMode = paymentProviderConfirmMode(props.form.provider);
  const personalPayment = ["personal_alipay", "alipay_personal", "wechat_personal"].includes(props.form.provider);
  const personalWechat = props.form.provider === "wechat_personal";
  const epay = props.form.provider === "epay";
  const official = ["alipay_merchant", "wechat_merchant", "epay"].includes(props.form.provider);
  async function uploadPersonalQr(file?: File) {
    if (!file) return;
    const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
    if (!allowedTypes.has(file.type)) {
      window.alert("请上传 PNG、JPG 或 WebP 图片。");
      return;
    }
    if (file.size > 600 * 1024) {
      window.alert("收款码图片太大，请压缩到 600KB 以内再上传。");
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    props.setForm({ ...props.form, qrUrl: dataUrl });
  }
  function applyZpayDefaults() {
    props.setForm({
      ...props.form,
      provider: "epay",
      displayName: "ZPAY 易支付",
      productType: "页面跳转支付",
      gatewayUrl: "https://zpayz.cn/submit.php",
      apiMode: "submit",
      returnUrl: props.form.returnUrl || "",
      note: "ZPAY 易支付：使用 submit.php 页面跳转支付，异步回调以系统自动生成的 notify_url 为准。"
    });
  }
  return (
    <div className="form-grid wide">
      <label>收款方式<select value={props.form.provider} onChange={(event) => props.setForm({ ...props.form, provider: event.target.value })}><option value="">请选择</option><option value="alipay_merchant">支付宝商户</option><option value="wechat_merchant">微信/腾讯商户</option><option value="epay">e支付 / ZPAY / xpay / 虎皮椒</option><option value="personal_alipay">个人支付宝</option><option value="wechat_personal">个人微信</option></select></label>
      <label>确认方式<input value={confirmMode} readOnly /></label>
      <label>默认方式<select value={props.form.isDefault ? "yes" : "no"} onChange={(event) => props.setForm({ ...props.form, isDefault: event.target.value === "yes" })}><option value="no">否</option><option value="yes">设为默认</option></select></label>
      <label>启用<select value={props.form.enabled ? "yes" : "no"} onChange={(event) => props.setForm({ ...props.form, enabled: event.target.value === "yes" })}><option value="yes">启用</option><option value="no">停用</option></select></label>
      {epay ? (
        <div className="span-2 payment-preset-box">
          <div>
            <strong>ZPAY 易支付</strong>
            <p>适合你给的接口文档：`submit.php` 跳转支付，系统自动生成 `notify_url` 并校验 MD5 回调签名。</p>
          </div>
          <button className="secondary small" type="button" onClick={applyZpayDefaults}>套用 ZPAY 默认值</button>
        </div>
      ) : null}
      <label>收款名称<input value={props.form.displayName} onChange={(event) => props.setForm({ ...props.form, displayName: event.target.value })} placeholder={epay ? "例如：ZPAY 易支付" : personalPayment ? "例如：个人收款码" : "例如：支付宝商户主通道"} /></label>
      <label>产品类型<input value={props.form.productType} onChange={(event) => props.setForm({ ...props.form, productType: event.target.value })} placeholder={epay ? "页面跳转支付" : personalPayment ? "可不填" : "H5 / 扫码 / JSAPI"} /></label>
      {!personalPayment ? <label>{epay ? "商户ID pid" : "商户号"}<input value={props.form.merchantNo} onChange={(event) => props.setForm({ ...props.form, merchantNo: event.target.value })} placeholder={epay ? "例如 2026060217530198" : "支付平台分配的商户号"} /></label> : null}
      {!personalPayment && !epay ? <label>AppID<input value={props.form.appId} onChange={(event) => props.setForm({ ...props.form, appId: event.target.value })} placeholder="支付宝/微信应用 ID" /></label> : null}
      {epay ? <label>支付渠道 ID cid<input value={props.form.serviceProviderId} onChange={(event) => props.setForm({ ...props.form, serviceProviderId: event.target.value })} placeholder="选填；多个用英文逗号隔开" /></label> : null}
      <label>账户名<input value={props.form.accountName} onChange={(event) => props.setForm({ ...props.form, accountName: event.target.value })} placeholder={personalPayment ? "后台内部核对用，前台不展示" : "内部识别名，可选"} /></label>
      {epay ? <label>支付网关<input value={props.form.gatewayUrl} onChange={(event) => props.setForm({ ...props.form, gatewayUrl: event.target.value })} placeholder="https://zpayz.cn/submit.php" /></label> : null}
      {epay ? <label>接口模式<select value={props.form.apiMode || "submit"} onChange={(event) => props.setForm({ ...props.form, apiMode: event.target.value })}><option value="submit">页面跳转支付 submit.php</option><option value="mapi_first">API 接口支付 mapi.php</option><option value="hupijiao_direct">虎皮椒直连</option></select></label> : null}
      {official ? <label>{epay ? "商户密钥 key" : "签名密钥"}<input type="password" value={props.form.signingSecret} onChange={(event) => props.setForm({ ...props.form, signingSecret: event.target.value })} placeholder="只提交，不回显明文" /></label> : null}
      {official && !epay ? <label>私钥<input type="password" value={props.form.privateKey} onChange={(event) => props.setForm({ ...props.form, privateKey: event.target.value })} placeholder="只提交，不回显明文" /></label> : null}
      {official && !epay ? <label>公钥<input type="password" value={props.form.publicKey} onChange={(event) => props.setForm({ ...props.form, publicKey: event.target.value })} placeholder="只提交，不回显明文" /></label> : null}
      {official && !epay ? <label>证书<input type="password" value={props.form.certificate} onChange={(event) => props.setForm({ ...props.form, certificate: event.target.value })} placeholder="只提交，不回显明文" /></label> : null}
      {personalPayment ? (
        <div className="span-2 qr-upload">
          <label>{personalWechat ? "个人微信收款码" : "个人支付宝收款码"}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void uploadPersonalQr(event.target.files?.[0])} /></label>
          {props.form.qrUrl ? (
            <div className="qr-preview">
              <img src={props.form.qrUrl} alt="个人收款码预览" />
              <button className="secondary small" type="button" onClick={() => props.setForm({ ...props.form, qrUrl: "" })}>重新上传</button>
            </div>
          ) : (
            <p className="hint">上传你已经下载好的收款码图片，保存后客户付款页会展示这张码。</p>
          )}
        </div>
      ) : (
        <label className="span-2">支付二维码 URL<input value={props.form.qrUrl} onChange={(event) => props.setForm({ ...props.form, qrUrl: event.target.value })} placeholder="支付平台返回二维码时可不填" /></label>
      )}
      <label className="span-2">支付链接<input value={props.form.paymentUrl} onChange={(event) => props.setForm({ ...props.form, paymentUrl: event.target.value })} placeholder={personalPayment ? "可不填" : "官方支付链接或测试链接"} /></label>
      {official ? <label className="span-2">支付后返回地址<input value={props.form.returnUrl} onChange={(event) => props.setForm({ ...props.form, returnUrl: event.target.value })} placeholder="只负责跳回页面，不代表支付成功" /></label> : null}
      <label className="span-2">给运营看的说明<textarea value={props.form.note} onChange={(event) => props.setForm({ ...props.form, note: event.target.value })} rows={2} placeholder={personalPayment ? "例如：付款后 10 分钟内人工确认" : "例如：支付成功以回调/查单为准"} /></label>
    </div>
  );
}

function PlatformProductDrawer(props: {
  product: JsonRecord;
  form: ProductFormState;
  setForm: React.Dispatch<React.SetStateAction<ProductFormState>>;
  tab: "base" | "codes" | "audit";
  setTab: (tab: "base" | "codes" | "audit") => void;
  rightsCodes: JsonRecord[];
  relatedMerchantProducts: JsonRecord[];
  channelRelations: JsonRecord[];
  channelOffers: JsonRecord[];
  onUploadImage: (file: File) => void;
  onSave: () => void;
  busy: boolean;
  onClose: () => void;
  onOpenInventory: () => void;
}) {
  const isCodePool = props.form.fulfillmentMode === "code_pool";
  const credentialType: CredentialType = props.form.credentialType === "account_password" ? "account_password" : productCredentialType(props.product);
  const stats = rightsCodeStats(props.rightsCodes);
  const lowStock = isCodePool && stats.available <= 3;

  function handleImageFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      window.alert("商品图片只支持 JPG、PNG 或 WebP。");
      return;
    }
    if (file.size > 1_200_000) {
      window.alert("商品图片不能超过 1.2MB。");
      return;
    }
    props.onUploadImage(file);
  }

  return (
    <aside className="drawer product-drawer" role="dialog" aria-modal="false" aria-label="平台商品详情">
      <div className="drawer-head">
        <div>
          <span>平台商品详情</span>
          <h3>{text(props.product.name, text(props.product.id))}</h3>
        </div>
        <button className="secondary" type="button" disabled={props.busy} onClick={props.onClose}>关闭</button>
      </div>
      <div className="tabs">
        <button className={props.tab === "base" ? "active" : ""} type="button" onClick={() => props.setTab("base")}>基础与价格</button>
        <button className={props.tab === "codes" ? "active" : ""} type="button" disabled={!isCodePool} onClick={() => props.setTab("codes")}>自动发货概况</button>
        <button className={props.tab === "audit" ? "active" : ""} type="button" onClick={() => props.setTab("audit")}>确认与审计</button>
      </div>
      {props.tab === "base" ? (
        <section className="product-workbench">
          <div className="product-media-panel">
            <label className="product-image-picker">
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleImageFileChange} />
              <ProductImage product={{ ...props.product, imageUrl: props.form.imageUrl }} size="detail" />
              <span>{props.busy ? "正在上传图片..." : "点击图片上传本地图片"}</span>
            </label>
            <KeyValue label="商品编号" value={friendlyId(props.product.id, "商品")} />
            <KeyValue label="发货类型" value={isCodePool ? `自动发库存凭证：${credentialTypeText(credentialType)}` : "人工交付"} />
            <KeyValue label="代理链路" value="平台商品源 -> M1 -> M2 -> M3" />
            <KeyValue label="代理状态" value={`${props.relatedMerchantProducts.length} 个店铺已代理`} />
          </div>
          <div className="product-edit-panel">
            <div className="form-grid wide">
              <div className="form-section-title span-2">基础信息</div>
              <label>商品名称<input value={props.form.name} onChange={(event) => props.setForm((form) => ({ ...form, name: event.target.value }))} /></label>
              <label>状态<select value={props.form.status} onChange={(event) => props.setForm((form) => ({ ...form, status: event.target.value }))}><option value="active">上架</option><option value="listed">上架中</option><option value="disabled">下架</option><option value="frozen">冻结</option></select></label>
              <label>类目<input value={props.form.category} onChange={(event) => props.setForm((form) => ({ ...form, category: event.target.value }))} /></label>
              <label>标签<input value={props.form.tags} onChange={(event) => props.setForm((form) => ({ ...form, tags: event.target.value }))} /></label>
              <label className="span-2">图片地址<input value={props.form.imageUrl} onChange={(event) => props.setForm((form) => ({ ...form, imageUrl: event.target.value }))} placeholder="上传后自动生成 /uploads/product-images/...；也可以暂时填写 https 图片外链" /></label>
              <div className="form-section-title span-2">发货与价格</div>
              <label>发货方式<select value={props.form.fulfillmentMode} onChange={(event) => props.setForm((form) => ({ ...form, fulfillmentMode: event.target.value }))}><option value="">请选择</option><option value="manual">人工交付</option><option value="code_pool">自动发库存凭证</option></select></label>
              {props.form.fulfillmentMode === "code_pool" ? <label>凭证类型<select value={props.form.credentialType} onChange={(event) => props.setForm((form) => ({ ...form, credentialType: event.target.value }))}><option value="code">兑换码/卡密</option><option value="account_password">账号密码</option></select></label> : null}
              <label>库存<input inputMode="numeric" value={props.form.stockCount} onChange={(event) => props.setForm((form) => ({ ...form, stockCount: event.target.value }))} /></label>
              <label>供货价(分)<input inputMode="numeric" value={props.form.supplyPriceCents} onChange={(event) => props.setForm((form) => ({ ...form, supplyPriceCents: event.target.value }))} /></label>
              <label>最低售价(分)<input inputMode="numeric" value={props.form.minSalePriceCents} onChange={(event) => props.setForm((form) => ({ ...form, minSalePriceCents: event.target.value }))} /></label>
              <label>建议售价(分)<input inputMode="numeric" value={props.form.suggestedSalePriceCents} onChange={(event) => props.setForm((form) => ({ ...form, suggestedSalePriceCents: event.target.value }))} /></label>
              <label>销量<input inputMode="numeric" value={props.form.soldCount} onChange={(event) => props.setForm((form) => ({ ...form, soldCount: event.target.value }))} /></label>
              <div className="form-section-title span-2">商品详情</div>
              <label className="span-2">商品说明<textarea rows={3} value={props.form.description} onChange={(event) => props.setForm((form) => ({ ...form, description: event.target.value }))} /></label>
              <label className="span-2">使用/人工交付说明<textarea rows={3} value={props.form.usageGuide} onChange={(event) => props.setForm((form) => ({ ...form, usageGuide: event.target.value }))} /></label>
              <label className="span-2">详情模块<textarea rows={4} value={props.form.detailSections} onChange={(event) => props.setForm((form) => ({ ...form, detailSections: event.target.value }))} placeholder="标题：内容一；内容二" /></label>
            </div>
          </div>
          <div className="product-side-panel">
            <ProductInventorySummary product={props.product} rightsCodes={props.rightsCodes} />
            <ProductProxySummary
              product={props.product}
              relatedMerchantProducts={props.relatedMerchantProducts}
              channelRelations={props.channelRelations}
              channelOffers={props.channelOffers}
            />
            <ProductChangeSummary product={props.product} form={props.form} />
            <div className="actions">
              {isCodePool ? <button className="secondary" type="button" disabled={props.busy} onClick={props.onOpenInventory}>去库存管理补货</button> : null}
              <button type="button" disabled={props.busy} onClick={props.onSave}>{props.busy ? "保存中..." : "确认保存详情"}</button>
            </div>
            {!isCodePool ? <p className="hint">人工交付商品不能导入自动发货库存；请维护人工交付说明和客服信息。</p> : null}
          </div>
        </section>
      ) : null}
      {props.tab === "codes" ? (
        isCodePool ? (
            <>
              <ProductInventorySummary product={props.product} rightsCodes={props.rightsCodes} />
              <section className="mini-metrics">
                <KeyValue label="库存总数" value={String(stats.total)} />
                <KeyValue label="可发给客户" value={String(stats.available)} />
                <KeyValue label="已发给客户" value={String(stats.issued)} />
                <KeyValue label="库存预警" value={lowStock ? "低库存，请补充" : "正常"} />
              </section>
              <p className="hint">这里只看当前商品的自动发货概况。添加兑换码、卡密或账号密码，请进入“自动发货库存”模块统一管理。</p>
              <p className="hint">分配规则：确认收款后按导入时间优先分配可用库存；已发放、冻结、失效、退款禁看的库存不会再次分配。</p>
              <div className="actions">
                <button type="button" disabled={props.busy} onClick={props.onOpenInventory}>去库存管理补货</button>
              </div>
              <RightsCodeTable
                rows={props.rightsCodes}
                showSensitiveCodes={false}
                sensitiveRows={[]}
                canReveal={false}
                hideActions
              />
          </>
        ) : <p className="empty">人工交付商品不走自动发货库存。请在基础信息中维护人工交付说明和客服资料。</p>
      ) : null}
      {props.tab === "audit" ? (
        <div className="audit-note">
          <KeyValue label="接口" value={`PATCH /api/admin/products/${text(props.product.id)}`} />
          <KeyValue label="保存确认" value="点击确认保存详情前弹出二次确认" />
          <KeyValue label="审计动作" value="platform_product.update / rights_code.secret.read / rights_code.import" />
          <KeyValue label="结果反馈" value="顶部提示条展示成功或错误原因，保存后自动刷新数据" />
        </div>
      ) : null}
    </aside>
  );
}

function RightsPrecheckPanel(props: { result?: RightsCodePrecheckResult }) {
  if (!props.result) return <p className="hint">预检会列出空行、本次重复和非法行；通过后才允许导入。</p>;
  return (
    <div className="precheck">
      <KeyValue label="总行数" value={String(props.result.totalLines)} />
      <KeyValue label="有效行" value={String(props.result.validCodes.length)} />
      <KeyValue label="空行" value={props.result.blankLines.length ? props.result.blankLines.join("、") : "无"} />
      <KeyValue label="重复" value={props.result.duplicateCodes.length ? props.result.duplicateCodes.join("、") : "无"} />
      <KeyValue label="非法行" value={props.result.invalidRows.length ? props.result.invalidRows.map((row) => `${row.line}:${row.reason}`).join("；") : "无"} />
    </div>
  );
}

function ChannelOfferEditor(props: {
  relations: JsonRecord[];
  products: JsonRecord[];
  selectedRelationId: string;
  selectedProductId: string;
  priceCents: string;
  disabled?: boolean;
  setSelectedRelationId: (value: string) => void;
  setSelectedProductId: (value: string) => void;
  setPriceCents: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="channel-offer-editor">
      <label>供货关系
        <select value={props.selectedRelationId} onChange={(event) => props.setSelectedRelationId(event.target.value)}>
          {props.relations.map((relation) => (
            <option key={text(relation.id)} value={text(relation.id)}>
              {channelRelationLabel(relation)}
            </option>
          ))}
        </select>
      </label>
      <label>平台商品
        <select value={props.selectedProductId} onChange={(event) => props.setSelectedProductId(event.target.value)}>
          {props.products.map((product) => (
            <option key={text(product.id)} value={text(product.id)}>
              {text(product.name, text(product.id))}
            </option>
          ))}
        </select>
      </label>
      <label>转供价(分)
        <input inputMode="numeric" value={props.priceCents} onChange={(event) => props.setPriceCents(event.target.value)} placeholder="必填，不能低于上游成本" />
      </label>
      <button className="secondary" disabled={props.disabled || !props.selectedRelationId || !props.selectedProductId || !props.priceCents.trim()} onClick={props.onSubmit}>配置转供价</button>
    </div>
  );
}

function ProductCatalogList(props: {
  products: JsonRecord[];
  rightsCodes: JsonRecord[];
  merchantProducts: JsonRecord[];
  channels?: JsonRecord;
  onPick: (product: JsonRecord) => void;
}) {
  const [draft, setDraft] = useState({
    keyword: "",
    category: "",
    fulfillmentMode: "",
    status: "",
    downstreamOpen: "",
    minSupplyYuan: "",
    maxSupplyYuan: ""
  });
  const [filters, setFilters] = useState(draft);
  const categories = Array.from(new Set(props.products.map((product) => text(product.category)).filter(Boolean))).sort();
  const offerCountsByProduct = new Map<string, number>();
  channelRows(props.channels, "offers").forEach((offer) => {
    const productId = text(offer.platformProductId);
    offerCountsByProduct.set(productId, (offerCountsByProduct.get(productId) ?? 0) + 1);
  });
  const filtered = props.products.filter((product) => {
    const keyword = filters.keyword.trim().toLowerCase();
    const productId = text(product.id);
    if (keyword) {
      const haystack = [product.name, product.category, product.tags, product.subtitle, productId]
        .map((item) => cellText(item).toLowerCase())
        .join(" ");
      if (!haystack.includes(keyword)) return false;
    }
    if (filters.category && text(product.category) !== filters.category) return false;
    if (filters.fulfillmentMode && productFulfillmentMode(product) !== filters.fulfillmentMode) return false;
    if (filters.status && text(product.status) !== filters.status) return false;
    const offerCount = offerCountsByProduct.get(productId) ?? 0;
    if (filters.downstreamOpen === "open" && offerCount === 0) return false;
    if (filters.downstreamOpen === "closed" && offerCount > 0) return false;
    const supplyPriceCents = Number(product.supplyPriceCents ?? 0);
    const minSupplyCents = yuanInputToCents(filters.minSupplyYuan);
    const maxSupplyCents = yuanInputToCents(filters.maxSupplyYuan);
    if (minSupplyCents !== undefined && supplyPriceCents < minSupplyCents) return false;
    if (maxSupplyCents !== undefined && supplyPriceCents > maxSupplyCents) return false;
    return true;
  });
  function resetSearch() {
    const empty = {
      keyword: "",
      category: "",
      fulfillmentMode: "",
      status: "",
      downstreamOpen: "",
      minSupplyYuan: "",
      maxSupplyYuan: ""
    };
    setDraft(empty);
    setFilters(empty);
  }
  if (props.products.length === 0) return <p className="empty">暂无平台商品</p>;
  return (
    <>
      <div className="structured-search product-catalog-search" role="search" aria-label="搜索平台商品库">
        <div className="search-help">可按商品名称、商品编号、标签、类目、发货方式、商品状态、下游开放状态、供货价范围组合搜索。平台商品才进入 M1 到 M2 到 M3 代理链。</div>
        <label>商品名称/编号
          <input
            value={draft.keyword}
            onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
            placeholder="例如 Claude、prod-code、自动发货"
          />
        </label>
        <label>类目
          <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
            <option value="">全部类目</option>
            {categories.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </label>
        <label>发货方式
          <select value={draft.fulfillmentMode} onChange={(event) => setDraft({ ...draft, fulfillmentMode: event.target.value })}>
            <option value="">全部方式</option>
            <option value="manual">人工交付</option>
            <option value="code_pool">自动发库存凭证</option>
          </select>
        </label>
        <label>商品状态
          <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
            <option value="">全部状态</option>
            <option value="active">上架</option>
            <option value="listed">上架中</option>
            <option value="disabled">下架</option>
            <option value="frozen">冻结</option>
          </select>
        </label>
        <label>下游开放
          <select value={draft.downstreamOpen} onChange={(event) => setDraft({ ...draft, downstreamOpen: event.target.value })}>
            <option value="">全部</option>
            <option value="open">已开放</option>
            <option value="closed">未开放</option>
          </select>
        </label>
        <label>最低供货价(元)
          <input
            inputMode="decimal"
            value={draft.minSupplyYuan}
            onChange={(event) => setDraft({ ...draft, minSupplyYuan: event.target.value })}
            placeholder="例如 20"
          />
        </label>
        <label>最高供货价(元)
          <input
            inputMode="decimal"
            value={draft.maxSupplyYuan}
            onChange={(event) => setDraft({ ...draft, maxSupplyYuan: event.target.value })}
            placeholder="例如 100"
          />
        </label>
        <div className="search-actions">
          <button type="button" onClick={() => setFilters(draft)}>搜索</button>
          <button className="secondary" type="button" onClick={resetSearch}>重置</button>
        </div>
        <span className="search-count">共 {props.products.length} 个平台商品，当前显示 {filtered.length} 个</span>
      </div>
      <div className="product-list">
        {filtered.map((product) => {
          const productId = text(product.id);
          const productCodes = props.rightsCodes.filter((item) => text(item.productId) === productId || text(item.platformProductId) === productId);
          const stats = rightsCodeStats(productCodes);
          const relatedListings = props.merchantProducts.filter((item) => text(item.platformProductId) === productId);
          const productOffers = channelRows(props.channels, "offers").filter((item) => text(item.platformProductId) === productId);
          const isCodePool = productFulfillmentMode(product) === "code_pool";
          return (
            <article className="product-row" key={productId}>
              <ProductImage product={product} size="list" />
              <div className="product-row-main">
                <div className="product-row-title">
                  <h4>{text(product.name, productId)}</h4>
                  <StatusBadge value={product.status} />
                </div>
                <p>{text(product.subtitle, text(product.description, "暂无商品简介"))}</p>
                <div className="product-row-facts">
                  <span>{text(product.category, "未分类")}</span>
                  <span>{isCodePool ? `自动发货库存：${stats.available} 个可用` : "人工交付：不走自动库存"}</span>
                  <span>供货价 {cents(product.supplyPriceCents)}</span>
                  <span>最低售价 {cents(product.minSalePriceCents)}</span>
                  <span>{relatedListings.length} 个店铺已代理</span>
                  <span>{productOffers.length > 0 ? `下游开放：${productOffers.length} 条` : "下游未开放"}</span>
                </div>
              </div>
              <div className="product-row-actions">
                <button className="small" type="button" onClick={() => props.onPick(product)}>打开详情</button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

function AutoInventoryProductList(props: {
  products: JsonRecord[];
  rightsCodes: JsonRecord[];
  selectedProductId: string;
  onSelect: (product: JsonRecord) => void;
  onEditProduct: (product: JsonRecord) => void;
}) {
  const [draft, setDraft] = useState({ keyword: "", credentialType: "", stockStatus: "" });
  const [filters, setFilters] = useState(draft);
  const rows = props.products.filter((product) => {
    const productId = text(product.id);
    const productRows = props.rightsCodes.filter((item) => text(item.productId) === productId || text(item.platformProductId) === productId);
    const stats = rightsCodeStats(productRows);
    const credentialType = productCredentialType(product);
    const keyword = filters.keyword.trim().toLowerCase();
    if (keyword) {
      const haystack = [product.name, product.id, product.category, product.tags, product.subtitle]
        .map((item) => cellText(item).toLowerCase())
        .join(" ");
      if (!haystack.includes(keyword)) return false;
    }
    if (filters.credentialType && credentialType !== filters.credentialType) return false;
    if (filters.stockStatus === "empty" && stats.available > 0) return false;
    if (filters.stockStatus === "low" && (stats.available === 0 || stats.available > 3)) return false;
    if (filters.stockStatus === "enough" && stats.available <= 3) return false;
    return true;
  });

  function resetSearch() {
    const empty = { keyword: "", credentialType: "", stockStatus: "" };
    setDraft(empty);
    setFilters(empty);
  }

  if (props.products.length === 0) {
    return <p className="empty">暂无自动发货商品。请先到商品管理设置发货方式和凭证类型。</p>;
  }

  return (
    <>
      <div className="structured-search inventory-product-search" role="search" aria-label="搜索自动发货商品">
        <div className="search-help">先找到要补货的自动发货商品，再点“管理库存”。兑换码/卡密和账号密码都在这里维护。</div>
        <label>商品名称/编号
          <input value={draft.keyword} onChange={(event) => setDraft({ ...draft, keyword: event.target.value })} placeholder="例如 Claude、Apple ID、prod-code" />
        </label>
        <label>凭证类型
          <select value={draft.credentialType} onChange={(event) => setDraft({ ...draft, credentialType: event.target.value })}>
            <option value="">全部类型</option>
            <option value="code">兑换码/卡密</option>
            <option value="account_password">账号密码</option>
          </select>
        </label>
        <label>库存状态
          <select value={draft.stockStatus} onChange={(event) => setDraft({ ...draft, stockStatus: event.target.value })}>
            <option value="">全部状态</option>
            <option value="empty">无可发库存</option>
            <option value="low">低库存</option>
            <option value="enough">库存正常</option>
          </select>
        </label>
        <div className="search-actions">
          <button type="button" onClick={() => setFilters(draft)}>搜索</button>
          <button className="secondary" type="button" onClick={resetSearch}>重置</button>
        </div>
        <span className="search-count">共 {props.products.length} 个自动发货商品，当前显示 {rows.length} 个</span>
      </div>
      <div className="inventory-product-list">
        {rows.map((product) => {
          const productId = text(product.id);
          const productRows = props.rightsCodes.filter((item) => text(item.productId) === productId || text(item.platformProductId) === productId);
          const stats = rightsCodeStats(productRows);
          const selected = props.selectedProductId === productId;
          const stockState = stats.available === 0 ? "无可发库存" : stats.available <= 3 ? "低库存" : "正常";
          return (
            <article className={`inventory-product-card${selected ? " active" : ""}`} key={productId}>
              <ProductImage product={product} size="list" />
              <div className="inventory-product-main">
                <div className="inventory-product-title">
                  <h4>{text(product.name, productId)}</h4>
                  <StatusBadge value={stockState} />
                </div>
                <p>{text(product.subtitle, text(product.description, "暂无商品简介"))}</p>
                <div className="product-row-facts">
                  <span>{credentialTypeText(productCredentialType(product))}</span>
                  <span>可发 {stats.available}</span>
                  <span>已发 {stats.issued}</span>
                  <span>总数 {stats.total}</span>
                </div>
              </div>
              <div className="inventory-product-actions">
                <button className="small" type="button" onClick={() => props.onSelect(product)}>{selected ? "正在管理" : "管理库存"}</button>
                <button className="secondary small" type="button" onClick={() => props.onEditProduct(product)}>编辑商品设置</button>
              </div>
            </article>
          );
        })}
      </div>
      {rows.length === 0 ? <p className="empty">没有符合条件的自动发货商品。</p> : null}
    </>
  );
}

function MerchantListingTable(props: {
  products: JsonRecord[];
  merchantProducts: JsonRecord[];
  onPick: (product: JsonRecord) => void;
  blocked: boolean;
  tier: string;
  loading: boolean;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 8;
  const existingByPlatformId = new Map(props.merchantProducts.map((item) => [text(item.platformProductId), item]));
  const filtered = query.trim()
    ? props.products.filter((product) => {
      const haystack = [
        product.name,
        product.category,
        product.tags,
        product.id
      ].map((item) => cellText(item).toLowerCase()).join(" ");
      return haystack.includes(query.trim().toLowerCase());
    })
    : props.products;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedProducts = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  if (props.products.length === 0) return <p className="empty">暂无可店铺商品</p>;
  return (
    <>
      <div className="table-tools">
        <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="筛选商品名称/类目" />
        <span>共 {filtered.length} 个可店铺商品，每页 8 个</span>
      </div>
      <div className="listing-grid" aria-busy={props.loading}>
        {pagedProducts.map((product) => {
          const existing = existingByPlatformId.get(text(product.id));
          const imageUrl = text(product.imageUrl);
          const upstreamPrice = props.tier === "first_tier"
            ? text(product.supplyPriceCents)
            : text(product.visibleUpstreamSupplyPriceCents);
          const minPrice = text(product.minSalePriceCents);
          const canPick = text(product.status, "active") === "active" && !props.blocked;
          return (
            <article className="listing-card" key={text(product.id)}>
              <div className="listing-thumb">
                {imageUrl ? <img src={imageUrl} alt="" /> : <span>商品图</span>}
              </div>
              <div className="listing-main">
                <div className="listing-title">
                  <h4>{text(product.name, text(product.id))}</h4>
                  <StatusBadge value={existing ? text(existing.status, "listed") : "未上架"} />
                </div>
                <p>{text(product.subtitle, text(product.description, "暂无简介"))}</p>
                <div className="listing-facts">
                  <span>可选：{canPick ? "是" : "否"}</span>
                  <span>当前售价：{existing ? cents(existing.salePriceCents) : "-"}</span>
                  <span>建议售价：{cents(product.suggestedSalePriceCents)}</span>
                  <span>最低售价：{cents(minPrice)}</span>
                  <span>可见成本：{cents(upstreamPrice)}</span>
                </div>
              </div>
              <button className="small" type="button" disabled={!canPick || props.loading} onClick={() => props.onPick(product)}>
                {props.loading ? "处理中..." : existing ? "编辑店铺商品" : "选品"}
              </button>
            </article>
          );
        })}
      </div>
      {filtered.length > pageSize ? (
        <div className="pager">
          <button className="secondary small" type="button" disabled={safePage <= 1 || props.loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
          <span>第 {safePage} / {totalPages} 页</span>
          <button className="secondary small" type="button" disabled={safePage >= totalPages || props.loading} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
        </div>
      ) : null}
    </>
  );
}

function OwnProductReviewDrawer(props: {
  product: JsonRecord;
  onApprove: () => void;
  onReject: () => void;
  onClose: () => void;
}) {
  const merchant = props.product.merchant as JsonRecord | undefined;
  const shop = props.product.shop as JsonRecord | undefined;
  const reviewStatus = text(props.product.reviewStatus, text(props.product.status));
  const pending = reviewStatus === "pending_review";
  const tags = Array.isArray(props.product.tags) ? props.product.tags.map((item) => text(item)).filter(Boolean) : [];
  const specs = Array.isArray(props.product.specs) ? props.product.specs.map((item) => text(item)).filter(Boolean) : [];
  const detailSections = Array.isArray(props.product.detailSections) ? props.product.detailSections.filter(isRecord) : [];
  return (
    <aside className="drawer" role="dialog" aria-modal="false" aria-label="自有商品审核详情">
      <div className="drawer-head">
        <div>
          <span>{pending ? "待审核自有商品" : "已审核自有商品"}</span>
          <h3>{text(props.product.name, text(props.product.id))}</h3>
        </div>
        <button className="secondary" type="button" onClick={props.onClose}>关闭</button>
      </div>
      <div className="review-detail-layout">
        <div className="review-media">
          <ProductImage product={props.product} size="detail" />
        </div>
        <section className="detail-grid">
          <KeyValue label="商品编号" value={text(props.product.ownProductId, text(props.product.id))} />
          <KeyValue label="商户" value={text(merchant?.name, text(props.product.merchantId))} />
          <KeyValue label="商户等级" value={humanValue(text(merchant?.tier, "-"), "-")} />
          <KeyValue label="店铺" value={text(shop?.name, text(props.product.shopId))} />
          <KeyValue label="类目" value={text(props.product.category, "未填写")} />
          <KeyValue label="标签" value={tags.length ? tags.join("、") : "未填写"} />
          <KeyValue label="售价" value={cents(props.product.salePriceCents)} />
          <KeyValue label="最低价" value={cents(props.product.minSalePriceCents)} />
          <KeyValue label="履约方式" value={fulfillmentModeLabel(props.product.fulfillmentRule)} />
          <KeyValue label="审核状态" value={humanValue(reviewStatus)} />
          <KeyValue label="商品状态" value={humanValue(props.product.status)} />
          <KeyValue label="提交时间" value={dateTimeText(props.product.createdAt)} />
          <KeyValue label="审核时间" value={text(props.product.reviewedAt) ? dateTimeText(props.product.reviewedAt) : "未审核"} />
          <KeyValue label="审核人" value={text(props.product.reviewedBy, pending ? "未审核" : "-")} />
        </section>
      </div>
      <section className="review-copy">
        <h4>副标题</h4>
        <p>{text(props.product.subtitle, "未填写")}</p>
        <h4>商品说明</h4>
        <p>{text(props.product.description, "未填写")}</p>
        <h4>使用/人工交付说明</h4>
        <p>{text(props.product.usageGuide, text(props.product.manualFulfillmentInstruction, "未填写"))}</p>
        <h4>规格</h4>
        <p>{specs.length ? specs.join("、") : "未填写"}</p>
        <h4>详情模块</h4>
        {detailSections.length ? (
          <div className="detail-section-list">
            {detailSections.map((section, index) => (
              <div key={`${text(section.title, "模块")}-${index}`}>
                <strong>{text(section.title, `模块 ${index + 1}`)}</strong>
                <p>{Array.isArray(section.items) ? section.items.map((item) => text(item)).filter(Boolean).join("；") : "未填写"}</p>
              </div>
            ))}
          </div>
        ) : <p>未填写</p>}
      </section>
      {pending ? (
        <div className="actions">
          <button type="button" onClick={props.onApprove}>通过审核</button>
          <button className="secondary" type="button" onClick={props.onReject}>拒绝审核</button>
        </div>
      ) : null}
      <p className="hint">{pending ? "未审核商品通过后会生成商户自有上架商品；拒绝后商户需要补充资料再提交。" : "该商品已完成审核，审核时间和审核人已记录在上方。"}</p>
    </aside>
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

function PaymentMethodCards(props: { methods: JsonRecord[]; exceptions: JsonRecord[]; onPickProvider?: (provider: string) => void }) {
  const rows = paymentOverviewRows(props.methods, props.exceptions);
  return (
    <section className="payment-method-grid">
      {rows.map((row) => (
        <article className={text(row.enabled) === "已启用" ? "payment-method-card active" : "payment-method-card"} key={text(row.method)}>
          <div>
            <span>{text(row.confirmMode)}</span>
            <h3>{text(row.method)}</h3>
          </div>
          <strong>{text(row.enabled)}</strong>
          <p>{paymentMethodPlainHint(text(row.method), text(row.enabled), text(row.exceptionCount))}</p>
          <dl>
            <div><dt>默认</dt><dd>{text(row.defaultMethod)}</dd></div>
            <div><dt>密钥</dt><dd>{text(row.secretStatus)}</dd></div>
            <div><dt>异常</dt><dd>{text(row.exceptionCount)} 条</dd></div>
          </dl>
          <button type="button" className="small ghost" onClick={() => props.onPickProvider?.(text(row.key))}>配置</button>
        </article>
      ))}
    </section>
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

function StatusBadge(props: { value: unknown }) {
  const raw = text(props.value, "unknown");
  return <span className={`status-badge ${statusTone(raw)}`}>{humanValue(raw)}</span>;
}

function ProductImage(props: { product?: JsonRecord; size: "list" | "detail" }) {
  const imageUrl = api.assetUrl(props.product?.imageUrl);
  const name = text(props.product?.name, "商品图片");
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [imageUrl]);
  return (
    <div className={`product-image ${props.size}`}>
      {imageUrl && !failed ? <img src={imageUrl} alt={name} onError={() => setFailed(true)} /> : <span>{imageUrl ? "图片加载失败，请更换图片" : "暂无图片"}</span>}
    </div>
  );
}

function ProductInventorySummary(props: { product?: JsonRecord; rightsCodes: JsonRecord[] }) {
  const isCodePool = props.product ? productFulfillmentMode(props.product) === "code_pool" : false;
  const credentialType = productCredentialType(props.product);
  const stats = rightsCodeStats(props.rightsCodes);
  return (
    <div className="inventory-summary">
      <h4>当前商品发货方式</h4>
      <KeyValue label="发货方式" value={isCodePool ? "自动发库存凭证" : "人工交付"} />
      {isCodePool ? (
        <>
          <KeyValue label="凭证类型" value={credentialTypeText(credentialType)} />
          <KeyValue label="库存总数" value={String(stats.total)} />
          <KeyValue label="可发给客户" value={String(stats.available)} />
          <KeyValue label="已发给客户" value={String(stats.issued)} />
          <KeyValue label="冻结/失效" value={String(stats.unavailable)} />
          <p className="hint">确认收款后按导入时间优先分配可用库存，并自动发给客户。</p>
        </>
      ) : (
        <p className="hint">人工交付商品不走自动发货库存，管理员只维护交付说明和客服处理方式。</p>
      )}
    </div>
  );
}

function ProductProxySummary(props: {
  product: JsonRecord;
  relatedMerchantProducts: JsonRecord[];
  channelRelations: JsonRecord[];
  channelOffers: JsonRecord[];
}) {
  const productId = text(props.product.id);
  const firstTierListings = props.relatedMerchantProducts.filter((item) => {
    const merchant = item.merchant as JsonRecord | undefined;
    return text(merchant?.tier) === "first_tier" || !text(merchant?.tier);
  }).length;
  const secondTierListings = props.relatedMerchantProducts.filter((item) => text((item.merchant as JsonRecord | undefined)?.tier) === "second_tier").length;
  const thirdTierListings = props.relatedMerchantProducts.filter((item) => text((item.merchant as JsonRecord | undefined)?.tier) === "third_tier").length;
  return (
    <div className="proxy-summary">
      <h4>代理链与转供</h4>
      <KeyValue label="M1 可代理" value="平台商品默认可选；M2/M3 必须由上游配置转供价" />
      <KeyValue label="店铺代理" value={`M1 ${firstTierListings} / M2 ${secondTierListings} / M3 ${thirdTierListings}`} />
      <KeyValue label="下游开放" value={props.channelOffers.length ? `${props.channelOffers.length} 条转供价` : "未向下游开放"} />
      <div className="proxy-flow-list">
        {props.channelOffers.length ? props.channelOffers.map((offer) => {
          const relation = props.channelRelations.find((item) => text(item.id) === text(offer.channelRelationId));
          return (
            <div key={`${productId}-${text(offer.id, text(offer.channelRelationId))}`}>
              <span>{relation ? channelRelationLabel(relation) : friendlyId(offer.channelRelationId, "关系")}</span>
              <strong>{cents(offer.resellSupplyPriceCents)}</strong>
              <StatusBadge value={offer.status} />
            </div>
          );
        }) : <p className="hint">未配置转供价时，M2/M3 不应看到这个商品；M1 仍按平台供货价选品。</p>}
      </div>
    </div>
  );
}

function platformProductChangeRows(product: JsonRecord, form: ProductFormState, options: { changedOnly?: boolean } = {}): ConfirmRow[] {
  const rows: ConfirmRow[] = [
    { label: "商品名称", before: text(product.name, "-"), value: form.name || "-" },
    { label: "商品图片", before: text(product.imageUrl, ""), value: form.imageUrl || "", kind: "image" },
    { label: "发货方式", before: productFulfillmentMode(product) === "code_pool" ? "自动发库存凭证" : "人工交付", value: form.fulfillmentMode === "code_pool" ? "自动发库存凭证" : form.fulfillmentMode === "manual" ? "人工交付" : "未选择" },
    { label: "库存", before: text(product.stockCount, "-"), value: form.stockCount || "-" },
    { label: "供货价", before: cents(product.supplyPriceCents), value: cents(form.supplyPriceCents) },
    { label: "最低售价", before: cents(product.minSalePriceCents), value: cents(form.minSalePriceCents) },
    { label: "建议售价", before: cents(product.suggestedSalePriceCents), value: cents(form.suggestedSalePriceCents) },
    { label: "状态", before: statusText(product.status), value: statusText(form.status) },
    { label: "类目", before: text(product.category, "-"), value: form.category || "-" },
    { label: "副标题", before: text(product.subtitle, "-"), value: form.subtitle || "-" }
  ];
  if (productFulfillmentMode(product) === "code_pool" || form.fulfillmentMode === "code_pool") {
    rows.splice(3, 0, { label: "凭证类型", before: credentialTypeText(productCredentialType(product)), value: credentialTypeText(form.credentialType) });
  }
  return options.changedOnly ? rows.filter((row) => normalizeConfirmValue(row.before) !== normalizeConfirmValue(row.value)) : rows;
}

function normalizeConfirmValue(value: string | undefined): string {
  return (value ?? "").trim();
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read file failed"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const [, base64 = ""] = result.split(",", 2);
      if (!base64) reject(new Error("图片读取失败"));
      else resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

function platformProductUpdatePayload(product: JsonRecord, form: ProductFormState): Partial<ProductFormState> {
  const payload: Partial<ProductFormState> = {};
  const add = (key: keyof ProductFormState, before: string, value: string) => {
    if (normalizeConfirmValue(before) !== normalizeConfirmValue(value)) payload[key] = value;
  };
  add("name", text(product.name, ""), form.name);
  add("category", text(product.category, ""), form.category);
  add("tags", Array.isArray(product.tags) ? product.tags.map((item) => text(item, "")).filter(Boolean).join("，") : "", form.tags);
  add("subtitle", text(product.subtitle, ""), form.subtitle);
  add("description", text(product.description, ""), form.description);
  add("usageGuide", text(product.usageGuide, ""), form.usageGuide);
  add("imageUrl", text(product.imageUrl, ""), form.imageUrl);
  add("specs", Array.isArray(product.specs) ? product.specs.map((item) => text(item, "")).filter(Boolean).join("\n") : "", form.specs);
  add("detailSections", formatDetailSections(product.detailSections), form.detailSections);
  add("stockCount", text(product.stockCount, ""), form.stockCount);
  add("soldCount", text(product.soldCount, ""), form.soldCount);
  add("supplyPriceCents", text(product.supplyPriceCents, ""), form.supplyPriceCents);
  add("minSalePriceCents", text(product.minSalePriceCents, ""), form.minSalePriceCents);
  add("suggestedSalePriceCents", text(product.suggestedSalePriceCents, ""), form.suggestedSalePriceCents);
  add("status", text(product.status, ""), form.status);
  const beforeMode = productFulfillmentMode(product);
  if (beforeMode !== form.fulfillmentMode) {
    payload.fulfillmentMode = form.fulfillmentMode;
    if (form.fulfillmentMode === "code_pool") payload.credentialType = form.credentialType;
  } else if (form.fulfillmentMode === "code_pool" && productCredentialType(product) !== form.credentialType) {
    payload.fulfillmentMode = form.fulfillmentMode;
    payload.credentialType = form.credentialType;
  }
  return payload;
}

function ProductChangeSummary(props: { product: JsonRecord; form: ProductFormState }) {
  const rows = platformProductChangeRows(props.product, props.form);
  return (
    <div className="change-summary">
      <h4>保存前核对</h4>
      {rows.map((row) => (
        <div key={row.label}>
          <span>{row.label}</span>
          <strong>{row.kind === "image" ? shortUrl(row.before || "-") : row.before ?? "-"}</strong>
          <em>{row.kind === "image" ? shortUrl(row.value || "-") : row.value}</em>
        </div>
      ))}
    </div>
  );
}

function OrderTodoSummary(props: { orders: JsonRecord[] }) {
  const cards = [
    { label: "待确认到账", value: props.orders.filter((order) => text(order.paymentStatus) !== "paid" && canManuallyConfirmOrder(order)).length, tone: "strong" },
    { label: "待发货", value: props.orders.filter((order) => text(order.paymentStatus) === "paid" && orderFulfillmentStatusKey(order) !== "success").length },
    { label: "发货失败", value: props.orders.filter((order) => orderFulfillmentStatusKey(order) === "failed").length },
    { label: "售后中", value: props.orders.filter((order) => text(order.refundStatus, "none") !== "none").length },
    { label: "今日订单", value: props.orders.filter((order) => isToday(orderCreatedAt(order))).length }
  ];
  return (
    <section className="order-todo-grid" aria-label="订单待办摘要">
      {cards.map((card) => (
        <div className={card.tone === "strong" ? "todo-card strong" : "todo-card"} key={card.label}>
          <span>{card.label}</span>
          <strong>{String(card.value)}</strong>
        </div>
      ))}
    </section>
  );
}

function OrderStatusBadge(props: { value: unknown; type: "payment" | "fulfillment" | "order" }) {
  const raw = text(props.value, "unknown");
  return <span className={`status-badge ${statusTone(raw)}`}>{orderStatusText(raw, props.type)}</span>;
}

function OrdersTable(props: { rows: JsonRecord[]; onPick: (order: JsonRecord) => void; mode?: "select" | "next-action" }) {
  const [draft, setDraft] = useState({
    orderNo: "",
    shop: "",
    product: "",
    startDate: "",
    endDate: "",
    paymentStatus: "",
    fulfillmentStatus: "",
    orderStatus: "",
    paymentProvider: ""
  });
  const [filters, setFilters] = useState(draft);
  const paymentProviderOptions = Array.from(new Set(props.rows.map((order) => orderPaymentProvider(order)).filter(Boolean))).sort();
  const filteredRows = sortOrdersNewestFirst(props.rows).filter((order) => orderMatchesFilters(order, filters));

  function resetSearch() {
    const empty = {
      orderNo: "",
      shop: "",
      product: "",
      startDate: "",
      endDate: "",
      paymentStatus: "",
      fulfillmentStatus: "",
      orderStatus: "",
      paymentProvider: ""
    };
    setDraft(empty);
    setFilters(empty);
  }

  if (props.rows.length === 0) return <p className="empty">暂无记录</p>;
  return (
    <>
      <div className="structured-search order-search" role="search" aria-label="搜索订单">
        <div className="search-help">可按订单号、店铺/商户、商品名称、下单时间、支付状态、发货状态、订单状态和收款方式组合搜索。</div>
        <label>订单号
          <input value={draft.orderNo} onChange={(event) => setDraft({ ...draft, orderNo: event.target.value })} placeholder="输入订单号" />
        </label>
        <label>店铺/商户
          <input value={draft.shop} onChange={(event) => setDraft({ ...draft, shop: event.target.value })} placeholder="店铺名、店铺ID、商户ID" />
        </label>
        <label>商品名称
          <input value={draft.product} onChange={(event) => setDraft({ ...draft, product: event.target.value })} placeholder="输入商品名称" />
        </label>
        <label>开始时间
          <input type="date" value={draft.startDate} onChange={(event) => setDraft({ ...draft, startDate: event.target.value })} />
        </label>
        <label>结束时间
          <input type="date" value={draft.endDate} onChange={(event) => setDraft({ ...draft, endDate: event.target.value })} />
        </label>
        <label>支付状态
          <select value={draft.paymentStatus} onChange={(event) => setDraft({ ...draft, paymentStatus: event.target.value })}>
            <option value="">全部支付状态</option>
            <option value="unpaid">待付款</option>
            <option value="paid">已支付</option>
            <option value="failed">支付失败</option>
          </select>
        </label>
        <label>发货状态
          <select value={draft.fulfillmentStatus} onChange={(event) => setDraft({ ...draft, fulfillmentStatus: event.target.value })}>
            <option value="">全部发货状态</option>
            <option value="pending">待发货</option>
            <option value="processing">发货中</option>
            <option value="success">发货成功</option>
            <option value="failed">发货失败</option>
          </select>
        </label>
        <label>订单状态
          <select value={draft.orderStatus} onChange={(event) => setDraft({ ...draft, orderStatus: event.target.value })}>
            <option value="">全部订单状态</option>
            <option value="pending">待处理</option>
            <option value="completed">已完成</option>
            <option value="aftersale">售后中</option>
            <option value="failed">异常/失败</option>
          </select>
        </label>
        <label>收款方式
          <select value={draft.paymentProvider} onChange={(event) => setDraft({ ...draft, paymentProvider: event.target.value })}>
            <option value="">全部收款方式</option>
            {paymentProviderOptions.map((provider) => <option key={provider} value={provider}>{paymentProviderName(provider)}</option>)}
          </select>
        </label>
        <div className="search-actions">
          <button type="button" onClick={() => setFilters(draft)}>搜索</button>
          <button className="secondary" type="button" onClick={resetSearch}>重置</button>
        </div>
        <span className="search-count">共 {props.rows.length} 笔，当前显示 {filteredRows.length} 笔</span>
      </div>
      {filteredRows.length === 0 ? <p className="empty">没有符合条件的订单</p> : (
        <>
          <div className="table-wrap orders-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>下单时间</th>
                  <th>订单号</th>
                  <th>店铺</th>
                  <th>商品</th>
                  <th>金额</th>
                  <th>收款方式</th>
                  <th>支付状态</th>
                  <th>发货状态</th>
                  <th>订单状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((order) => (
                  <tr key={text(order.orderNo)}>
                    <td>{orderTimeLabel(order)}</td>
                    <td>{text(order.orderNo)}</td>
                    <td>{orderShopLabel(order)}</td>
                    <td>{orderProductLabel(order)}</td>
                    <td>{cents(amountOf(order))}</td>
                    <td>{orderPaymentMethodLabel(order)}</td>
                    <td><OrderStatusBadge value={order.paymentStatus} type="payment" /></td>
                    <td><OrderStatusBadge value={order.fulfillmentStatus} type="fulfillment" /></td>
                    <td><OrderStatusBadge value={order.status} type="order" /></td>
                    <td><button className="small" type="button" onClick={() => props.onPick(order)}>{props.mode === "next-action" ? orderActionLabel(order) : "查看"}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mobile-card-list" aria-label="订单卡片列表">
            {filteredRows.map((order) => (
              <article className="mobile-data-card" key={`mobile-${text(order.orderNo)}`}>
                <div className="mobile-card-head">
                  <strong>{text(order.orderNo)}</strong>
                  <OrderStatusBadge value={order.paymentStatus} type="payment" />
                </div>
                <div className="card-facts">
                  <span><b>下单时间</b>{orderTimeLabel(order)}</span>
                  <span><b>店铺</b>{orderShopLabel(order)}</span>
                  <span><b>商品</b>{orderProductLabel(order)}</span>
                  <span><b>金额</b>{cents(amountOf(order))}</span>
                  <span><b>收款方式</b>{orderPaymentMethodLabel(order)}</span>
                  <span><b>发货</b><OrderStatusBadge value={order.fulfillmentStatus} type="fulfillment" /></span>
                  <span><b>订单状态</b><OrderStatusBadge value={order.status} type="order" /></span>
                </div>
                <div className="card-actions">
                  <button className="small" type="button" onClick={() => props.onPick(order)}>{props.mode === "next-action" ? orderActionLabel(order) : "查看"}</button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function orderActionLabel(order: JsonRecord): string {
  if (text(order.refundStatus, "none") !== "none") return "处理售后";
  if (text(order.paymentStatus) !== "paid") return canManuallyConfirmOrder(order) ? "确认到账" : "看支付状态";
  if (text(order.fulfillmentStatus) !== "success") return "去发货";
  return "查看订单";
}

function orderMatchesFilters(order: JsonRecord, filters: {
  orderNo: string;
  shop: string;
  product: string;
  startDate: string;
  endDate: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  orderStatus: string;
  paymentProvider: string;
}): boolean {
  if (!includesKeyword([order.orderNo, order.id], filters.orderNo)) return false;
  if (!includesKeyword([orderShopLabel(order), order.shopId, order.merchantId], filters.shop)) return false;
  if (!includesKeyword([orderProductLabel(order), orderProductId(order)], filters.product)) return false;
  const createdAt = orderCreatedAt(order);
  if (filters.startDate && (!createdAt || createdAt < startOfDay(filters.startDate))) return false;
  if (filters.endDate && (!createdAt || createdAt > endOfDay(filters.endDate))) return false;
  if (filters.paymentStatus && orderPaymentStatusKey(order) !== filters.paymentStatus) return false;
  if (filters.fulfillmentStatus && orderFulfillmentStatusKey(order) !== filters.fulfillmentStatus) return false;
  if (filters.orderStatus && orderBusinessStatusKey(order) !== filters.orderStatus) return false;
  if (filters.paymentProvider && orderPaymentProvider(order) !== filters.paymentProvider) return false;
  return true;
}

function includesKeyword(values: unknown[], keyword: string): boolean {
  const normalized = keyword.trim().toLowerCase();
  if (!normalized) return true;
  return values.map((item) => cellText(item).toLowerCase()).join(" ").includes(normalized);
}

function orderPaymentStatusKey(order: JsonRecord): string {
  const status = text(order.paymentStatus, "");
  if (status === "paid") return "paid";
  if (status === "failed") return "failed";
  return "unpaid";
}

function orderFulfillmentStatusKey(order: JsonRecord): string {
  const status = text(order.fulfillmentStatus, "");
  if (status === "success" || status === "fulfilled") return "success";
  if (status === "failed") return "failed";
  if (status === "processing" || status === "fulfilling") return "processing";
  return "pending";
}

function orderBusinessStatusKey(order: JsonRecord): string {
  if (text(order.refundStatus, "none") !== "none") return "aftersale";
  if (orderPaymentStatusKey(order) === "failed" || orderFulfillmentStatusKey(order) === "failed") return "failed";
  if (orderPaymentStatusKey(order) === "paid" && orderFulfillmentStatusKey(order) === "success") return "completed";
  return "pending";
}

function orderStatusText(value: unknown, type: "payment" | "fulfillment" | "order"): string {
  const raw = text(value, "");
  if (type === "payment") {
    if (raw === "paid") return "已支付";
    if (raw === "failed") return "支付失败";
    return "待付款";
  }
  if (type === "fulfillment") {
    if (raw === "success" || raw === "fulfilled") return "发货成功";
    if (raw === "failed") return "发货失败";
    if (raw === "processing" || raw === "fulfilling") return "发货中";
    return "未发货";
  }
  if (raw === "success" || raw === "fulfilled" || raw === "completed") return "已完成";
  if (raw === "failed") return "异常/失败";
  if (raw === "closed" || raw === "cancelled") return "已关闭";
  return humanValue(raw, "待处理");
}

function OwnProductReviewTable(props: { rows: JsonRecord[]; onPick: (row: JsonRecord) => void }) {
  const [draft, setDraft] = useState({
    keyword: "",
    category: "",
    minPriceYuan: "",
    maxPriceYuan: "",
    reviewStatus: ""
  });
  const [filters, setFilters] = useState(draft);
  const categories = Array.from(new Set(props.rows.map((row) => text(row.category)).filter(Boolean))).sort();
  const filteredRows = props.rows.filter((row) => {
    const keyword = filters.keyword.trim().toLowerCase();
    if (keyword) {
      const haystack = [row.name, row.ownProductId, row.id, row.merchantId, row.shopId, row.category]
        .map((item) => cellText(item).toLowerCase())
        .join(" ");
      if (!haystack.includes(keyword)) return false;
    }
    if (filters.category && text(row.category) !== filters.category) return false;
    const salePriceCents = Number(row.salePriceCents ?? 0);
    const minPriceCents = yuanInputToCents(filters.minPriceYuan);
    const maxPriceCents = yuanInputToCents(filters.maxPriceYuan);
    if (minPriceCents !== undefined && salePriceCents < minPriceCents) return false;
    if (maxPriceCents !== undefined && salePriceCents > maxPriceCents) return false;
    const reviewStatus = text(row.reviewStatus, text(row.status));
    if (filters.reviewStatus === "completed" && reviewStatus === "pending_review") return false;
    if (filters.reviewStatus && filters.reviewStatus !== "completed" && reviewStatus !== filters.reviewStatus) return false;
    return true;
  });

  function resetSearch() {
    const empty = { keyword: "", category: "", minPriceYuan: "", maxPriceYuan: "", reviewStatus: "" };
    setDraft(empty);
    setFilters(empty);
  }

  return (
    <>
      <div className="structured-search" role="search" aria-label="搜索商户自有商品审核">
        <div className="search-help">可按商品名称、商品编号、商户、类目、售价范围和审核状态组合搜索。</div>
        <label>商品名称/编号
          <input value={draft.keyword} onChange={(event) => setDraft({ ...draft, keyword: event.target.value })} placeholder="例如 商品名、own-1、merchant-2" />
        </label>
        <label>商品类目
          <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
            <option value="">全部类目</option>
            {categories.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </label>
        <label>最低售价(元)
          <input inputMode="decimal" value={draft.minPriceYuan} onChange={(event) => setDraft({ ...draft, minPriceYuan: event.target.value })} placeholder="例如 30" />
        </label>
        <label>最高售价(元)
          <input inputMode="decimal" value={draft.maxPriceYuan} onChange={(event) => setDraft({ ...draft, maxPriceYuan: event.target.value })} placeholder="例如 100" />
        </label>
        <label>审核状态
          <select value={draft.reviewStatus} onChange={(event) => setDraft({ ...draft, reviewStatus: event.target.value })}>
            <option value="">全部状态</option>
            <option value="pending_review">待审核</option>
            <option value="completed">已审核完成</option>
            <option value="approved">已通过</option>
            <option value="rejected">已拒绝</option>
          </select>
        </label>
        <div className="search-actions">
          <button type="button" onClick={() => setFilters(draft)}>搜索</button>
          <button className="secondary" type="button" onClick={resetSearch}>重置</button>
        </div>
        <span className="search-count">共 {props.rows.length} 条，当前显示 {filteredRows.length} 条</span>
      </div>
      <Table
        rows={ownProductReviewRows(filteredRows)}
        columns={["id", "name", "category", "merchantTier", "salePriceCents", "minSalePriceCents", "fulfillmentMode", "reviewStatus", "reviewedAt", "reviewedBy"]}
        moneyColumns={["salePriceCents", "minSalePriceCents"]}
        onPick={(row) => {
          const source = props.rows.find((item) => text(item.id) === text(row.id)) ?? row;
          props.onPick(source);
        }}
        hideSearch
      />
    </>
  );
}

function PlatformShopProductTable(props: { rows: JsonRecord[]; onPick: (row: JsonRecord) => void }) {
  const [draft, setDraft] = useState({
    keyword: "",
    status: "",
    minSaleYuan: "",
    maxSaleYuan: ""
  });
  const [filters, setFilters] = useState(draft);

  const filteredRows = props.rows.filter((row) => {
    const keyword = filters.keyword.trim().toLowerCase();
    if (keyword) {
      const matched = ["productName", "platformProductId", "id", "shopName"].some((column) =>
        cellText(row[column]).toLowerCase().includes(keyword)
      );
      if (!matched) return false;
    }
    if (filters.status && text(row.status) !== filters.status) return false;
    const salePriceCents = Number(row.salePriceCents ?? 0);
    const minSaleCents = yuanInputToCents(filters.minSaleYuan);
    const maxSaleCents = yuanInputToCents(filters.maxSaleYuan);
    if (minSaleCents !== undefined && salePriceCents < minSaleCents) return false;
    if (maxSaleCents !== undefined && salePriceCents > maxSaleCents) return false;
    return true;
  });

  function resetSearch() {
    const empty = { keyword: "", status: "", minSaleYuan: "", maxSaleYuan: "" };
    setDraft(empty);
    setFilters(empty);
  }

  return (
    <>
      <div className="structured-search" role="search" aria-label="搜索平台自营商品">
        <div className="search-help">可按商品名称、商品编号、自营编号、店铺名称、销售状态、售价范围组合搜索。</div>
        <label>商品名称/编号
          <input
            value={draft.keyword}
            onChange={(event) => setDraft({ ...draft, keyword: event.target.value })}
            placeholder="例如 Claude、psp-code、prod-code"
          />
        </label>
        <label>销售状态
          <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
            <option value="">全部状态</option>
            <option value="listed">上架销售</option>
            <option value="approved">审核通过未上架</option>
            <option value="delisted">下架</option>
            <option value="risk_removed">风控下架</option>
          </select>
        </label>
        <label>最低售价(元)
          <input
            inputMode="decimal"
            value={draft.minSaleYuan}
            onChange={(event) => setDraft({ ...draft, minSaleYuan: event.target.value })}
            placeholder="例如 30"
          />
        </label>
        <label>最高售价(元)
          <input
            inputMode="decimal"
            value={draft.maxSaleYuan}
            onChange={(event) => setDraft({ ...draft, maxSaleYuan: event.target.value })}
            placeholder="例如 100"
          />
        </label>
        <div className="search-actions">
          <button type="button" onClick={() => setFilters(draft)}>搜索</button>
          <button className="secondary" type="button" onClick={resetSearch}>重置</button>
        </div>
        <span className="search-count">共 {props.rows.length} 条，当前显示 {filteredRows.length} 条</span>
      </div>
      <Table
        rows={filteredRows}
        columns={["id", "platformProductId", "productName", "shopName", "salePriceCents", "fulfillmentCostCents", "status"]}
        moneyColumns={["salePriceCents", "fulfillmentCostCents"]}
        onPick={props.onPick}
        hideSearch
      />
    </>
  );
}

type RightsCodeFilters = { productId?: string; orderNo?: string; status?: string };

function RightsCodeTable(props: {
  rows: JsonRecord[];
  showSensitiveCodes: boolean;
  sensitiveRows: JsonRecord[];
  canReveal?: boolean;
  loading?: boolean;
  hideActions?: boolean;
  onExportMasked?: (rows: JsonRecord[]) => void;
  onReveal?: (filters: RightsCodeFilters) => void;
  onExportPlain?: (filters: RightsCodeFilters) => void;
}) {
  const [draft, setDraft] = useState({ query: "", productId: "", status: "", batchNo: "", orderNo: "" });
  const [filters, setFilters] = useState(draft);
  const displayRows = props.showSensitiveCodes ? props.sensitiveRows : props.rows;
  const productOptions = Array.from(new Set(props.rows.map((row) => rightsCodeProductId(row)).filter(Boolean))).sort();
  const productLabels = new Map<string, string>();
  for (const row of props.rows) {
    const productId = rightsCodeProductId(row);
    if (productId && !productLabels.has(productId)) productLabels.set(productId, relatedName(row, "product", "name") || productId);
  }
  const statusOptions = Array.from(new Set(props.rows.map((row) => text(row.status)).filter(Boolean))).sort();
  const filteredRows = displayRows.filter((row) => {
    const query = filters.query.trim().toLowerCase();
    const productId = rightsCodeProductId(row);
    const haystack = [
      row.codeId,
      row.id,
      row.productId,
      row.platformProductId,
      row.merchantProductId,
      relatedName(row, "product", "name"),
      row.batchNo,
      row.status,
      humanValue(row.status),
      row.orderNo,
      credentialTypeText(row.credentialType),
      row.codePreview,
      row.code
    ].map((value) => text(value).toLowerCase()).join(" ");
    if (query && !haystack.includes(query)) return false;
    if (filters.productId && productId !== filters.productId) return false;
    if (filters.status && text(row.status) !== filters.status) return false;
    if (filters.batchNo.trim() && !text(row.batchNo).toLowerCase().includes(filters.batchNo.trim().toLowerCase())) return false;
    if (filters.orderNo.trim() && !text(row.orderNo).toLowerCase().includes(filters.orderNo.trim().toLowerCase())) return false;
    return true;
  });
  const apiFilters: RightsCodeFilters = {
    productId: filters.productId || undefined,
    status: filters.status || undefined,
    orderNo: filters.orderNo.trim() || undefined
  };
  const columns = props.showSensitiveCodes
    ? ["codeId", "productCode", "credentialLabel", "batchNo", "status", "orderNo", "code"]
    : ["codeId", "productCode", "credentialLabel", "codePreview", "batchNo", "status", "orderNo"];
  const tableRows = filteredRows.map((row) => ({
    ...row,
    codeId: text(row.codeId, text(row.id)),
    productCode: rightsCodeProductId(row),
    credentialLabel: credentialTypeText(row.credentialType),
    orderNo: text(row.orderNo, "未绑定订单")
  }));

  function resetSearch() {
    const empty = { query: "", productId: "", status: "", batchNo: "", orderNo: "" };
    setDraft(empty);
    setFilters(empty);
  }

  return (
    <>
      <div className="structured-search" role="search" aria-label="搜索自动发货库存">
        <div className="search-help">可按商品编号、库存编号、内容预览、凭证类型、批次号、订单号和库存状态组合搜索。</div>
        <label>关键词
          <input
            value={draft.query}
            onChange={(event) => setDraft({ ...draft, query: event.target.value })}
            placeholder="例如 prod-code、CODE-001、订单号、批次号"
          />
        </label>
        <label>所属商品
          <select value={draft.productId} onChange={(event) => setDraft({ ...draft, productId: event.target.value })}>
            <option value="">全部商品</option>
            {productOptions.map((productId) => <option key={productId} value={productId}>{productLabels.get(productId) ?? productId}</option>)}
          </select>
        </label>
        <label>库存状态
          <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
            <option value="">全部状态</option>
            {statusOptions.map((status) => <option key={status} value={status}>{statusText(status)}</option>)}
          </select>
        </label>
        <label>批次号
          <input value={draft.batchNo} onChange={(event) => setDraft({ ...draft, batchNo: event.target.value })} placeholder="例如 batch-202606" />
        </label>
        <label>订单号
          <input value={draft.orderNo} onChange={(event) => setDraft({ ...draft, orderNo: event.target.value })} placeholder="例如 order-1001" />
        </label>
        <div className="search-actions">
          <button type="button" onClick={() => setFilters(draft)}>搜索</button>
          <button className="secondary" type="button" onClick={resetSearch}>重置</button>
        </div>
        <span className="search-count">共 {displayRows.length} 条，当前显示 {filteredRows.length} 条</span>
      </div>
      {props.hideActions ? null : (
        <div className="actions">
          <button className="secondary" disabled={props.loading || filteredRows.length === 0} onClick={() => props.onExportMasked?.(filteredRows)}>导出库存核对表</button>
          <button className="secondary" disabled={props.loading || !props.canReveal || displayRows.length === 0} onClick={() => props.onReveal?.(apiFilters)}>查看完整库存内容</button>
          <button className="secondary" disabled={props.loading || !props.canReveal || displayRows.length === 0} onClick={() => props.onExportPlain?.(apiFilters)}>下载完整库存表</button>
        </div>
      )}
      <Table rows={tableRows} columns={columns} hideSearch />
    </>
  );
}

function Table(props: { rows: JsonRecord[]; columns: string[]; moneyColumns?: string[]; onPick?: (row: JsonRecord) => void; hideSearch?: boolean }) {
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
      {props.hideSearch ? null : (
        <div className="table-tools">
          <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="输入关键词筛选本表格" />
          <span>共 {filteredRows.length} 条</span>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {props.onPick ? <th>操作</th> : null}
              {props.columns.map((column) => <th key={column}>{fieldLabel(column)}</th>)}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, index) => (
              <tr key={`${props.columns.map((column) => text(row[column])).join("-")}-${index}`}>
                {props.onPick ? <td><button className="small" type="button" onClick={() => props.onPick?.(row)}>查看</button></td> : null}
                {props.columns.map((column) => (
                  <td key={column} className={isIdLikeColumn(column) ? "muted-id" : undefined}>
                    {moneyColumns.has(column) ? cents(row[column]) : humanCell(row, column)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mobile-card-list" aria-label="移动端表格卡片">
        {pageRows.map((row, index) => {
          const titleColumn = props.columns.find((column) => !isIdLikeColumn(column) && cellText(row[column])) ?? props.columns[0];
          return (
            <article className="mobile-data-card" key={`mobile-${props.columns.map((column) => text(row[column])).join("-")}-${index}`}>
              <div className="mobile-card-head">
                <strong>{cellText(row[titleColumn]) || "未命名记录"}</strong>
                {props.onPick ? <button className="small" type="button" onClick={() => props.onPick?.(row)}>查看</button> : null}
              </div>
              <div className="card-facts">
                {props.columns.map((column) => (
                  <span key={column}>
                    <b>{fieldLabel(column)}</b>
                    {moneyColumns.has(column) ? cents(row[column]) : humanCell(row, column)}
                  </span>
                ))}
              </div>
            </article>
          );
        })}
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

function yuanInputToCents(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return undefined;
  return Math.round(amount * 100);
}

function dateTimeText(value: unknown): string {
  const raw = text(value);
  if (!raw) return "-";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function fieldLabel(column: string): string {
  return fieldLabels[column] ?? column.replace(/([A-Z])/g, " $1").trim();
}

function humanValue(value: unknown, fallback = "未填写"): string {
  const raw = cellText(value);
  if (!raw) return fallback;
  return valueLabels[raw] ?? raw;
}

function statusText(value: unknown): string {
  return humanValue(value, "未设置");
}

function shortUrl(value: string): string {
  if (!value || value === "-") return "-";
  return value.length > 46 ? `${value.slice(0, 24)}...${value.slice(-14)}` : value;
}

function dataBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true" || value === "yes" || value === "1";
  return fallback;
}

function humanCell(row: JsonRecord, column: string): string {
  const value = row[column];
  if (column === "shopId") return relatedName(row, "shop", "name") || friendlyId(value, "店铺");
  if (column === "merchantId") return relatedName(row, "merchant", "name") || friendlyId(value, "商户");
  if (column === "productId" || column === "platformProductId" || column === "merchantProductListingId" || column === "ownProductId") {
    return relatedName(row, "product", "name") || relatedName(row, "platformProduct", "name") || friendlyId(value, "商品");
  }
  if (column === "userId") return friendlyId(value, "买家");
  if (column === "id" || isIdLikeColumn(column)) return friendlyId(value, "编号");
  if (column.toLowerCase().includes("status") || column === "fulfillmentMode" || column === "provider" || column === "ownerType" || column === "targetTier") {
    return humanValue(value);
  }
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map((item) => humanValue(item, "")).filter(Boolean).join("、");
  return humanValue(value, "");
}

function relatedName(row: JsonRecord, relationKey: string, nameKey: string): string {
  const relation = row[relationKey] as JsonRecord | undefined;
  return text(relation?.[nameKey], "");
}

function isIdLikeColumn(column: string): boolean {
  return column === "id" || column.endsWith("Id") || column.endsWith("No") || column === "codeId" || column === "targetId" || column === "sourceId";
}

function friendlyId(value: unknown, label = "编号"): string {
  const raw = text(value, "");
  if (!raw) return "未返回";
  if (raw.length <= 14) return raw;
  return `${label}...${raw.slice(-6)}`;
}

function orderShopLabel(order?: JsonRecord): string {
  const snapshot = order?.snapshot as JsonRecord | undefined;
  const shopSnapshot = snapshot?.shopSnapshot as JsonRecord | undefined;
  return text(shopSnapshot?.name, friendlyId(order?.shopId, "店铺"));
}

function orderProductLabel(order?: JsonRecord): string {
  const snapshot = order?.snapshot as JsonRecord | undefined;
  const productSnapshot = snapshot?.productSnapshot as JsonRecord | undefined;
  return text(productSnapshot?.name, text(snapshot?.productNameSnapshot, friendlyId(orderProductId(order), "商品")));
}

function orderProductId(order?: JsonRecord): string {
  const snapshot = order?.snapshot as JsonRecord | undefined;
  const productSnapshot = snapshot?.productSnapshot as JsonRecord | undefined;
  return text(productSnapshot?.id, text(order?.productId, text(snapshot?.productId, "")));
}

function orderCustomerLabel(order?: JsonRecord): string {
  return friendlyId(order?.userId, "客户");
}

function orderCreatedAt(order?: JsonRecord): Date | undefined {
  const snapshot = order?.snapshot as JsonRecord | undefined;
  const raw = text(order?.createdAt, text(snapshot?.createdAt, ""));
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function orderTimeLabel(order?: JsonRecord): string {
  return dateTimeText(text(order?.createdAt, text((order?.snapshot as JsonRecord | undefined)?.createdAt, "")));
}

function sortOrdersNewestFirst(rows: JsonRecord[]): JsonRecord[] {
  return [...rows].sort((left, right) => {
    const leftTime = orderCreatedAt(left)?.getTime() ?? 0;
    const rightTime = orderCreatedAt(right)?.getTime() ?? 0;
    if (rightTime !== leftTime) return rightTime - leftTime;
    return text(right.orderNo).localeCompare(text(left.orderNo));
  });
}

function startOfDay(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

function endOfDay(value: string): Date {
  return new Date(`${value}T23:59:59.999`);
}

function isToday(value?: Date): boolean {
  if (!value) return false;
  const now = new Date();
  return value.getFullYear() === now.getFullYear() && value.getMonth() === now.getMonth() && value.getDate() === now.getDate();
}

function statusTone(value: string): string {
  if (["paid", "success", "fulfilled", "active", "approved", "open", "available", "enabled", "processed"].includes(value)) return "good";
  if (["pending", "pending_review", "pending_payment", "unpaid", "not_started", "processing", "fulfilling", "refunding", "created", "paying", "pending_manual_confirmation"].includes(value)) return "todo";
  if (["rejected", "failed", "disabled", "frozen", "refunded", "voided", "voided_after_refund"].includes(value)) return "warn";
  return "neutral";
}

function amountOf(order?: JsonRecord): string {
  if (order?.paidAmountCents) return text(order.paidAmountCents, "0");
  const snapshot = order?.snapshot as JsonRecord | undefined;
  const amount = snapshot?.amountSnapshot as JsonRecord | undefined;
  return text(amount?.paidAmountCents, "0");
}

function paymentMethodLabel(order?: JsonRecord): string {
  const method = order?.paymentMethod as JsonRecord | undefined;
  if (method) {
    return [method.displayName, humanValue(method.provider, ""), friendlyId(method.id, "方式")].map((item) => text(item, "")).filter(Boolean).join(" / ");
  }
  const snapshot = order?.snapshot as JsonRecord | undefined;
  const methodSnapshot = order?.paymentMethodSnapshot as JsonRecord | undefined
    ?? snapshot?.paymentMethodSnapshot as JsonRecord | undefined
    ?? order?.paymentSnapshot as JsonRecord | undefined
    ?? snapshot?.paymentSnapshot as JsonRecord | undefined;
  if (methodSnapshot) {
    return [methodSnapshot.displayName, humanValue(methodSnapshot.provider, ""), friendlyId(methodSnapshot.id, "方式")].map((item) => text(item, "")).filter(Boolean).join(" / ");
  }
  return friendlyId(order?.paymentMethodId ?? snapshot?.paymentMethodId, "方式");
}

function orderPaymentProvider(order?: JsonRecord): string {
  const paymentClient = order?.paymentClient as JsonRecord | undefined;
  const paymentSnapshot = order?.paymentSnapshot as JsonRecord | undefined
    ?? paymentClient?.paymentSnapshot as JsonRecord | undefined;
  const methodSnapshot = order?.paymentMethodSnapshot as JsonRecord | undefined;
  return text(paymentClient?.provider, text(paymentSnapshot?.provider, text(methodSnapshot?.provider, "")));
}

function isPersonalPaymentProvider(provider: string): boolean {
  return provider === "personal_alipay" || provider === "alipay_personal" || provider.includes("personal");
}

function isOfficialPaymentProvider(provider: string): boolean {
  return provider === "alipay_merchant" || provider === "wechat_merchant" || provider === "epay";
}

function canManuallyConfirmOrder(order?: JsonRecord): boolean {
  if (!order || text(order.paymentStatus) === "paid") return false;
  const provider = orderPaymentProvider(order);
  if (isPersonalPaymentProvider(provider)) return true;
  if (isOfficialPaymentProvider(provider)) return false;
  return !provider;
}

function orderPaymentMethodLabel(order?: JsonRecord): string {
  const provider = orderPaymentProvider(order);
  if (provider) return paymentProviderName(provider);
  const channel = paymentMethodLabel(order);
  return channel === "未返回" ? "未选择收款方式" : channel;
}

function orderNextStep(order?: JsonRecord): string {
  if (!order) return "先选择订单";
  if (text(order.refundStatus, "none") !== "none") return "处理售后/退款";
  if (text(order.paymentStatus) === "paid" && text(order.fulfillmentStatus) !== "success") return "已收款，去发货";
  if (text(order.paymentStatus) === "paid") return "已完成收款";
  const provider = orderPaymentProvider(order);
  if (isPersonalPaymentProvider(provider) || !provider) return "确认个人收款是否到账";
  return "等待回调，必要时主动查单";
}

function orderNextStepHint(order?: JsonRecord): string {
  if (!order) return "从订单列表选择一笔订单后再处理。";
  if (text(order.refundStatus, "none") !== "none") return "这笔订单已经进入售后流程，请到售后退款模块处理拆账、审批和退款。";
  if (text(order.paymentStatus) === "paid" && text(order.fulfillmentStatus) !== "success") return "款项已经确认，可以进入发货管理处理自动发货或人工交付。";
  if (text(order.paymentStatus) === "paid") return "这笔订单已完成收款，后续只需要关注售后和结算状态。";
  const provider = orderPaymentProvider(order);
  if (isPersonalPaymentProvider(provider) || !provider) return "个人支付宝订单必须确认真实到账后再点确认。";
  return "平台 e支付、支付宝商户和微信商户订单以官方回调或主动查单为准。";
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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("收款码图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function csvCell(value: unknown): string {
  const raw = cellText(value).replaceAll("\"", "\"\"");
  return `"${raw}"`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMerchantSession(session: BackendSession | undefined): session is MerchantSession {
  return Boolean(session && "merchant" in session && "shop" in session);
}

function sessionLabel(session: BackendSession): string {
  if (isMerchantSession(session)) return text(session.merchant.displayName, text(session.merchant.username, "商户"));
  return text(session.admin.displayName, text(session.admin.adminRole, "admin"));
}

function shopShareUrl(shopId: string, shop?: JsonRecord): string {
  const publicPath = text(shop?.publicPath, "");
  if (!shopId && !publicPath) return "";
  const configured = text(import.meta.env.VITE_H5_BASE_URL, "").replace(/\/+$/, "");
  const base = configured || localH5BaseUrl();
  if (publicPath) return `${base}${publicPath.startsWith("/") ? publicPath : `/${publicPath}`}`;
  return `${base}/s/${encodeURIComponent(shopId)}`;
}

function localH5BaseUrl(): string {
  if (window.location.port === "5173") {
    return `${window.location.protocol}//${window.location.hostname}:5174`;
  }
  return window.location.origin;
}

function merchantProductRows(rows: JsonRecord[]): JsonRecord[] {
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

function platformShopProductRows(rows: JsonRecord[]): JsonRecord[] {
  return rows.map((row) => {
    const product = row.product as JsonRecord | undefined;
    const shop = row.shop as JsonRecord | undefined;
    return {
      id: row.id,
      platformProductId: row.platformProductId,
      productName: product?.name,
      shopName: shop?.name,
      salePriceCents: row.salePriceCents,
      fulfillmentCostCents: row.fulfillmentCostCents,
      status: row.status
    };
  });
}

function ownProductReviewRows(rows: JsonRecord[]): JsonRecord[] {
  return rows.map((row) => {
    const merchant = row.merchant as JsonRecord | undefined;
    return {
      ...row,
      id: text(row.id, text(row.ownProductId)),
      category: text(row.category, "未填写"),
      merchantTier: humanValue(text(merchant?.tier, text(row.merchantTier, "-")), "-"),
      fulfillmentMode: text(row.fulfillmentMode, productFulfillmentMode(row)),
      reviewStatus: text(row.reviewStatus, text(row.status, "pending_review")),
      reviewedAt: text(row.reviewedAt) ? dateTimeText(row.reviewedAt) : "-",
      reviewedBy: text(row.reviewedBy, "-")
    };
  });
}

function fulfillmentModeLabel(rule: unknown): string {
  const record = isRecord(rule) ? rule : {};
  return text(record.mode) === "code_pool" ? "自动发库存凭证" : "人工交付";
}

function productFulfillmentMode(product?: JsonRecord): "code_pool" | "manual" {
  const explicitMode = text(product?.fulfillmentMode);
  if (explicitMode === "code_pool" || explicitMode === "manual") return explicitMode;
  const rule = isRecord(product?.fulfillmentRule) ? product?.fulfillmentRule as JsonRecord : {};
  return text(rule.mode) === "code_pool" ? "code_pool" : "manual";
}

type CredentialType = "code" | "account_password";

function productCredentialType(product?: JsonRecord): CredentialType {
  const rule = isRecord(product?.fulfillmentRule) ? product?.fulfillmentRule as JsonRecord : {};
  const value = text(product?.credentialType, text(rule.credentialType));
  return value === "account_password" ? "account_password" : "code";
}

function credentialTypeText(value: unknown): string {
  return text(value) === "account_password" ? "账号密码" : "兑换码/卡密";
}

function credentialInputLabel(type: CredentialType): string {
  return type === "account_password" ? "账号密码清单" : "兑换码/卡密";
}

function credentialInputPlaceholder(type: CredentialType): string {
  return type === "account_password"
    ? "每行一组：账号,密码,备注；备注可选"
    : "一行一个兑换码或卡密，例如 CARD-EXAMPLE-001";
}

function rightsCodeStats(rows: JsonRecord[]) {
  const available = rows.filter((item) => text(item.status) === "available").length;
  const issued = rows.filter((item) => ["issued", "used"].includes(text(item.status))).length;
  return {
    total: rows.length,
    available,
    issued,
    unavailable: Math.max(0, rows.length - available - issued)
  };
}

function rightsCodeProductId(row: JsonRecord): string {
  return text(row.productId, text(row.platformProductId, text(row.merchantProductId, "")));
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

function channelRelationLabel(relation: JsonRecord): string {
  const first = friendlyId(relation.firstTierMerchantId, "M1");
  const second = friendlyId(relation.secondTierMerchantId, "M2");
  const third = text(relation.thirdTierMerchantId, "");
  return third ? `${first} -> ${second} -> ${friendlyId(third, "M3")}` : `${first} -> ${second}`;
}

function formatDetailSections(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const section = isRecord(item) ? item : {};
    const title = text(section.title, "");
    const items = Array.isArray(section.items) ? section.items.map((entry) => text(entry, "")).filter(Boolean) : [];
    return [title, ...items].filter(Boolean).join("：");
  }).filter(Boolean).join("\n");
}

function depositStatusRows(rows: JsonRecord[]): Array<{ label: string; value: string }> {
  const statuses = ["paid", "pending_payment", "pending_review", "partially_deducted", "insufficient", "deducted", "unknown"];
  return statuses.map((status) => ({
    label: status,
    value: String(rows.filter((row) => text(row.status, "unknown") === status).length)
  }));
}

function paymentOverviewRows(methodsRows: JsonRecord[], exceptions: JsonRecord[]): JsonRecord[] {
  const methods = [
    { key: "alipay_merchant", method: "支付宝商户", confirmMode: "回调/查单自动确认" },
    { key: "wechat_merchant", method: "腾讯/微信商户", confirmMode: "回调/查单自动确认" },
    { key: "epay", method: "e支付/xpay/虎皮椒", confirmMode: "回调/查单自动确认" },
    { key: "personal_alipay", method: "个人支付宝", confirmMode: "人工确认" },
    { key: "wechat_personal", method: "个人微信", confirmMode: "人工确认" },
    { key: "balance", method: "余额支付", confirmMode: "余额扣款自动确认" }
  ];
  return methods.map((item) => {
    const matchedMethods = methodsRows.filter((method) => text(method.provider) === item.key);
    const enabled = item.key === "balance" || matchedMethods.some((method) => method.enabled === true && ["enabled", "active"].includes(text(method.status)));
    return {
      key: item.key,
      method: item.method,
      enabled: enabled ? "已启用" : "未启用",
      defaultMethod: matchedMethods.some((method) => method.isDefault === true) ? "是" : "否",
      confirmMode: item.confirmMode,
      secretStatus: ["personal_alipay", "wechat_personal", "balance"].includes(item.key) ? "不需要密钥" : paymentKeyStatusText(matchedMethods[0]),
      lastCallback: text(matchedMethods[0]?.lastCallbackAt, "暂无"),
      exceptionCount: exceptions.filter((exception) => text(exception.provider) === item.key).length
    };
  });
}

function paymentMethodRows(methods: JsonRecord[]): JsonRecord[] {
  return methods.map((method) => ({
    id: method.id,
    method: paymentProviderName(text(method.provider)),
    ownerType: method.ownerType,
    displayName: method.displayName,
    merchant: text(method.merchantNoMasked, text(method.accountName, "-")),
    confirmMode: ["manual", "manual_confirm"].includes(text(method.confirmationMode)) ? "人工确认" : "回调/查单自动确认",
    enabled: method.enabled === true && ["enabled", "active"].includes(text(method.status)) ? "已启用" : humanValue(method.status, "未启用"),
    isDefault: method.isDefault === true ? "是" : "否",
    keyStatus: paymentKeyStatusText(method),
    lastTestResult: humanValue(method.lastTestResult, "未测试"),
    lastCallbackAt: text(method.lastCallbackAt, "暂无")
  }));
}

function paymentDisputeMaterialRows(rows: JsonRecord[]): JsonRecord[] {
  return rows.map((row) => ({
    ...row,
    channel: paymentProviderName(text(row.channel, text(row.provider, ""))),
    status: humanValue(row.status),
    voucherUrl: text(row.voucherUrl, "无"),
    reviewedBy: row.reviewedBy ? friendlyId(row.reviewedBy, "审核人") : "-"
  }));
}

function paymentCallbackRows(callbacks: JsonRecord[]): JsonRecord[] {
  return callbacks.map((callback) => ({
    source: paymentProviderName(text(callback.provider)),
    orderNo: callback.orderNo,
    tradeNo: text(callback.providerTradeNo, "-"),
    notifiedAt: text(callback.receivedAt, text(callback.createdAt, "-")),
    signature: humanValue(callback.signatureStatus, humanValue(callback.status, "-")),
    amountCheck: humanValue(callback.amountCheck, text(callback.amountCents, "-")),
    idempotency: humanValue(callback.idempotencyStatus, text(callback.status, "-")),
    errorReason: text(callback.errorReason, text(callback.reasonCode, "-"))
  }));
}

function paymentExceptionRows(exceptions: JsonRecord[]): JsonRecord[] {
  return exceptions.map((exception) => ({
    id: exception.id,
    type: paymentProviderName(text(exception.provider)),
    orderNo: exception.orderNo,
    amountCents: exception.amountCents,
    status: exception.handled === true ? "已处理" : "待处理",
    reason: text(exception.reasonCode, text(exception.reason, "异常")),
    maskedPayload: text(exception.maskedPayload, "已脱敏"),
    handled: exception.handled === true ? "是" : "否",
    note: text(exception.note, "-")
  }));
}

function paymentMethodEnabled(methods: JsonRecord[], provider: string): boolean {
  return methods.some((method) => text(method.provider) === provider && method.enabled === true && ["enabled", "active"].includes(text(method.status)));
}

function paymentMethodEnabledText(method?: JsonRecord): string {
  if (!method) return "未配置";
  if (method.enabled === true && ["enabled", "active"].includes(text(method.status))) return "已启用";
  if (method.enabled === true) return humanValue(method.status, "已保存，未启用");
  return "已停用";
}

function paymentMethodPlainHint(method: string, enabled: string, exceptionCount: string): string {
  if (method === "个人支付宝" || method === "个人微信") {
    return enabled === "已启用" ? "买家扫码后，后台人工确认真实到账。" : "可作为备用收款方式，需要人工确认。";
  }
  if (method === "余额支付") return "买家使用账户余额扣款，默认不收手续费。";
  const exceptionText = Number(exceptionCount) > 0 ? `，当前有 ${exceptionCount} 条异常` : "";
  return enabled === "已启用" ? `靠回调或查单确认支付${exceptionText}。` : "填好商户资料并测试通过后再启用。";
}

function paymentMethodFormInput(form: {
  provider: string;
  displayName: string;
  accountName: string;
  qrUrl: string;
  paymentUrl: string;
  productType: string;
  merchantNo: string;
  appId: string;
  serviceProviderId: string;
  gatewayUrl: string;
  apiMode: string;
  returnUrl: string;
  note: string;
  signingSecret: string;
  privateKey: string;
  publicKey: string;
  certificate: string;
  enabled: boolean;
  isDefault: boolean;
}, id?: string): PaymentMethodInput {
  return {
    id,
    provider: form.provider,
    displayName: form.displayName,
    productType: form.productType || undefined,
    merchantNo: form.merchantNo || undefined,
    appId: form.appId || undefined,
    serviceProviderId: form.serviceProviderId || undefined,
    gatewayUrl: form.gatewayUrl || undefined,
    apiMode: (["mapi_first", "hupijiao_direct"].includes(form.apiMode) ? form.apiMode : "submit") as PaymentMethodInput["apiMode"],
    accountName: form.accountName || undefined,
    qrUrl: form.qrUrl || undefined,
    paymentUrl: form.paymentUrl || undefined,
    note: form.note || undefined,
    returnUrl: form.returnUrl || undefined,
    enabled: form.enabled,
    isDefault: form.isDefault,
    signingSecret: form.signingSecret || undefined,
    privateKey: form.privateKey || undefined,
    publicKey: form.publicKey || undefined,
    certificate: form.certificate || undefined
  };
}

function paymentMethodToForm(method?: JsonRecord) {
  return {
    provider: text(method?.provider, ""),
    displayName: text(method?.displayName, ""),
    accountName: text(method?.accountName, ""),
    qrUrl: text(method?.qrUrl, ""),
    paymentUrl: text(method?.paymentUrl, ""),
    productType: text(method?.productType, ""),
    merchantNo: text(method?.merchantNoMasked, ""),
    appId: text(method?.appIdMasked, ""),
    serviceProviderId: text(method?.serviceProviderMasked, ""),
    gatewayUrl: text(method?.gatewayUrl, ""),
    apiMode: text(method?.apiMode, "submit"),
    returnUrl: text(method?.returnUrl, ""),
    note: text(method?.note, ""),
    signingSecret: "",
    privateKey: "",
    publicKey: "",
    certificate: "",
    enabled: method?.enabled === true,
    isDefault: method?.isDefault === true
  };
}

function paymentProviderName(provider: string): string {
  if (provider === "alipay_merchant") return "支付宝商户";
  if (provider === "wechat_merchant") return "腾讯/微信商户";
  if (provider === "epay") return "e支付/xpay/虎皮椒";
  if (provider === "personal_alipay" || provider === "alipay_personal") return "个人支付宝";
  if (provider === "wechat_personal") return "个人微信";
  if (provider === "balance") return "余额支付";
  if (provider === "alipay_wap") return "支付宝";
  if (provider === "wechat_h5" || provider === "wechat_h5_jsapi") return "微信支付";
  return provider || "未知收款方式";
}

function paymentKeyStatusText(method?: JsonRecord): string {
  if (!method) return "未配置";
  if (["personal_alipay", "wechat_personal", "balance"].includes(text(method.provider))) return "不需要密钥";
  const keyStatus = isRecord(method.keyStatus) ? method.keyStatus : {};
  const fields = [
    ["signingSecret", "签名密钥"],
    ["privateKey", "私钥"],
    ["publicKey", "公钥"],
    ["certificate", "证书"]
  ] as const;
  const configured = fields.filter(([key]) => text(keyStatus[key]) === "configured").map(([, label]) => label);
  if (configured.length === 0) return "未配置";
  return `${configured.join("、")}已配置`;
}

function paymentProviderTypeName(type: string): string {
  if (type.startsWith("alipay_merchant")) return "支付宝商户";
  if (type.startsWith("wechat_merchant")) return "腾讯/微信商户";
  if (type.startsWith("epay")) return "e支付/xpay/虎皮椒";
  if (type.startsWith("alipay_personal") || type === "personal_alipay") return "个人支付宝";
  if (type.startsWith("wechat_personal")) return "个人微信";
  if (type === "balance") return "余额支付";
  return "其它收款";
}

function paymentProviderConfirmMode(type: string): string {
  if (type.startsWith("alipay_personal") || type === "personal_alipay" || type.startsWith("wechat_personal")) return "人工确认";
  if (type === "balance") return "余额扣款";
  if (type.startsWith("alipay_merchant") || type.startsWith("wechat_merchant") || type.startsWith("epay")) return "回调/查单自动确认";
  return "后台确认";
}

function validatePlatformProductForm(form: {
  name: string;
  imageUrl?: string;
  fulfillmentMode: string;
  stockCount: string;
  soldCount: string;
  supplyPriceCents: string;
  minSalePriceCents: string;
  suggestedSalePriceCents: string;
}): string {
  if (!form.name.trim()) return "请填写商品名称";
  if (form.imageUrl?.startsWith("data:image/")) return "商品图片不能直接保存 data:image。请点击图片重新上传，系统会生成 /uploads/product-images/... 地址。";
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
  if (codes.length === 0) return "请填写至少一条自动发货库存";
  return "";
}

function precheckRightsCodes(value: string, credentialType = "code"): RightsCodePrecheckResult {
  const lines = value.split(/\n/);
  const seen = new Set<string>();
  const validCodes: string[] = [];
  const duplicateCodes: string[] = [];
  const blankLines: number[] = [];
  const invalidRows: Array<{ line: number; value: string; reason: string }> = [];
  for (const [index, raw] of lines.entries()) {
    const lineNo = index + 1;
    const code = raw.trim();
    if (!code) {
      blankLines.push(lineNo);
      continue;
    }
    if (credentialType === "account_password") {
      const [account = "", password = ""] = splitCredentialInputLine(code);
      if (!account.trim() || !password.trim()) {
        invalidRows.push({ line: lineNo, value: code, reason: "账号密码每行必须按“账号,密码,备注”填写，备注可选" });
        continue;
      }
    }
    if (code.length < 3 || code.length > 500) {
      invalidRows.push({ line: lineNo, value: code, reason: "长度需为 3-500 个字符" });
      continue;
    }
    if (seen.has(code)) {
      duplicateCodes.push(code);
      continue;
    }
    seen.add(code);
    validCodes.push(code);
  }
  return {
    totalLines: lines.length,
    validCodes,
    blankLines,
    duplicateCodes,
    invalidRows
  };
}

function splitCredentialInputLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && (char === "," || char === "\t")) {
      values.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current);
  return values;
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

function validateManualMerchantForm(form: {
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

function requiresActionConfirmation(label: string): boolean {
  return /保存|提交|确认|到账|启用|停用|退款|审核|导入|导出|查看卡密|发货|创建|扣减|冻结|打款|查单|标记/.test(label);
}

function groupedNav(merchantSessionActive = false) {
  const visibleItems = merchantSessionActive
    ? navItems.filter((item) => !["merchants", "risk"].includes(item.id))
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

const adminRootElement = document.getElementById("root")!;
const adminRuntime = globalThis as typeof globalThis & { __tosellAdminRoot?: ReturnType<typeof createRoot> };
adminRuntime.__tosellAdminRoot ??= createRoot(adminRootElement);
adminRuntime.__tosellAdminRoot.render(<App />);

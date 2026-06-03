import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, cents, text, type AuthSession, type JsonRecord } from "./api.js";
import "./styles.css";

type CheckoutState = {
  product: JsonRecord;
  quote: JsonRecord;
  coupons: JsonRecord[];
  couponId?: string;
};

type MerchantRegisterForm = {
  inviteCode: string;
  name: string;
  shopName: string;
  contactPhone: string;
  customerServiceWechat: string;
};

const orderTabs = ["全部", "待支付", "已支付", "售后"] as const;
type OrderTab = (typeof orderTabs)[number];
const defaultShopId = "default";
const storeAiLogoSrc = "/brand/ai-store-logo.png";

type PaymentGuideState = {
  order: JsonRecord;
  payment: JsonRecord;
  channel?: JsonRecord;
};

type RechargeGuideState = {
  recharge: JsonRecord;
  channel?: JsonRecord;
};

function currentShopId() {
  const path = window.location.pathname;
  const match = path.match(/^\/s\/([^/]+)/);
  return match?.[1] ?? new URLSearchParams(window.location.search).get("shopId") ?? "default";
}

function shopHref(shopId?: string, shop?: JsonRecord) {
  const publicPath = text(shop?.publicPath);
  if (publicPath) return publicPath;
  return shopId && shopId !== "default" ? `/s/${shopId}` : "/";
}

function App() {
  if (window.location.pathname.startsWith("/extract")) {
    return <ExtractionPage />;
  }
  if (window.location.pathname.startsWith("/user/register")) {
    return <UserRegisterPage />;
  }
  if (window.location.pathname.startsWith("/merchant/register")) {
    return <MerchantRegisterPage />;
  }

  const initialShopId = currentShopId();
  if (!initialShopId) {
    return <ShopLinkRequiredPage />;
  }

  const [shopId, setShopId] = useState(initialShopId);
  const [shop, setShop] = useState<JsonRecord>({});
  const [products, setProducts] = useState<JsonRecord[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<JsonRecord[]>([]);
  const [wallet, setWallet] = useState<JsonRecord | undefined>();
  const [rechargeAmount, setRechargeAmount] = useState("10000");
  const [orderPayments, setOrderPayments] = useState<Record<string, JsonRecord>>({});
  const [userCoupons, setUserCoupons] = useState<JsonRecord[]>([]);
  const [orders, setOrders] = useState<JsonRecord[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<JsonRecord | undefined>();
  const [detailProduct, setDetailProduct] = useState<JsonRecord | undefined>();
  const [detailCoupons, setDetailCoupons] = useState<JsonRecord[]>([]);
  const [detailCouponId, setDetailCouponId] = useState("");
  const [checkout, setCheckout] = useState<CheckoutState | undefined>();
  const [selectedOrder, setSelectedOrder] = useState<JsonRecord | undefined>();
  const [paymentGuide, setPaymentGuide] = useState<PaymentGuideState | undefined>();
  const [rechargeGuide, setRechargeGuide] = useState<RechargeGuideState | undefined>();
  const [afterSaleOrder, setAfterSaleOrder] = useState<JsonRecord | undefined>();
  const [supportMaterialOrder, setSupportMaterialOrder] = useState<JsonRecord | undefined>();
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState("");
  const [orderTab, setOrderTab] = useState<OrderTab>("全部");
  const [message, setMessage] = useState("正在打开店铺");
  const [loading, setLoading] = useState(false);
  const [afterSaleReason, setAfterSaleReason] = useState("权益无法正常使用");
  const [afterSaleDescription, setAfterSaleDescription] = useState("请协助核实权益使用情况");
  const [extractionCode, setExtractionCode] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [category, setCategory] = useState("全部");
  const [extractOrder, setExtractOrder] = useState<JsonRecord | undefined>();
  const [extractInput, setExtractInput] = useState("");
  const [extractResult, setExtractResult] = useState<JsonRecord | undefined>();
  const [auth, setAuth] = useState<AuthSession | undefined>(() => api.currentSession());
  const [showLogin, setShowLogin] = useState(false);
  const [showNotice, setShowNotice] = useState(() => localStorage.getItem("tosell_notice_ack") !== "true");
  const [loginPhone, setLoginPhone] = useState("");
  const [loginName, setLoginName] = useState("");
  const [orderQuery, setOrderQuery] = useState("");
  const [paymentVoucherForm, setPaymentVoucherForm] = useState({
    channel: "",
    payerName: "",
    voucherUrl: "",
    note: ""
  });

  const theme = useMemo(() => ({ "--brand": text(shop.themeColor, "#106270") }) as React.CSSProperties, [shop.themeColor]);
  const featured = products[0];
  const activeProduct = selectedProduct ?? featured;
  const categories = useMemo(() => ["全部", ...Array.from(new Set(products.map((item) => text(productRecord(item).category, "")).filter(Boolean)))], [products]);
  const visibleProducts = useMemo(() => products.filter((item) => {
    const keyword = searchKeyword.trim().toLowerCase();
    const matchesCategory = category === "全部" || text(productRecord(item).category) === category;
    if (!matchesCategory) return false;
    if (!keyword) return true;
    const haystack = [
      productName(item),
      productIntro(item),
      text(productRecord(item).category),
      productTags(item).join(" ")
    ].join(" ").toLowerCase();
    return haystack.includes(keyword);
  }), [products, category, searchKeyword]);
  const filteredOrders = orders.filter((order) => belongsToShop(order, shopId)).filter((order) => {
    if (orderTab === "待支付") return text(order.paymentStatus) === "unpaid";
    if (orderTab === "已支付") return text(order.paymentStatus) === "paid" && text(order.refundStatus, "none") === "none";
    if (orderTab === "售后") return text(order.refundStatus, "none") !== "none";
    return true;
  });

  async function load(targetShopId = shopId) {
    setLoading(true);
    try {
      const session = api.currentSession();
      const [nextShop, nextProducts, nextPaymentMethods] = await Promise.all([
        api.shop(targetShopId),
        api.products(targetShopId),
        api.paymentMethods(targetShopId)
      ]);
      const resolvedShopId = text(nextShop.id, targetShopId);
      setShopId(resolvedShopId);
      setShop(nextShop);
      setProducts(nextProducts);
      setPaymentMethods(nextPaymentMethods);
      setSelectedPaymentMethodId((current) =>
        nextPaymentMethods.some((item) => text(item.id) === current)
          ? current
          : defaultPaymentMethodId(nextPaymentMethods, wallet)
      );
      setSelectedProduct((current) => current ?? nextProducts[0]);
      setOrders([]);
      setAuth(session);
      if (session) {
        void refreshUserState(resolvedShopId);
      } else {
        setUserCoupons([]);
      }
      setMessage("店铺已准备好");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "店铺加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function refreshUserState(resolvedShopId = shopId) {
    try {
      const [nextOrders, nextWallet, nextCoupons] = await Promise.all([
        api.orders().catch(() => [] as JsonRecord[]),
        api.wallet().catch(() => undefined),
        api.coupons(resolvedShopId).catch(() => [] as JsonRecord[])
      ]);
      setWallet(nextWallet);
      setUserCoupons(nextCoupons);
      setOrders(nextOrders.filter((order) => belongsToShop(order, resolvedShopId)));
    } catch {
      // User-specific data must not block browsing the shop catalog.
    }
  }

  async function submitPhoneLogin() {
    try {
      const phone = loginPhone.trim();
      if (!phone) {
        setMessage("请输入手机号后再注册或登录。");
        return;
      }
      setLoading(true);
      const session = await api.authRegister(phone, loginName.trim() || undefined);
      api.saveSession(session);
      setAuth(session);
      setShowLogin(false);
      setMessage(session.grantedCoupon ? "注册成功，平台赠券已发放" : "登录成功");
      await load(shopId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "注册或登录失败");
    } finally {
      setLoading(false);
    }
  }

  async function continueAsGuest() {
    try {
      setLoading(true);
      const session = await api.authGuest();
      api.saveSession(session);
      setAuth(session);
      setShowLogin(false);
      setMessage("已以游客身份继续");
      await load(shopId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "游客登录失败");
    } finally {
      setLoading(false);
    }
  }

  async function ensureAuth(): Promise<boolean> {
    const session = api.currentSession();
    if (session) {
      setAuth(session);
      return true;
    }
    setShowLogin(true);
    setMessage("请先登录或以游客身份继续，订单会绑定到服务端账号。");
    return false;
  }

  useEffect(() => {
    if (!["/", "/index.html"].includes(window.location.pathname) && !window.location.pathname.startsWith("/s/") && shopId) {
      window.history.replaceState(null, "", `/s/${shopId}${window.location.hash}`);
    }
    void load(shopId);
  }, []);

  useEffect(() => {
    if (!checkout) return undefined;
    let stopped = false;
    const refreshWallet = async () => {
      try {
        const nextWallet = await api.wallet();
        if (!stopped) setWallet(nextWallet);
      } catch {
        // Wallet polling is best-effort; the checkout can still use external payment.
      }
    };
    void refreshWallet();
    const timer = window.setInterval(() => void refreshWallet(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [checkout]);

  async function openShop(targetShopId: string) {
    setShopId(targetShopId);
    setSelectedProduct(undefined);
    setDetailProduct(undefined);
      setCheckout(undefined);
      setSelectedOrder(undefined);
      setAfterSaleOrder(undefined);
      setSupportMaterialOrder(undefined);
      setSelectedPaymentMethodId("");
      setExtractOrder(undefined);
      setExtractResult(undefined);
      setOrders([]);
    window.history.replaceState(null, "", shopHref(targetShopId));
    await load(targetShopId);
  }

  function acknowledgeNotice() {
    localStorage.setItem("tosell_notice_ack", "true");
    setShowNotice(false);
  }

  async function startCheckout(product: JsonRecord, preferredCouponId?: string) {
    try {
      setLoading(true);
      const productId = text(product.id);
      const [detail, coupons, nextWallet] = await Promise.all([
        api.product(productId),
        api.coupons(shopId, productId),
        api.wallet().catch(() => wallet)
      ]);
      const preferredCoupon = coupons.find((coupon) => text(coupon.id) === preferredCouponId && text(coupon.status) === "available" && coupon.applicable !== false);
      const couponId = text(preferredCoupon?.id, text(coupons.find((coupon) => text(coupon.status) === "available" && coupon.applicable !== false)?.id, ""));
      const quote = await api.quote(shopId, productId, couponId || undefined);
      setWallet(nextWallet);
      setSelectedProduct(detail);
      setCheckout({ product: detail, quote, coupons, couponId: couponId || undefined });
      setSelectedPaymentMethodId(defaultPaymentMethodId(paymentMethods, nextWallet, orderPayableAmount(quote)));
      setExtractionCode("");
      setBuyerPhone("");
      setBuyerEmail("");
      setMessage("请确认订单信息");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "报价失败");
    } finally {
      setLoading(false);
    }
  }

  async function openProductDetail(product: JsonRecord) {
    try {
      setLoading(true);
      const productId = text(product.id);
      const [detail, coupons] = await Promise.all([
        api.product(productId),
        api.coupons(shopId, productId).catch(() => [])
      ]);
      const couponId = text(coupons.find((coupon) => text(coupon.status) === "available" && coupon.applicable !== false)?.id, "");
      setSelectedProduct(detail);
      setDetailProduct(detail);
      setDetailCoupons(coupons);
      setDetailCouponId(couponId);
      setMessage("商品详情已加载");
    } catch (error) {
      setSelectedProduct(product);
      setDetailProduct(product);
      setDetailCoupons([]);
      setDetailCouponId("");
      setMessage(error instanceof Error ? error.message : "商品详情加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function updateCheckoutCoupon(couponId: string) {
    if (!checkout) return;
    try {
      setLoading(true);
      const nextCouponId = couponId || undefined;
      const quote = await api.quote(shopId, text(checkout.product.id), nextCouponId);
      setCheckout({ ...checkout, couponId: nextCouponId, quote });
      setSelectedPaymentMethodId(defaultPaymentMethodId(paymentMethods, wallet, orderPayableAmount(quote)));
      setMessage(nextCouponId ? "优惠券已应用，金额已由后端重新计算" : "已取消使用优惠券");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "优惠券不可用");
    } finally {
      setLoading(false);
    }
  }

  async function submitOrder() {
    if (!checkout) return;
    if (!await ensureAuth()) return;
    if (loading) return;
    const needsPurchasePassword = requiresProductExtractionCode(checkout.product);
    if (needsPurchasePassword && !isValidPurchasePassword(extractionCode)) {
      setMessage("请设置 4-32 位购买密码。");
      return;
    }
    if (needsPurchasePassword && !isMainlandChinaMobile(buyerPhone)) {
      setMessage("请填写有效的中国大陆手机号，用于卡密商品订单核验。");
      return;
    }
    if (buyerEmail.trim() && !isValidEmail(buyerEmail)) {
      setMessage("请填写有效邮箱地址，或清空邮箱后继续下单。");
      return;
    }
    try {
      setLoading(true);
      const paymentMethodId = effectivePaymentMethodId(paymentMethods, selectedPaymentMethodId, wallet, orderPayableAmount(checkout.quote));
      const order = await api.createOrder(
        shopId,
        text(checkout.product.id),
          orderPayableAmount(checkout.quote),
          {
          purchasePassword: requiresProductExtractionCode(checkout.product) ? extractionCode.trim() : undefined,
          couponId: checkout.couponId,
          buyerEmail: buyerEmail.trim() || undefined,
          buyerPhone: needsPurchasePassword ? buyerPhone.trim() : undefined,
          paymentMethodId
        }
      );
      let payment: JsonRecord | undefined;
      try {
        payment = await api.createPayment(text(order.orderNo), paymentMethodId);
      } catch (error) {
        setMessage(error instanceof Error ? `订单已创建，支付单创建失败：${error.message}` : "订单已创建，支付单创建失败");
      }
      const orderWithPayment = payment ? attachPayment(order, payment) : order;
      updateOrders((current) => upsertOrder(current, orderWithPayment));
      if (payment) {
        setOrderPayments((current) => ({ ...current, [text(order.orderNo)]: payment }));
      }
      const selectedChannel = selectedPaymentMethod(paymentMethods, paymentMethodId);
      setCheckout(undefined);
      if (payment && isPersonalPayment(payment, selectedChannel)) {
        setSelectedOrder(undefined);
        setPaymentGuide({ order: orderWithPayment, payment, channel: selectedChannel });
      } else if (payment && isOfficialPayment(payment, selectedChannel)) {
        const openResult = openOfficialPayment(payment);
        if (openResult === "submitted") {
          setMessage("支付信息已生成，正在提交到 e支付收银台。");
          return;
        }
        if (openResult === "redirected") {
          setMessage("支付信息已生成，正在打开支付平台。");
          return;
        }
        setSelectedOrder(orderWithPayment);
        setMessage("支付方式没有返回可跳转链接，请联系商户检查后台支付配置。");
      } else {
        setSelectedOrder(orderWithPayment);
      }
      if (payment) {
        setMessage(paymentStatusMessage(payment));
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "下单失败");
    } finally {
      setLoading(false);
    }
  }

  function showCollection(order: JsonRecord) {
    setSelectedOrder(order);
    setMessage(`订单 ${text(order.orderNo)} 待收款确认，请按页面金额付款，付款后等待后台确认。`);
  }

  async function refreshOrderStatus(order: JsonRecord) {
    const orderNo = text(order.orderNo);
    if (!orderNo) return;
    try {
      setLoading(true);
      const nextOrder = await api.order(orderNo);
      updateOrders((current) => upsertOrder(current, nextOrder));
      setSelectedOrder((current) => current && text(current.orderNo) === orderNo ? nextOrder : current);
      setPaymentGuide((current) => current && text(current.order.orderNo) === orderNo ? { ...current, order: nextOrder } : current);
      setMessage(text(nextOrder.paymentStatus) === "paid" ? "订单已确认收款，请查看卡密或等待交付。" : "订单还在等待确认收款。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "刷新订单失败");
    } finally {
      setLoading(false);
    }
  }

  function copyServiceContact() {
    const wechat = text(shop.customerServiceWechat);
    const qq = text(shop.customerServiceQq, text(shop.customerServiceQQ, text(shop.qq)));
    const contact = wechat || qq;
    if (!contact) {
      setMessage("当前店铺还没有配置客服联系方式。");
      return;
    }
    void navigator.clipboard?.writeText(contact);
    setMessage(wechat ? "客服微信已复制。" : "客服 QQ 已复制。");
  }

  async function createOrderPayment(order: JsonRecord) {
    const orderNo = text(order.orderNo);
    if (!orderNo) return;
    try {
      setLoading(true);
      const payment = await api.createPayment(orderNo, selectedPaymentMethodId || undefined);
      const nextOrder = attachPayment(order, payment);
      setOrderPayments((current) => ({ ...current, [orderNo]: payment }));
      updateOrders((current) => upsertOrder(current, nextOrder));
      setSelectedOrder(nextOrder);
      const selectedChannel = selectedPaymentMethod(paymentMethods, selectedPaymentMethodId);
      if (isOfficialPayment(payment, selectedChannel)) {
        const openResult = openOfficialPayment(payment);
        if (openResult === "submitted") {
          setMessage("支付信息已生成，正在提交到 e支付收银台。");
          return;
        }
        if (openResult === "redirected") {
          setMessage("支付信息已生成，正在打开支付平台。");
          return;
        }
        setMessage("支付方式没有返回可跳转链接，请联系商户检查后台支付配置。");
        return;
      }
      setMessage(paymentStatusMessage(payment));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "支付单创建失败");
    } finally {
      setLoading(false);
    }
  }

  async function createRecharge() {
    if (!canRecharge(auth)) {
      setShowLogin(true);
      setMessage("请先用手机号注册或登录，登录后才能充值余额。");
      return;
    }
    if (!isPositiveInteger(rechargeAmount)) {
      setMessage("请输入正确的充值金额");
      return;
    }
    try {
      setLoading(true);
      const channelId = defaultRechargePaymentMethodId(paymentMethods, selectedPaymentMethodId) || undefined;
      const recharge = await api.createWalletRecharge(rechargeAmount, channelId);
      const channel = selectedPaymentMethod(paymentMethods, text(recharge.paymentMethodId, channelId ?? ""));
      setRechargeGuide({ recharge, channel });
      setMessage(`充值单已生成，应付 ${cents(text(recharge.payableCents, rechargeAmount))}，付款后等待后台确认到账。`);
      setWallet(await api.wallet());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "充值失败");
    } finally {
      setLoading(false);
    }
  }

  function openPaymentVoucher(order: JsonRecord) {
    const channel = inferPaymentVoucherChannel(selectedPaymentMethod(paymentMethods, selectedPaymentMethodId));
    setPaymentVoucherForm({
      channel,
      payerName: "",
      voucherUrl: "",
      note: ""
    });
    setSupportMaterialOrder(order);
  }

  async function submitPaymentVoucher() {
    if (!supportMaterialOrder) return;
    if (!paymentVoucherForm.voucherUrl.trim() && !paymentVoucherForm.note.trim()) {
      setMessage("请填写异常材料 URL 或备注，便于客服核实。");
      return;
    }
    try {
      setLoading(true);
      const voucher = await api.submitPaymentVoucher(text(supportMaterialOrder.orderNo), {
        channel: paymentVoucherForm.channel || undefined,
        payerName: paymentVoucherForm.payerName.trim() || undefined,
        voucherUrl: paymentVoucherForm.voucherUrl.trim() || undefined,
        note: paymentVoucherForm.note.trim() || undefined
      });
      updateOrders((current) => upsertOrder(current, {
        ...supportMaterialOrder,
        disputeMaterialStatus: text(voucher.status, "pending_review"),
        paymentVoucherId: text(voucher.id, "")
      }));
      setSupportMaterialOrder(undefined);
      setMessage(`异常材料已提交：${text(voucher.id, "待核实")}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "异常材料提交失败");
    } finally {
      setLoading(false);
    }
  }

  async function findOrder() {
    const orderNo = orderQuery.trim();
    if (!orderNo) {
      setMessage("请输入订单号。");
      return;
    }
    try {
      setLoading(true);
      const order = await api.order(orderNo);
      if (!belongsToShop(order, shopId)) {
        setMessage("该订单不属于当前店铺。");
        return;
      }
      updateOrders((current) => upsertOrder(current, order));
      setSelectedOrder(order);
      setMessage("订单已找回。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单找回失败");
    } finally {
      setLoading(false);
    }
  }

  async function openOrderDetail(order: JsonRecord) {
    setSelectedOrder(order);
    const orderNo = text(order.orderNo, "");
    if (!orderNo) return;
    try {
      setLoading(true);
      const detail = await api.order(orderNo);
      updateOrders((current) => upsertOrder(current, detail));
      setSelectedOrder(detail);
      setMessage("订单详情已刷新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "订单详情刷新失败");
    } finally {
      setLoading(false);
    }
  }

  async function afterSale() {
    if (!afterSaleOrder) return;
    if (loading) return;
    if (text(afterSaleOrder.refundStatus, "none") !== "none") {
      setMessage("该订单已进入售后或退款流程，不能重复申请。");
      return;
    }
    try {
      setLoading(true);
      await api.createAfterSale(text(afterSaleOrder.orderNo), orderPaidAmount(afterSaleOrder), `${afterSaleReason}：${afterSaleDescription}`);
      updateOrders((current) => upsertOrder(current, { ...afterSaleOrder, refundStatus: "requested", afterSaleReason, afterSaleDescription }));
      setAfterSaleOrder(undefined);
      setMessage(`售后已提交：${text(afterSaleOrder.orderNo)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "售后提交失败");
    } finally {
      setLoading(false);
    }
  }

  async function submitExtract() {
    if (!extractOrder) return;
    if (loading) return;
    if (text(extractOrder.refundStatus, "none") !== "none") {
      setMessage("订单已进入售后或退款流程，不能查看卡密。");
      return;
    }
    try {
      setLoading(true);
      const result = await api.extractOrder(text(extractOrder.orderNo), extractInput.trim());
      setExtractResult(result);
      setMessage("卡密提取成功");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "卡密提取失败");
    } finally {
      setLoading(false);
    }
  }

  function updateOrders(updater: (current: JsonRecord[]) => JsonRecord[]) {
    setOrders(updater);
  }

  return (
    <main className="page" style={theme}>
      <header className="store-top">
        <button type="button" className="brand-link" onClick={() => void openShop(shopId)}>
          <span className="brand-logo"><img src={storeAiLogoSrc} alt="" /></span>
          <strong>{text(shop.name, "ToSell")}</strong>
        </button>
        <nav aria-label="店铺导航">
          <a href="#mall">商城</a>
          <a href="#orders">查询订单</a>
          <a href="/user/register">用户注册</a>
          <a href="/merchant/register">商户入驻</a>
          <button type="button" className="nav-button" onClick={() => setShowNotice(true)}>购买须知</button>
        </nav>
        <button type="button" className="ghost" onClick={() => setShowLogin(true)}>{auth ? "账号" : "登录"}</button>
      </header>

      <section className="shop-shell">
        <div className="shop-main">
          <section className="shop-hero">
            <div className="hero-copy">
              <span>{text(shop.ownerType) === "platform" ? "平台自营" : "认证小店"}</span>
              <h1>{text(shop.name, "ToSell 店铺")}</h1>
              <p>{text(shop.shareTitle, text(shop.announcement, "精选虚拟权益，即买即用，售后可查。"))}</p>
              <div className="hero-actions">
                <button type="button" onClick={() => activeProduct && void startCheckout(activeProduct)}>立即购买</button>
                <a href="#mall">查看商品</a>
              </div>
            </div>
            <div className="hero-visual" aria-hidden="true">
              <ImageWithFallback src={text(shop.bannerUrl)} alt="" fallback={<StoreLogoVisual />} />
            </div>
          </section>

          <section className="announcement">
            <span>店铺公告</span>
            <p>{text(shop.announcement, "购买虚拟账号、卡密或会员权益前，请确认商品说明、发放方式和售后规则。")}</p>
            <ul>
              <li>自动发码商品购买时设置购买密码，后台确认收款后可在订单详情查看卡密。</li>
              <li>人工交付商品请添加本店客服领取账号或权益。</li>
              <li>遇到发放超时或无法使用，可在订单中心提交售后。</li>
            </ul>
          </section>
        </div>

        <aside className="shop-side desktop-side">
          <AccountPanel
            auth={auth}
            coupons={userCoupons}
            orders={filteredOrders}
            wallet={wallet}
            channels={paymentMethods}
            rechargeAmount={rechargeAmount}
            selectedRechargeChannelId={defaultRechargePaymentMethodId(paymentMethods, selectedPaymentMethodId)}
            loading={loading}
            onRechargeAmountChange={setRechargeAmount}
            onSelectRechargeChannel={setSelectedPaymentMethodId}
            onRecharge={() => void createRecharge()}
            onLogin={() => setShowLogin(true)}
            onLogout={() => {
              api.logout();
              setAuth(undefined);
              setMessage("已退出登录");
            }}
          />

          <section className="service">
            <ServiceContact shop={shop} />
          </section>
        </aside>
      </section>

      <section className="trust-bar" aria-label="服务承诺">
        <div><i aria-hidden="true">卡</i><strong>虚拟权益</strong><span>账号/卡密/会员</span></div>
        <div><i aria-hidden="true">发</i><strong>发放清晰</strong><span>自动或人工</span></div>
        <div><i aria-hidden="true">单</i><strong>订单可查</strong><span>支付履约留痕</span></div>
        <div><i aria-hidden="true">保</i><strong>售后保障</strong><span>未履约可处理</span></div>
      </section>

      {loading || (message && message !== "正在打开店铺" && message !== "店铺已准备好") ? (
        <div className={loading ? "notice loading" : "notice"}>{message}</div>
      ) : null}

      <section className="catalog-tools" id="mall" aria-label="商品筛选">
        <label>
          <span>搜索</span>
          <input value={searchKeyword} onChange={(event) => setSearchKeyword(event.target.value)} placeholder="商品名、类目、标签" />
        </label>
        <div className="category-tabs" role="list" aria-label="商品分类">
          {categories.map((item) => (
            <button type="button" role="listitem" key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>{item}</button>
          ))}
        </div>
      </section>

      <section className="grid">
        {visibleProducts.length === 0 ? <p className="empty">当前筛选暂无商品</p> : visibleProducts.map((item) => (
          <ProductCard
            key={text(item.id)}
            item={item}
            active={text(item.id) === text(activeProduct?.id)}
            onDetail={() => void openProductDetail(item)}
            onBuy={() => void startCheckout(item)}
          />
        ))}
      </section>

      <section className="orders" id="orders">
        <div className="orders-head">
          <div>
            <span>订单中心</span>
            <h2>我的订单</h2>
          </div>
          <div className="tabs">
            {orderTabs.map((tab) => <button type="button" className={orderTab === tab ? "active" : ""} key={tab} onClick={() => setOrderTab(tab)}>{tab}</button>)}
          </div>
        </div>
        <div className="order-query">
          <input value={orderQuery} onChange={(event) => setOrderQuery(event.target.value)} placeholder="输入订单号找回当前账号订单" />
          <button type="button" className="ghost" disabled={loading || !orderQuery.trim()} onClick={() => void findOrder()}>找回订单</button>
          <button type="button" className="ghost" disabled={loading} onClick={() => void load(shopId)}>刷新状态</button>
        </div>
        {filteredOrders.length === 0 ? <p className="empty">暂无订单</p> : filteredOrders.slice(0, 8).map((order) => (
          <article className="order" key={text(order.orderNo)}>
            <button type="button" className="order-main" onClick={() => void openOrderDetail(order)}>
              <strong>{orderProductName(order)}</strong>
              <span>{text(order.orderNo)}</span>
            </button>
            <em>{statusLabel(order)}</em>
            <strong>{cents(orderPaidAmount(order))}</strong>
            {text(order.paymentStatus) === "unpaid" ? <button type="button" onClick={() => showCollection(order)}>收款信息</button> : null}
            {text(order.paymentStatus) === "paid" && text(order.refundStatus, "none") === "none" ? (
              <button type="button" onClick={() => setAfterSaleOrder(order)}>申请售后</button>
            ) : null}
          </article>
        ))}
      </section>

      <aside className="shop-side mobile-side" aria-label="个人信息和客服">
        <AccountPanel
          auth={auth}
          coupons={userCoupons}
          orders={filteredOrders}
          wallet={wallet}
          channels={paymentMethods}
          rechargeAmount={rechargeAmount}
          selectedRechargeChannelId={defaultRechargePaymentMethodId(paymentMethods, selectedPaymentMethodId)}
          loading={loading}
          onRechargeAmountChange={setRechargeAmount}
          onSelectRechargeChannel={setSelectedPaymentMethodId}
          onRecharge={() => void createRecharge()}
          onLogin={() => setShowLogin(true)}
          onLogout={() => {
            api.logout();
            setAuth(undefined);
            setMessage("已退出登录");
          }}
        />

        <section className="service">
          <ServiceContact shop={shop} />
        </section>
      </aside>

      {checkout ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="确认订单">
          <section className="checkout">
            <div className="checkout-head">
              <div>
                <span>确认订单</span>
                <h2>{productName(checkout.product)}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setCheckout(undefined)}>关闭</button>
            </div>
            <div className="checkout-row"><span>店铺</span><strong>{text(shop.name)}</strong></div>
            <div className="checkout-row"><span>数量</span><strong>1</strong></div>
            <div className="checkout-row"><span>商品原价</span><strong>{cents(quoteOriginalAmount(checkout.quote))}</strong></div>
            {Number(checkout.quote.couponDiscountCents ?? 0) > 0 ? (
              <div className="checkout-row"><span>优惠抵扣</span><strong>-{cents(checkout.quote.couponDiscountCents)}</strong></div>
            ) : null}
            <div className="checkout-row total"><span>应付金额</span><strong>{cents(checkoutPayableAmount(checkout.quote, paymentMethods, selectedPaymentMethodId, wallet))}</strong></div>
            {checkout.coupons.length > 0 ? (
              <CouponPicker
                coupons={checkout.coupons}
                selectedCouponId={checkout.couponId ?? ""}
                onSelect={(couponId) => void updateCheckoutCoupon(couponId)}
              />
            ) : null}
            <label className="field">
              <span>接收邮箱（选填）</span>
              <input
                type="email"
                value={buyerEmail}
                onChange={(event) => setBuyerEmail(event.target.value)}
                placeholder="用于接收卡密或服务通知"
              />
            </label>
            {requiresProductExtractionCode(checkout.product) ? (
              <>
                <label className="field">
                  <span>购买密码 <em className="required-mark">必填</em></span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={extractionCode}
                    onChange={(event) => setExtractionCode(event.target.value.slice(0, 32))}
                    placeholder="4-32 位，提交后用于提取卡密"
                    required
                  />
                  <small className="field-hint">至少输入 4 位，支付成功后用它提取卡密。</small>
                </label>
                <label className="field">
                  <span>联系电话 <em className="required-mark">必填</em></span>
                  <input
                    inputMode="tel"
                    value={buyerPhone}
                    onChange={(event) => setBuyerPhone(event.target.value.replace(/\D/g, "").slice(0, 11))}
                    placeholder="中国大陆手机号"
                    required
                  />
                  <small className="field-hint">请输入 11 位中国大陆手机号。</small>
                </label>
              </>
            ) : null}
            <p>{requiresProductExtractionCode(checkout.product)
              ? "后台确认收款并发码后，请使用购买时设置的购买密码查看。"
              : "本商品由客服人工交付，后台确认收款后请添加店铺客服领取账号资料或使用说明。"}</p>
            <PaymentAmountBreakdown
              baseAmountCents={orderPayableAmount(checkout.quote)}
              channel={selectedPaymentMethod(paymentMethods, effectivePaymentMethodId(paymentMethods, selectedPaymentMethodId, wallet, orderPayableAmount(checkout.quote)))}
            />
            <PaymentMethodPicker
              channels={paymentMethods}
              wallet={wallet}
              orderAmountCents={orderPayableAmount(checkout.quote)}
              selectedChannelId={effectivePaymentMethodId(paymentMethods, selectedPaymentMethodId, wallet, orderPayableAmount(checkout.quote))}
              onSelect={setSelectedPaymentMethodId}
            />
            <div className="checkout-actions">
              <button type="button" className="ghost" onClick={() => setCheckout(undefined)}>再看看</button>
              <button type="button" disabled={loading || paymentMethods.length === 0 || (requiresProductExtractionCode(checkout.product) && (!isValidPurchasePassword(extractionCode) || !isMainlandChinaMobile(buyerPhone)))} onClick={() => void submitOrder()}>立即购买</button>
            </div>
          </section>
        </div>
      ) : null}

      {paymentGuide ? (
        <PersonalPaymentGuide
          order={paymentGuide.order}
          payment={paymentGuide.payment}
          channel={paymentGuide.channel}
          shop={shop}
          loading={loading}
          onRefresh={() => void refreshOrderStatus(paymentGuide.order)}
          onViewOrder={() => {
            setSelectedOrder(paymentGuide.order);
            setPaymentGuide(undefined);
          }}
          onContact={copyServiceContact}
          onClose={() => setPaymentGuide(undefined)}
        />
      ) : null}

      {rechargeGuide ? (
        <RechargePaymentGuide
          recharge={rechargeGuide.recharge}
          channel={rechargeGuide.channel}
          shop={shop}
          loading={loading}
          onRefresh={async () => {
            setWallet(await api.wallet());
            setMessage("已刷新余额；如果后台还没确认，请稍后再看。");
          }}
          onContact={copyServiceContact}
          onClose={() => setRechargeGuide(undefined)}
        />
      ) : null}

      {detailProduct ? (
        <ProductDetailPage
          product={detailProduct}
          shop={shop}
          coupons={detailCoupons}
          selectedCouponId={detailCouponId}
          onSelectCoupon={setDetailCouponId}
          onClose={() => setDetailProduct(undefined)}
          onBuy={() => void startCheckout(detailProduct, detailCouponId)}
        />
      ) : null}

      {showNotice ? (
        <div className="modal-backdrop notice-backdrop" role="dialog" aria-modal="true" aria-label="购买须知">
          <section className="purchase-notice">
            <span>购买须知</span>
            <div className="purchase-notice-body">
              <h2>重要提醒，请下单前仔细阅读</h2>
              <p>为减少虚拟商品售后争议，请在购买前确认商品名称、发放方式、使用说明和客服处理时效。</p>
              <NoticeItem index="1" title="请认真查看商品详情" text="确认规格、发放方式和使用限制；因未阅读说明造成的问题，按页面规则处理。" />
              <NoticeItem index="2" title="付款请以订单金额为准" text="当前店铺收款方式由后台配置，付款后由商户或平台后台确认收款。" />
              <NoticeItem index="3" title="自动发码需设置购买密码" text="购买密码由你购买时自行输入；人工交付商品请添加店铺客服领取。" />
              <NoticeItem index="4" title="售后请从订单中心提交" text="订单中心会保留支付、履约、卡密和售后记录，便于平台仲裁和追踪。" />
            </div>
            <div className="checkout-actions purchase-notice-actions">
              <button type="button" onClick={acknowledgeNotice}>我已知晓并继续访问</button>
            </div>
          </section>
        </div>
      ) : null}

      {showLogin ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="登录注册">
          <section className="checkout">
            <div className="checkout-head">
              <div>
                <span>登录/注册</span>
                <h2>绑定你的订单</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setShowLogin(false)}>关闭</button>
            </div>
            <label className="field">
              <span>手机号</span>
              <input inputMode="tel" value={loginPhone} onChange={(event) => setLoginPhone(event.target.value)} placeholder="输入手机号注册或登录" />
            </label>
            <label className="field">
              <span>昵称</span>
              <input value={loginName} onChange={(event) => setLoginName(event.target.value)} placeholder="选填" />
            </label>
            <p>H5 当前支持手机号注册登录和游客继续，订单、售后和卡密提取都会绑定到当前账号。</p>
            <div className="login-benefits">
              <span>注册后可用</span>
              <strong>平台赠券、订单找回、售后进度、卡密提取记录</strong>
            </div>
            <div className="checkout-actions">
              <button type="button" className="ghost" onClick={() => void continueAsGuest()}>游客继续</button>
              <button type="button" disabled={!loginPhone.trim()} onClick={() => void submitPhoneLogin()}>注册/登录</button>
            </div>
          </section>
        </div>
      ) : null}

      {selectedOrder ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="订单详情">
          <section className="checkout">
            <div className="checkout-head">
              <div>
                <span>订单详情</span>
                <h2>{orderProductName(selectedOrder)}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setSelectedOrder(undefined)}>关闭</button>
            </div>
            <div className="checkout-row"><span>订单号</span><strong>{text(selectedOrder.orderNo)}</strong></div>
            <div className="checkout-row"><span>店铺</span><strong>{text(selectedOrder.shopName, text(shop.name))}</strong></div>
            <div className="checkout-row"><span>实付金额</span><strong>{cents(orderPaidAmount(selectedOrder))}</strong></div>
            <div className="checkout-row"><span>支付状态</span><strong>{statusLabel(selectedOrder)}</strong></div>
            <div className="checkout-row"><span>履约方式</span><strong>{text(selectedOrder.fulfillmentStatus, "待处理")}</strong></div>
            {text(selectedOrder.paymentStatus) === "unpaid" || text(selectedOrder.paymentStatus) === "paying" ? (
              <>
                {!paymentForOrder(selectedOrder) ? (
                  <PaymentMethodPicker
                    channels={paymentMethods}
                    wallet={wallet}
                    orderAmountCents={orderBaseAmount(selectedOrder)}
                    selectedChannelId={effectivePaymentMethodId(paymentMethods, selectedPaymentMethodId, wallet, orderBaseAmount(selectedOrder))}
                    onSelect={setSelectedPaymentMethodId}
                  />
                ) : null}
                <PaymentBox
                  channels={paymentMethods}
                  orderAmountCents={orderBaseAmount(selectedOrder)}
                  selectedChannelId={effectivePaymentMethodId(paymentMethods, selectedPaymentMethodId, wallet, orderBaseAmount(selectedOrder))}
                  payment={orderPayments[text(selectedOrder.orderNo)] ?? paymentForOrder(selectedOrder)}
                />
              </>
            ) : null}
            {text(selectedOrder.disputeMaterialStatus, "") ? <div className="checkout-row"><span>异常材料</span><strong>{text(selectedOrder.disputeMaterialStatus)}</strong></div> : null}
            <DeliveryBlock order={selectedOrder} onExtract={(token) => {
              if (token) {
                window.location.href = `/extract?token=${encodeURIComponent(token)}&shopId=${encodeURIComponent(shopId)}`;
                return;
              }
              setExtractOrder(selectedOrder);
              setExtractInput("");
              setExtractResult(undefined);
            }} />
            <ServiceContact shop={shop} compact />
            <p>虚拟权益订单会保留支付、履约和售后记录；遇到问题请联系店铺客服。</p>
            <div className="checkout-actions">
              {text(selectedOrder.paymentStatus) === "unpaid" && !paymentForOrder(selectedOrder) ? (
                <button type="button" disabled={loading} onClick={() => void createOrderPayment(selectedOrder)}>去支付</button>
              ) : null}
              <button type="button" className="ghost" onClick={() => openPaymentVoucher(selectedOrder)}>提交核实材料</button>
            </div>
          </section>
        </div>
      ) : null}

      {supportMaterialOrder ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="提交核实材料">
          <section className="checkout">
            <div className="checkout-head">
              <div>
                <span>仅用于异常核实</span>
                <h2>{text(supportMaterialOrder.orderNo)}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setSupportMaterialOrder(undefined)}>关闭</button>
            </div>
            <div className="checkout-row"><span>订单金额</span><strong>{cents(orderPaidAmount(supportMaterialOrder))}</strong></div>
            <div className="field">
              <span>相关通道</span>
              <div className="support-channel-grid">
                {[
                  ["", "按收款码核验"],
                  ["alipay_wap", "支付宝"],
                  ["wechat_h5", "微信"],
                  ["wechat_h5_jsapi", "微信 JSAPI"]
                ].map(([value, label]) => (
                  <button
                    key={value || "auto"}
                    type="button"
                    className={paymentVoucherForm.channel === value ? "selected" : ""}
                    onClick={() => setPaymentVoucherForm({ ...paymentVoucherForm, channel: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>付款人</span>
              <input value={paymentVoucherForm.payerName} onChange={(event) => setPaymentVoucherForm({ ...paymentVoucherForm, payerName: event.target.value })} placeholder="选填，付款账号名或姓名" />
            </label>
            <label className="field">
              <span>材料 URL</span>
              <input value={paymentVoucherForm.voucherUrl} onChange={(event) => setPaymentVoucherForm({ ...paymentVoucherForm, voucherUrl: event.target.value })} placeholder="选填，图片或说明链接" />
            </label>
            <label className="field">
              <span>备注</span>
              <textarea value={paymentVoucherForm.note} onChange={(event) => setPaymentVoucherForm({ ...paymentVoucherForm, note: event.target.value })} rows={3} placeholder="说明异常情况、客服沟通结果或账号尾号" />
            </label>
            <p>此入口只在订单长时间未确认、客服要求补充信息或发生争议时使用；提交后不会确认付款，也不会触发自动发货。</p>
            <div className="checkout-actions">
              <button type="button" className="ghost" onClick={() => setSupportMaterialOrder(undefined)}>取消</button>
              <button type="button" disabled={loading || (!paymentVoucherForm.voucherUrl.trim() && !paymentVoucherForm.note.trim())} onClick={() => void submitPaymentVoucher()}>提交核实材料</button>
            </div>
          </section>
        </div>
      ) : null}

      {extractOrder ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="提取卡密">
          <section className="checkout">
            <div className="checkout-head">
              <div>
                <span>提取卡密</span>
                <h2>{orderProductName(extractOrder)}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setExtractOrder(undefined)}>关闭</button>
            </div>
            <label className="field">
              <span>购买密码</span>
              <input
                type="password"
                autoComplete="current-password"
                value={extractInput}
                onChange={(event) => setExtractInput(event.target.value.slice(0, 32))}
                placeholder="输入购买时设置的购买密码"
              />
              <small className="field-hint">至少输入 4 位。</small>
            </label>
            {extractResult ? <ExtractResult result={extractResult} /> : null}
            <div className="checkout-actions">
              <button type="button" className="ghost" onClick={() => setExtractOrder(undefined)}>返回订单</button>
              <button type="button" disabled={loading || extractInput.trim().length < 4 || text(extractOrder.refundStatus, "none") !== "none"} onClick={() => void submitExtract()}>提取</button>
            </div>
          </section>
        </div>
      ) : null}

      {afterSaleOrder ? (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="申请售后">
          <section className="checkout">
            <div className="checkout-head">
              <div>
                <span>申请售后</span>
                <h2>{orderProductName(afterSaleOrder)}</h2>
              </div>
              <button type="button" className="icon-button" onClick={() => setAfterSaleOrder(undefined)}>关闭</button>
            </div>
            <div className="checkout-row"><span>订单号</span><strong>{text(afterSaleOrder.orderNo)}</strong></div>
            <div className="checkout-row"><span>退款金额</span><strong>{cents(orderPaidAmount(afterSaleOrder))}</strong></div>
            <label className="field">
              <span>售后原因</span>
              <select value={afterSaleReason} onChange={(event) => setAfterSaleReason(event.target.value)} aria-label="售后原因">
                <option>权益无法正常使用</option>
                <option>发放超时</option>
                <option>商品信息不符</option>
              </select>
            </label>
            <label className="field">
              <span>问题说明</span>
              <textarea value={afterSaleDescription} onChange={(event) => setAfterSaleDescription(event.target.value)} rows={3} />
            </label>
            <div className="checkout-actions">
              <button type="button" className="ghost" onClick={() => setAfterSaleOrder(undefined)}>取消</button>
              <button type="button" disabled={loading || text(afterSaleOrder.refundStatus, "none") !== "none"} onClick={() => void afterSale()}>提交售后</button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function UserRegisterPage() {
  const [phone, setPhone] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState("手机号注册后，订单、优惠券、售后和卡密提取记录会绑定到当前账号。");
  const [session, setSession] = useState<AuthSession | undefined>(() => api.currentSession());
  const [loading, setLoading] = useState(false);
  const backHref = shopHref(defaultShopId);

  async function submit() {
    const nextPhone = phone.trim();
    if (!nextPhone) {
      setMessage("请输入手机号。");
      return;
    }
    setLoading(true);
    try {
      const nextSession = await api.authRegister(nextPhone, displayName.trim() || undefined);
      api.saveSession(nextSession);
      setSession(nextSession);
      setMessage(nextSession.grantedCoupon ? "注册成功，平台赠券已发放。" : "登录成功，账号已绑定。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "注册或登录失败");
    } finally {
      setLoading(false);
    }
  }

  async function guest() {
    setLoading(true);
    try {
      const nextSession = await api.authGuest();
      api.saveSession(nextSession);
      setSession(nextSession);
      setMessage("已以游客身份继续，订单也会绑定到游客账号。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "游客登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="merchant-page">
      <header className="merchant-header">
        <a href="/">ToSell</a>
        <a href={backHref}>返回商城</a>
      </header>
      <section className="user-register-page">
        <section className="merchant-copy">
          <span>用户注册</span>
          <h1>绑定你的订单和虚拟权益</h1>
          <p>注册后可以在当前浏览器查看订单、平台优惠券、售后处理进度，以及符合规则的卡密提取记录。</p>
          <div className="merchant-rules">
            <div><strong>订单可查</strong><span>下单后绑定到服务端账号</span></div>
            <div><strong>优惠券</strong><span>注册赠券按平台规则发放</span></div>
            <div><strong>售后留痕</strong><span>售后和提取记录可追踪</span></div>
          </div>
        </section>
        <section className="merchant-form">
          <div className={loading ? "notice loading" : "notice"}>{message}</div>
          <label className="field">
            <span>手机号</span>
            <input inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="输入手机号注册或登录" />
          </label>
          <label className="field">
            <span>昵称</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="选填" />
          </label>
          {session ? (
            <div className="merchant-result">
              <strong>当前账号</strong>
              <span>{authLabel(session)}</span>
              <span>用户ID：{text(session.user.userId)}</span>
            </div>
          ) : null}
          <div className="checkout-actions">
            <button type="button" className="ghost" onClick={() => void guest()}>游客继续</button>
            <button type="button" disabled={!phone.trim()} onClick={() => void submit()}>注册/登录</button>
          </div>
        </section>
      </section>
    </main>
  );
}

function ShopLinkRequiredPage() {
  return (
    <main className="merchant-page">
      <header className="merchant-header">
        <a href="/">ToSell</a>
        <a href="/merchant/register">商户入驻</a>
      </header>
      <section className="user-register-page">
        <section className="merchant-copy">
          <span>店铺链接</span>
          <h1>请通过商户店铺分享地址访问</h1>
          <p>生产环境不会默认进入测试店铺。每个商户都有自己的独立 H5 店铺地址，请使用商户分享链接打开。</p>
        </section>
      </section>
    </main>
  );
}

function ExtractionPage() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") ?? "";
  const shopId = params.get("shopId") ?? defaultShopId;
  const [extractionCode, setExtractionCode] = useState("");
  const [result, setResult] = useState<JsonRecord | undefined>();
  const [message, setMessage] = useState(token ? "输入购买时设置的购买密码查看卡密。" : "提取链接无效，请从订单详情重新进入。");
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!token) return;
    setLoading(true);
    try {
      const next = await api.extractWithToken(token, extractionCode.trim());
      setResult(next);
      setMessage("卡密提取成功，请妥善保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "卡密提取失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page extract-page">
      <section className="checkout extract-panel">
        <div className="checkout-head">
          <div>
            <span>卡密提取</span>
            <h2>输入购买密码</h2>
          </div>
          <a className="ghost-link" href={`${shopHref(shopId)}#orders`}>返回订单</a>
        </div>
        <p>{message}</p>
        <label className="field">
          <span>购买密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={extractionCode}
            onChange={(event) => setExtractionCode(event.target.value.slice(0, 32))}
            placeholder="输入购买时设置的购买密码"
            autoFocus
          />
          <small className="field-hint">至少输入 4 位。</small>
        </label>
        {result ? <ExtractResult result={result} /> : null}
        <div className="checkout-actions">
          <a className="ghost-link" href={`${shopHref(shopId)}#orders`}>返回店铺</a>
          <button type="button" disabled={!token || loading || extractionCode.trim().length < 4} onClick={() => void submit()}>
            {loading ? "提取中" : "提取卡密"}
          </button>
        </div>
      </section>
    </main>
  );
}

function MerchantRegisterPage() {
  const params = new URLSearchParams(window.location.search);
  const [form, setForm] = useState<MerchantRegisterForm>({
    inviteCode: params.get("inviteCode") ?? "",
    name: "",
    shopName: "",
    contactPhone: "",
    customerServiceWechat: ""
  });
  const [message, setMessage] = useState("请使用平台或上级商户发放的邀请码提交入驻。");
  const [result, setResult] = useState<JsonRecord | undefined>();
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true);
    try {
      const nextResult = await api.registerMerchantByInvite({
        inviteCode: form.inviteCode.trim(),
        name: form.name.trim(),
        shopName: form.shopName.trim(),
        contactPhone: form.contactPhone.trim(),
        customerServiceWechat: form.customerServiceWechat.trim()
      });
      setResult(nextResult);
      setMessage("入驻申请已提交，平台审核和保证金确认前不可销售或店铺商品。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "入驻提交失败");
    } finally {
      setLoading(false);
    }
  }

  const merchant = result?.merchant as JsonRecord | undefined;
  const shop = result?.shop as JsonRecord | undefined;
  const application = result?.application as JsonRecord | undefined;
  const credential = result?.credential as JsonRecord | undefined;

  return (
    <main className="merchant-page">
      <header className="merchant-header">
        <a href="/">ToSell</a>
        <a href={shopHref(defaultShopId)}>返回商城</a>
      </header>
      <section className="merchant-register">
        <div className="merchant-copy">
          <span>商户入驻</span>
          <h1>用邀请码开通自己的虚拟权益小店</h1>
          <p>平台邀请码注册为一级商户；一级邀请码注册为二级商户；二级邀请码注册为三级商户。邀请码只绑定供货关系，收益来自商品价差。</p>
          <div className="merchant-rules">
            <div><strong>审核后开店</strong><span>平台审核资料和店铺信息</span></div>
            <div><strong>保证金门槛</strong><span>未确认保证金不能选品、上架和销售</span></div>
            <div><strong>独立店铺</strong><span>前台只展示自己的商品、客服和收款方式</span></div>
          </div>
        </div>
        <section className="merchant-form">
          <div className={loading ? "notice loading" : "notice"}>{message}</div>
          <label className="field">
            <span>邀请码</span>
            <input value={form.inviteCode} onChange={(event) => setForm({ ...form, inviteCode: event.target.value })} placeholder="平台或上级商户发放的邀请码" />
          </label>
          <label className="field">
            <span>商户名称</span>
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="营业主体或联系人名称" />
          </label>
          <label className="field">
            <span>店铺名称</span>
            <input value={form.shopName} onChange={(event) => setForm({ ...form, shopName: event.target.value })} placeholder="请输入对外展示的店铺名称" />
          </label>
          <label className="field">
            <span>联系电话</span>
            <input inputMode="tel" value={form.contactPhone} onChange={(event) => setForm({ ...form, contactPhone: event.target.value })} placeholder="用于平台审核联系" />
          </label>
          <label className="field">
            <span>客服微信</span>
            <input value={form.customerServiceWechat} onChange={(event) => setForm({ ...form, customerServiceWechat: event.target.value })} placeholder="店铺售后客服微信" />
          </label>
          <button type="button" disabled={loading || !form.inviteCode.trim() || !form.name.trim()} onClick={() => void submit()}>
            提交入驻申请
          </button>
          {result ? (
            <div className="merchant-result">
              <strong>提交成功</strong>
              <span>申请编号：{text(application?.applicationNo)}</span>
              <span>商户ID：{text(merchant?.id ?? merchant?.merchantId)}</span>
              <span>店铺ID：{text(shop?.id)}</span>
              {credential ? <span>后台账号：{text(credential.account)} / 初始密码：{text(credential.initialPassword)}</span> : null}
              <span>当前状态：{text(merchant?.status)} / 保证金 {text(merchant?.depositStatus)}</span>
              <p>请等待平台后台审核，并在保证金确认后再配置商品、客服二维码和收款方式。</p>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}

function AccountBenefits(props: { coupons: JsonRecord[]; orders: JsonRecord[] }) {
  const availableCoupons = props.coupons.filter((coupon) => text(coupon.status) === "available");
  return (
    <div className="account-benefits">
      <div><strong>{availableCoupons.length}</strong><span>可用优惠券</span></div>
      <div><strong>{props.orders.length}</strong><span>当前店铺订单</span></div>
    </div>
  );
}

function CouponPicker(props: { coupons: JsonRecord[]; selectedCouponId: string; onSelect: (couponId: string) => void }) {
  const availableCoupons = props.coupons.filter((coupon) => text(coupon.status) === "available");
  if (props.coupons.length === 0) {
    return (
      <section className="coupon-picker empty">
        <div className="coupon-title">
          <span>优惠券</span>
          <small>暂无可用优惠券</small>
        </div>
      </section>
    );
  }
  return (
    <section className="coupon-picker" aria-label="优惠券">
      <div className="coupon-title">
        <span>优惠券</span>
        <small>一次只能使用一张，金额由后台重新计算。</small>
      </div>
      <div className="coupon-grid">
        <button
          type="button"
          className={!props.selectedCouponId ? "coupon-card selected" : "coupon-card"}
          onClick={() => props.onSelect("")}
        >
          <strong>不使用优惠券</strong>
          <span>按原价结算</span>
        </button>
        {props.coupons.map((coupon) => {
          const template = coupon.template as JsonRecord | undefined;
          const disabled = coupon.applicable === false || text(coupon.status) !== "available";
          return (
            <button
              key={text(coupon.id)}
              type="button"
              className={props.selectedCouponId === text(coupon.id) ? "coupon-card selected" : "coupon-card"}
              disabled={disabled}
              onClick={() => props.onSelect(text(coupon.id))}
            >
              <strong>{cents(template?.discountCents)}</strong>
              <span>{text(template?.name, "平台优惠券")}</span>
              <small>{disabled ? "当前不可用" : "可抵扣订单金额"}</small>
            </button>
          );
        })}
      </div>
      {availableCoupons.length === 0 ? <small>当前商品暂无可用券。</small> : null}
    </section>
  );
}

function AccountPanel(props: {
  auth?: AuthSession;
  coupons: JsonRecord[];
  orders: JsonRecord[];
  wallet?: JsonRecord;
  channels: JsonRecord[];
  rechargeAmount: string;
  selectedRechargeChannelId: string;
  loading: boolean;
  onRechargeAmountChange: (value: string) => void;
  onSelectRechargeChannel: (channelId: string) => void;
  onRecharge: () => void;
  onLogin: () => void;
  onLogout: () => void;
}) {
  const registered = canRecharge(props.auth);
  const rechargeChannels = props.channels.filter((channel) => text(channel.provider) !== "balance" && text(channel.id) !== "balance");
  return (
    <section className="account-card">
      <span>个人信息</span>
      <strong>{text(props.auth?.user.displayName, "欢迎光临")}</strong>
      <p>{props.auth ? authLabel(props.auth) : "登录后可在服务端查询订单、售后状态和余额。"}</p>
      <AccountBenefits coupons={props.coupons} orders={props.orders} />
      <div className={registered ? "account-wallet" : "account-wallet locked"}>
        <div>
          <span>账户余额</span>
          <strong>{registered ? cents(text(props.wallet?.availableBalanceCents, "0")) : "登录后可充值"}</strong>
          <small>余额支付默认不收手续费。</small>
        </div>
        {registered ? (
          <div className="account-recharge">
            <label>
              <span>充值金额(元)</span>
              <input
                inputMode="decimal"
                value={yuanInputValue(props.rechargeAmount)}
                onChange={(event) => props.onRechargeAmountChange(yuanToCentsInput(event.target.value))}
                placeholder="例如 100"
              />
            </label>
            <PaymentMethodPicker
              channels={rechargeChannels}
              orderAmountCents={props.rechargeAmount}
              selectedChannelId={props.selectedRechargeChannelId}
              onSelect={props.onSelectRechargeChannel}
              title="充值方式"
              note="充值到账后可用余额按原价消费"
            />
            <button type="button" disabled={props.loading} onClick={props.onRecharge}>充值</button>
          </div>
        ) : (
          <button type="button" className="ghost" onClick={props.onLogin}>登录/注册后充值</button>
        )}
      </div>
      <div className="side-actions">
        <button type="button" onClick={props.onLogin}>登录/注册</button>
        {props.auth ? <button type="button" className="ghost" onClick={props.onLogout}>退出</button> : null}
      </div>
    </section>
  );
}

function ServiceContact(props: { shop: JsonRecord; compact?: boolean }) {
  const wechat = text(props.shop.customerServiceWechat, "未配置");
  const wechatQr = text(props.shop.customerServiceQrUrl, "");
  const qq = text(props.shop.customerServiceQq, text(props.shop.customerServiceQQ, text(props.shop.qq, "")));
  const qqQr = text(props.shop.customerServiceQqQrUrl, text(props.shop.customerServiceQQQrUrl, text(props.shop.qqQrUrl, "")));
  const note = text(props.shop.customerServiceNote, text(props.shop.customerServiceDescription, text(props.shop.serviceNote, "")));
  return (
    <>
      <div>
        <strong>客服微信</strong>
        <span>{wechat}</span>
        {wechat !== "未配置" ? <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(wechat)}>复制微信</button> : null}
        {qq ? <><strong>客服 QQ</strong><span>{qq}</span><button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(qq)}>复制 QQ</button></> : null}
        {note ? <small>{note}</small> : null}
      </div>
      {!props.compact ? (
        <div className="service-qr-grid">
          <ImageWithFallback src={wechatQr} alt="微信客服二维码" fallback={<div className="qr-empty">微信二维码</div>} />
          {qqQr ? <ImageWithFallback src={qqQr} alt="QQ 客服二维码" fallback={<div className="qr-empty">QQ 二维码</div>} /> : null}
        </div>
      ) : null}
    </>
  );
}

function PaymentMethodPicker(props: {
  channels: JsonRecord[];
  wallet?: JsonRecord;
  orderAmountCents: string;
  selectedChannelId?: string;
  onSelect: (channelId: string) => void;
  title?: string;
  note?: string;
}) {
  const orderedChannels = [...props.channels].sort((left, right) => {
    const leftBalance = text(left.provider) === "balance" || text(left.id) === "balance";
    const rightBalance = text(right.provider) === "balance" || text(right.id) === "balance";
    if (leftBalance === rightBalance) return Number(right.isDefault === true) - Number(left.isDefault === true);
    return leftBalance ? 1 : -1;
  });
  if (orderedChannels.length === 0) {
    return (
      <div className="payment-method-picker unavailable">
        <strong>暂无可用支付方式</strong>
        <span>当前店铺暂时不能收款，请联系店铺客服。</span>
      </div>
    );
  }
  return (
    <section className="payment-method-picker" aria-label="支付方式">
      <div className="payment-method-title">
        <span>{props.title ?? "支付方式"}</span>
        <small>{props.note ?? "余额支付不加手续费"}</small>
      </div>
      <div className="payment-method-grid">
        {orderedChannels.map((channel) => {
          const provider = text(channel.provider);
          const channelId = text(channel.id);
          const isBalance = provider === "balance" || channelId === "balance";
          const balanceEnough = BigInt(text(props.wallet?.availableBalanceCents, "0")) >= BigInt(props.orderAmountCents || "0");
          const disabled = isBalance && !balanceEnough;
          const selected = props.selectedChannelId === channelId;
          return (
            <button
              key={channelId}
              type="button"
              className={selected ? "payment-method-tile selected" : "payment-method-tile"}
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => props.onSelect(channelId)}
            >
              <PaymentIcon provider={provider || text(channel.channelType)} />
              <span>{paymentTileTitle(channel)}</span>
              <small>{disabled ? "余额不足" : paymentTileSubtitle(channel)}</small>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PaymentBox(props: { channels: JsonRecord[]; orderAmountCents: string; selectedChannelId?: string; payment?: JsonRecord }) {
  const channel = selectedPaymentMethod(props.channels, props.selectedChannelId);
  const payment = props.payment;
  const paymentParams = payment?.paymentParams as JsonRecord | undefined;
  const paymentMethod = payment?.paymentMethod as JsonRecord | undefined;
  const paymentQr = text(paymentParams?.qrCodeUrl, text(paymentMethod?.qrUrl, ""));
  const paymentUrl = text(paymentParams?.paymentUrl, text(paymentMethod?.paymentUrl, ""));
  const paymentProvider = text(payment?.provider, text(paymentMethod?.provider, ""));
  const provider = paymentProvider || text(channel?.provider);
  const baseAmountCents = props.orderAmountCents;
  const feeCents = paymentMethodFeeCents(baseAmountCents, channel);
  const payableCents = String(BigInt(baseAmountCents || "0") + BigInt(feeCents));
  const epayPayment = paymentProviderFrom(payment, channel) === "epay";
  if (!channel) {
    return (
      <div className="payment-box unavailable">
      <div>
        <strong>暂无可用收款方式</strong>
        <span>当前店铺暂时不能收款，请联系店铺客服。</span>
      </div>
      </div>
    );
  }
  const personalPayment = isPersonalPaymentProvider(provider) || isPersonalPaymentMethod(channel);
  const interfacePayment = ["alipay_merchant", "wechat_merchant", "epay"].includes(provider) || isInterfacePaymentMethod(channel);
  const balancePayment = provider === "balance";
  const displayQr = epayPayment ? "" : paymentQr || text(channel.qrUrl);
  const publicLabel = text(channel.publicLabel, paymentProviderPublicLabelForH5(provider, channel));
  return (
    <div className="payment-box">
      <div>
        <strong><PaymentIcon provider={provider} /> {publicLabel}</strong>
        <small>{epayPayment
          ? "点击下方按钮进入 e支付收银台，订单以服务端回调确认为准。"
          : interfacePayment
            ? text(payment?.message, "请使用官方二维码或支付链接完成支付，订单以服务端回调或主动查单确认为准。")
          : balancePayment
            ? "使用账户余额支付，按商品原价扣款，不加手续费。"
            : personalPayment
              ? text(payment?.message, "请截屏保存收款码，打开对应支付 App 扫码付款，付款后等待商户确认。")
              : "请按订单金额付款，订单以后台确认结果为准。"}</small>
        {payment ? <small>支付单状态：{humanPaymentStatus(text(payment.status))}</small> : null}
      </div>
      <strong className="payment-amount">{cents(text(payment?.amountCents, payableCents))}</strong>
      {displayQr ? (
        usableImageSrc(displayQr)
          ? <ImageWithFallback src={displayQr} alt={interfacePayment ? "官方支付二维码" : "店铺收款码"} fallback={<div className="qr-empty">{interfacePayment ? "支付二维码" : "收款码"}</div>} />
          : <div className="qr-empty">{interfacePayment ? "官方支付参数" : "收款信息"}</div>
      ) : (
        <div className="qr-empty">{interfacePayment ? "支付二维码" : "收款码"}</div>
      )}
      {epayPayment && payment ? (
        <button type="button" onClick={() => openOfficialPayment(payment)}>进入 e支付收银台</button>
      ) : paymentUrl ? (
        paymentProviderFrom(payment, channel) === "epay" && payment
          ? <button type="button" onClick={() => openOfficialPayment(payment)}>{interfacePayment ? "进入 e支付收银台" : "打开支付链接"}</button>
          : <a href={paymentUrl} target="_blank" rel="noreferrer">{interfacePayment ? "打开官方支付链接" : "打开支付链接"}</a>
      ) : null}
    </div>
  );
}

function PersonalPaymentGuide(props: {
  order: JsonRecord;
  payment: JsonRecord;
  channel?: JsonRecord;
  shop: JsonRecord;
  loading: boolean;
  onRefresh: () => void;
  onViewOrder: () => void;
  onContact: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const provider = paymentProviderFrom(props.payment, props.channel);
  const appName = provider.includes("wechat") ? "微信" : "支付宝";
  const personalSteps = personalPaymentSteps(provider);
  const amountCents = text(props.payment.amountCents, orderPaidAmount(props.order));
  const amount = cents(amountCents);
  const amountForCopy = (Number(amountCents || 0) / 100).toFixed(2);
  const qrUrl = paymentQrUrl(props.payment, props.channel);
  const isPaid = text(props.order.paymentStatus) === "paid";

  async function copyAmount() {
    await navigator.clipboard?.writeText(amountForCopy);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="modal-backdrop payment-guide-backdrop" role="dialog" aria-modal="true" aria-label={`${appName}付款`}>
      <section className="personal-payment-guide">
        <div className="payment-guide-head">
          <div>
            <span>订单已提交</span>
            <h2>{appName}付款</h2>
          </div>
          <button type="button" className="icon-button" onClick={props.onClose}>关闭</button>
        </div>

        <div className="payment-guide-amount">
          <span>请支付</span>
          <strong>{amount}</strong>
          <button type="button" className="ghost" onClick={() => void copyAmount()}>{copied ? "已复制" : "复制金额"}</button>
        </div>

        <div className="payment-guide-code">
          {qrUrl ? (
            <ImageWithFallback src={qrUrl} alt={`${appName}付款码`} fallback={<div className="qr-empty large">付款码</div>} />
          ) : (
            <div className="qr-empty large">付款码</div>
          )}
        </div>

        <div className="payment-guide-steps">
          <strong>{isPaid ? "订单已确认收款" : "请截图保存上方付款码"}</strong>
          {personalSteps.map((step) => <p key={step}>{step}</p>)}
          <p>支付后请回到本页面等待订单刷新，后台确认收款后会自动发放卡密或进入人工交付。</p>
        </div>

        <div className="payment-guide-warning">
          支付后 5 分钟如果订单状态还没刷新，或者没有发放卡密，请第一时间联系客服。
        </div>

        <div className="checkout-row"><span>订单号</span><strong>{text(props.order.orderNo)}</strong></div>
        <div className="checkout-row"><span>订单状态</span><strong>{statusLabel(props.order)}</strong></div>

        <div className="checkout-actions payment-guide-actions">
          <button type="button" disabled={props.loading} onClick={props.onRefresh}>刷新订单状态</button>
          <button type="button" className="ghost" onClick={props.onContact}>联系客服</button>
          <button type="button" className="ghost" onClick={props.onViewOrder}>查看订单详情</button>
        </div>
      </section>
    </div>
  );
}

function RechargePaymentGuide(props: {
  recharge: JsonRecord;
  channel?: JsonRecord;
  shop: JsonRecord;
  loading: boolean;
  onRefresh: () => void | Promise<void>;
  onContact: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const provider = text(props.recharge.provider, text((props.recharge.paymentMethod as JsonRecord | undefined)?.provider, text(props.channel?.provider)));
  const appName = provider.includes("wechat") ? "微信" : provider.includes("alipay") ? "支付宝" : "支付平台";
  const payableCents = text(props.recharge.payableCents, text(props.recharge.rechargeCents));
  const amount = cents(payableCents);
  const amountForCopy = (Number(payableCents || 0) / 100).toFixed(2);
  const qrUrl = paymentQrUrl(props.recharge, props.channel);

  async function copyAmount() {
    await navigator.clipboard?.writeText(amountForCopy);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="modal-backdrop payment-guide-backdrop" role="dialog" aria-modal="true" aria-label={`${appName}充值`}>
      <section className="personal-payment-guide">
        <div className="payment-guide-head">
          <div>
            <span>充值单已生成</span>
            <h2>{appName}充值</h2>
          </div>
          <button type="button" className="icon-button" onClick={props.onClose}>关闭</button>
        </div>

        <div className="payment-guide-amount">
          <span>请支付</span>
          <strong>{amount}</strong>
          <button type="button" className="ghost" onClick={() => void copyAmount()}>{copied ? "已复制" : "复制金额"}</button>
        </div>

        <div className="payment-guide-code">
          {qrUrl ? (
            <ImageWithFallback src={qrUrl} alt={`${appName}充值码`} fallback={<div className="qr-empty large">充值码</div>} />
          ) : (
            <div className="qr-empty large">充值码</div>
          )}
        </div>

        <div className="payment-guide-steps">
          <strong>请截图保存上方充值码</strong>
          <p>打开{appName}扫一扫，选择刚保存的图片或扫码完成付款。</p>
          <p>付款后回到商城等待后台确认，确认后余额会自动到账。</p>
        </div>

        <div className="payment-guide-warning">
          支付后 5 分钟如果余额还没刷新，请第一时间联系客服。
        </div>

        <div className="checkout-row"><span>充值单号</span><strong>{text(props.recharge.rechargeNo)}</strong></div>
        <div className="checkout-row"><span>充值到账</span><strong>{cents(text(props.recharge.rechargeCents))}</strong></div>

        <div className="checkout-actions payment-guide-actions">
          <button type="button" disabled={props.loading} onClick={() => void props.onRefresh()}>刷新余额</button>
          <button type="button" className="ghost" onClick={props.onContact}>联系客服</button>
        </div>
      </section>
    </div>
  );
}

function PaymentAmountBreakdown(props: { baseAmountCents: string; channel?: JsonRecord }) {
  const feeCents = paymentMethodFeeCents(props.baseAmountCents, props.channel);
  const payableCents = String(BigInt(props.baseAmountCents || "0") + BigInt(feeCents));
  return (
    <div className="amount-breakdown">
      <span>商品金额 {cents(props.baseAmountCents)}</span>
      <span>支付手续费 {cents(feeCents)}</span>
      <strong>应付 {cents(payableCents)}</strong>
    </div>
  );
}

function PaymentIcon(props: { provider: string }) {
  const kind = props.provider.includes("wechat") ? "wechat" : props.provider.includes("alipay") || props.provider === "personal_alipay" ? "alipay" : props.provider === "balance" ? "balance" : "epay";
  const label = kind === "wechat" ? "微" : kind === "alipay" ? "支" : kind === "balance" ? "余" : "e";
  return <i className={`payment-icon ${kind}`} aria-hidden="true">{label}</i>;
}

function personalPaymentSteps(provider: string): string[] {
  if (provider.includes("wechat")) {
    return [
      "截屏保存支付码。",
      "打开微信扫一扫，从相册选择刚才保存的支付码。",
      "按页面金额付款，付款完成后回到本页面。"
    ];
  }
  return [
    "截屏保存支付码。",
    "打开支付宝扫一扫，从相册选择刚才保存的支付码。",
    "按页面金额付款，付款完成后回到本页面。"
  ];
}

function ExtractResult(props: { result: JsonRecord }) {
  const codes = Array.isArray(props.result.codes) ? props.result.codes as JsonRecord[] : [];
  return (
    <div className="delivery-box">
      <strong>{text(props.result.message, "提取成功")}</strong>
      {codes.length === 0 ? <span>暂无可展示卡密，请联系店铺客服核实。</span> : codes.map((item) => (
        <code key={text(item.codeId, text(item.code))}>{text(item.code)}</code>
      ))}
    </div>
  );
}

function DeliveryBlock(props: { order: JsonRecord; onExtract: (token?: string) => void }) {
  const delivery = props.order.delivery as JsonRecord | undefined;
  const codes = Array.isArray(delivery?.codes) ? delivery.codes as JsonRecord[] : [];
  const extractionToken = text(delivery?.extractionToken, "");
  const emailDelivery = delivery?.emailDelivery as JsonRecord | undefined;
  const passwordProtected = delivery?.purchasePasswordSet === true;
  if (text(props.order.refundStatus, "none") !== "none") {
    return (
      <div className="delivery-box unavailable">
        <strong>卡密不可查看</strong>
        <span>订单已进入售后或退款流程，卡密提取入口已关闭。</span>
      </div>
    );
  }
  if (text(delivery?.mode) === "automatic") {
    return (
      <div className="delivery-box">
        <strong>自动卡密</strong>
        <span>{text(delivery?.message, "付款后自动发放卡密")}</span>
        {passwordProtected ? <small>已设置购买密码</small> : null}
        {props.order.buyerEmail || emailDelivery ? (
          <small>邮件投递：{emailDeliveryStatusText(emailDelivery, text(props.order.buyerEmail, text(delivery?.buyerEmail, "")))}</small>
        ) : null}
        {passwordProtected && (delivery?.extractable || codes.length > 0) ? <button type="button" onClick={() => props.onExtract(extractionToken || undefined)}>提取卡密</button> : null}
        {!passwordProtected && codes.length > 0 ? codes.map((item) => (
          <code key={text(item.codeId, text(item.code))}>{text(item.code)}</code>
        )) : null}
      </div>
    );
  }
  return (
    <div className="delivery-box">
      <strong>人工交付</strong>
      <span>{text(delivery?.message, "请添加店铺客服领取账号资料或使用说明")}</span>
    </div>
  );
}

function ImageWithFallback(props: { src: string; alt: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [props.src]);
  const src = usableImageSrc(props.src);
  if (!src || failed) return <>{props.fallback}</>;
  return <img src={src} alt={props.alt} onError={() => setFailed(true)} />;
}

function usableImageSrc(src: string): string {
  if (!src) return "";
  try {
    const url = new URL(src, window.location.href);
    if (url.hostname.endsWith(".test")) return "";
    return src;
  } catch {
    return "";
  }
}

function ProductVisual(props: { label: string }) {
  return (
    <div className="product-visual">
      <div>
        <span>ToSell</span>
        <strong>{props.label.slice(0, 18)}</strong>
        <small>虚拟权益交付中心</small>
      </div>
    </div>
  );
}

function StoreLogoVisual() {
  return <img className="store-logo-visual" src={storeAiLogoSrc} alt="" />;
}

function NoticeItem(props: { index: string; title: string; text: string }) {
  return (
    <article className="notice-item">
      <strong>{props.index}</strong>
      <div>
        <h3>{props.title}</h3>
        <p>{props.text}</p>
      </div>
    </article>
  );
}

function ProductCard(props: { item: JsonRecord; active: boolean; onDetail: () => void; onBuy: () => void }) {
  const category = text(productRecord(props.item).category, text(props.item.productType) === "platform_self_operated" ? "官方精选" : "店铺精选");
  const tags = productTags(props.item)
    .filter((tag) => tag !== category)
    .slice(0, 2);
  const stock = productStock(props.item);
  const soldOut = isAutomaticProduct(props.item) && stock <= 0;

  return (
    <article className={props.active ? "product active" : "product"}>
      <div className="product-media">
        <ImageWithFallback src={productImage(props.item)} alt={productName(props.item)} fallback={<ProductVisual label={productName(props.item)} />} />
        <span>{productDisplayBadge(props.item)}</span>
      </div>
      <div className="product-tags">
        <span>{category}</span>
        {tags.map((tag) => <span key={tag}>{tag}</span>)}
        <span>{soldOut ? "库存不足" : `库存 ${stock}`}</span>
        <span>销量 {productSales(props.item)}</span>
      </div>
      <h2>{productName(props.item)}</h2>
      <strong>{cents(props.item.salePriceCents)}</strong>
      <div className="product-actions">
        <button type="button" className="ghost" onClick={props.onDetail}>详情</button>
        <button type="button" disabled={soldOut} onClick={props.onBuy}>{soldOut ? "库存不足" : "购买"}</button>
      </div>
    </article>
  );
}

function ProductDetailPage(props: {
  product: JsonRecord;
  shop: JsonRecord;
  coupons: JsonRecord[];
  selectedCouponId: string;
  onSelectCoupon: (couponId: string) => void;
  onClose: () => void;
  onBuy: () => void;
}) {
  const tags = productTags(props.product);
  const specs = productSpecs(props.product);
  const sections = productDetailSections(props.product);
  const automatic = isAutomaticProduct(props.product);
  return (
    <div className="detail-backdrop" role="dialog" aria-modal="true" aria-label="商品详情页">
      <section className="product-detail-page">
        <div className="detail-toolbar">
          <button type="button" className="ghost" onClick={props.onClose}>返回商城</button>
          <button type="button" onClick={props.onBuy}>立即购买</button>
        </div>

        <section className="detail-hero">
          <div className="detail-image">
            <ImageWithFallback src={productImage(props.product)} alt={productName(props.product)} fallback={<ProductVisual label={productName(props.product)} />} />
          </div>
          <div className="detail-summary">
            <div className="product-tags">
              <span>{text(productRecord(props.product).category, "虚拟商品")}</span>
              {tags.map((tag) => <span key={tag}>{tag}</span>)}
            </div>
            <h1>{productName(props.product)}</h1>
            <p>{text(productRecord(props.product).subtitle, productIntro(props.product))}</p>
            <strong>{cents(props.product.salePriceCents)}</strong>
            <div className="detail-stats">
              <div><span>库存</span><b>{productStock(props.product)}</b></div>
              <div><span>销量</span><b>{productSales(props.product)}</b></div>
              <div><span>发货</span><b>{fulfillmentLabel(props.product)}</b></div>
            </div>
            {specs.length > 0 ? (
              <div className="detail-specs" aria-label="商品规格">
                {specs.map((spec) => <span key={spec}>{spec}</span>)}
              </div>
            ) : null}
            <CouponPicker coupons={props.coupons} selectedCouponId={props.selectedCouponId} onSelect={props.onSelectCoupon} />
          </div>
        </section>

        <section className="detail-content">
          {sections.map((section) => (
            <article key={section.title}>
              <span>{section.title}</span>
              <ul>
                {section.items.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </article>
          ))}
          <article>
            <span>{automatic ? "自动提取" : "人工交付"}</span>
            <p>{automatic
              ? "购买时设置购买密码，订单支付成功后进入订单详情提取卡密。"
              : "订单支付成功后添加本店客服领取账号资料或使用说明。"}</p>
          </article>
        </section>

        <section className="detail-service">
          <ServiceContact shop={props.shop} />
        </section>
      </section>
    </div>
  );
}

function productStock(item?: JsonRecord): number {
  const stock = productRecord(item).stockCount;
  if (typeof stock === "number") return stock;
  if (typeof stock === "string" && stock) return Number(stock);
  return 0;
}

function productSales(item?: JsonRecord): number {
  const sold = productRecord(item).soldCount;
  if (typeof sold === "number") return sold;
  if (typeof sold === "string" && sold) return Number(sold);
  return 0;
}

function productTags(item?: JsonRecord): string[] {
  const tags = productRecord(item).tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

function productSpecs(item?: JsonRecord): string[] {
  const specs = productRecord(item).specs;
  return Array.isArray(specs) ? specs.filter((spec): spec is string => typeof spec === "string" && spec.length > 0) : [];
}

function productDetailSections(item?: JsonRecord): Array<{ title: string; items: string[] }> {
  const sections = productRecord(item).detailSections;
  if (!Array.isArray(sections)) {
    return [
      { title: "商品说明", items: [productIntro(item)] },
      { title: "使用说明", items: [text(productRecord(item).usageGuide, "购买后请在订单中心查看履约状态。")] }
    ];
  }
  return sections
    .filter((section): section is JsonRecord => typeof section === "object" && section !== null && !Array.isArray(section))
    .map((section) => ({
      title: text(section.title, "商品详情"),
      items: Array.isArray(section.items)
        ? section.items.filter((detail): detail is string => typeof detail === "string" && detail.length > 0)
        : []
    }))
    .filter((section) => section.items.length > 0);
}

function productRecord(item?: JsonRecord): JsonRecord {
  return (item?.product as JsonRecord | undefined) ?? {};
}

function productName(item?: JsonRecord): string {
  return text(productRecord(item).name, "虚拟权益");
}

function productImage(item?: JsonRecord): string {
  return text(productRecord(item).imageUrl);
}

function productIntro(item?: JsonRecord): string {
  const description = text(productRecord(item).description);
  if (description) return description;
  const mode = text((productRecord(item).fulfillmentRule as JsonRecord | undefined)?.mode, "manual");
  if (mode === "code_pool") return "自动发码权益，适合标准化兑换场景。";
  return "人工核验后发放，适合需要客服协助的虚拟服务。";
}

function fulfillmentLabel(item?: JsonRecord): string {
  const mode = text((productRecord(item).fulfillmentRule as JsonRecord | undefined)?.mode, "manual");
  return mode === "code_pool" ? "自动发码" : "人工发放";
}

function productDisplayBadge(item?: JsonRecord): string {
  return text(productRecord(item).displayBadge, fulfillmentLabel(item));
}

function isAutomaticProduct(item?: JsonRecord): boolean {
  const mode = text((productRecord(item).fulfillmentRule as JsonRecord | undefined)?.mode, "manual");
  return mode === "code_pool";
}

function requiresProductExtractionCode(item?: JsonRecord): boolean {
  return isAutomaticProduct(item);
}

function isValidPurchasePassword(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 4 && trimmed.length <= 32;
}

function isMainlandChinaMobile(value: string): boolean {
  return /^1[3-9]\d{9}$/.test(value.trim());
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function emailDeliveryStatusText(delivery: JsonRecord | undefined, email: string): string {
  if (!email) return "未填写邮箱";
  const status = text(delivery?.status, "");
  const masked = maskEmail(email);
  if (status === "sent") return `${masked} 已记录发送`;
  if (status === "provider_not_configured") return `${masked} 已记录，邮件服务未配置`;
  if (status === "failed") return `${masked} 发送失败`;
  if (status === "pending") return `${masked} 等待发送`;
  return `${masked} 付款发码后记录投递状态`;
}

function maskEmail(value: string): string {
  const [name, domain] = value.split("@");
  if (!name || !domain) return value;
  return `${name.slice(0, 2)}***@${domain}`;
}

function upsertOrder(orders: JsonRecord[], order: JsonRecord): JsonRecord[] {
  const orderNo = text(order.orderNo);
  const next = orders.filter((item) => text(item.orderNo) !== orderNo);
  return [order, ...next];
}

function belongsToShop(order: JsonRecord, shopId: string): boolean {
  return text(order.shopId, shopId) === shopId;
}

function orderPaidAmount(order: JsonRecord): string {
  const snapshot = order.snapshot as JsonRecord | undefined;
  const amountSnapshot = snapshot?.amountSnapshot as JsonRecord | undefined;
  const quote = snapshot?.quote as JsonRecord | undefined;
  return text(order.buyerPaidAmountCents, text(order.paidAmountCents, text(amountSnapshot?.buyerPaidAmountCents, text(amountSnapshot?.paidAmountCents, text(quote?.buyerPaidAmountCents, text(quote?.paidAmountCents, "0"))))));
}

function orderBaseAmount(order: JsonRecord): string {
  const snapshot = order.snapshot as JsonRecord | undefined;
  const amountSnapshot = snapshot?.amountSnapshot as JsonRecord | undefined;
  const quote = snapshot?.quote as JsonRecord | undefined;
  return text(amountSnapshot?.paidAmountCents, text(quote?.paidAmountCents, text(order.paidAmountCents, "0")));
}

function orderPayableAmount(quote: JsonRecord): string {
  return text(quote.buyerPaidAmountCents, text(quote.paidAmountCents, "0"));
}

function checkoutPayableAmount(quote: JsonRecord, channels: JsonRecord[], selectedChannelId: string | undefined, wallet?: JsonRecord): string {
  const baseAmount = orderPayableAmount(quote);
  const channel = selectedPaymentMethod(channels, effectivePaymentMethodId(channels, selectedChannelId ?? "", wallet, baseAmount));
  return payableAmountWithPaymentFee(baseAmount, channel);
}

function quoteOriginalAmount(quote: JsonRecord): string {
  const quantity = BigInt(text(quote.quantity, "1") || "1");
  const salePriceCents = text(quote.salePriceCents);
  if (salePriceCents) return String(BigInt(salePriceCents) * quantity);
  return text(quote.settlementBasisAmountCents, text(quote.paidAmountCents, "0"));
}

function attachPayment(order: JsonRecord, payment: JsonRecord): JsonRecord {
  const paymentSnapshot = isRecord(payment.paymentSnapshot) ? payment.paymentSnapshot : {};
  const payableAmountCents = text(payment.amountCents, text(paymentSnapshot.amountCents));
  return {
    ...order,
    ...(payableAmountCents ? { buyerPaidAmountCents: payableAmountCents } : {}),
    paymentClient: payment,
    paymentSnapshot,
    paymentStatus: text(payment.status) === "created" ? "paying" : text(order.paymentStatus, "unpaid")
  };
}

function paymentForOrder(order: JsonRecord): JsonRecord | undefined {
  if (isRecord(order.paymentClient)) return order.paymentClient;
  if (isRecord(order.paymentSnapshot)) return {
    status: text(order.paymentSnapshot.status, text(order.paymentStatus)),
    provider: text(order.paymentSnapshot.provider),
    paymentSnapshot: order.paymentSnapshot
  };
  return undefined;
}

function paymentStatusMessage(payment: JsonRecord): string {
  const orderNo = text(payment.orderNo);
  if (text(payment.status) === "pending_manual_confirmation") return `订单 ${orderNo} 已生成个人支付宝收款信息，请付款后等待商户确认。`;
  if (text(payment.status) === "created") return `订单 ${orderNo} 已生成官方支付信息，请完成支付并等待回调确认。`;
  if (text(payment.status) === "already_paid") return `订单 ${orderNo} 已支付。`;
  return text(payment.message, `订单 ${orderNo} 支付信息已更新。`);
}

function humanPaymentStatus(status: string): string {
  const labels: Record<string, string> = {
    created: "等待官方确认",
    paying: "等待官方确认",
    pending_manual_confirmation: "等待商户确认",
    already_paid: "已支付",
    not_configured: "未配置",
    not_implemented: "未开通"
  };
  return labels[status] ?? status;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function inferPaymentVoucherChannel(channel?: JsonRecord): string {
  const type = text(channel?.channelType, "").toLowerCase();
  if (type.includes("alipay")) return "alipay_wap";
  if (type.includes("wechat")) return "wechat_h5";
  return "";
}

function selectedPaymentMethod(channels: JsonRecord[], selectedChannelId?: string): JsonRecord | undefined {
  return channels.find((item) => text(item.id) === selectedChannelId) ?? channels[0];
}

function effectivePaymentMethodId(channels: JsonRecord[], selectedChannelId: string, wallet?: JsonRecord, baseAmountCents?: string): string {
  const balanceDefault = defaultPaymentMethodId(channels, wallet, baseAmountCents);
  if (balanceDefault === "balance") return balanceDefault;
  return channels.some((item) => text(item.id) === selectedChannelId)
    ? selectedChannelId
    : balanceDefault;
}

function defaultPaymentMethodId(channels: JsonRecord[], wallet?: JsonRecord, baseAmountCents?: string): string {
  const balance = channels.find((item) => text(item.id) === "balance" || text(item.provider) === "balance");
  const base = BigInt(baseAmountCents || "0");
  const available = BigInt(text(wallet?.availableBalanceCents, "0"));
  if (balance && base > 0n && available >= base) return text(balance.id);
  const externalDefault = channels.find((item) => text(item.provider) !== "balance" && item.isDefault === true);
  const externalFirst = channels.find((item) => text(item.provider) !== "balance");
  return text((externalDefault ?? externalFirst ?? balance)?.id, "");
}

function defaultRechargePaymentMethodId(channels: JsonRecord[], selectedChannelId?: string): string {
  const externalChannels = channels.filter((item) => text(item.id) !== "balance" && text(item.provider) !== "balance");
  if (externalChannels.some((item) => text(item.id) === selectedChannelId)) return selectedChannelId ?? "";
  const defaultExternal = externalChannels.find((item) => item.isDefault === true);
  return text((defaultExternal ?? externalChannels[0])?.id, "");
}

function isPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

function paymentMethodFeeCents(baseAmountCents: string, channel?: JsonRecord): string {
  const base = BigInt(baseAmountCents || "0");
  const bps = Number(text(channel?.paymentFeeBps, text(channel?.feeBps, "0")));
  if (!Number.isFinite(bps) || bps <= 0) return "0";
  return ((base * BigInt(Math.trunc(bps)) + 9999n) / 10000n).toString();
}

function payableAmountWithPaymentFee(baseAmountCents: string, channel?: JsonRecord): string {
  return String(BigInt(baseAmountCents || "0") + BigInt(paymentMethodFeeCents(baseAmountCents, channel)));
}

function paymentFeeRateLabel(channel?: JsonRecord): string {
  const bps = Number(text(channel?.paymentFeeBps, text(channel?.feeBps, "0")));
  return Number.isFinite(bps) && bps > 0 ? `手续费 ${(bps / 100).toFixed(0)}%` : "";
}

function isPersonalPaymentProvider(provider: string): boolean {
  return provider === "personal_alipay" || provider === "wechat_personal";
}

function isPersonalPaymentMethod(channel?: JsonRecord): boolean {
  const type = text(channel?.channelType);
  return type.startsWith("alipay_personal") || type.startsWith("wechat_personal");
}

function isInterfacePaymentMethod(channel?: JsonRecord): boolean {
  const type = text(channel?.channelType);
  return type.startsWith("alipay_merchant") || type.startsWith("wechat_merchant") || type.startsWith("epay");
}

function isPersonalPayment(payment?: JsonRecord, channel?: JsonRecord): boolean {
  return isPersonalPaymentProvider(paymentProviderFrom(payment, channel)) || isPersonalPaymentMethod(channel);
}

function isOfficialPayment(payment?: JsonRecord, channel?: JsonRecord): boolean {
  const provider = paymentProviderFrom(payment, channel);
  return provider === "alipay_merchant" || provider === "wechat_merchant" || provider === "epay" || isInterfacePaymentMethod(channel);
}

function paymentRedirectUrl(payment?: JsonRecord): string {
  const paymentParams = payment?.paymentParams as JsonRecord | undefined;
  const directAppUrl = text(paymentParams?.directAppUrl);
  if (/^(alipays?:\/\/|weixin:\/\/)/i.test(directAppUrl)) return directAppUrl;
  const explicitUrl = text(paymentParams?.paymentUrl);
  if (explicitUrl) return explicitUrl;
  const qrCodeUrl = text(paymentParams?.qrCodeUrl);
  return /^https?:\/\//.test(qrCodeUrl) && !usableImageSrc(qrCodeUrl) ? qrCodeUrl : "";
}

function openOfficialPayment(payment?: JsonRecord): "submitted" | "redirected" | "missing" {
  if (submitEpayPaymentForm(payment)) return "submitted";
  const redirectUrl = paymentRedirectUrl(payment);
  if (!redirectUrl) return "missing";
  window.location.assign(redirectUrl);
  return "redirected";
}

function submitEpayPaymentForm(payment?: JsonRecord): boolean {
  const paymentParams = payment?.paymentParams as JsonRecord | undefined;
  if (text(payment?.provider) !== "epay" && text((payment?.paymentMethod as JsonRecord | undefined)?.provider) !== "epay") return false;
  const params = paymentParams?.submitParams as JsonRecord | undefined;
  const action = text(paymentParams?.gatewayUrl, text(paymentParams?.submitPaymentUrl).split("?")[0]);
  if (!params || !/^https?:\/\//.test(action)) return false;
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  form.style.display = "none";
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = key;
    input.value = String(value);
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  return true;
}

function paymentProviderFrom(payment?: JsonRecord, channel?: JsonRecord): string {
  const paymentMethod = payment?.paymentMethod as JsonRecord | undefined;
  return text(payment?.provider, text(paymentMethod?.provider, text(channel?.provider, text(channel?.channelType))));
}

function paymentQrUrl(payment?: JsonRecord, channel?: JsonRecord): string {
  const paymentParams = payment?.paymentParams as JsonRecord | undefined;
  const paymentMethod = payment?.paymentMethod as JsonRecord | undefined;
  return text(paymentParams?.qrCodeUrl, text(paymentMethod?.qrUrl, text(channel?.qrUrl)));
}

function paymentChannelDisplayName(channel?: JsonRecord): string {
  const configuredName = text(channel?.displayName);
  if (configuredName) return configuredName;
  const provider = text(channel?.provider);
  if (provider) return paymentProviderDisplayName(provider);
  const type = text(channel?.channelType);
  if (type.startsWith("alipay_merchant")) return "支付宝商户收款";
  if (type.startsWith("wechat_merchant")) return "腾讯/微信商户收款";
  if (type.startsWith("epay")) return "e支付收款";
  if (type.startsWith("alipay_personal")) return "个人支付宝收款";
  if (type.startsWith("wechat_personal")) return "个人微信收款";
  return "店铺收款方式";
}

function paymentProviderDisplayName(provider: string): string {
  if (provider === "alipay_merchant") return "支付宝商户收款";
  if (provider === "wechat_merchant") return "腾讯/微信商户收款";
  if (provider === "epay") return "e支付收款";
  if (provider === "personal_alipay") return "个人支付宝收款";
  if (provider === "wechat_personal") return "个人微信收款";
  if (provider === "balance") return "余额支付";
  return "店铺收款方式";
}

function paymentProviderPublicLabelForH5(provider: string, channel?: JsonRecord): string {
  const serverLabel = text(channel?.publicLabel);
  if (serverLabel) return serverLabel;
  const configuredName = text(channel?.displayName);
  if (configuredName && provider !== "balance") {
    const feeBps = Number(text(channel?.paymentFeeBps, text(channel?.feeBps, "0")));
    return feeBps > 0 ? `${configuredName} +${(feeBps / 100).toFixed(0)}%` : configuredName;
  }
  if (provider === "balance") return "余额支付";
  const feeBps = Number(text(channel?.paymentFeeBps, text(channel?.feeBps, "0")));
  const suffix = feeBps > 0 ? `+${(feeBps / 100).toFixed(0)}%` : "";
  const type = provider || text(channel?.channelType);
  if (type === "personal_alipay" || type.startsWith("alipay_personal")) return `支付宝${suffix}（个人）`;
  if (type === "wechat_personal" || type.startsWith("wechat_personal")) return `微信${suffix}（个人）`;
  if (type === "alipay_merchant" || type.startsWith("alipay_merchant")) return `支付宝${suffix}（商家）`;
  if (type === "wechat_merchant" || type.startsWith("wechat_merchant")) return `微信${suffix}（商家）`;
  if (type === "epay" || type.startsWith("epay")) return `e支付${suffix}（商家）`;
  return paymentChannelDisplayName(channel);
}

function paymentTileTitle(channel: JsonRecord): string {
  const provider = text(channel.provider);
  const type = provider || text(channel.channelType);
  if (type === "balance" || text(channel.id) === "balance") return "余额支付";
  if (type.includes("wechat") || type.includes("alipay") || type.includes("epay")) return paymentProviderPublicLabelForH5(type, channel);
  return paymentProviderPublicLabelForH5(provider, channel);
}

function paymentTileSubtitle(channel: JsonRecord): string {
  const provider = text(channel.provider);
  const type = provider || text(channel.channelType);
  const feeLabel = paymentFeeRateLabel(channel);
  if (type === "balance" || text(channel.id) === "balance") return "原价扣款";
  if (type === "personal_alipay" || type.startsWith("alipay_personal")) return "保存码后扫码";
  if (type === "wechat_personal" || type.startsWith("wechat_personal")) return "保存码后扫码";
  if (type.includes("alipay") || type.includes("wechat") || type.includes("epay")) return feeLabel ? `跳转官方支付 · ${feeLabel}` : "跳转官方支付";
  return "可用";
}

function paymentTypeLabel(provider: string, channel?: JsonRecord): string {
  const type = provider || text(channel?.channelType);
  if (type === "personal_alipay" || type.startsWith("alipay_personal")) return "个人";
  if (type === "wechat_personal" || type.startsWith("wechat_personal")) return "个人";
  if (type === "alipay_merchant" || type.startsWith("alipay_merchant")) return "商家";
  if (type === "wechat_merchant" || type.startsWith("wechat_merchant")) return "商家";
  if (type === "epay" || type.startsWith("epay")) return "商家";
  return "收款方式";
}

function orderProductName(order: JsonRecord): string {
  const snapshot = order.snapshot as JsonRecord | undefined;
  const productSnapshot = snapshot?.productSnapshot as JsonRecord | undefined;
  return text(order.productName, text(snapshot?.productNameSnapshot, text(productSnapshot?.name, "虚拟权益")));
}

function statusLabel(order: JsonRecord): string {
  const refundStatus = text(order.refundStatus, "none");
  if (["refunded", "success", "succeeded"].includes(refundStatus)) return "已退款";
  if (refundStatus !== "none") return "售后处理中";
  if (text(order.paymentStatus) === "paid") return "已支付";
  const method = order.paymentMethodSnapshot as JsonRecord | undefined
    ?? order.paymentSnapshot as JsonRecord | undefined;
  if (isPersonalPaymentMethod(method)) return "待商户确认收款";
  if (isInterfacePaymentMethod(method)) return "待官方确认支付";
  return "待支付";
}

function authLabel(session: AuthSession): string {
  const identityType = text(session.user.identityType);
  if (identityType === "h5_phone") return `手机号用户 ${text(session.user.phone)}`;
  if (identityType.startsWith("wechat")) return "微信用户";
  return "游客身份";
}

function canRecharge(session?: AuthSession): boolean {
  const identityType = text(session?.user.identityType);
  return identityType === "h5_phone" || identityType.startsWith("wechat");
}

function yuanInputValue(centsValue: string): string {
  const centsNumber = Number(centsValue || 0);
  if (!Number.isFinite(centsNumber) || centsNumber <= 0) return "";
  return centsNumber % 100 === 0 ? String(centsNumber / 100) : (centsNumber / 100).toFixed(2);
}

function yuanToCentsInput(value: string): string {
  const normalized = value.replace(/[^\d.]/g, "");
  const [yuan = "", centsPart = ""] = normalized.split(".");
  const centsDigits = centsPart.slice(0, 2).padEnd(2, "0");
  const centsValue = `${yuan || "0"}${centsDigits}`.replace(/^0+(?=\d)/, "");
  return centsValue || "0";
}

const h5RootElement = document.getElementById("root")!;
const h5Runtime = globalThis as typeof globalThis & { __tosellH5Root?: ReturnType<typeof createRoot> };
h5Runtime.__tosellH5Root ??= createRoot(h5RootElement);
h5Runtime.__tosellH5Root.render(<App />);

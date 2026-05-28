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
const defaultShopId = import.meta.env.VITE_DEFAULT_SHOP_ID ?? "shop-1";
const storeAiLogoSrc = "/brand/ai-store-logo.png";

function currentShopId() {
  const path = window.location.pathname;
  const match = path.match(/^\/s\/([^/]+)/);
  return match?.[1] ?? new URLSearchParams(window.location.search).get("shopId") ?? defaultShopId;
}

function App() {
  if (window.location.pathname.startsWith("/user/register")) {
    return <UserRegisterPage />;
  }
  if (window.location.pathname.startsWith("/merchant/register")) {
    return <MerchantRegisterPage />;
  }

  const [shopId, setShopId] = useState(currentShopId());
  const [shop, setShop] = useState<JsonRecord>({});
  const [products, setProducts] = useState<JsonRecord[]>([]);
  const [collectionChannels, setCollectionChannels] = useState<JsonRecord[]>([]);
  const [userCoupons, setUserCoupons] = useState<JsonRecord[]>([]);
  const [orders, setOrders] = useState<JsonRecord[]>(() => readCachedOrders(currentShopId()));
  const [selectedProduct, setSelectedProduct] = useState<JsonRecord | undefined>();
  const [detailProduct, setDetailProduct] = useState<JsonRecord | undefined>();
  const [checkout, setCheckout] = useState<CheckoutState | undefined>();
  const [selectedOrder, setSelectedOrder] = useState<JsonRecord | undefined>();
  const [afterSaleOrder, setAfterSaleOrder] = useState<JsonRecord | undefined>();
  const [orderTab, setOrderTab] = useState<OrderTab>("全部");
  const [message, setMessage] = useState("正在打开店铺");
  const [loading, setLoading] = useState(false);
  const [afterSaleReason, setAfterSaleReason] = useState("权益无法正常使用");
  const [afterSaleDescription, setAfterSaleDescription] = useState("请协助核实权益使用情况");
  const [extractionCode, setExtractionCode] = useState("");
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
      const [nextShop, nextProducts, nextOrders, nextCollectionChannels] = await Promise.all([
        api.shop(targetShopId),
        api.products(targetShopId),
        api.orders(),
        api.collectionChannels(targetShopId)
      ]);
      setShop(nextShop);
      setProducts(nextProducts);
      setCollectionChannels(nextCollectionChannels);
      setSelectedProduct((current) => current ?? nextProducts[0]);
      const mergedOrders = mergeOrders(readCachedOrders(targetShopId), nextOrders.filter((order) => belongsToShop(order, targetShopId)));
      setOrders(mergedOrders);
      writeCachedOrders(targetShopId, mergedOrders);
      const session = api.currentSession();
      setAuth(session);
      if (session) {
        setUserCoupons(await api.coupons(targetShopId));
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
    if (!window.location.pathname.startsWith("/s/") && shopId) {
      window.history.replaceState(null, "", `/s/${shopId}${window.location.hash}`);
    }
    void load(shopId);
  }, []);

  async function openShop(targetShopId: string) {
    setShopId(targetShopId);
    setSelectedProduct(undefined);
    setDetailProduct(undefined);
      setCheckout(undefined);
      setSelectedOrder(undefined);
      setAfterSaleOrder(undefined);
      setExtractOrder(undefined);
      setExtractResult(undefined);
      setOrders(readCachedOrders(targetShopId).filter((order) => belongsToShop(order, targetShopId)));
    window.history.replaceState(null, "", `/s/${targetShopId}`);
    await load(targetShopId);
  }

  function acknowledgeNotice() {
    localStorage.setItem("tosell_notice_ack", "true");
    setShowNotice(false);
  }

  async function startCheckout(product: JsonRecord) {
    try {
      setLoading(true);
      const productId = text(product.id);
      const coupons = await api.coupons(shopId, productId);
      const couponId = text(coupons.find((coupon) => text(coupon.status) === "available" && coupon.applicable !== false)?.id, "");
      const quote = await api.quote(shopId, productId, couponId || undefined);
      setSelectedProduct(product);
      setCheckout({ product, quote, coupons, couponId: couponId || undefined });
      setExtractionCode("");
      setBuyerEmail("");
      setMessage("请确认订单信息");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "报价失败");
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
    try {
      setLoading(true);
      const order = await api.createOrder(
        shopId,
        text(checkout.product.id),
        orderPayableAmount(checkout.quote),
        {
          extractionCode: requiresProductExtractionCode(checkout.product) ? extractionCode : undefined,
          couponId: checkout.couponId,
          buyerEmail: buyerEmail.trim() || undefined,
          collectionChannelId: text(collectionChannels[0]?.id, "")
        }
      );
      updateOrders((current) => upsertOrder(current, order));
      setCheckout(undefined);
      setSelectedOrder(order);
      setMessage(`订单已创建：${text(order.orderNo)}，请按店铺收款信息付款后等待后台确认。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "下单失败");
    } finally {
      setLoading(false);
    }
  }

  function showCollection(order: JsonRecord) {
    setSelectedOrder(order);
    setMessage(`订单 ${text(order.orderNo)} 待收款确认，请使用当前店铺收款通道付款。`);
  }

  async function afterSale() {
    if (!afterSaleOrder) return;
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
    setOrders((current) => {
      const next = updater(current);
      writeCachedOrders(shopId, next);
      return next;
    });
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
              <li>自动发码商品购买时设置纯数字提取码，后台确认收款后按订单提取查看卡密。</li>
              <li>人工交付商品请添加本店客服领取账号或权益。</li>
              <li>遇到发放超时或无法使用，可在订单中心提交售后。</li>
            </ul>
          </section>
        </div>

        <aside className="shop-side desktop-side">
          <section className="account-card">
            <span>个人信息</span>
            <strong>{text(auth?.user.displayName, "欢迎光临")}</strong>
            <p>{auth ? authLabel(auth) : "登录后可在服务端查询订单和售后状态"}</p>
            <AccountBenefits coupons={userCoupons} orders={filteredOrders} />
            <div className="side-actions">
              <button type="button" onClick={() => setShowLogin(true)}>登录/注册</button>
              {auth ? <button type="button" className="ghost" onClick={() => {
                api.logout();
                setAuth(undefined);
                setMessage("已退出登录");
              }}>退出</button> : null}
            </div>
          </section>

          <section className="service">
            <div>
              <strong>客服微信</strong>
              <span>{text(shop.customerServiceWechat, "未配置")}</span>
              <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(text(shop.customerServiceWechat, ""))}>复制微信</button>
            </div>
            <ImageWithFallback src={text(shop.customerServiceQrUrl)} alt="客服二维码" fallback={<div className="qr-empty">客服二维码</div>} />
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
            onDetail={() => {
              setSelectedProduct(item);
              setDetailProduct(item);
            }}
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
        {filteredOrders.length === 0 ? <p className="empty">暂无订单</p> : filteredOrders.slice(0, 8).map((order) => (
          <article className="order" key={text(order.orderNo)}>
            <button type="button" className="order-main" onClick={() => setSelectedOrder(order)}>
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
        <section className="account-card">
          <span>个人信息</span>
          <strong>{text(auth?.user.displayName, "欢迎光临")}</strong>
          <p>{auth ? authLabel(auth) : "登录后可在服务端查询订单和售后状态"}</p>
          <AccountBenefits coupons={userCoupons} orders={filteredOrders} />
          <div className="side-actions">
            <button type="button" onClick={() => setShowLogin(true)}>登录/注册</button>
            {auth ? <button type="button" className="ghost" onClick={() => {
              api.logout();
              setAuth(undefined);
              setMessage("已退出登录");
            }}>退出</button> : null}
          </div>
        </section>

        <section className="service">
          <div>
            <strong>客服微信</strong>
            <span>{text(shop.customerServiceWechat, "未配置")}</span>
            <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(text(shop.customerServiceWechat, ""))}>复制微信</button>
          </div>
          <ImageWithFallback src={text(shop.customerServiceQrUrl)} alt="客服二维码" fallback={<div className="qr-empty">客服二维码</div>} />
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
            <div className="checkout-row"><span>商品金额</span><strong>{cents(checkout.quote.paidAmountCents)}</strong></div>
            {Number(checkout.quote.couponDiscountCents ?? 0) > 0 ? (
              <div className="checkout-row"><span>优惠抵扣</span><strong>-{cents(checkout.quote.couponDiscountCents)}</strong></div>
            ) : null}
            <div className="checkout-row total"><span>应付金额</span><strong>{cents(orderPayableAmount(checkout.quote))}</strong></div>
            {checkout.coupons.length > 0 ? (
              <label className="field">
                <span>优惠券</span>
                <select value={checkout.couponId ?? ""} onChange={(event) => void updateCheckoutCoupon(event.target.value)}>
                  <option value="">不使用优惠券</option>
                  {checkout.coupons.map((coupon) => {
                    const template = coupon.template as JsonRecord | undefined;
                    return (
                      <option key={text(coupon.id)} value={text(coupon.id)} disabled={coupon.applicable === false || text(coupon.status) !== "available"}>
                        {text(template?.name, "优惠券")} {cents(template?.discountCents)}{coupon.applicable === false ? "（当前商品不可用）" : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
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
              <label className="field">
                <span>提取码</span>
                <input
                  inputMode="numeric"
                  value={extractionCode}
                  onChange={(event) => setExtractionCode(event.target.value.replace(/\D/g, "").slice(0, 12))}
                  placeholder="4-12 位纯数字"
                  required
                />
              </label>
            ) : null}
            <p>{requiresProductExtractionCode(checkout.product)
              ? "后台确认收款并发码后，请使用购买时设置的提取码查看。"
              : "本商品由客服人工交付，后台确认收款后请添加店铺客服领取卡密或账号。"}</p>
            <CollectionBox channels={collectionChannels} orderAmountCents={orderPayableAmount(checkout.quote)} />
            <div className="checkout-actions">
              <button type="button" className="ghost" onClick={() => setCheckout(undefined)}>再看看</button>
              <button type="button" disabled={collectionChannels.length === 0 || (requiresProductExtractionCode(checkout.product) && extractionCode.trim().length < 4)} onClick={() => void submitOrder()}>提交订单</button>
            </div>
          </section>
        </div>
      ) : null}

      {detailProduct ? (
        <ProductDetailPage
          product={detailProduct}
          shop={shop}
          onClose={() => setDetailProduct(undefined)}
          onBuy={() => void startCheckout(detailProduct)}
        />
      ) : null}

      {showNotice ? (
        <div className="modal-backdrop notice-backdrop" role="dialog" aria-modal="true" aria-label="购买须知">
          <section className="purchase-notice">
            <span>购买须知</span>
            <h2>重要提醒，请下单前仔细阅读</h2>
            <p>为减少虚拟商品售后争议，请在购买前确认商品名称、发放方式、使用说明和客服处理时效。</p>
            <NoticeItem index="1" title="请认真查看商品详情" text="确认规格、发放方式和使用限制；因未阅读说明造成的问题，按页面规则处理。" />
            <NoticeItem index="2" title="付款请以订单金额为准" text="当前店铺收款通道由后台配置，付款后由商家或平台后台确认收款。" />
            <NoticeItem index="3" title="自动发码需设置提取码" text="提取码由你购买时自行输入，建议 4-12 位纯数字；人工交付商品请添加店铺客服领取。" />
            <NoticeItem index="4" title="售后请从订单中心提交" text="订单中心会保留支付、履约、卡密和售后记录，便于平台仲裁和追踪。" />
            <div className="checkout-actions">
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
            {text(selectedOrder.paymentStatus) === "unpaid" ? <CollectionBox channels={collectionChannels} orderAmountCents={orderPaidAmount(selectedOrder)} /> : null}
            <DeliveryBlock order={selectedOrder} onExtract={() => {
              setExtractOrder(selectedOrder);
              setExtractInput("");
              setExtractResult(undefined);
            }} />
            <div className="checkout-row"><span>客服微信</span><strong>{text(selectedOrder.customerServiceWechat, text(shop.customerServiceWechat, "未配置"))}</strong></div>
            <p>虚拟权益订单会保留支付、履约和售后记录；遇到问题请联系店铺客服。</p>
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
              <span>提取码</span>
              <input
                inputMode="numeric"
                value={extractInput}
                onChange={(event) => setExtractInput(event.target.value.replace(/\D/g, "").slice(0, 12))}
                placeholder="输入购买时设置的提取码"
              />
            </label>
            {extractResult ? <ExtractResult result={extractResult} /> : null}
            <div className="checkout-actions">
              <button type="button" className="ghost" onClick={() => setExtractOrder(undefined)}>返回订单</button>
              <button type="button" disabled={extractInput.trim().length < 4} onClick={() => void submitExtract()}>提取</button>
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
              <button type="button" onClick={() => void afterSale()}>提交售后</button>
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
  const backHref = defaultShopId ? `/s/${defaultShopId}` : "/";

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
      setMessage("入驻申请已提交，平台审核和保证金确认前不可销售或代理商品。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "入驻提交失败");
    } finally {
      setLoading(false);
    }
  }

  const agent = result?.agent as JsonRecord | undefined;
  const shop = result?.shop as JsonRecord | undefined;
  const application = result?.application as JsonRecord | undefined;
  const credential = result?.credential as JsonRecord | undefined;

  return (
    <main className="merchant-page">
      <header className="merchant-header">
        <a href="/">ToSell</a>
        <a href={defaultShopId ? `/s/${defaultShopId}` : "/"}>返回商城</a>
      </header>
      <section className="merchant-register">
        <div className="merchant-copy">
          <span>商户入驻</span>
          <h1>用邀请码开通自己的虚拟权益小店</h1>
          <p>平台邀请码注册为一级商户；一级邀请码注册为二级商户；二级邀请码注册为三级商户。邀请码只绑定供货关系，收益来自商品价差。</p>
          <div className="merchant-rules">
            <div><strong>审核后开店</strong><span>平台审核资料和店铺信息</span></div>
            <div><strong>保证金门槛</strong><span>未确认保证金不能选品、上架和销售</span></div>
            <div><strong>独立店铺</strong><span>前台只展示自己的商品、客服和收款通道</span></div>
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
              <span>商户ID：{text(agent?.id)}</span>
              <span>店铺ID：{text(shop?.id)}</span>
              {credential ? <span>后台账号：{text(credential.account)} / 初始密码：{text(credential.initialPassword)}</span> : null}
              <span>当前状态：{text(agent?.status)} / 保证金 {text(agent?.depositStatus)}</span>
              <p>请等待平台后台审核，并在保证金确认后再配置商品、客服二维码和收款通道。</p>
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

function CollectionBox(props: { channels: JsonRecord[]; orderAmountCents: string }) {
  const channel = props.channels[0];
  const hasQr = Boolean(usableImageSrc(text(channel?.qrUrl, "")));
  if (!channel) {
    return (
      <div className="collection-box unavailable">
        <div>
          <strong>暂无可用收款通道</strong>
          <span>当前店铺还没有审核启用的商户收款通道。</span>
          <small>请联系店铺客服，或等待商户在后台提交并由平台审核启用。</small>
        </div>
      </div>
    );
  }
  return (
    <div className="collection-box">
      <div>
        <strong>店铺收款通道</strong>
        <span>{text(channel.displayName, "商户收款")} / {text(channel.accountName, "未填写账户名")}</span>
        <small>请按订单金额付款，付款后等待商家或平台后台确认收款。</small>
      </div>
      <strong className="collection-amount">{cents(props.orderAmountCents)}</strong>
      {hasQr ? (
        <ImageWithFallback src={text(channel.qrUrl)} alt="店铺收款码" fallback={<div className="qr-empty">收款码</div>} />
      ) : (
        <div className="qr-empty">收款码</div>
      )}
      {text(channel.paymentUrl, "") ? <a href={text(channel.paymentUrl)} target="_blank" rel="noreferrer">打开支付链接</a> : null}
    </div>
  );
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

function DeliveryBlock(props: { order: JsonRecord; onExtract: () => void }) {
  const delivery = props.order.delivery as JsonRecord | undefined;
  const codes = Array.isArray(delivery?.codes) ? delivery.codes as JsonRecord[] : [];
  if (text(delivery?.mode) === "automatic") {
    return (
      <div className="delivery-box">
        <strong>自动卡密</strong>
        <span>{text(delivery?.message, "付款后自动发放卡密")}</span>
        {delivery?.extractionCodeSet ? <small>已设置提取码</small> : null}
        {delivery?.extractable && delivery?.extractionCodeSet ? <button type="button" onClick={props.onExtract}>提取卡密</button> : null}
        {codes.length > 0 ? codes.map((item) => (
          <code key={text(item.codeId, text(item.code))}>{text(item.code)}</code>
        )) : null}
      </div>
    );
  }
  return (
    <div className="delivery-box">
      <strong>人工交付</strong>
      <span>{text(delivery?.message, "请添加店铺客服领取卡密或账号")}</span>
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

  return (
    <article className={props.active ? "product active" : "product"}>
      <div className="product-media">
        <ImageWithFallback src={productImage(props.item)} alt={productName(props.item)} fallback={<ProductVisual label={productName(props.item)} />} />
        <span>{productDisplayBadge(props.item)}</span>
      </div>
      <div className="product-tags">
        <span>{category}</span>
        {tags.map((tag) => <span key={tag}>{tag}</span>)}
        <span>库存 {productStock(props.item)}</span>
        <span>销量 {productSales(props.item)}</span>
      </div>
      <h2>{productName(props.item)}</h2>
      <strong>{cents(props.item.salePriceCents)}</strong>
      <div className="product-actions">
        <button type="button" className="ghost" onClick={props.onDetail}>详情</button>
        <button type="button" onClick={props.onBuy}>购买</button>
      </div>
    </article>
  );
}

function ProductDetailPage(props: { product: JsonRecord; shop: JsonRecord; onClose: () => void; onBuy: () => void }) {
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
              ? "购买时设置提取码，订单支付成功后进入订单详情提取卡密。"
              : "订单支付成功后添加本店客服领取账号资料或使用说明。"}</p>
          </article>
        </section>

        <section className="detail-service">
          <div>
            <span>店铺客服</span>
            <strong>{text(props.shop.customerServiceWechat, "未配置")}</strong>
            <p>购买前如需确认商品规格、库存或售后范围，可以先联系本店客服。</p>
          </div>
          <ImageWithFallback src={text(props.shop.customerServiceQrUrl)} alt="客服二维码" fallback={<div className="qr-empty">客服二维码</div>} />
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
  const rule = productRecord(item).fulfillmentRule as JsonRecord | undefined;
  return isAutomaticProduct(item) && rule?.extractCodeRequired === true;
}

function upsertOrder(orders: JsonRecord[], order: JsonRecord): JsonRecord[] {
  const orderNo = text(order.orderNo);
  const next = orders.filter((item) => text(item.orderNo) !== orderNo);
  return [order, ...next];
}

function mergeOrders(...groups: JsonRecord[][]): JsonRecord[] {
  return groups.flat().reduce<JsonRecord[]>((current, order) => upsertOrder(current, order), []);
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

function orderPayableAmount(quote: JsonRecord): string {
  return text(quote.buyerPaidAmountCents, text(quote.paidAmountCents, "0"));
}

function orderProductName(order: JsonRecord): string {
  const snapshot = order.snapshot as JsonRecord | undefined;
  const productSnapshot = snapshot?.productSnapshot as JsonRecord | undefined;
  return text(order.productName, text(snapshot?.productNameSnapshot, text(productSnapshot?.name, "虚拟权益")));
}

function statusLabel(order: JsonRecord): string {
  if (text(order.refundStatus, "none") !== "none") return "售后处理中";
  if (text(order.paymentStatus) === "paid") return "已支付";
  return "待支付";
}

function authLabel(session: AuthSession): string {
  const identityType = text(session.user.identityType);
  if (identityType === "h5_phone") return `手机号用户 ${text(session.user.phone)}`;
  if (identityType.startsWith("wechat")) return "微信用户";
  return "游客身份";
}

function cacheKey(shopId: string): string {
  return `tosell_h5_orders_${shopId}`;
}

function readCachedOrders(shopId: string): JsonRecord[] {
  try {
    const raw = localStorage.getItem(cacheKey(shopId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is JsonRecord => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
  } catch {
    return [];
  }
}

function writeCachedOrders(shopId: string, orders: JsonRecord[]) {
  localStorage.setItem(cacheKey(shopId), JSON.stringify(orders.slice(0, 20).map(redactCachedOrder)));
}

function redactCachedOrder(order: JsonRecord): JsonRecord {
  const delivery = order.delivery as JsonRecord | undefined;
  if (!delivery) return order;
  return {
    ...order,
    buyerEmail: undefined,
    extractionCodeSet: order.extractionCodeSet,
    delivery: {
      ...delivery,
      buyerEmail: undefined,
      extractionCodeSet: delivery.extractionCodeSet,
      codes: []
    }
  };
}

createRoot(document.getElementById("root")!).render(<App />);

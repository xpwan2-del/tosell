import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, cents, text, type JsonRecord } from "./api.js";
import "./styles.css";

type CheckoutState = {
  product: JsonRecord;
  quote: JsonRecord;
};

const orderTabs = ["全部", "待支付", "已支付", "售后"] as const;
type OrderTab = (typeof orderTabs)[number];

function currentShopId() {
  const path = window.location.pathname;
  const match = path.match(/^\/s\/([^/]+)/);
  return match?.[1] ?? new URLSearchParams(window.location.search).get("shopId") ?? "shop-platform";
}

function App() {
  const [shopId, setShopId] = useState(currentShopId());
  const [shop, setShop] = useState<JsonRecord>({});
  const [products, setProducts] = useState<JsonRecord[]>([]);
  const [orders, setOrders] = useState<JsonRecord[]>(() => readCachedOrders(currentShopId()));
  const [selectedProduct, setSelectedProduct] = useState<JsonRecord | undefined>();
  const [checkout, setCheckout] = useState<CheckoutState | undefined>();
  const [selectedOrder, setSelectedOrder] = useState<JsonRecord | undefined>();
  const [afterSaleOrder, setAfterSaleOrder] = useState<JsonRecord | undefined>();
  const [orderTab, setOrderTab] = useState<OrderTab>("全部");
  const [message, setMessage] = useState("正在打开店铺");
  const [loading, setLoading] = useState(false);
  const [afterSaleReason, setAfterSaleReason] = useState("权益无法正常使用");
  const [afterSaleDescription, setAfterSaleDescription] = useState("请协助核实权益使用情况");

  const theme = useMemo(() => ({ "--brand": text(shop.themeColor, "#106270") }) as React.CSSProperties, [shop.themeColor]);
  const featured = products[0];
  const activeProduct = selectedProduct ?? featured;
  const filteredOrders = orders.filter((order) => belongsToShop(order, shopId)).filter((order) => {
    if (orderTab === "待支付") return text(order.paymentStatus) === "unpaid";
    if (orderTab === "已支付") return text(order.paymentStatus) === "paid" && text(order.refundStatus, "none") === "none";
    if (orderTab === "售后") return text(order.refundStatus, "none") !== "none";
    return true;
  });

  async function load(targetShopId = shopId) {
    setLoading(true);
    try {
      const [nextShop, nextProducts, nextOrders] = await Promise.all([
        api.shop(targetShopId),
        api.products(targetShopId),
        api.orders()
      ]);
      setShop(nextShop);
      setProducts(nextProducts);
      setSelectedProduct((current) => current ?? nextProducts[0]);
      const mergedOrders = mergeOrders(readCachedOrders(targetShopId), nextOrders.filter((order) => belongsToShop(order, targetShopId)));
      setOrders(mergedOrders);
      writeCachedOrders(targetShopId, mergedOrders);
      setMessage("店铺已准备好");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "店铺加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(shopId);
  }, []);

  async function openShop(targetShopId: string) {
    setShopId(targetShopId);
    setSelectedProduct(undefined);
    setCheckout(undefined);
    setSelectedOrder(undefined);
    setAfterSaleOrder(undefined);
    setOrders(readCachedOrders(targetShopId).filter((order) => belongsToShop(order, targetShopId)));
    window.history.replaceState(null, "", `/s/${targetShopId}`);
    await load(targetShopId);
  }

  async function startCheckout(product: JsonRecord) {
    try {
      setLoading(true);
      const quote = await api.quote(shopId, text(product.id));
      setSelectedProduct(product);
      setCheckout({ product, quote });
      setMessage("请确认订单信息");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "报价失败");
    } finally {
      setLoading(false);
    }
  }

  async function submitOrder() {
    if (!checkout) return;
    try {
      setLoading(true);
      const order = await api.createOrder(shopId, text(checkout.product.id), text(checkout.quote.paidAmountCents));
      updateOrders((current) => upsertOrder(current, order));
      setCheckout(undefined);
      setMessage(`订单已创建：${text(order.orderNo)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "下单失败");
    } finally {
      setLoading(false);
    }
  }

  async function pay(order: JsonRecord) {
    try {
      setLoading(true);
      await api.mockPayment(text(order.orderNo), orderPaidAmount(order));
      updateOrders((current) => upsertOrder(current, { ...order, status: "paid", paymentStatus: "paid" }));
      setMessage(`支付已完成：${text(order.orderNo)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "支付失败");
    } finally {
      setLoading(false);
    }
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

  function updateOrders(updater: (current: JsonRecord[]) => JsonRecord[]) {
    setOrders((current) => {
      const next = updater(current);
      writeCachedOrders(shopId, next);
      return next;
    });
  }

  return (
    <main className="page" style={theme}>
      <header className="shop-hero">
        <div className="hero-media">
          <ImageWithFallback src={text(shop.bannerUrl)} alt="" fallback={<div className="hero-placeholder">ToSell</div>} />
        </div>
        <div className="hero-copy">
          <span>{text(shop.ownerType) === "platform" ? "平台自营" : "认证小店"}</span>
          <h1>{text(shop.name, "ToSell 店铺")}</h1>
          <p>{text(shop.shareTitle, text(shop.announcement, "精选虚拟权益，即买即用，售后可查。"))}</p>
          <div className="hero-actions">
            <button type="button" onClick={() => activeProduct && void startCheckout(activeProduct)}>立即购买</button>
            <a href="#orders">查看订单</a>
          </div>
        </div>
      </header>

      <nav className="switcher" aria-label="店铺切换">
        <button type="button" className={shopId === "shop-platform" ? "active" : ""} onClick={() => void openShop("shop-platform")}>平台自营店</button>
        <button type="button" className={shopId === "shop-1" ? "active" : ""} onClick={() => void openShop("shop-1")}>代理 A 小店</button>
      </nav>

      <section className="trust-bar" aria-label="服务承诺">
        <div><strong>虚拟权益</strong><span>购买后按规则发放</span></div>
        <div><strong>客服协助</strong><span>微信/二维码可联系</span></div>
        <div><strong>订单可查</strong><span>支付、履约、售后留痕</span></div>
        <div><strong>售后保障</strong><span>未履约可申请处理</span></div>
      </section>

      <section className="service">
        <div>
          <strong>客服微信</strong>
          <span>{text(shop.customerServiceWechat, "未配置")}</span>
          <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(text(shop.customerServiceWechat, ""))}>复制微信</button>
        </div>
        <ImageWithFallback src={text(shop.customerServiceQrUrl)} alt="客服二维码" fallback={<div className="qr-empty">客服二维码</div>} />
      </section>

      <div className={loading ? "notice loading" : "notice"}>{message}</div>

      <section className="section-head">
        <div>
          <span>精选商品</span>
          <h2>可直接售卖的虚拟权益</h2>
        </div>
        <small>最终金额以下单确认为准</small>
      </section>

      <section className="grid">
        {products.map((item) => (
          <ProductCard
            key={text(item.id)}
            item={item}
            active={text(item.id) === text(activeProduct?.id)}
            onDetail={() => setSelectedProduct(item)}
            onBuy={() => void startCheckout(item)}
          />
        ))}
      </section>

      {activeProduct ? (
        <section className="detail">
          <div>
            <span>商品详情</span>
            <h2>{productName(activeProduct)}</h2>
            <p>{productIntro(activeProduct)}</p>
          </div>
          <dl>
            <div><dt>发放方式</dt><dd>{fulfillmentLabel(activeProduct)}</dd></div>
            <div><dt>售后规则</dt><dd>未完成履约前可提交售后，平台后台处理。</dd></div>
            <div><dt>购买须知</dt><dd>虚拟权益下单后进入订单中心查看状态，遇到问题请联系店铺客服。</dd></div>
          </dl>
          <button type="button" onClick={() => void startCheckout(activeProduct)}>确认购买</button>
        </section>
      ) : null}

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
            {text(order.paymentStatus) === "unpaid" ? <button type="button" onClick={() => void pay(order)}>确认支付（演示）</button> : null}
            {text(order.paymentStatus) === "paid" && text(order.refundStatus, "none") === "none" ? (
              <button type="button" onClick={() => setAfterSaleOrder(order)}>申请售后</button>
            ) : null}
          </article>
        ))}
      </section>

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
            <div className="checkout-row"><span>实付金额</span><strong>{cents(checkout.quote.paidAmountCents)}</strong></div>
            <p>提交后会生成订单，当前阶段使用模拟支付，正式收款将在支付账号开通后接入。</p>
            <div className="checkout-actions">
              <button type="button" className="ghost" onClick={() => setCheckout(undefined)}>再看看</button>
              <button type="button" onClick={() => void submitOrder()}>提交订单</button>
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
            <div className="checkout-row"><span>客服微信</span><strong>{text(selectedOrder.customerServiceWechat, text(shop.customerServiceWechat, "未配置"))}</strong></div>
            <p>虚拟权益订单会保留支付、履约和售后记录；遇到问题请联系店铺客服。</p>
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

function ProductCard(props: { item: JsonRecord; active: boolean; onDetail: () => void; onBuy: () => void }) {
  return (
    <article className={props.active ? "product active" : "product"}>
      <div className="product-mark">{fulfillmentLabel(props.item).slice(0, 1)}</div>
      <div className="product-tags">
        <span>{text(props.item.productType) === "platform_self_operated" ? "官方精选" : "店铺精选"}</span>
        <span>{fulfillmentLabel(props.item)}</span>
        <span>售后可查</span>
      </div>
      <h2>{productName(props.item)}</h2>
      <p>{productIntro(props.item)}</p>
      <strong>{cents(props.item.salePriceCents)}</strong>
      <div className="product-actions">
        <button type="button" className="ghost" onClick={props.onDetail}>详情</button>
        <button type="button" onClick={props.onBuy}>购买</button>
      </div>
    </article>
  );
}

function productRecord(item?: JsonRecord): JsonRecord {
  return (item?.product as JsonRecord | undefined) ?? {};
}

function productName(item?: JsonRecord): string {
  return text(productRecord(item).name, "虚拟权益");
}

function productIntro(item?: JsonRecord): string {
  const mode = text((productRecord(item).fulfillmentRule as JsonRecord | undefined)?.mode, "manual");
  if (mode === "code_pool") return "自动发码权益，适合标准化兑换场景。";
  return "人工核验后发放，适合需要客服协助的虚拟服务。";
}

function fulfillmentLabel(item?: JsonRecord): string {
  const mode = text((productRecord(item).fulfillmentRule as JsonRecord | undefined)?.mode, "manual");
  return mode === "code_pool" ? "自动发码" : "人工发放";
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
  return text(order.paidAmountCents, text(amountSnapshot?.paidAmountCents, text(quote?.paidAmountCents, "0")));
}

function orderProductName(order: JsonRecord): string {
  const snapshot = order.snapshot as JsonRecord | undefined;
  const productSnapshot = snapshot?.productSnapshot as JsonRecord | undefined;
  return text(snapshot?.productNameSnapshot, text(productSnapshot?.name, "虚拟权益"));
}

function statusLabel(order: JsonRecord): string {
  if (text(order.refundStatus, "none") !== "none") return "售后处理中";
  if (text(order.paymentStatus) === "paid") return "已支付";
  return "待支付";
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
  localStorage.setItem(cacheKey(shopId), JSON.stringify(orders.slice(0, 20)));
}

createRoot(document.getElementById("root")!).render(<App />);

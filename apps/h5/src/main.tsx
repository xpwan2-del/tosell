import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, cents, text, type JsonRecord } from "./api.js";
import "./styles.css";

function currentShopId() {
  const path = window.location.pathname;
  const match = path.match(/^\/s\/([^/]+)/);
  return match?.[1] ?? new URLSearchParams(window.location.search).get("shopId") ?? "shop-platform";
}

function App() {
  const [shopId, setShopId] = useState(currentShopId());
  const [shop, setShop] = useState<JsonRecord>({});
  const [products, setProducts] = useState<JsonRecord[]>([]);
  const [orders, setOrders] = useState<JsonRecord[]>([]);
  const [message, setMessage] = useState("加载中");
  const [loading, setLoading] = useState(false);

  const theme = useMemo(() => ({ "--brand": text(shop.themeColor, "#0f5f6f") }) as React.CSSProperties, [shop.themeColor]);

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
      setOrders(nextOrders);
      setMessage("数据已刷新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(shopId);
  }, []);

  async function openShop(targetShopId: string) {
    setShopId(targetShopId);
    window.history.replaceState(null, "", `/s/${targetShopId}`);
    await load(targetShopId);
  }

  async function buy(productId: string) {
    try {
      setLoading(true);
      const quote = await api.quote(shopId, productId);
      const order = await api.createOrder(shopId, productId, text(quote.paidAmountCents));
      setMessage(`订单已创建：${text(order.orderNo)}`);
      await load(shopId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "下单失败");
    } finally {
      setLoading(false);
    }
  }

  async function pay(order: JsonRecord) {
    try {
      setLoading(true);
      await api.mockPayment(text(order.orderNo), text(order.paidAmountCents));
      setMessage(`支付已完成：${text(order.orderNo)}`);
      await load(shopId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "支付失败");
    } finally {
      setLoading(false);
    }
  }

  async function afterSale(order: JsonRecord) {
    try {
      setLoading(true);
      await api.createAfterSale(text(order.orderNo), text(order.paidAmountCents));
      setMessage(`售后已提交：${text(order.orderNo)}`);
      await load(shopId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "售后提交失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page" style={theme}>
      <header className="shop-hero">
        {shop.bannerUrl ? <img src={text(shop.bannerUrl)} alt="" /> : null}
        <div>
          <span>{text(shop.ownerType) === "platform" ? "平台自营" : "渠道店铺"}</span>
          <h1>{text(shop.name, "ToSell 店铺")}</h1>
          <p>{text(shop.shareTitle, text(shop.announcement, "精选虚拟权益"))}</p>
        </div>
      </header>

      <nav className="switcher">
        <button type="button" onClick={() => void openShop("shop-platform")}>平台自营店</button>
        <button type="button" onClick={() => void openShop("shop-1")}>代理 A 小店</button>
      </nav>

      <section className="service">
        <div>
          <strong>客服微信</strong>
          <span>{text(shop.customerServiceWechat, "未配置")}</span>
        </div>
        {shop.customerServiceQrUrl ? <img src={text(shop.customerServiceQrUrl)} alt="客服二维码" /> : null}
      </section>

      <div className={loading ? "notice loading" : "notice"}>{message}</div>

      <section className="grid">
        {products.map((item) => {
          const product = item.product as JsonRecord | undefined;
          return (
            <article className="product" key={text(item.id)}>
              <span>{text(item.productType)}</span>
              <h2>{text(product?.name, "虚拟权益")}</h2>
              <strong>{cents(item.salePriceCents)}</strong>
              <p>{text((product?.fulfillmentRule as JsonRecord | undefined)?.mode, "manual")}</p>
              <button type="button" onClick={() => void buy(text(item.id))}>购买</button>
            </article>
          );
        })}
      </section>

      <section className="orders">
        <h2>我的订单</h2>
        {orders.length === 0 ? <p>暂无订单</p> : orders.slice(0, 5).map((order) => (
          <div key={text(order.orderNo)}>
            <span>{text(order.orderNo)}</span>
            <strong>{cents(order.paidAmountCents)}</strong>
            <em>{text(order.status)}</em>
            {text(order.paymentStatus) === "unpaid" ? <button type="button" onClick={() => void pay(order)}>模拟支付</button> : null}
            {text(order.paymentStatus) === "paid" && text(order.refundStatus) === "none" ? <button type="button" onClick={() => void afterSale(order)}>申请售后</button> : null}
          </div>
        ))}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

import { api, cents, text } from "../../utils/api.js";

Page({
  data: {
    shopId: "shop-1",
    productId: "",
    loading: false,
    error: "",
    quote: {} as Record<string, unknown>,
    extractionCode: "",
    product: {
      id: "",
      name: "",
      salePrice: "",
      rightsDesc: "",
      fulfillmentType: "",
      afterSaleRule: "",
      status: ""
    }
  },
  onLoad(this: any, query: Record<string, string | undefined>) {
    this.setData({ productId: query.id ?? "ap-1", shopId: query.shopId ?? "shop-1" });
    void this.loadProduct();
  },
  async loadProduct(this: any) {
    this.setData({ loading: true, error: "" });
    try {
      const [agentProduct, quote] = await Promise.all([
        api.product(this.data.productId),
        api.quote(this.data.shopId, this.data.productId)
      ]);
      const product = agentProduct.product as Record<string, unknown> | undefined;
      this.setData({
        quote,
        product: {
          id: text(agentProduct.id),
          name: text(product?.name),
          salePrice: cents(agentProduct.salePriceCents),
          rightsDesc: "购买后可在订单中查看权益凭证",
          fulfillmentType: text((product?.fulfillmentRule as Record<string, unknown> | undefined)?.mode, "manual"),
          afterSaleRule: "未履约可申请售后，已使用按规则处理",
          status: text(agentProduct.status)
        }
      });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "加载失败" });
    } finally {
      this.setData({ loading: false });
    }
  },
  onExtractionCodeInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ extractionCode: String(event.detail.value).replace(/\D/g, "").slice(0, 12) });
  },
  async createOrder(this: any) {
    try {
      const order = await api.createOrder(
        this.data.shopId,
        this.data.productId,
        text(this.data.quote.paidAmountCents),
        this.data.product.fulfillmentType === "code_pool" ? this.data.extractionCode : undefined
      );
      wx.navigateTo({ url: `/pages/payment/result?orderNo=${order.orderNo}` });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "下单失败", icon: "none" });
    }
  }
});

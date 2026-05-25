import { api, cents, text } from "../../utils/api.js";

Page({
  data: {
    shopId: "shop-1",
    loading: false,
    error: "",
    shop: {
      name: "",
      announcement: "",
      customerServiceWechat: "",
      status: ""
    },
    products: [] as Array<Record<string, unknown>>
  },
  onLoad(this: any, query: Record<string, string | undefined>) {
    const shopId = query.shopId ?? "shop-1";
    this.setData({ shopId });
    void this.loadShop();
  },
  async loadShop(this: any) {
    this.setData({ loading: true, error: "" });
    try {
      const [shop, products] = await Promise.all([
        api.shop(this.data.shopId),
        api.shopProducts(this.data.shopId)
      ]);
      this.setData({
        shop,
        products: products.map((item: Record<string, unknown>) => ({
          ...item,
          displayName: text((item.product as Record<string, unknown> | undefined)?.name),
          displayPrice: cents(item.salePriceCents)
        }))
      });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "加载失败" });
    } finally {
      this.setData({ loading: false });
    }
  },
  copyServiceWechat(this: any) {
    wx.setClipboardData({ data: text(this.data.shop.customerServiceWechat, "") });
  },
  openProduct(this: any, event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/product/detail?id=${id}&shopId=${this.data.shopId}` });
  }
});

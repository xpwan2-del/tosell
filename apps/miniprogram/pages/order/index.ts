import { api, cents, text } from "../../utils/api.js";

Page({
  data: {
    loading: false,
    error: "",
    orders: [] as Array<Record<string, unknown>>
  },
  onLoad(this: any) {
    void this.loadOrders();
  },
  async loadOrders(this: any) {
    this.setData({ loading: true, error: "" });
    try {
      const orders = await api.orders();
      this.setData({
        orders: orders.map((order: Record<string, unknown>) => ({
          ...order,
          paidAmount: cents(order.paidAmountCents),
          productName: text(order.productName)
        }))
      });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "加载失败" });
    } finally {
      this.setData({ loading: false });
    }
  },
  openOrder(this: any, event: WechatMiniprogram.TouchEvent) {
    const orderNo = event.currentTarget.dataset.orderNo;
    wx.navigateTo({ url: `/pages/order/detail?orderNo=${orderNo}` });
  }
});

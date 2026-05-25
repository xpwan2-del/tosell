import { api, cents, text } from "../../utils/api.js";

Page({
  data: {
    orderNo: "",
    loading: false,
    error: "",
    paymentResult: "待模拟支付",
    paidAmount: "0.00",
    order: {
      orderNo: "",
      paymentStatus: "",
      fulfillmentStatus: ""
    }
  },
  onLoad(this: any, query: Record<string, string | undefined>) {
    this.setData({ orderNo: query.orderNo ?? "" });
    if (query.orderNo) void this.loadOrder();
  },
  async loadOrder(this: any) {
    this.setData({ loading: true, error: "" });
    try {
      const order = await api.order(this.data.orderNo);
      this.setData({
        paidAmount: cents(order.paidAmountCents),
        order: {
          orderNo: text(order.orderNo),
          paymentStatus: text(order.paymentStatus),
          fulfillmentStatus: text(order.fulfillmentStatus)
        },
        paymentResult: order.paymentStatus === "paid" ? "支付成功" : "待模拟支付"
      });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "加载失败" });
    } finally {
      this.setData({ loading: false });
    }
  },
  async simulatePayment(this: any) {
    try {
      const amountCents = String(Math.round(Number(this.data.paidAmount) * 100));
      const result = await api.mockPayment(this.data.orderNo, amountCents);
      this.setData({ paymentResult: text(result.status, "processed") });
      wx.showToast({ title: "支付回调已处理", icon: "none" });
      void this.loadOrder();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "支付失败", icon: "none" });
    }
  },
  openOrder(this: any) {
    wx.navigateTo({ url: `/pages/order/detail?orderNo=${this.data.orderNo}` });
  },
  openOrders() {
    wx.navigateTo({ url: "/pages/order/index" });
  }
});

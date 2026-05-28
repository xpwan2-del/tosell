import { api, cents, text } from "../../utils/api.js";

Page({
  data: {
    orderNo: "",
    loading: false,
    error: "",
    paidAmount: "0.00",
    refundCents: "",
    refundReasonCode: "fulfillment_issue",
    refundDescription: "权益未按预期发放",
    order: {
      orderNo: "",
      status: "",
      paymentStatus: "",
      fulfillmentStatus: "",
      refundStatus: "",
      settlementStatus: "",
      entitlement: "履约成功后显示权益凭证",
      entitlementCodes: [] as string[],
      deliveryMessage: "付款后按商品规则发放"
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
      const delivery = order.delivery as Record<string, unknown> | undefined;
      const codes = Array.isArray(delivery?.codes)
        ? delivery.codes.map((item) => text((item as Record<string, unknown>).code)).filter(Boolean)
        : [];
      this.setData({
        paidAmount: cents(order.paidAmountCents),
        refundCents: text(order.paidAmountCents, this.data.refundCents),
        order: {
          orderNo: text(order.orderNo),
          status: text(order.status),
          paymentStatus: text(order.paymentStatus),
          fulfillmentStatus: text(order.fulfillmentStatus),
          refundStatus: text(order.refundStatus),
          entitlement: codes.length > 0 ? "卡密已自动发放" : text(delivery?.message, order.fulfillmentStatus === "success" ? "权益已发放，请联系客服核验凭证" : "履约成功后显示权益凭证"),
          entitlementCodes: codes,
          deliveryMessage: text(delivery?.message, "付款后按商品规则发放")
        }
      });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "加载失败" });
    } finally {
      this.setData({ loading: false });
    }
  },
  onRefundCentsInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ refundCents: event.detail.value });
  },
  onRefundReasonInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ refundReasonCode: event.detail.value });
  },
  onRefundDescriptionInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ refundDescription: event.detail.value });
  },
  async requestRefund(this: any) {
    try {
      await api.createAfterSaleWithReason(
        this.data.orderNo,
        this.data.refundCents,
        this.data.refundReasonCode,
        this.data.refundDescription
      );
      wx.showToast({ title: "售后申请已提交", icon: "none" });
      void this.loadOrder();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "售后提交失败", icon: "none" });
    }
  }
});

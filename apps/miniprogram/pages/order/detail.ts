Page({
  data: {
    order: {
      orderNo: "mock-order",
      status: "待支付",
      fulfillmentStatus: "未履约",
      refundStatus: "无",
      entitlement: "支付后发放"
    }
  },
  requestRefund() {
    wx.showToast({ title: "售后申请入口待接入 API", icon: "none" });
  }
});

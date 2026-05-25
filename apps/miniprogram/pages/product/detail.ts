Page({
  data: {
    product: {
      id: "p1",
      name: "示例虚拟权益",
      salePrice: "150.00",
      rightsDesc: "购买后发放虚拟权益凭证",
      fulfillmentType: "自动或人工发放",
      afterSaleRule: "未履约可退款，已使用按规则仲裁"
    }
  },
  createOrder() {
    wx.navigateTo({ url: "/pages/order/detail?orderNo=mock-order" });
  }
});

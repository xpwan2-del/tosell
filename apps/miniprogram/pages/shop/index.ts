Page({
  data: {
    shop: {
      name: "示例代理小店",
      announcement: "虚拟商品购买后按规则发放权益",
      serviceWechat: "demo-service"
    },
    products: [
      { id: "p1", name: "示例虚拟权益", salePrice: "150.00" }
    ]
  },
  copyServiceWechat(this: any) {
    wx.setClipboardData({ data: this.data.shop.serviceWechat });
  },
  openProduct(this: any, event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/product/detail?id=${id}` });
  }
});

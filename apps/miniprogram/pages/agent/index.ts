import { api, cents, text } from "../../utils/api.js";

Page({
  data: {
    loading: false,
    error: "",
    priceCents: "15000",
    contactPhone: "13800000000",
    customerServiceWechat: "agent_a_service",
    customerServiceQrUrl: "https://example.test/qr-agent-a.png",
    shopName: "云享数码权益店",
    announcement: "购买后按商品规则发放权益",
    selectedPlatformProductId: "prod-1",
    selectedAgentProductId: "ap-1",
    ownProductName: "代理自有课程权益",
    ownProductSalePriceCents: "19900",
    ownProductMinPriceCents: "9900",
    themeColor: "#00aa88",
    shareTitle: "代理 A 精选权益",
    bannerUrl: "https://example.test/banner.png",
    shop: {} as Record<string, unknown>,
    dashboard: {} as Record<string, unknown>,
    platformProducts: [] as Array<Record<string, unknown>>,
    agentProducts: [] as Array<Record<string, unknown>>,
    orders: [] as Array<Record<string, unknown>>,
    settlements: [] as Array<Record<string, unknown>>,
    clawbacks: [] as Array<Record<string, unknown>>,
    notifications: [] as Array<Record<string, unknown>>
  },
  onLoad(this: any) {
    void this.loadAgentCenter();
  },
  async loadAgentCenter(this: any) {
    this.setData({ loading: true, error: "" });
    try {
      const [shop, dashboard, products, orders, settlements, clawbacks, notifications] = await Promise.all([
        api.agentShop(),
        api.agentDashboard(),
        Promise.all([api.platformProducts(), api.agentProducts()]),
        api.agentOrders(),
        api.settlements(),
        api.clawbacks(),
        api.notifications()
      ]);
      const [platformProducts, agentProducts] = products;
      this.setData({
        shop,
        dashboard: {
          ...dashboard,
          gmv: cents(dashboard.gmvCents),
          expectedIncome: cents(dashboard.expectedIncomeCents),
          refundRate: `${(Number(dashboard.refundRateBps ?? 0) / 100).toFixed(2)}%`
        },
        shopName: text(shop.name, this.data.shopName),
        announcement: text(shop.announcement, this.data.announcement),
        customerServiceWechat: text(shop.customerServiceWechat, this.data.customerServiceWechat),
        customerServiceQrUrl: text(shop.customerServiceQrUrl, this.data.customerServiceQrUrl),
        themeColor: text(shop.themeColor, this.data.themeColor),
        shareTitle: text(shop.shareTitle, this.data.shareTitle),
        bannerUrl: text(shop.bannerUrl, this.data.bannerUrl),
        platformProducts: platformProducts.map((item: Record<string, unknown>) => ({
          ...item,
          supplyPrice: cents(item.supplyPriceCents),
          minSalePrice: cents(item.minSalePriceCents),
          suggestedSalePrice: cents(item.suggestedSalePriceCents)
        })),
        agentProducts: agentProducts.map((item: Record<string, unknown>) => {
          const product = item.product as Record<string, unknown> | undefined;
          return {
            ...item,
            productName: text(product?.name),
            salePrice: cents(item.salePriceCents),
            supplyPrice: cents(product?.supplyPriceCents),
            minSalePrice: cents(product?.minSalePriceCents)
          };
        }),
        orders: orders.map((item: Record<string, unknown>) => ({
          ...item,
          paidAmount: cents((item.snapshot as Record<string, unknown> | undefined)?.amountSnapshot && ((item.snapshot as Record<string, unknown>).amountSnapshot as Record<string, unknown>).paidAmountCents),
          expectedIncome: cents((item.snapshot as Record<string, unknown> | undefined)?.amountSnapshot && ((item.snapshot as Record<string, unknown>).amountSnapshot as Record<string, unknown>).agentExpectedIncomeCents)
        })),
        settlements,
        clawbacks,
        notifications
      });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "加载失败" });
    } finally {
      this.setData({ loading: false });
    }
  },
  async submitApplication(this: any) {
    try {
      await api.submitApplication(this.data.contactPhone, this.data.customerServiceWechat);
      wx.showToast({ title: "入驻资料已提交", icon: "none" });
      void this.loadAgentCenter();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "提交失败", icon: "none" });
    }
  },
  async saveShop(this: any) {
    try {
      await api.saveAgentShop(this.data.shopName, this.data.announcement, this.data.customerServiceWechat, this.data.customerServiceQrUrl);
      wx.showToast({ title: "店铺资料已保存", icon: "none" });
      void this.loadAgentCenter();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "保存失败", icon: "none" });
    }
  },
  onPriceInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ priceCents: event.detail.value });
  },
  onContactPhoneInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ contactPhone: event.detail.value });
  },
  onCustomerServiceInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ customerServiceWechat: event.detail.value });
  },
  onCustomerServiceQrInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ customerServiceQrUrl: event.detail.value });
  },
  onShopNameInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ shopName: event.detail.value });
  },
  onAnnouncementInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ announcement: event.detail.value });
  },
  onPlatformProductInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ selectedPlatformProductId: event.detail.value });
  },
  onAgentProductInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ selectedAgentProductId: event.detail.value });
  },
  onOwnProductNameInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ ownProductName: event.detail.value });
  },
  onOwnProductSalePriceInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ ownProductSalePriceCents: event.detail.value });
  },
  onOwnProductMinPriceInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ ownProductMinPriceCents: event.detail.value });
  },
  onThemeColorInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ themeColor: event.detail.value });
  },
  onShareTitleInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ shareTitle: event.detail.value });
  },
  onBannerUrlInput(this: any, event: WechatMiniprogram.InputEvent) {
    this.setData({ bannerUrl: event.detail.value });
  },
  async saveDecor(this: any) {
    try {
      await api.saveShopDecor(this.data.themeColor, this.data.shareTitle, this.data.bannerUrl);
      wx.showToast({ title: "店铺装修已保存", icon: "none" });
      void this.loadAgentCenter();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "装修保存失败", icon: "none" });
    }
  },
  async batchSelectProducts(this: any) {
    try {
      await api.batchSelectPlatformProducts();
      wx.showToast({ title: "批量选品已处理", icon: "none" });
      void this.loadAgentCenter();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "批量选品失败", icon: "none" });
    }
  },
  async selectPlatformProduct(this: any) {
    try {
      const selected = await api.selectPlatformProduct(this.data.selectedPlatformProductId, this.data.priceCents);
      wx.showToast({ title: "商品已上架", icon: "none" });
      this.setData({ selectedAgentProductId: text(selected.id, this.data.selectedAgentProductId) });
      void this.loadAgentCenter();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "上架失败", icon: "none" });
    }
  },
  async updatePrice(this: any) {
    try {
      await api.updatePrice(this.data.selectedAgentProductId, this.data.priceCents);
      wx.showToast({ title: "售价已保存", icon: "none" });
      void this.loadAgentCenter();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "改价失败", icon: "none" });
    }
  },
  async submitOwnProduct(this: any) {
    try {
      await api.submitOwnProduct(this.data.ownProductName, this.data.ownProductSalePriceCents, this.data.ownProductMinPriceCents);
      wx.showToast({ title: "自有商品已提交审核", icon: "none" });
      void this.loadAgentCenter();
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : "提交失败", icon: "none" });
    }
  }
});

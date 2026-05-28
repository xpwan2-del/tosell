App({
  globalData: {
    apiBaseUrl: "http://localhost:3000",
    authToken: "",
    userId: "user-1",
    agentId: "agent-1",
    shopId: "shop-1"
  },
  onLaunch() {
    wx.login({
      success: (result) => {
        if (!result.code) return;
        const app = this as unknown as { globalData: { apiBaseUrl: string; authToken: string; userId: string } };
        wx.request<{ token: string; user: { userId: string } }>({
          url: `${app.globalData.apiBaseUrl}/api/auth/wechat/miniprogram/login`,
          method: "POST",
          header: { "content-type": "application/json" },
          data: { code: result.code },
          success(response) {
            if (response.data?.token) app.globalData.authToken = response.data.token;
            if (response.data?.user?.userId) app.globalData.userId = response.data.user.userId;
          }
        });
      }
    });
  }
});

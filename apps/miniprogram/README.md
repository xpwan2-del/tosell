# Mini-program MVP

当前是 native 微信小程序页面结构和 API 约定，默认 API 地址在 `app.ts` 的 `globalData.apiBaseUrl` 中配置为 `http://localhost:3000`。

页面覆盖：

- `pages/shop/index`：代理独立店铺、商品列表、客服微信复制。
- `pages/product/detail`：商品详情、后端报价、创建订单。
- `pages/payment/result`：支付结果页，使用 mock 支付回调模拟支付成功。
- `pages/order/detail`：订单状态、履约状态、权益提示、售后申请。
- `pages/agent/index`：代理中心的入驻、店铺、选品定价、订单收益、结算和追扣记录。

用户购买页不展示平台供货价、服务费、代理收益、结算或冻结金额；代理中心可展示平台商品价格口径和收益记录，最终金额以后端 API 返回为准。

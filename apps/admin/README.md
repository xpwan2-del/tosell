# Admin MVP

Vite React 管理台默认访问 `http://localhost:3000` 的 Fastify MVP API。

可覆盖的演示入口：

- 平台后台：基础看板、代理审核、保证金、店铺、商品、订单、履约、售后退款、结算、风控、审计。
- 代理中心：入驻与店铺、选品与定价、订单收益、结算记录、追扣记录。

本地运行：

```bash
npm run api:dev
npm run admin:dev
```

可通过 `VITE_API_BASE_URL` 指向其他 API 地址。管理台使用 demo mock header，不包含真实密钥。

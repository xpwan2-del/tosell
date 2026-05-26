# 微商小店虚拟商品供货平台

本项目是一个微信小程序 + H5 方向的虚拟商品销售与供货平台。平台既可以自己开设平台自营店直接销售，也可以向渠道商供货；渠道商审核入驻并缴纳保证金后，可以拥有自己的小店、客服入口、商品售价和推广链接。用户可以在平台自营店或渠道小店购买虚拟商品。

本项目不做多级分销、返佣、团队业绩奖、邀请奖励或拉人头收益。后续允许平台自营与受控两级渠道供货并存：平台自营店 -> 消费者；平台供货 -> 一级渠道商 -> 二级渠道商 -> 消费者。渠道收益来自供货价差，不按招募人数、团队订单或返佣比例计算。

## 开发依据

开发、测试、产品讨论和 CCB agent 协作都以 `docs/` 下的文档为准：

- [项目需求说明](docs/01-product-requirements.md)
- [业务规则与账务规则](docs/02-business-rules.md)
- [功能卡片与开发计划](docs/03-development-cards.md)
- [测试验收与上线清单](docs/04-testing-and-release.md)
- [待确认问题](docs/05-open-questions.md)
- [系统架构](docs/06-system-architecture.md)
- [后台、后端与数据库计划](docs/07-admin-backend-database-plan.md)
- [状态机与权限](docs/08-state-machines-and-permissions.md)
- [API、测试与发布计划](docs/09-api-testing-release-plan.md)
- [V2 支付开通与对接流程](docs/10-v2-payment-onboarding.md)
- [V2 非支付经营增强交付说明](docs/11-v2-non-payment-release.md)
- [H5 与受控两级渠道供货开发计划](docs/12-h5-and-two-tier-channel-plan.md)

## 第一版核心闭环

平台自营闭环：平台配置自营店 -> 上架自营商品 -> 用户下单支付 -> 虚拟权益发放 -> 退款/售后处理 -> 平台收入/成本对账。

渠道闭环：渠道入驻审核 -> 缴纳保证金 -> 配置独立小店 -> 选择平台商品或提交自有商品审核 -> 设置销售价/转供价 -> 分享店铺 -> 用户下单支付 -> 虚拟权益发放 -> 退款/售后处理 -> T+1 结算 -> 财务对账。

## 第一版不做

- 三级渠道或更多层级
- 下级返佣
- 团队奖、平级奖、领导奖
- 邀请奖励、拉人奖励
- 复杂 CRM
- 复杂营销活动
- 自动化私域运营
- 开放平台 API

## 当前阶段

当前已进入 V1 MVP 实现阶段。仓库包含：

- `packages/database`：Prisma 数据模型、种子数据入口。
- `packages/core`：金额计算、退款拆账、结算筛选、权限隔离、幂等工具和单元测试。
- `apps/api`：Fastify API 骨架，含店铺/商品、订单创建、mock 支付/退款回调、履约、退款拆账、结算、保证金、风控、审计和权限检查示例。
- `apps/admin`：平台后台/运营财务工作台骨架。
- `apps/miniprogram`：微信小程序用户端、商品、订单、代理中心页面结构。

V2 已在本地能力层加入经营增强：店铺装修、代理经营看板、批量选品、权益码池、模拟自动履约、消息通知、风险看板和支付开通指引。真实支付仍需等待微信支付商户号、证书和回调域名开通后接入。

## 本地命令

```bash
npm install
npm test
npm run typecheck
npm run db:validate
npm run api:dev
npm run admin:dev
```

`db:validate` 默认使用示例 `DATABASE_URL` 校验 Prisma schema。真实环境需要按 `.env.example` 配置 PostgreSQL、微信小程序和支付参数。

## API 本地联调

```bash
npm run api:dev
```

开发期 API 使用内存 demo store，不依赖真实 PostgreSQL；正式环境必须替换为 Prisma/PostgreSQL 事务服务、真实登录态和微信支付验签。mock 认证头：

- 用户端：`x-user-id`
- 代理端：`x-agent-id`、`x-shop-id`
- 后台：`x-admin-id`、`x-admin-role: operator | finance | admin`

主要 MVP 分组：

- `/api/user/*`：店铺、商品、订单报价/创建、订单详情、售后申请。
- `/api/agent/*`：入驻、店铺、商品定价、订单收益、结算记录、追扣记录。
- `/api/admin/*`：代理审核、商品、订单、履约、退款拆账、结算、保证金、风控、审计。
- `/api/callbacks/*`：mock 支付回调、mock 退款回调，按幂等键去重。
- `/api/exports/*`：基础对账摘要。

# ToSell 后台负责模块需求文档与开发计划

## 1. 文档目标

本文档用于明确我负责的后台模块范围、业务目标、页面/API/数据库/权限/审计/风控要求，以及 3 天内可执行的开发计划。

本次负责模块：

1. 店铺设置
2. 商户管理
3. 下级供货
4. 风控日志
5. 结算
6. 收款配置

参考基线：

- `README.md`
- `docs/00-canonical-development-baseline.md`
- `docs/01-product-requirements.md`
- `docs/02-business-rules.md`
- `docs/16-page-level-production-acceptance-test-plan.md`
- `apps/admin`
- `apps/api`
- `packages/database`

## 2. 模块边界

### 2.1 我负责

我负责后台中与平台运营、商户配置、收款、结算、风控和下级供货相关的管理能力。

具体包括：

- 平台或商户店铺基础设置、客服二维码、公告、装修配置的后台维护。
- 商户入驻申请、审核、手动创建、保证金确认/扣减、商户状态管理。
- 二级商户供货关系、供货资格、供货商品报价和下级供货开关。
- 风控冻结、解冻、风险看板、风控日志、审计日志查看。
- 商户结算候选、结算单生成、打款确认、扣款和流水查看。
- 平台和商户收款配置、支付方式启停、默认通道、回调异常、查单、人工确认。

### 2.2 我不负责

以下模块由老板或其它人负责，本次不重复开发：

- 商品管理
- 订单管理
- 发货
- 售后退款
- 优惠券
- 库存卡密
- H5 商品购买主流程
- 商品详情页、购物车、用户端营销页面

如本模块必须联动上述模块，只做最小联动：

- 结算读取订单成交金额和退款状态，但不改订单业务规则。
- 风控冻结订单/店铺时影响交易和履约状态，但不重写订单、发货、售后逻辑。
- 收款配置影响 H5 下单支付方式展示，但 H5 只读取后端公开字段，不接触密钥。
- 下级供货读取商品、库存、价格基础数据，但不新增商品管理能力。

## 3. 当前代码现状判断

后台菜单中已存在相关模块入口：

- `shops`：店铺设置，已有，需要补齐/优化。
- `merchants`：商户管理，已有，需要补齐/优化。
- `secondTierChannels`：下级供货，已有，需要补齐/优化。
- `risk`：风控日志，已有，需要补齐/优化。
- `settlements`：结算，已有，需要补齐/优化。
- `payment`：收款配置，已有，需要重点补齐/优化。

API 中已存在相关接口：

- 店铺设置：`/api/merchant/shop`、`/api/admin/shops/:shopId/collection`、`/api/admin/shops/:shopId/service-qrcode`
- 商户管理：`/api/merchant/applications`、`/api/admin/merchant-applications`、`/api/admin/merchants/:merchantId/review`、`/api/admin/merchants/manual`、`/api/admin/deposits/:merchantId/confirm`
- 下级供货：`/api/admin/merchant-supply`、`/api/admin/merchant-supply/relations`、`/api/admin/merchant-supply/offers`、`/api/merchant/supply/offers`
- 风控日志：`/api/admin/risk-freezes`、`/api/admin/risk-dashboard`
- 结算：`/api/admin/settlements`、`/api/admin/settlements/candidate`、`/api/admin/settlements/generate`、`/api/admin/settlements/:settlementNo/payouts`
- 收款配置：`/api/admin/payment-methods`、`/api/merchant/payment-methods`、`/api/admin/payment-callbacks`、`/api/admin/payment-exceptions`、`/api/admin/orders/:orderNo/payment-query`

数据库中已存在相关对象：

- 商户：`MerchantAccount`、`Merchant`、`MerchantApplication`、`MerchantInviteCode`
- 店铺：`Shop`、`ShopProductGroup`、`ShopCustomerServiceBinding`
- 收款：`CollectionPaymentConfig`、`PaymentChannelConfig`、`PlatformServiceFeeConfig`
- 结算：`SettlementSheet`、`SettlementItem`、`DepositAccount`、`DepositTransaction`、`LedgerEntry`
- 风控审计：`RiskFreeze`、`AuditLog`

结论：六个模块不是从零开始，属于“已有页面和接口，需要按生产验收标准补齐权限、状态、审计、异常、字段展示和端到端校验”。

## 4. 通用要求

### 4.1 权限/RBAC

- 平台管理员使用 `/api/admin/*`。
- 商户后台使用 `/api/merchant/*`。
- 商户只能操作自己名下店铺、收款配置、结算和供货数据。
- 商户 A 不允许查看或操作商户 B 的店铺、订单、收款、结算、供货关系。
- 未缴纳保证金或保证金不足的商户，不允许售卖、选择商品、代理供货、配置下级价格。
- 风控冻结中的商户/店铺/订单必须禁止交易、履约、结算相关动作。

### 4.2 数据和安全

- 禁止在代码、seed、前端、文档中硬编码真实店铺、商户、商品、价格、库存、卡密、客服二维码、支付二维码、支付链接。
- 收款配置以 `collection_payment_configs` 为权威表。
- 支付密钥、商户号、证书、token 不允许出现在前端和 Git 仓库中。
- 前端只展示支付名称、手续费、二维码或跳转链接等公开信息。
- 支付账号、实名、手机号、证书、密钥、卡密等敏感信息必须脱敏。

### 4.3 审计日志

以下动作必须写入审计日志：

- 修改店铺配置、客服二维码、公告、装修。
- 审核商户、手动创建商户、调整商户状态、确认或扣减保证金。
- 开通/关闭下级供货、调整供货关系、调整供货报价。
- 创建冻结、解除冻结、处理风控异常。
- 生成结算单、确认打款、扣款、异常处理。
- 新增/修改/删除/启停收款方式、设置默认支付、查单、人工确认、处理回调异常。

### 4.4 验收底线

- 生产环境不能依赖 mock 支付、demo 支付或写死二维码。
- 支付成功只能以后端回调、主动查单、余额扣减或后台人工确认为准。
- 结算生成和打款确认必须幂等，不能重复生成、重复打款。
- 风控冻结必须能阻断交易、履约和结算。
- 页面字段要和 API、数据库对象一致，不能只做静态展示。

## 5. 店铺设置

### 5.1 业务目标

让平台或商户维护自己的店铺基础信息、客服信息、公告和装修配置，保证 H5 展示来自数据库/API，不依赖硬编码。

当前状态：已有，需要补齐/优化。

### 5.2 页面字段

- 店铺名称
- 店铺归属：平台/商户
- 商户 ID
- 店铺状态：正常/关闭/冻结
- 客服微信号
- 客服二维码 URL
- 店铺公告
- 分享链接
- 装修配置
- 收款配置入口
- 最近更新时间

### 5.3 操作按钮

- 保存基础信息
- 上传/更新客服二维码
- 保存公告
- 保存装修配置
- 打开收款配置中心
- 查看店铺 H5 链接

### 5.4 API 需求

已有接口：

- `GET /api/merchant/shop`
- `PATCH /api/merchant/shop`
- `PATCH /api/merchant/shop/collection`
- `PATCH /api/merchant/shop/decor`
- `PATCH /api/admin/shops/:shopId/collection`
- `PATCH /api/admin/shops/:shopId/service-qrcode`

需要补齐/确认：

- 管理员是否有统一的店铺详情读取接口。
- 店铺字段保存后是否写入审计日志。
- 商户接口是否严格限制只能修改自己的店铺。

### 5.5 数据库读写对象

- `Shop`
- `ShopCustomerServiceBinding`
- `CollectionPaymentConfig`
- `AuditLog`
- `RiskFreeze`

### 5.6 权限、审计、风控

- 平台管理员可维护平台店铺和商户店铺。
- 商户只能维护自己的商户店铺。
- 冻结店铺不能修改收款配置，不能继续交易。
- 修改客服二维码、公告、装修、收款绑定必须写审计日志。

### 5.7 P0/P1/P2

P0：

- 店铺基础信息可读取、可保存。
- 客服二维码和公告从数据库读取。
- 商户只能修改自己的店铺。
- 冻结状态下关键配置不可继续变更。

P1：

- 增加装修配置预览。
- 增加客服二维码上传校验和预览。
- 增加修改记录列表。

P2：

- 多套装修模板。
- 店铺配置版本回滚。
- 店铺健康检查。

### 5.8 验收标准

- 商户 A 不能读取或修改商户 B 店铺。
- H5 店铺信息不再依赖硬编码。
- 修改店铺信息后刷新页面仍然保留。
- 敏感信息脱敏展示，关键动作有审计日志。

## 6. 商户管理

### 6.1 业务目标

支撑商户从申请、审核、开通、保证金确认到状态管理的完整后台流程。

当前状态：已有，需要补齐/优化。

### 6.2 页面字段

- 商户 ID
- 商户名称
- 联系人
- 手机号
- 入驻来源：申请/邀请码/后台手动创建
- 申请状态：待审核/通过/拒绝
- 商户状态：正常/禁用/冻结
- 保证金状态
- 保证金余额
- 邀请码
- 下级供货权限
- 创建时间
- 审核时间
- 审核备注

### 6.3 操作按钮

- 审核通过
- 审核拒绝
- 手动创建商户
- 创建邀请码
- 确认保证金
- 扣减保证金
- 启用/禁用商户
- 开通/关闭下级供货能力
- 查看商户详情

### 6.4 API 需求

已有接口：

- `POST /api/merchant/applications`
- `POST /api/merchant/register-by-invite`
- `GET /api/admin/merchant-applications`
- `POST /api/admin/merchants/:merchantId/review`
- `POST /api/admin/merchants/manual`
- `GET /api/admin/invite-codes`
- `POST /api/admin/invite-codes`
- `POST /api/admin/deposits/:merchantId/confirm`
- `POST /api/admin/deposits/:merchantId/deduct`

需要补齐/确认：

- 商户列表/详情字段是否覆盖保证金、状态、供货权限。
- 保证金确认是否幂等，重复确认不能重复入账。
- 禁用/冻结商户后是否阻断交易、结算、供货。

### 6.5 数据库读写对象

- `MerchantAccount`
- `Merchant`
- `MerchantApplication`
- `MerchantInviteCode`
- `DepositAccount`
- `DepositTransaction`
- `AuditLog`
- `RiskFreeze`

### 6.6 权限、审计、风控

- 只有平台管理员可以审核、创建、禁用商户。
- 商户不能自己修改审核状态、保证金状态、平台权限。
- 保证金确认、扣减必须记录流水和审计。
- 风控冻结商户后，商户相关交易、供货、结算必须受限。

### 6.7 P0/P1/P2

P0：

- 商户申请列表、审核通过/拒绝。
- 后台手动创建一级商户。
- 保证金确认和扣减。
- 商户状态控制。

P1：

- 商户详情页。
- 审核历史和保证金流水。
- 邀请码使用记录。

P2：

- 商户评分。
- 商户经营看板。
- 批量审核和批量状态调整。

### 6.8 验收标准

- 审核状态变化正确落库。
- 保证金重复确认不会重复入账。
- 未缴保证金商户不能进入售卖、供货和结算流程。
- 所有管理动作都有审计日志。

## 7. 下级供货

### 7.1 业务目标

支持平台管理二级商户供货资格、供货关系和报价，确保下级供货不越权、不越级、不影响老板负责的商品主模块。

当前状态：已有，需要补齐/优化。

### 7.2 页面字段

- 供货商户 ID
- 下级商户 ID
- 关系状态：待审核/已通过/已拒绝/已停用
- 商品 ID
- 供货价格
- 建议零售价
- 供货库存引用
- 保证金状态
- 风控状态
- 创建时间
- 审核备注

### 7.3 操作按钮

- 审核供货申请
- 建立供货关系
- 停用供货关系
- 新增/修改供货报价
- 启用/停用报价
- 查看关系详情

### 7.4 API 需求

已有接口：

- `GET /api/admin/merchant-supply`
- `POST /api/admin/merchant-supply/:merchantId/review`
- `POST /api/admin/merchant-supply/relations`
- `POST /api/admin/merchant-supply/offers`
- `POST /api/merchant/supply/offers`

需要补齐/确认：

- 供货关系不能越级到三级。
- 未缴保证金商户不能配置下级供货。
- 冻结商户不能新增/修改供货报价。
- 供货商品读取商品模块数据，但不改商品主数据。

### 7.5 数据库读写对象

- `Merchant`
- `MerchantAccount`
- `Shop`
- 供货关系相关表
- 供货报价相关表
- `DepositAccount`
- `RiskFreeze`
- `AuditLog`

### 7.6 权限、审计、风控

- 平台管理员可审核和调整供货关系。
- 商户只能维护自己被允许的供货报价。
- 未缴保证金、冻结、禁用商户不能供货。
- 调整供货关系和报价必须写审计日志。

### 7.7 P0/P1/P2

P0：

- 下级供货资格审核。
- 建立/停用供货关系。
- 新增/修改供货报价。
- 保证金和风控状态拦截。

P1：

- 供货关系详情。
- 报价变更历史。
- 供货商品筛选和批量启停。

P2：

- 自动利润校验。
- 供货商评分。
- 异常供货预警。

### 7.8 验收标准

- 未缴保证金商户不能代理供货。
- 不允许三级或越级供货。
- 风控冻结后供货报价不可继续变更。
- 供货不重复实现商品管理，只引用商品数据。

## 8. 风控日志

### 8.1 业务目标

让平台能发现、冻结、解除和追踪风险对象，并保证风控状态能影响交易、履约、收款和结算。

当前状态：已有，需要补齐/优化。

### 8.2 页面字段

- 冻结对象类型：商户/店铺/订单
- 冻结对象 ID
- 冻结原因
- 冻结状态：冻结中/已解除
- 创建人
- 创建时间
- 解除人
- 解除时间
- 解除原因
- 风险等级
- 关联订单/商户/店铺
- 审计日志记录

### 8.3 操作按钮

- 新增冻结
- 解除冻结
- 查看风险详情
- 查看审计日志
- 刷新风险看板

### 8.4 API 需求

已有接口：

- `POST /api/admin/risk-freezes`
- `GET /api/admin/risk-freezes`
- `POST /api/admin/risk-freezes/:freezeId/release`
- `GET /api/admin/risk-dashboard`

需要补齐/确认：

- 冻结是否能阻断下单、支付、发货、结算。
- 重复冻结同一对象是否幂等处理。
- 解除冻结是否记录解除原因和操作人。

### 8.5 数据库读写对象

- `RiskFreeze`
- `AuditLog`
- `Merchant`
- `Shop`
- 订单相关对象
- `SettlementSheet`

### 8.6 权限、审计、风控

- 只有平台管理员能新增或解除冻结。
- 所有冻结和解除必须审计。
- 风控状态必须被收款、结算、供货、店铺设置读取。

### 8.7 P0/P1/P2

P0：

- 创建冻结。
- 解除冻结。
- 风控列表和风险看板。
- 关键流程读取冻结状态并拦截。

P1：

- 风险等级。
- 关联对象详情跳转。
- 冻结影响范围说明。

P2：

- 自动风控规则。
- 异常行为评分。
- 风控趋势报表。

### 8.8 验收标准

- 冻结商户后不能交易、供货、结算。
- 冻结店铺后 H5 不允许继续下单。
- 冻结订单后不允许发货或结算。
- 冻结/解冻均有审计日志。

## 9. 结算

### 9.1 业务目标

按订单成交、退款、手续费、扣款和保证金规则生成商户结算单，并支持平台确认打款。

当前状态：已有，需要补齐/优化。

### 9.2 页面字段

- 结算单号
- 商户 ID
- 商户名称
- 结算周期
- 订单数
- 成交金额
- 退款金额
- 平台手续费
- 扣款金额
- 应结金额
- 结算状态：候选/待打款/已打款/异常
- 打款时间
- 打款凭证
- 备注

### 9.3 操作按钮

- 查看结算候选
- 生成结算单
- 查看结算明细
- 确认打款
- 查看保证金流水
- 查看扣款流水

### 9.4 API 需求

已有接口：

- `GET /api/admin/settlements`
- `POST /api/admin/settlements/candidate`
- `POST /api/admin/settlements/generate`
- `POST /api/admin/settlements/:settlementNo/payouts`
- `GET /api/merchant/settlements`
- `GET /api/merchant/clawbacks`
- `GET /api/merchant/deposit-transactions`

需要补齐/确认：

- 结算单生成幂等，同一周期不能重复生成。
- 打款确认幂等，同一结算单不能重复确认。
- 冻结商户、冻结订单不能进入结算。
- 售后退款、扣款、手续费规则与业务规则文档一致。

### 9.5 数据库读写对象

- `SettlementSheet`
- `SettlementItem`
- `LedgerEntry`
- `DepositAccount`
- `DepositTransaction`
- `Merchant`
- `RiskFreeze`
- `AuditLog`

### 9.6 权限、审计、风控

- 平台管理员可生成结算和确认打款。
- 商户只能查看自己的结算单、扣款、保证金流水。
- 风控冻结商户或订单不得结算。
- 生成结算、确认打款、扣款必须审计。

### 9.7 P0/P1/P2

P0：

- 结算候选计算。
- 生成结算单。
- 确认打款。
- 商户只读查看自己的结算和流水。
- 幂等和风控拦截。

P1：

- 结算明细筛选。
- 打款凭证上传。
- 结算异常处理。

P2：

- 自动结算任务。
- 财务报表导出。
- 对账差异分析。

### 9.8 验收标准

- 同一商户同一周期不能重复生成结算单。
- 已打款结算单不能重复打款。
- 冻结商户/订单不能进入结算。
- 商户不能看到其它商户结算数据。

## 10. 收款配置

### 10.1 业务目标

支持平台和商户配置可用收款方式，保证支付配置安全、支付状态可信、支付异常可追踪。

当前状态：已有，需要重点补齐/优化。

### 10.2 页面字段

- 支付方式名称
- 支付渠道类型：个人支付宝/个人微信/e支付/xpay/虎皮椒
- 归属类型：平台/商户
- 归属店铺
- 启用状态
- 默认状态
- 手续费
- 展示名称
- 展示二维码
- 跳转链接
- 回调地址
- 最近测试结果
- 最近回调时间
- 异常状态
- 创建时间
- 更新时间

禁止前端展示：

- 商户密钥
- 私钥
- 证书
- token
- 完整真实账号
- 付款人实名信息

### 10.3 操作按钮

- 新增支付方式
- 编辑支付方式
- 启用/停用
- 设为默认
- 删除
- 发起测试
- 查看回调日志
- 查看支付异常
- 处理支付异常
- 按订单号查单
- 后台人工确认

### 10.4 API 需求

已有接口：

- `GET /api/admin/payment-config/status`
- `GET /api/admin/payment-methods`
- `POST /api/admin/payment-methods`
- `PATCH /api/admin/payment-methods/:methodId`
- `DELETE /api/admin/payment-methods/:methodId`
- `POST /api/admin/payment-methods/:methodId/default`
- `POST /api/admin/payment-methods/:methodId/test`
- `GET /api/admin/payment-callbacks`
- `GET /api/admin/payment-exceptions`
- `POST /api/admin/payment-exceptions/:exceptionId/handle`
- `POST /api/admin/orders/:orderNo/payment-query`
- `PATCH /api/admin/payment-config/metadata`
- `POST /api/admin/payment-config/check`
- `GET /api/merchant/payment-methods`
- `POST /api/merchant/payment-methods`
- `PATCH /api/merchant/payment-methods/:methodId`
- `DELETE /api/merchant/payment-methods/:methodId`
- `POST /api/merchant/payment-methods/:methodId/default`
- `POST /api/merchant/payment-methods/:methodId/test`
- `GET /api/merchant/payment-vouchers`

需要补齐/确认：

- 支付密钥只允许后端读取，不进入前端响应。
- 第三方支付创建支付单必须走服务端。
- 第三方支付回调必须验签。
- 查单结果必须能修正异常订单状态。
- 人工确认只用于个人支付宝/个人微信等线下收款。

### 10.5 数据库读写对象

- `CollectionPaymentConfig`
- `PaymentChannelConfig`
- `PlatformServiceFeeConfig`
- 支付回调记录相关对象
- 支付异常相关对象
- 订单支付状态相关对象
- `AuditLog`
- `RiskFreeze`

### 10.6 收款配置特别规则

个人支付宝/个人微信：

- 只作为人工转账和后台人工确认使用。
- 前端最多展示支付名称、手续费、二维码或跳转链接。
- 付款后不能由前端直接改为支付成功。
- 支付成功必须由后台人工确认，或后端查证后确认。

e支付/xpay/虎皮椒：

- 必须走服务端创建支付单。
- 必须由服务端处理回调。
- 必须验签。
- 可以支持主动查单。
- 支付成功只能以后端回调或主动查单结果为准。
- 前端不能拼接支付链接，不能接触 key、商户号、证书、token。

密钥和证书：

- 不能写进代码。
- 不能写进前端。
- 不能提交到 Git。
- 不能写进普通文档。
- 生产环境应来自环境变量或加密后的数据库字段。

前端展示：

- 只展示支付名称、手续费、二维码或跳转链接。
- 不展示付款人真实姓名。
- 不展示完整收款账号。
- 不展示密钥、证书、商户号敏感字段。

支付成功依据：

- 后端支付回调。
- 后端主动查单。
- 余额扣减成功。
- 后台人工确认。

不允许：

- 前端提交“我已付款”就自动改支付成功。
- H5 传入 paid=true 之类字段绕过支付。
- mock/demo 支付在生产环境启用。
- 把支付二维码或支付链接写死在前端代码。

### 10.7 权限、审计、风控

- 平台管理员可配置平台主店收款方式。
- 商户只能配置自己店铺的商户收款方式。
- 商户不能读取平台支付密钥。
- 商户不能读取其它商户支付配置。
- 新增、编辑、启停、设默认、删除、测试、查单、异常处理、人工确认必须审计。
- 风控冻结店铺或商户后，不允许新增或切换支付方式。

### 10.8 P0/P1/P2

P0：

- 支付方式列表、新增、编辑、启停、设默认、删除。
- 平台/商户收款配置严格隔离。
- 密钥不进前端响应。
- 个人支付宝/个人微信仅人工确认。
- e支付/xpay/虎皮椒服务端创建支付单、回调、查单。
- 支付异常列表和处理。

P1：

- 支付通道连通性测试。
- 回调日志详情。
- 支付异常处理备注。
- 手续费展示和配置。

P2：

- 通道健康度统计。
- 自动切换备用通道。
- 支付成功率报表。

### 10.9 验收标准

- 前端网络响应中看不到密钥、证书、token。
- 第三方支付不能由前端直接生成支付成功状态。
- 个人支付宝/微信只能走人工确认。
- 默认支付方式切换后 H5 展示同步变化。
- 支付回调异常能在后台看到并处理。
- 支付查单能用于修正异常订单。

## 11. 不和老板模块重复的说明

本次只围绕后台配置、权限、审计、结算、风控、收款、供货关系做开发。

商品、订单、发货、售后、优惠券、库存卡密等模块只作为读取或状态联动对象，不新增这些模块的核心业务能力。

具体控制：

- 下级供货只维护供货关系和报价，不开发商品 CRUD。
- 结算只读取订单和售后结果，不重写订单状态机。
- 风控只写冻结状态和拦截点，不重写发货/售后流程。
- 收款配置只维护支付方式和支付可信状态，不重写 H5 商品购买体验。
- 店铺设置只维护店铺展示配置，不改商品详情和商品分类主逻辑。

## 12. 三天开发计划

### 第一天：基础边界、店铺设置、商户管理、收款配置 P0

开发内容：

- 对照现有页面和 API，补齐六个模块字段清单。
- 补齐店铺设置 P0：基础信息、客服二维码、公告、商户权限隔离。
- 补齐商户管理 P0：审核、手动创建、保证金确认/扣减、状态控制。
- 补齐收款配置 P0 的安全边界：密钥不进前端、平台/商户隔离、个人收款人工确认规则。
- 检查所有关键动作是否写 `AuditLog`。

当天测试：

- `npm run db:validate`
- `npm run typecheck`
- `npm test`
- API smoke：店铺读取/保存、商户审核、保证金确认、收款配置增删改查。
- 浏览器检查：admin 后台六个入口能打开，页面无明显报错。

### 第二天：下级供货、风控、结算 P0

开发内容：

- 补齐下级供货 P0：供货资格审核、供货关系、报价、保证金拦截、禁止三级供货。
- 补齐风控日志 P0：冻结、解冻、风险看板、审计记录。
- 补齐结算 P0：候选计算、生成结算单、确认打款、商户只读查看。
- 打通风控冻结对收款、供货、结算的拦截。

当天测试：

- `npm run db:validate`
- `npm run typecheck`
- `npm test`
- API tests：未缴保证金不能供货、冻结商户不能结算、重复生成结算单不重复、重复打款不重复。
- 浏览器检查：admin 下级供货、风控、结算页面可完成 P0 操作。

### 第三天：端到端验收、异常和文档收尾

开发内容：

- 按 `docs/16-page-level-production-acceptance-test-plan.md` 做页面级验收。
- 补齐支付回调日志、支付异常处理、查单、人工确认的页面和接口细节。
- 补齐敏感字段脱敏、RBAC 越权测试、审计日志检查。
- 更新最终文档和验收清单。

当天测试：

- `npm run db:validate`
- `npm run typecheck`
- `npm test`
- 浏览器端到端走查：admin、merchant、H5 关键链路。
- 检查网络响应：支付密钥、证书、token 不出现在前端响应中。
- 检查生产禁用 mock/demo 支付。

## 13. 最终交付物

- `docs/my-admin-modules-requirements-and-plan.md`
- 六个后台模块 P0 能上线验收。
- P1/P2 明确排期，不阻塞 P0 上线。
- 关键接口、数据库对象、权限、审计、风控和异常状态均有验收依据。


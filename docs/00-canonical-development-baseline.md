# ToSell 一次到位开发基线

本文是 2026-06-01 起的最高优先级开发口径。后续数据库、接口、后台、H5、测试和验收都以本文为准；其它文档如有冲突，以本文为准并必须同步修正。

## 1. 本轮目标

当前仍处于开发阶段，现有线上和本地数据均按测试数据处理，可以清空重建。目标不是在旧结构上继续补丁，而是一次性收口为可长期维护的生产结构。

本轮必须一次性完成：

1. 删除旧代理主体 `agents` 体系，统一为 `merchants` 商户主体。
2. 删除旧收款表 `shop_collection_channels`，统一为 `collection_payment_configs`。
3. 平台主店、商户店、商品、收款、订单、钱包、优惠券、履约、结算全部按新结构重建。
4. 前台、后台、API、测试文档全部同步，不再保留两套叫法和两套表逻辑。

## 2. 统一命名

业务上可以说“一级商户、二级商户、三级商户”和“代理销售”，但数据库和接口不再使用 `agent` 作为主体名。

| 旧口径 | 新口径 |
| --- | --- |
| `agents` | `merchants` |
| `agent_id` | `merchant_id` |
| `agent_products` | `merchant_product_listings` |
| `agent_product_reviews` | `merchant_product_reviews` |
| `agent_applications` | `merchant_applications` |
| `/api/agent/*` | `/api/merchant/*` |
| `shop_collection_channels` | 删除，统一用 `collection_payment_configs` |

前端显示可以继续用“商户”“一级商户”“二级商户”“三级商户”“代理商品”等人能理解的词，但不得把旧表名和旧接口继续写进新开发文档。

## 3. 店铺归属

`shops` 只保留两种归属：

1. `owner_type = platform`：平台主店。
2. `owner_type = merchant`：商户店铺。

平台主店规则：

1. `merchant_id = null`。
2. 不挂任何旧 `agent_id`。
3. 根域名 `888tech.club` 默认打开平台主店。
4. 平台主店也可以有短地址，例如 `/s/SHOP000001`，但代码不得写死这个店铺号。

商户店规则：

1. `merchant_id` 必须指向商户。
2. 每个商户有自己的店铺地址、店铺资料、客服资料、商品展示和收款配置。
3. 商户店不能读取其它商户的收款配置。

## 4. 商品结构

目标结构：

| 表 | 用途 |
| --- | --- |
| `platform_products` | 平台商品源，只由平台维护 |
| `platform_shop_products` | 平台主店上架哪些平台商品、售价、状态 |
| `merchant_product_listings` | 商户代理平台或上游商品后的本店展示、售价、状态 |
| `merchant_products` | 商户自有商品 |
| `merchant_product_reviews` | 商户自有商品审核 |
| `rights_codes` | 卡密池，按商品源和归属绑定 |
| `fulfillment_records` | 发货记录 |

代理商品规则：

1. 商户代理平台商品可以修改本店展示名、图片、详情、规格和售价。
2. 修改只影响该商户自己的店铺和订单快照。
3. 平台商品源、库存源、卡密源、供货链和结算归属不变。
4. 下级商户选品时看到直接上级的展示版本。
5. M1/M2/M3 不需要复制平台商品库存；销售后按商品源锁码和发码。

## 5. 收款结构

只保留 `collection_payment_configs` 作为收款配置表。

收款归属规则：

| owner_type | 含义 | 前台可见范围 |
| --- | --- | --- |
| `platform` | 平台收款方式 | 只给平台主店使用 |
| `merchant` | 商户自己的收款方式 | 只给该商户店铺使用 |

收款方式：

1. 支付宝商户：回调/查单自动确认。
2. 微信/腾讯商户：回调/查单自动确认。
3. e支付：回调/查单自动确认。
4. 个人支付宝：人工确认。
5. 个人微信：人工确认。
6. 余额支付：余额扣减自动确认。

前台展示规则：

1. 当前店铺配置完整、已启用、状态 active 的通道必须显示。
2. 未启用、未测试通过、配置不完整的通道不得显示。
3. 平台主店显示平台收款方式和余额支付。
4. 商户店显示该商户自己的收款方式和余额支付。
5. 不展示收款人姓名。
6. 不用下拉框，使用支付宝、微信、e支付、余额支付按钮。
7. 前台只接收服务端返回的支付跳转地址、二维码地址、订单号、支付单号、展示金额和状态文案；不得下发商户密钥、签名原文、证书、上报 token 或回调密钥。
8. 如果 e支付服务商返回可唤起支付宝/微信 App 的链接，H5 可以直接跳转；如果只返回网页支付页或二维码，H5 只展示服务商返回的网页或二维码，不自行拼接 App Scheme。
9. 个人支付宝、个人微信只展示二维码和金额，不展示收款人真实姓名、账号或后台备注。
10. 服务端回调地址和前台返回地址必须分开：`notify_url` 指向 API 公网地址，`return_url` 指向 H5 前台地址，不能把支付回调拼到后台或 H5 页面地址上。

## 6. 支付和费用

支付手续费和平台服务费必须分开。

支付手续费：

1. 支付宝、微信、e支付、个人支付宝、个人微信统一由客户承担 1%。
2. 余额支付 0 手续费。
3. 后端计算，前端只展示后端返回金额。
4. 订单和支付快照保存 `fee_bps`、`fee_cents`、`base_amount_cents`、`payable_amount_cents`。

平台服务费：

1. 平台向商户收取，默认千五 0.5%。
2. 后台可开启、关闭、调整比例。
3. 不允许写死。
4. 每笔订单创建时写入服务费快照。

## 7. 接口边界

统一接口分组：

1. `/api/user/*`：H5 买家。
2. `/api/merchant/*`：商户后台。
3. `/api/admin/*`：平台后台。
4. `/api/callbacks/payments/*`：支付回调。

旧 `/api/agent/*` 不再作为新开发接口。本轮清库重建后不保留对外兼容入口；如代码中短暂出现内部过渡方法，必须在本轮收口前删除，不能进入验收标准。

支付回调和幂等要求：

1. 回调必须验签，并校验订单号、金额、商户号/AppID/服务商商户号、交易状态和收款配置归属。
2. 前端页面返回不等于支付成功；支付成功只能来自回调验签成功、主动查单成功、个人收款人工确认或余额扣减成功。
3. 重复回调、重复查单、重复人工确认不得重复发码、重复扣余额或重复入账。
4. 建议幂等键：
   - `payment_confirm:{payment_id}:{confirm_source}`
   - `pay:{provider}:{collection_payment_config_id}:{channel_trade_no}`
   - `refund:{provider}:{collection_payment_config_id}:{channel_refund_no}`
   - `fulfill:{order_item_id}:{attempt_no}`
   - `entitlement:{order_item_id}:{rights_code_id}`
   - `settlement:{merchant_id}:{period_start}:{period_end}:{batch_no}`

## 7.1 核心模块

系统按以下业务模块建设，不能退回“表格 CRUD”：

1. Auth/RBAC：平台后台账号、商户账号、买家账号、权限和会话。
2. Merchant/Shop：商户、上下级、店铺、客服资料、保证金。
3. Product：平台商品、平台自营上架、商户代理展示、商户自有商品审核。
4. VirtualInventory：卡密池、锁码、发码、退款禁看、明文查看审计。
5. Order/Payment：订单、支付单、支付快照、回调、查单、人工确认、异常订单。
6. Wallet/Coupon：余额、充值、余额消费、注册赠券、用券、券作废。
7. Fulfillment/AfterSale：自动发码、人工交付、售后、退款、责任拆分。
8. Settlement/Ledger：供货应付、服务费、追扣、保证金流水、财务流水。
9. Audit/Risk：审计、风控冻结、导出脱敏、异常处理。

## 7.2 卡密商品下单信息

H5 下单页必须按商品履约方式展示输入项。有卡密的虚拟卡密商品，也就是 `code_pool` 自动发码商品，必须收集并由后端校验以下信息：

1. 购买密码：必填。买家后续提取卡密时只输入这个购买密码；服务端只保存哈希，不保存明文。
2. 联系电话：必填。前端和后端都必须校验为合法中国大陆手机号，并写入订单快照。
3. 接收邮箱：选填。买家填写邮箱时，前端和后端都必须校验邮箱格式，并在确认收款和发码后触发邮件投递。

`manual` 人工交付商品没有卡密池，不强制购买密码和联系电话；如后续某类人工交付商品需要联系方式，必须按商品或店铺规则单独配置，不得默认套用卡密商品规则。

邮件不是假状态。若生产要求把卡密真实发送到买家邮箱，必须配置邮件服务、发件人、模板、投递记录、失败状态、重试和人工补发能力；未配置邮件服务时，不能提示“已发送成功”。

## 8. 一次性数据库处理

因为当前数据都是测试数据，本轮采用清库重建，不做历史数据迁移。

执行原则：

1. 先改 schema 和代码。
2. 删除旧表和旧字段。
3. 重建数据库。
4. 重新 seed 干净数据。
5. 跑页面级验收。

必须删除的旧表：

1. `agents`
2. `agent_applications`
3. `agent_notifications`
4. `agent_products`
5. `agent_product_reviews`
6. `shop_collection_channels`

本轮不再保留第二套旧清算事实表；结算以 `settlement_sheets`、`settlement_items`、`ledger_entries` 为主链路，不再把 `clearing_*` 作为新核心事实表。

必须删除并改成新字段的旧字段：

1. 所有业务主链路里的旧 `agent_id` 要删除或改为 `merchant_id`。
2. 所有旧 `first_tier_agent_id`、`second_tier_agent_id`、`third_tier_agent_id` 要删除或改为商户层级字段。
3. `orders.collection_channel_id` 对旧收款表的依赖。
4. `payments.collection_channel_id` 对旧收款表的依赖。
5. `payment_confirmations.collection_channel_id` 对旧收款表的依赖。

## 8.1 必保留核心表

正式结构保留以下核心表，后续如需新增表，必须证明不是旧体系复活：

| 分组 | 表 |
| --- | --- |
| 账号权限 | `users`、`user_identities`、`auth_sessions`、`admin_users`、`roles`、`permissions`、`admin_user_roles`、`role_permissions`、`merchant_accounts` |
| 商户店铺 | `merchants`、`merchant_applications`、`merchant_invite_codes`、`shops`、`shop_customer_service_bindings`、`shop_product_groups` |
| 商品 | `platform_products`、`platform_shop_products`、`merchant_product_listings`、`merchant_products`、`merchant_product_reviews` |
| 订单支付 | `orders`、`order_items`、`order_amount_snapshots`、`payments`、`payment_snapshots`、`payment_callback_logs`、`payment_confirmations`、`payment_exceptions`、`payment_dispute_materials` |
| 收款配置 | `collection_payment_configs`、`payment_channel_configs`、`platform_service_fee_configs` |
| 钱包 | `user_wallets`、`wallet_recharge_orders`、`wallet_payment_holds`、`wallet_transactions` |
| 优惠券 | `coupon_templates`、`coupon_scopes`、`user_coupons`、`coupon_grant_records`、`coupon_void_records`、`coupon_usage` |
| 履约 | `rights_codes`、`fulfillment_records`、`fulfillment_attempts`、`entitlements`、`order_extract_secrets`、`order_extract_logs`、`email_delivery_records`、`code_plaintext_access_logs` |
| 售后财务 | `after_sales`、`refunds`、`refund_callbacks`、`refund_manual_confirmations`、`settlement_sheets`、`settlement_items`、`settlement_confirmations`、`deposit_accounts`、`deposit_transactions`、`ledger_entries` |
| 风控审计 | `risk_freezes`、`complaints`、`audit_logs` |

商户上下级和转供关系只使用 `merchants` 层级、`merchant_product_listings.upstream_listing_id`、订单中的 `first_tier_merchant_id/second_tier_merchant_id/third_tier_merchant_id` 和订单快照承接。若确实需要独立授权表，表名和字段必须使用 `merchant_*` 口径并单独评审；不得继续把 `channel_relations`、`channel_product_offers` 当作新核心表。

## 8.2 主表字段目标

`shops`：

1. `owner_type` 只允许 `platform` / `merchant`。
2. 平台店 `merchant_id=null`；商户店 `merchant_id` 必填。
3. `shop_no` 是短号，不是业务身份判断。
4. `share_path` 支持平台主店 `/` 和商户店 `/s/:shopNo`。

`merchant_product_listings`：

1. 必须记录 `merchant_id`、`shop_id`、`source_type`、`platform_product_id`、`upstream_listing_id`、`sale_price_cents`、`status`。
2. 必须支持展示覆盖字段：商品名、图片、详情、规格、使用说明、标签、详情模块。
3. 展示覆盖只影响本店和订单快照，不复制库存和卡密。

`orders`：

1. 删除旧 `agent_id/first_tier_agent_id/second_tier_agent_id/third_tier_agent_id/collection_channel_id`。
2. 使用 `merchant_id/first_tier_merchant_id/second_tier_merchant_id/third_tier_merchant_id/collection_payment_config_id`。
3. 保存 `collection_snapshot_json` 和 `coupon_snapshot_json`。
4. 对 `code_pool` 自动发码订单保存买家联系电话、接收邮箱、购买密码哈希和下单时的客户信息快照；`manual` 人工交付订单不强制保存购买密码和联系电话。

`order_items`：

1. 删除旧 `agent_product_id`。
2. 使用 `platform_shop_product_id`、`merchant_product_listing_id`、`merchant_product_id`、`sale_source_type`。

`payments`：

1. 删除旧 `collection_channel_id`。
2. 使用 `collection_payment_config_id`、`provider`、`confirm_mode`、`base_amount_cents`、`fee_bps`、`fee_cents`、`amount_cents`、`confirm_source`。

## 9. 干净 seed 数据

重建后只保留最小可验收数据：

1. 一个平台主店。
2. 一个一级商户 M1。
3. 一个二级商户 M2。
4. 一个三级商户 M3。
5. 平台商品若干，包含自动卡密商品和人工交付商品。
6. 平台主店上架商品。
7. M1/M2/M3 代理商品和展示覆盖。
8. 平台个人支付宝、平台 e支付配置。
9. M1 自己的 e支付或个人码配置。
10. 注册赠送优惠券一张。
11. 可用于页面级测试的钱包、充值、订单、卡密基础数据。

## 10. 文档门禁

其它文档必须满足：

1. 不再把 `agents` 当作目标表。
2. 不再把 `shop_collection_channels` 当作新收款表。
3. 不再要求新功能走 `/api/agent/*`。
4. 不再把上传付款截图作为支付确认链路。
5. 所有测试用例必须按 `merchants + collection_payment_configs` 验收。

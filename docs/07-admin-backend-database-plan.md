# 管理后台、后端模块与数据库账务设计

本文是 P0 开发依据，覆盖 H5 虚拟商品小店的平台后台、商户后台、后端领域服务、数据库核心实体、金额字段、逐级价格隔离、账务流水、唯一约束、事务边界和审计要求。

## 1. 开发硬约束

1. 数据库和后端是本项目核心，所有金额、状态、库存、卡密、收款、供货应付/服务费、退款、保证金和账务处理以后端落库为准。
2. 前端不得成为最终金额依据，前端传入的价格、服务费、收益、退款金额、清算金额必须由后端重新计算或校验。
3. 金额统一使用 `BIGINT amount_cents`，默认币种 `CNY`，禁止浮点。
4. 服务费率 P0 默认为 `service_fee_bps=50`，即 0.5%；计算后四舍五入到分，并写入订单快照。
5. `ledger_entries` 是不可变审计流水，不允许物理删除，不允许原地修改金额；冲正只能新增反向流水。
6. 单层订单保持 `clearing_items.order_id` 唯一；多级渠道订单必须使用 `order_id + clearing_role` 唯一。
7. 支付确认、真实支付回调、退款、履约、供货清算、追扣、保证金交易必须有幂等键和唯一约束。
8. 商户侧所有查询必须以后端认证主体派生 `merchant_id/shop_id`，不能信任前端传参。
9. 数据库、API、页面、导出不得出现邀请奖励、团队业绩、代理等级、返佣比例、团队订单奖励等设计。
10. 受控代理价差供货最多允许到三级：平台供货 -> 一级商户 -> 二级商户 -> 三级商户 -> 消费者，禁止四级渠道。
11. 平台自营店是平台自己的销售渠道，不属于一级商户，不参与渠道供货清算。
12. 商户使用自己的收款码/链接收款，P0 不做平台代收后 T+1 给商户打款；数据库只记录收款确认、供货应付、服务费、追扣和清算凭证。
13. 商品资料可以向下级开放，越级供货价格不能向下级泄露。

## 2. 平台后台 P0 模块

1. 基础看板：GMV、订单数、退款率、履约成功率、平台服务费、商户收益、冻结金额。
2. 商户审核：入驻资料、邀请码来源、上级关系、保证金、店铺状态。
3. 后台手工开店：创建一级商户、创建店铺、生成初始账号密码、记录交付状态和审计日志。
4. 保证金管理：确认缴纳、扣减、冻结、退还登记。
5. 平台商品库：商品名称、分类、图片、详情、供货价、最低价、建议价、履约方式、售后规则。
6. 自有商品审核：商户自提商品资料、价格、履约说明、售后说明、风险原因。
7. 库存与卡密：码池导入、库存扣减、自动发码、手工交付记录。
8. 收款通道审核：支付宝个人码、支付宝商户码/链接、微信个人码、微信商户码/链接。
9. 邀请码与渠道关系：平台/一级/二级邀请码、层级绑定、禁止四级。
10. 选品与转供价：平台给一级的供货价、一级给二级的转供价、二级给三级的转供价。
11. 订单管理：订单快照、收款状态、履约状态、退款状态、清算状态、风控状态。
12. 售后仲裁：责任归属、退款金额、平台/一级/二级/三级承担金额。
13. 供货清算与服务费：供货应付、服务费账单、清算明细、线下清算凭证、追扣。
14. 风控冻结：订单、店铺、商品、商户、收款通道和清算限制。
15. 审计日志：敏感操作前后值、原因、操作者、request_id、IP。
16. 平台自营：自营店、自营商品、自营订单、自营履约、自营收入成本对账。

## 3. 商户后台 P0 模块

1. 店铺配置：名称、Logo、公告、客服二维码、分享链接。
2. 收款通道：提交二维码/链接、查看审核状态、设置默认通道。
3. 商品选品：查看自己可见商品和自己可见上游供货价。
4. 商品上架：设置最终售价，导入或查看库存卡密。
5. 下级供货：一级给二级开放商品并设置一级转供价；二级给三级开放商品并设置二级转供价。
6. 订单和履约：确认收款、自动发码、手工交付、售后处理。
7. 供货清算和追扣：查看自己的可见收益、冻结、供货应付/服务费账单和追扣原因。

商户后台不得显示无关商户数据。二级不得显示平台给一级的供货价；三级不得显示一级转供价和平台供货价。

## 4. 后端领域模块

1. Auth/RBAC：H5 买家、商户账号、平台账号、角色权限、菜单权限、数据权限。
2. Merchant/Shop：入驻申请、审核、保证金状态联动、店铺资料、客服二维码、冻结、禁用。
3. Product/MerchantProduct：平台商品库、商户选品、自有商品审核、上下架、风控下架。
4. VirtualInventory：卡密导入、库存扣减、权益发放、商品级提取码配置、提取锁定、邮箱发码、退款后禁看。
5. Pricing：后端价格校验、最低限价校验、上游供货价校验、服务费计算、收益预估、订单金额快照。
6. ChannelSupply：邀请码、渠道关系、转供商品、转供价、逐级价格隔离、供货链快照。
7. Order：订单创建、归属固化、订单状态机、超时关闭、订单查询与权限隔离。
8. CollectionChannel：收款通道提交、审核、启用、禁用、订单通道快照。
9. PaymentConfirmation：收款确认、真实回调预留、金额校验、幂等入账、支付成功触发履约。
10. Fulfillment：自动/人工履约、履约尝试、权益发放、补发、撤销、重复发放拦截。
11. Coupon：注册赠券、商品适用、有效期、作废、不可叠加。
12. AfterSale/Refund：售后申请、冻结供货应付/服务费账单、责任归属、退款审批、退款拆账。
13. Clearing/Reconciliation：供货应付、服务费账单、清算明细唯一约束、线下清算凭证、追扣对账。
14. Deposit：保证金账户、缴纳确认、扣减、冻结、退还、余额不足限制。
15. RiskFreeze：订单冻结、店铺冻结、限制供货/清算、禁用、解冻后重新判断清算资格。
16. Ledger/Audit：不可变账务流水、操作审计、冲正流水、敏感操作留痕。
17. Reconciliation/Export：订单、收款、退款、供货应付、服务费、追扣、保证金、ledger 对账导出。

## 5. 核心数据库实体

### 5.1 账号、商户、店铺

`users`：H5 买家身份，包含 `id`、`phone`、`email`、`status`、`created_at`、`updated_at`。

`merchant_accounts`：商户登录账号，包含 `id`、`merchant_id`、`phone`、`email`、`password_hash`、`initial_password_reset_required`、`credential_delivery_status`、`status`、`last_login_at`。

`admin_users`、`roles`、`permissions`、`admin_user_roles`、`role_permissions`：平台后台 RBAC。

`merchants`：`id`、`merchant_no`、`name`、`tier`、`parent_merchant_id`、`root_first_tier_merchant_id`、`creation_source`、`created_by_admin_id`、`status`、`risk_status`、`deposit_status`、`approved_at`。

`merchant_applications`：`id`、`merchant_id`、`invite_code_id`、`application_source`、`identity_info_json`、`contact_info_json`、`customer_service_wechat`、`status`、`reject_reason`、`reviewed_by`、`reviewed_at`。

`shops`：`id`、`owner_type`、`merchant_id`、`shop_no`、`slug`、`domain`、`name`、`logo_url`、`announcement`、`status`、`risk_status`。

`shop_customer_service_bindings`：`id`、`shop_id`、`wechat_id`、`qr_code_url`、`status`、`review_status`、`reviewed_by`。

### 5.2 邀请码与渠道关系

`merchant_invite_codes`：`id`、`code`、`issuer_type`、`issuer_merchant_id`、`target_tier`、`status`、`max_uses`、`used_count`、`expires_at`、`created_by`、`created_at`。

规则：

1. 平台邀请码 `target_tier=1`。
2. 一级邀请码 `target_tier=2`。
3. 二级邀请码 `target_tier=3`。
4. 三级不得生成邀请码。
5. 邀请码不产生奖励和佣金。

`channel_relations`：`id`、`root_first_tier_merchant_id`、`parent_merchant_id`、`child_merchant_id`、`parent_tier`、`child_tier`、`invite_code_id`、`status`、`created_at`、`closed_at`。

唯一约束：`child_merchant_id` 同一时间只能有一个有效上级；`child_tier <= 3`。

### 5.3 保证金

保证金相关表必须支持后台人工确认。

`deposit_accounts`：`id`、`merchant_id`、`status`、`required_amount_cents`、`confirmed_amount_cents`、`available_amount_cents`、`frozen_amount_cents`、`deducted_amount_cents`、`confirmed_at`、`confirmed_by`、`proof_url`、`remark`、`created_at`、`updated_at`。

`deposit_transactions`：`id`、`merchant_id`、`account_id`、`type`、`amount_cents`、`status`、`balance_before_cents`、`balance_after_cents`、`reason_code`、`source_type`、`source_id`、`related_type`、`related_id`、`proof_url`、`idempotency_key`、`operator_id`、`confirmed_by`、`confirmed_at`、`remark`、`created_at`。

规则：`deposit_status != paid` 的商户不得销售、不得选品上架、不得代理平台商品、不得代理上级商户商品、不得配置转供价。所有后台人工确认保证金操作必须写 `deposit_transactions`、`ledger_entries` 和 `audit_logs`。

### 5.4 商品、选品与价格

`platform_products`：`id`、`product_no`、`name`、`category_id`、`cover_url`、`images_json`、`detail_json`、`rights_desc`、`supply_price_cents`、`min_sale_price_cents`、`suggested_sale_price_cents`、`fulfillment_type`、`after_sale_rule_json`、`status`。

`merchant_products`：`id`、`merchant_id`、`shop_id`、`product_type`、`platform_product_id`、`own_product_review_id`、`sale_price_cents`、`status`、`listed_at`、`delisted_at`。

`merchant_product_reviews`：`id`、`merchant_id`、`shop_id`、`name`、`detail_json`、`sale_price_cents`、`after_sale_rule_json`、`fulfillment_rule_json`、`status`、`risk_reason`、`reviewed_by`、`reviewed_at`。

`channel_product_offers`：`id`、`supplier_merchant_id`、`buyer_merchant_id`、`supplier_tier`、`buyer_tier`、`platform_product_id`、`visible_product_snapshot_json`、`upstream_supply_price_cents`、`transfer_supply_price_cents`、`min_sale_price_cents`、`status`、`created_at`、`updated_at`。

价格字段解释：

1. 平台给一级：一级看到 `platform_products.supply_price_cents`。
2. 一级给二级：二级只看到 `channel_product_offers.transfer_supply_price_cents`，该记录的 `supplier_tier=1`、`buyer_tier=2`。
3. 二级给三级：三级只看到 `channel_product_offers.transfer_supply_price_cents`，该记录的 `supplier_tier=2`、`buyer_tier=3`。
4. `upstream_supply_price_cents` 是服务端校验与结算字段，不得原样返回给下游。

约束：一级转供价不得低于平台供货价；二级转供价不得低于一级转供价；最终售价不得低于销售方上游供货价、平台最低限价和上级限制价。

### 5.5 库存、卡密与优惠券

`virtual_code_batches`：`id`、`product_id`、`merchant_product_id`、`batch_no`、`total_count`、`available_count`、`status`、`created_by`、`created_at`。

`virtual_codes`：`id`、`batch_id`、`code_ciphertext`、`status`、`order_id`、`issued_at`、`refunded_at`、`created_at`。

`order_extract_secrets`：`id`、`order_id`、`secret_hash`、`failed_attempts`、`locked_until`、`created_at`、`updated_at`。

`order_extract_logs`：`id`、`order_id`、`user_id`、`attempt_result`、`failure_reason`、`failed_attempts_after`、`locked_until`、`ip_hash`、`user_agent`、`created_at`。每次成功提取、失败提取、锁定拒绝、退款后拒绝都必须记录。

`coupon_templates`：`id`、`name`、`grant_type`、`discount_type`、`discount_amount_cents`、`min_order_amount_cents`、`scope_type`、`scope_json`、`total_grant_limit`、`per_user_limit`、`valid_from`、`valid_to`、`status`、`created_by`、`created_at`、`updated_at`。

`coupon_grant_records`：`id`、`template_id`、`user_id`、`grant_reason`、`granted_by`、`granted_at`、`source_event_id`。

`user_coupons`：`id`、`user_id`、`template_id`、`status`、`claimed_at`、`used_at`、`voided_at`、`void_reason`、`order_id`、`expires_at`。

`coupon_usage_records`：`id`、`user_coupon_id`、`order_id`、`pre_coupon_sale_amount_cents`、`coupon_discount_cents`、`buyer_paid_amount_cents`、`platform_coupon_subsidy_cents`、`used_at`、`voided_after_refund_at`。

### 5.6 收款与订单

`shop_collection_channels`：`id`、`shop_id`、`merchant_id`、`owner_type`、`channel_type`、`display_name`、`account_name`、`qr_url`、`payment_url`、`status`、`review_status`、`reviewed_by`、`reviewed_at`、`reject_reason`、`is_default`、`sort_order`、`daily_limit_cents`、`single_order_limit_cents`、`created_at`、`updated_at`。

`orders`：`id`、`order_no`、`sales_channel_type`、`buyer_type`、`user_id`、`merchant_id`、`shop_id`、`platform_shop_id`、`status`、`payment_status`、`fulfillment_status`、`refund_status`、`settlement_status`、`risk_status`、`buyer_email_snapshot`、`pre_coupon_sale_amount_cents`、`coupon_discount_cents`、`buyer_paid_amount_cents`、`platform_coupon_subsidy_cents`、`paid_amount_cents`、`created_at`、`paid_at`。

`order_items`：`id`、`order_id`、`merchant_product_id`、`product_type`、`product_id_snapshot`、`product_name_snapshot`、`sale_price_cents`、`pre_coupon_sale_amount_cents`、`coupon_discount_cents`、`buyer_paid_amount_cents`、`platform_coupon_subsidy_cents`、`quantity`、`supply_price_cents`、`service_fee_cents`、`merchant_income_cents`。

`order_amount_snapshots`：`order_id`、`service_fee_bps`、`pre_coupon_sale_amount_cents`、`coupon_discount_cents`、`buyer_paid_amount_cents`、`platform_coupon_subsidy_cents`、`coupon_id`、`user_coupon_id`、`coupon_refund_policy`、`settlement_basis_amount_cents`、`paid_amount_cents`、`supply_amount_cents`、`service_fee_cents`、`merchant_expected_income_cents`、`product_snapshot_json`、`shop_snapshot_json`、`pricing_snapshot_json`。

多级订单快照必须额外固化完整结算依据：`first_tier_merchant_id`、`second_tier_merchant_id`、`third_tier_merchant_id`、`platform_supply_price_cents`、`first_tier_supply_price_cents`、`second_tier_supply_price_cents`、`final_sale_price_cents`、`first_tier_margin_cents`、`second_tier_margin_cents`、`third_tier_margin_cents`、`service_fee_bearer`、`channel_relation_chain_json`。

注意：完整快照可在数据库保存，但 API 响应必须按角色脱敏。

`payments`：`id`、`payment_no`、`order_id`、`user_id`、`collection_channel_id`、`channel_snapshot_json`、`amount_cents`、`status`、`confirmed_by`、`confirmed_at`、`idempotency_key`。

### 5.7 售后、供货清算、账务和审计

`after_sales`：`id`、`after_sale_no`、`order_id`、`buyer_type`、`user_id`、`merchant_id`、`shop_id`、`status`、`reason_code`、`responsibility`、`requested_refund_cents`、`approved_refund_cents`、`platform_bear_cents`、`merchant_bear_cents`、`first_tier_bear_cents`、`second_tier_bear_cents`、`third_tier_bear_cents`、`service_fee_refund_cents`、`service_fee_bearer`。

`clearing_sheets`：`id`、`clearing_no`、`merchant_id`、`period_start`、`period_end`、`status`、`total_order_count`、`total_paid_cents`、`total_service_fee_cents`、`total_supply_payable_cents`、`total_margin_cents`、`total_clawback_cents`、`created_by`、`confirmed_by`。

`clearing_items`：`id`、`clearing_id`、`order_id`、`merchant_id`、`shop_id`、`clearing_role`、`settlement_basis_amount_cents`、`pre_coupon_sale_amount_cents`、`coupon_discount_cents`、`platform_coupon_subsidy_cents`、`buyer_paid_amount_cents`、`paid_amount_cents`、`supply_amount_cents`、`service_fee_cents`、`merchant_margin_cents`、`supply_payable_cents`、`deducted_cents`、`clear_amount_cents`、`fulfilled_at`。

清算项必须以 `settlement_basis_amount_cents` 作为价差和服务费默认计算基准。`paid_amount_cents` / `buyer_paid_amount_cents` 只表示买家实际付款和收款确认金额，用于退款上限、实收统计和对账，不得直接替代供货价差结算基准。平台券相关字段必须进入清算快照，确保平台补贴不侵蚀商户价差。

`clearing_confirmations`：`id`、`clearing_id`、`merchant_id`、`confirmation_type`、`amount_cents`、`proof_url`、`remark`、`confirmed_by`、`confirmed_at`。用于记录线下供货应付/服务费清算凭证，不是平台代收后给商户打款。

`clawbacks`、`ledger_entries`、`risk_freezes`、`complaints`、`audit_logs`：保持不可变、可追溯、可审计。

## 6. 逐级价格响应规则

后端必须提供响应整形层，不允许前端自行隐藏敏感字段。

| 访问角色 | 可返回价格 | 禁止返回 |
| --- | --- | --- |
| 平台后台 | 平台供货价、一级转供价、二级转供价、最终售价、各级差价 | 无，但需 RBAC |
| 一级商户 | 平台给自己的供货价、自己设置的一级转供价、自己店铺售价 | 无关一级数据 |
| 二级商户 | 一级给自己的转供价、自己设置的二级转供价、自己店铺售价 | 平台给一级的供货价 |
| 三级商户 | 二级给自己的转供价、自己店铺售价 | 平台供货价、一级转供价 |
| H5 买家 | 最终销售价、优惠后实付 | 所有供货价、转供价、差价、服务费、清算金额 |

该规则适用于商品列表、商品详情、选品 API、订单详情、清算列表、导出文件、后台表格和浏览器网络响应。

## 7. 关键唯一约束与索引

1. `merchant_invite_codes.code` 唯一。
2. `channel_relations(child_merchant_id, status)` 对 active 状态唯一。
3. `shops.slug` 唯一，`shops.domain` 可选唯一。
4. `merchant_products(shop_id, product_type, platform_product_id)` 唯一。
5. `channel_product_offers(buyer_merchant_id, platform_product_id, status)` 对 active 状态唯一。
6. `orders.order_no` 唯一。
7. `payments.payment_no` 唯一，`payments.idempotency_key` 唯一。
8. `virtual_codes(order_id)` 对已发放状态建索引。
9. `clearing_items(order_id, clearing_role)` 唯一。
10. `ledger_entries.idempotency_key` 唯一。
11. `risk_freezes(target_type, target_id, freeze_type, status)` 对 active 状态唯一。
12. `audit_logs.request_id` 或 `audit_logs(actor/action/target/request_id)` 唯一。

## 8. 关键事务边界

1. 创建订单：校验店铺、销售商户保证金确认状态、商户、商品、库存、价格、优惠券、收款通道和风控；销售商户 `deposit_status != paid` 时后端硬拒绝创建可支付订单；通过后写订单、快照、支付记录。
2. 确认收款：锁定订单和支付记录；校验金额；写账务流水；触发履约；幂等处理。
3. 自动发码：锁定可用卡密；分配给订单；写权益和履约记录；重复请求不得重复发码。
4. 提取卡密：校验提取码、锁定状态、退款状态和订单归属；错误次数服务端累计。
5. 退款：创建售后并冻结供货应付/服务费账单；退款完成后禁看卡密；按责任写 ledger 和追扣。
6. 供货清算：按商户和窗口加锁筛选可清算订单；多级订单按 `order_id + clearing_role` 防重复。
7. 清算凭证：锁定清算单；写线下收款/补款凭证、ledger 和审计日志，不做平台代收后商户打款。
8. 转供价调整：校验层级、上游价格、最低价；写审计；不影响历史订单快照。
9. 邀请码使用：锁定邀请码；校验目标层级和有效期；创建商户关系；拒绝四级。

## 9. P0 必做与后置

P0 必做：

1. 数据库生产化和核心实体。
2. 商户收款通道。
3. 商品、库存、卡密、订单、售后、供货清算/服务费对账。
4. 邀请码、渠道关系、转供价、逐级价格隔离。
5. 平台后台、商户后台和 H5 前台共用 API。
6. RBAC、审计、账务流水和越权测试。

后置：

1. 商户自助提现。
2. 真实支付自动回调和真实退款。
3. 完整复式总账。
4. 自动风控评分。
5. 复杂营销。
6. 高级 BI。
7. 多履约供应商路由。

# 管理后台、后端模块与数据库账务设计

本文是 V1 开发依据文档，覆盖平台后台页面、后端领域服务、数据库核心实体、金额字段、账务流水、唯一约束、索引、事务边界和审计要求。

## 1. 开发硬约束

1. 数据库和后端是本项目核心，所有金额、状态、结算、退款、保证金和账务处理以后端落库为准。
2. 前端不得成为最终金额依据，前端传入的价格、服务费、收益、退款金额、结算金额必须由后端重新计算或校验。
3. 金额统一使用 `BIGINT amount_cents`，默认币种 `CNY`，禁止浮点。
4. 服务费率 V1 固化为 `service_fee_bps=50`，即 0.5%；计算后四舍五入到分，并写入订单快照。
5. `ledger_entries` 是不可变审计流水，不允许物理删除，不允许原地修改金额；冲正只能新增反向流水。
6. 单层订单保持 `settlement_items.order_id` 唯一；两级渠道订单必须改为 `order_id + settlement_role` 唯一，防止同一订单同一结算角色重复结算。
7. 支付、退款、履约、结算、追扣、保证金交易必须有幂等键和唯一约束。
8. 代理侧所有查询必须以后端认证主体派生 `agent_id/shop_id`，不能信任前端传参。
9. 数据库、API、页面、导出不得出现邀请奖励、团队业绩、代理等级、返佣比例、团队订单奖励等设计。
10. 受控两级渠道只允许平台供货 -> 一级渠道商 -> 二级渠道商 -> 消费者，禁止三级渠道。
11. 渠道收益必须按供货价差计算，不得按招募人数、团队订单或返佣比例计算。
12. 平台自营店是平台自己的销售渠道，不属于一级渠道商，不参与一级/二级渠道结算。

## 2. 平台后台 V1 模块

### 2.1 基础看板

字段：GMV、订单数、退款率、履约成功率、平台服务费、代理收益、活跃代理数、冻结金额。

操作：按日期、代理、商品筛选；跳转订单、售后、结算明细。

### 2.2 代理审核

字段：代理申请资料、联系人、联系方式、客服微信、售后说明、审核状态、拒绝原因、保证金状态、店铺状态。

操作：审核通过、审核拒绝、补充备注、冻结店铺、禁用店铺。

要求：审核动作必须写 `audit_logs`。

### 2.3 保证金管理

字段：应缴金额、可用金额、冻结金额、扣减金额、状态、关联订单/售后/投诉/追扣、凭证。

操作：确认缴纳、扣减、冻结、退还登记。

要求：任何保证金变化必须写 `deposit_transactions` 和 `ledger_entries`，不得只更新余额。

### 2.4 平台商品库

字段：商品名称、分类、详情、权益说明、供货价、最低销售价、建议销售价、履约方式、履约规则、售后规则、上下架状态。

操作：创建、编辑、上架、下架、调整价格、查看历史。

要求：商品价格变化不得影响历史订单快照。

### 2.5 代理商品审核

字段：代理、店铺、自有商品资料、售价、履约说明、售后说明、风险原因、审核状态。

操作：审核通过、审核拒绝、风险下架。

要求：未审核通过的自有商品不得出现在用户端售卖。

### 2.6 订单管理

字段：订单号、用户、代理、店铺、商品、订单快照、支付状态、履约状态、退款状态、结算状态、风控状态。

操作：查询、备注、冻结、解冻、查看全链路记录。

要求：订单冻结期间不得进入结算。

### 2.7 履约管理

字段：待履约订单、发放方式、权益凭证、失败原因、尝试次数、权益状态。

操作：人工发放、重试、补发、撤销。

要求：重复发放必须被幂等拦截，发放和补发必须写凭证。

### 2.8 售后仲裁

字段：售后原因、用户凭证、订单实付、责任归属、退款金额、平台承担金额、代理承担金额、一级承担金额、二级承担金额、服务费退还金额、服务费承担方。

操作：审核、拒绝、平台介入、创建退款、记录裁决。

要求：退款金额累计不得超过用户实付金额，责任归属必须记录。

### 2.9 结算管理

字段：可结算订单、冻结订单、结算单、结算明细、人工打款状态、打款凭证。

操作：生成结算单、确认结算、导出打款文件、回填人工打款。

要求：结算单金额必须等于结算明细汇总，同一订单不得重复结算。

### 2.10 风控冻结

字段：目标类型、目标 ID、代理、店铺、订单、商品、冻结原因、影响范围、状态。

操作：冻结、解冻、限制结算、禁用店铺、下架商品。

要求：冻结和解冻必须写审计，解冻后重新判断结算资格。

### 2.11 审计日志

字段：操作人、角色、动作、目标、前后值、原因、时间、request_id、IP。

操作：查询、导出、追踪敏感操作。

必须审计：退款裁决、退款金额确认、保证金扣减/退还、结算单生成/确认、人工打款回填、订单/店铺冻结解冻、店铺禁用、商品风险下架、后台价格调整、权限变更。

### 2.12 H5 与渠道供货管理

字段：H5 店铺域名、渠道层级、一级渠道授权状态、二级渠道审核状态、可转供商品、一级转供价、最终销售价、供货链订单快照、一级/二级结算状态。

操作：审核一级开通二级能力、审核二级入驻、关闭渠道授权、配置或审核转供价、查询供货链订单、生成一级/二级结算明细。

要求：二级不得继续创建三级；转供价调整必须写审计；历史订单不得受后续转供价变化影响。

### 2.13 平台自营管理

字段：平台自营店、平台自营商品、自营售价、履约成本、支付通道费、平台自营毛收益、自营订单、自营售后、自营对账状态。

操作：配置平台自营店、上架/下架自营商品、调整自营售价、查看自营订单、处理自营售后、查看自营看板和对账。

要求：平台自营订单不生成渠道结算项，但必须进入平台收入、成本、退款、ledger 和对账。

## 3. 后端领域模块

1. Auth/RBAC：微信登录、后台账号、角色权限、菜单权限、数据权限、敏感操作授权。
2. Agent/Shop：代理入驻申请、审核、保证金状态联动、店铺资料、客服微信、冻结、禁用。
3. Product/AgentProduct：平台商品库、代理选品、代理自有商品提交审核、上下架、风控下架。
4. Pricing：后端价格校验、最低限价校验、服务费计算、代理收益预估、订单金额快照。
5. Order：订单创建、归属固化、订单状态机、超时关闭、订单查询与代理隔离。
6. PaymentCallback：微信支付单、支付回调验签、金额校验、幂等入账、支付成功触发履约。
7. Fulfillment：自动/人工履约、履约尝试、权益发放、补发、撤销、重复发放拦截。
8. AfterSale/Refund：售后申请、冻结结算、责任归属、退款审批、退款回调、退款拆账。
9. Settlement：T+1 可结算筛选、结算单生成、结算明细唯一约束、人工打款确认。
10. Deposit：保证金账户、缴纳确认、扣减、冻结、退还、余额不足限制。
11. RiskFreeze：订单冻结、店铺冻结、限制结算、禁用、解冻后重新判断结算资格。
12. Ledger/Audit：不可变账务流水、操作审计、冲正流水、敏感操作留痕。
13. Reconciliation/Export：订单、支付、退款、结算、人工打款、保证金、ledger 对账导出。
14. ChannelSupply：渠道授权、渠道关系、转供商品、转供价、供货链快照、一级/二级结算。
15. H5Frontend：H5 店铺、H5 用户身份、H5 订单和售后入口。
16. PaymentChannel：微信小程序、微信内 H5 JSAPI、微信外 H5、支付宝手机网站、mock 支付统一模型。
17. PlatformSelfOperated：平台自营店、自营商品、自营订单、自营履约、自营售后、自营对账。

## 4. 核心数据库实体

### 4.1 用户、代理、店铺

`users`：`id`、`openid`、`unionid`、`phone`、`status`、`created_at`、`updated_at`。

`agents`：`id`、`user_id`、`agent_no`、`name`、`contact_phone`、`status`、`risk_status`、`deposit_status`、`approved_at`。

`agent_applications`：`id`、`agent_id`、`user_id`、`identity_info_json`、`contact_info_json`、`customer_service_wechat`、`status`、`reject_reason`、`reviewed_by`、`reviewed_at`。

`shops`：`id`、`owner_type`、`agent_id`、`shop_no`、`name`、`logo_url`、`announcement`、`share_path`、`status`、`risk_status`。

`owner_type` 枚举：`platform`、`agent`。平台自营店使用 `owner_type=platform`，渠道店使用 `owner_type=agent`。

`shop_customer_service_bindings`：`id`、`shop_id`、`wechat_id`、`qr_code_url`、`status`、`review_status`、`reviewed_by`。

### 4.1.1 渠道关系与 H5 身份

`channel_authorizations`：`id`、`agent_id`、`status`、`allow_second_tier`、`reviewed_by`、`reviewed_at`、`closed_at`、`reason`、`created_at`。

`channel_relations`：`id`、`first_tier_agent_id`、`second_tier_agent_id`、`status`、`created_by`、`created_at`、`closed_at`。唯一约束：`second_tier_agent_id` 只能绑定一个有效一级渠道商。

`h5_users`：`id`、`phone`、`wechat_unionid`、`status`、`created_at`、`updated_at`。

`shop_domains`：`id`、`shop_id`、`domain`、`path_slug`、`status`、`created_at`、`updated_at`。

### 4.2 保证金

`deposit_accounts`：`id`、`agent_id`、`required_amount_cents`、`available_amount_cents`、`frozen_amount_cents`、`deducted_amount_cents`、`status`。

`deposit_transactions`：`id`、`agent_id`、`account_id`、`type`、`amount_cents`、`balance_before_cents`、`balance_after_cents`、`reason_code`、`related_type`、`related_id`、`voucher_url`、`idempotency_key`、`operator_id`、`created_at`。

### 4.3 商品

`platform_products`：`id`、`product_no`、`name`、`category_id`、`detail`、`rights_desc`、`supply_price_cents`、`min_sale_price_cents`、`suggested_sale_price_cents`、`fulfillment_type`、`fulfillment_rule_json`、`after_sale_rule_json`、`status`。

`agent_products`：`id`、`agent_id`、`shop_id`、`product_type`、`platform_product_id`、`own_product_review_id`、`sale_price_cents`、`status`、`listed_at`、`delisted_at`。

`agent_product_reviews`：`id`、`agent_id`、`shop_id`、`name`、`detail_json`、`sale_price_cents`、`after_sale_rule_json`、`fulfillment_rule_json`、`status`、`risk_reason`、`reviewed_by`、`reviewed_at`。

`channel_product_offers`：`id`、`first_tier_agent_id`、`second_tier_agent_id`、`platform_product_id`、`resell_supply_price_cents`、`min_sale_price_cents`、`status`、`created_at`、`updated_at`。

约束：`resell_supply_price_cents` 不得低于平台供货价；二级最终售价不得低于 `resell_supply_price_cents` 和平台限制价。

### 4.4 订单与快照

`orders`：`id`、`order_no`、`sales_channel_type`、`buyer_type`、`user_id`、`mini_user_id`、`h5_user_id`、`unified_user_id`、`agent_id`、`shop_id`、`platform_shop_id`、`status`、`payment_status`、`fulfillment_status`、`refund_status`、`settlement_status`、`risk_status`、`paid_amount_cents`、`created_at`、`paid_at`。

`sales_channel_type` 枚举：`platform_self_operated`、`single_agent`、`two_tier`。

买家身份规则：小程序订单写 `buyer_type=mini_program` 和 `mini_user_id/user_id`；H5 订单写 `buyer_type=h5` 和 `h5_user_id`；如果后续完成手机号或 unionid 合并，可写 `unified_user_id`。订单、售后和权益查询必须从登录态派生对应买家身份。

`order_items`：`id`、`order_id`、`agent_product_id`、`product_type`、`product_id_snapshot`、`product_name_snapshot`、`sale_price_cents`、`quantity`、`supply_price_cents`、`service_fee_cents`、`agent_income_cents`。

`order_amount_snapshots`：`order_id`、`service_fee_bps`、`paid_amount_cents`、`supply_amount_cents`、`service_fee_cents`、`agent_expected_income_cents`、`platform_product_snapshot_json`、`shop_snapshot_json`、`pricing_snapshot_json`。

订单快照必须固化：`agent_id`、`shop_id`、店铺名称、客服微信、用户入口来源、商品 ID 与版本、商品名称、商品类型、履约规则、售后规则、销售价、实付金额、平台供货价、最低限价、服务费率、服务费金额、代理预计收益、创建时代理/店铺状态。

两级渠道订单快照必须额外固化：`first_tier_agent_id`、`second_tier_agent_id`、`first_tier_shop_id`、`second_tier_shop_id`、`platform_supply_price_cents`、`resell_supply_price_cents`、`final_sale_price_cents`、`first_tier_margin_cents`、`second_tier_margin_cents`、`service_fee_bearer`、`channel_relation_id`、`channel_authorization_snapshot_json`。

平台自营订单快照必须额外固化：`platform_shop_id`、`final_sale_price_cents`、`fulfillment_cost_cents`、`payment_channel_fee_cents`、`platform_self_operated_gross_margin_cents`。

### 4.5 支付、履约、权益

`payments`：`id`、`payment_no`、`order_id`、`user_id`、`channel`、`channel_trade_no`、`amount_cents`、`status`、`paid_at`。

`payment_callbacks`：`id`、`payment_id`、`channel_event_id`、`raw_payload_json`、`processed_status`、`idempotency_key`、`created_at`。

`fulfillment_records`：`id`、`order_id`、`order_item_id`、`agent_id`、`fulfillment_type`、`status`、`success_at`、`fail_reason`。

`fulfillment_attempts`：`id`、`fulfillment_id`、`attempt_no`、`idempotency_key`、`operator_id`、`request_json`、`result_json`、`status`。

`entitlements`：`id`、`order_id`、`order_item_id`、`user_id`、`rights_code`、`rights_payload_json`、`status`、`issued_at`、`revoked_at`。

### 4.6 售后与退款

`after_sales`：`id`、`after_sale_no`、`order_id`、`buyer_type`、`user_id`、`mini_user_id`、`h5_user_id`、`agent_id`、`shop_id`、`status`、`reason_code`、`responsibility`、`requested_refund_cents`、`approved_refund_cents`、`platform_bear_cents`、`agent_bear_cents`、`first_tier_bear_cents`、`second_tier_bear_cents`、`service_fee_refund_cents`、`service_fee_bearer`。

`responsibility` 枚举：`platform`、`agent`、`first_tier`、`second_tier`、`user`、`mixed`。单层订单可使用 `agent`；两级渠道订单必须使用 `first_tier`、`second_tier` 或 `mixed`，不得只写模糊的 `agent`。

`refunds`：`id`、`refund_no`、`after_sale_id`、`order_id`、`payment_id`、`amount_cents`、`status`、`channel_refund_no`、`idempotency_key`、`created_at`。

`refund_callbacks`：`id`、`refund_id`、`channel_event_id`、`raw_payload_json`、`processed_status`、`idempotency_key`。

退款拆账必须记录：退款总额、累计已退金额、平台承担金额、代理承担金额、一级承担金额、二级承担金额、服务费退还金额、服务费承担方、责任归属、是否已结算、是否生成追扣、关联售后单、关联退款渠道流水。

部分退款累计金额不得超过用户实付金额。同一订单多次售后、部分退款、退款失败重试都必须有独立单据和 ledger 事件。

### 4.7 结算、人工打款、追扣

`settlement_sheets`：`id`、`settlement_no`、`agent_id`、`period_start`、`period_end`、`status`、`total_order_count`、`total_paid_cents`、`total_service_fee_cents`、`total_agent_income_cents`、`created_by`、`confirmed_by`。

`settlement_items`：`id`、`settlement_id`、`order_id`、`agent_id`、`shop_id`、`paid_amount_cents`、`supply_amount_cents`、`service_fee_cents`、`agent_income_cents`、`deducted_cents`、`settle_amount_cents`、`fulfilled_at`。

两级渠道结算建议扩展：`settlement_role`、`first_tier_agent_id`、`second_tier_agent_id`、`platform_supply_price_cents`、`resell_supply_price_cents`、`final_sale_price_cents`、`first_tier_margin_cents`、`second_tier_margin_cents`。

唯一约束：单层订单可使用 `order_id` 唯一；两级渠道必须使用 `order_id + settlement_role` 唯一，其中 `settlement_role` 至少包含 `single_agent`、`first_tier`、`second_tier`。

平台自营订单不插入渠道结算明细；平台自营订单进入平台收入、履约成本、支付通道费、退款和 ledger 对账。

`manual_payouts`：`id`、`settlement_id`、`agent_id`、`amount_cents`、`payee_info_snapshot_json`、`payout_method`、`payout_voucher_url`、`status`、`paid_by`、`paid_at`。

`clawbacks`：`id`、`clawback_no`、`agent_id`、`source_type`、`source_id`、`order_id`、`amount_cents`、`status`、`deduct_from`、`reason_code`、`idempotency_key`。

结算明细必须记录：订单号、代理、店铺、履约成功时间、进入可结算时间、用户实付、供货价、服务费、代理收益、退款扣减、风控/投诉冻结状态、最终结算金额、关联 ledger entry。

### 4.8 账务、风控、投诉、审计、权限

`ledger_entries`：见第 5 节。

`risk_freezes`：`id`、`target_type`、`target_id`、`agent_id`、`freeze_type`、`status`、`reason_code`、`reason_text`、`created_by`、`released_by`、`created_at`。

`complaints`：`id`、`order_id`、`agent_id`、`user_id`、`status`、`complaint_type`、`responsibility`、`resolution_json`。

`audit_logs`：`id`、`actor_type`、`actor_id`、`action`、`target_type`、`target_id`、`before_json`、`after_json`、`reason`、`idempotency_key`、`request_id`、`ip`、`created_at`。

权限表：`admin_users`、`roles`、`permissions`、`admin_user_roles`、`role_permissions`。

## 5. Ledger 设计口径

`ledger_entries` 关键字段：

`id`、`ledger_no`、`agent_id`、`shop_id`、`subject_type`、`subject_id`、`account_type`、`entry_type`、`direction`、`amount_cents`、`currency`、`source_type`、`source_id`、`order_id`、`settlement_id`、`refund_id`、`clawback_id`、`deposit_transaction_id`、`idempotency_key`、`balance_before_cents`、`balance_after_cents`、`created_at`。

建议 `account_type`：

1. `agent_pending_income`
2. `agent_frozen_income`
3. `agent_payable_income`
4. `agent_paid_income`
5. `agent_clawback_receivable`
6. `agent_deposit_available`
7. `agent_deposit_frozen`
8. `platform_service_fee_income`
9. `platform_refund_cost`

建议 `entry_type`：

1. `ORDER_AGENT_INCOME_PENDING`
2. `ORDER_SERVICE_FEE_ACCRUAL`
3. `REFUND_AGENT_BEAR`
4. `REFUND_PLATFORM_BEAR`
5. `SERVICE_FEE_REFUND`
6. `SETTLEMENT_LOCK`
7. `SETTLEMENT_PAYOUT`
8. `CLAWBACK_CREATE`
9. `CLAWBACK_DEDUCT_PENDING`
10. `CLAWBACK_DEDUCT_PAYOUT`
11. `CLAWBACK_DEDUCT_DEPOSIT`
12. `DEPOSIT_PAY`
13. `DEPOSIT_DEDUCT`
14. `DEPOSIT_REFUND`
15. `RISK_FREEZE`
16. `RISK_UNFREEZE`
17. `MANUAL_ADJUST`

所有 ledger 事件必须能关联来源单据。人工调整必须有原因、操作人和审批记录。

## 6. 关键唯一约束与索引

1. `users.openid` 唯一。
2. `agents.user_id` 唯一，`agents.agent_no` 唯一。
3. `shops.agent_id` 唯一，`shops.shop_no` 唯一。
4. `agent_products(shop_id, product_type, platform_product_id)` 唯一，避免同店重复上架同一平台商品。
5. `orders.order_no` 唯一。
6. `orders(agent_id, created_at)`、`orders(shop_id, status)`、`orders(user_id, created_at)` 建索引。
7. `payments.payment_no` 唯一，`payments.channel_trade_no` 唯一。
8. `payment_callbacks.channel_event_id` 或 `payment_callbacks.idempotency_key` 唯一。
9. `refunds.refund_no` 唯一，`refunds.idempotency_key` 唯一。
10. `refund_callbacks.channel_event_id` 唯一。
11. `fulfillment_attempts.idempotency_key` 唯一。
12. `entitlements(order_item_id, rights_code)` 唯一或业务唯一。
13. `settlement_items.order_id` 单层唯一；两级渠道改为 `settlement_items(order_id, settlement_role)` 唯一。
14. `clawbacks.idempotency_key` 唯一。
15. `deposit_transactions.idempotency_key` 唯一。
16. `ledger_entries.idempotency_key` 唯一。
17. `ledger_entries(agent_id, created_at)`、`ledger_entries(source_type, source_id)`、`ledger_entries(order_id)` 建索引。
18. `risk_freezes(target_type, target_id, freeze_type, status)` 对 active 状态做唯一约束。
19. `audit_logs.idempotency_key` 唯一，或至少 `actor/action/target/request_id` 唯一。

## 7. 关键事务边界

### 7.1 创建订单

校验代理已审核、保证金满足销售条件、店铺营业、商品上架、售价不低于最低限价、无禁止销售风控；写订单、订单项、金额快照、商品和规则快照。

### 7.2 支付成功回调

验签；校验渠道金额等于订单金额；锁定订单和支付记录；写 payment callback；更新订单已支付；写代理待结算收益和服务费 ledger；触发一次履约。

### 7.3 履约成功/失败

锁定履约记录；按幂等键写 attempt；成功生成权益并更新履约成功；失败记录原因并保持不可结算。

### 7.4 退款申请与退款回调

创建售后单并立即冻结订单结算状态。退款成功回调锁定 refund/order，更新退款状态，按责任写退款 ledger；未结算则扣减待结算收益，已结算则生成追扣。

### 7.5 结算单生成

按 `agent_id` 和结算窗口选择可结算订单，排除退款中、投诉中、风控冻结；加锁插入 `settlement_items`。单层依赖 `settlement_items.order_id` 唯一防重复；两级渠道依赖 `settlement_items(order_id, settlement_role)` 唯一防重复。

### 7.6 人工打款确认

锁定结算单；写 `manual_payouts`、打款凭证和 payout ledger；结算单变为已打款/已结算。

### 7.7 已结算后追扣

创建 `clawbacks`；按未结算收益、待打款收益、保证金顺序扣减；每一步写 ledger；不足时限制店铺销售、限制结算或暂停人工打款。

### 7.8 保证金扣减/退还

锁定 `deposit_account`；写 `deposit_transactions` 和 ledger；更新余额；不足时触发店铺或结算限制。

### 7.9 风控冻结/解冻

写 `risk_freezes`；同步订单、店铺或结算限制；写审计日志；解冻后重新进入可结算判断。

## 8. 幂等键

1. 支付回调：`pay:{channel}:{channel_trade_no}`
2. 退款回调：`refund:{channel}:{channel_refund_no}`
3. 履约尝试：`fulfill:{order_item_id}:{attempt_no}` 或外部请求号
4. 权益发放：`entitlement:{order_item_id}:{rights_code}`
5. 结算生成：`settlement:{agent_id}:{period_start}:{period_end}:{batch_no}`
6. 追扣：`clawback:{source_type}:{source_id}:{agent_id}`
7. 保证金交易：`deposit:{type}:{source_type}:{source_id}:{agent_id}`
8. 审计事件：`audit:{request_id}` 或 `audit:{actor}:{action}:{target}:{request_id}`

## 9. V1 必做与后置

V1 必做：

1. 订单快照、金额快照。
2. 支付和退款幂等回调。
3. 履约尝试与权益记录。
4. 售后责任拆账。
5. 结算单、结算明细唯一约束、人工打款记录。
6. 已结算后追扣。
7. 保证金账户与交易。
8. `ledger_entries`。
9. `risk_freezes`、`complaints`、`audit_logs`。
10. RBAC。
11. 代理数据隔离索引。

后置：

1. 自动提现。
2. 多供应商结算。
3. 完整复式总账。
4. 自动风控评分。
5. 复杂营销优惠。
6. 代理销售额度动态模型。
7. 高级 BI。
8. 多履约供应商路由。
9. 开放平台 API。

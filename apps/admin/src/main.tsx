import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, cents, text, type JsonRecord } from "./api.js";
import "./styles.css";

type LoadState = {
  shop?: JsonRecord;
  platformShop?: JsonRecord;
  publicProducts: JsonRecord[];
  platformShopProducts: JsonRecord[];
  agentProducts: JsonRecord[];
  platformProducts: JsonRecord[];
  ownProducts: JsonRecord[];
  agentOrders: JsonRecord[];
  adminOrders: JsonRecord[];
  agentApplications: JsonRecord[];
  adminAfterSales: JsonRecord[];
  adminRefunds: JsonRecord[];
  adminSettlements: JsonRecord[];
  adminDeposits: JsonRecord[];
  serviceQrCodes: JsonRecord[];
  riskFreezes: JsonRecord[];
  paymentConfigs: JsonRecord[];
  settlements: JsonRecord[];
  clawbacks: JsonRecord[];
  auditLogs: JsonRecord[];
  ledgerEntries: JsonRecord[];
  channels?: JsonRecord;
  rightsCodes: JsonRecord[];
  notifications: JsonRecord[];
  reconciliation?: JsonRecord;
  agentDashboard?: JsonRecord;
  riskDashboard?: JsonRecord;
  paymentGuide?: JsonRecord;
};

const initialState: LoadState = {
  publicProducts: [],
  platformShopProducts: [],
  agentProducts: [],
  platformProducts: [],
  ownProducts: [],
  agentOrders: [],
  adminOrders: [],
  agentApplications: [],
  adminAfterSales: [],
  adminRefunds: [],
  adminSettlements: [],
  adminDeposits: [],
  serviceQrCodes: [],
  riskFreezes: [],
  paymentConfigs: [],
  settlements: [],
  clawbacks: [],
  auditLogs: [],
  ledgerEntries: [],
  rightsCodes: [],
  notifications: []
};

const adminNav = [
  "基础看板",
  "代理审核",
  "保证金",
  "店铺管理",
  "平台自营",
  "商品管理",
  "代理商品审核",
  "订单管理",
  "履约管理",
  "售后退款",
  "结算管理",
  "风控冻结",
  "审计日志",
  "账务流水",
  "客服二维码",
  "V2经营看板",
  "权益码池",
  "支付开通"
];

const agentNav = [
  "入驻与店铺",
  "选品与定价",
  "订单收益",
  "结算记录",
  "追扣记录",
  "店铺装修",
  "消息通知"
];

function App() {
  const [data, setData] = useState<LoadState>(initialState);
  const [message, setMessage] = useState("正在连接 API...");
  const [loading, setLoading] = useState(false);
  const [priceCents, setPriceCents] = useState("15000");
  const [refundCents, setRefundCents] = useState("3000");
  const [attemptNo, setAttemptNo] = useState(1);
  const [currentOrder, setCurrentOrder] = useState<JsonRecord | undefined>();
  const [currentAfterSale, setCurrentAfterSale] = useState<JsonRecord | undefined>();
  const [currentRefund, setCurrentRefund] = useState<JsonRecord | undefined>();
  const [currentAllocation, setCurrentAllocation] = useState<JsonRecord | undefined>();

  const selectedPublicProduct = data.publicProducts[0];
  const selectedPlatformShopProduct = data.platformShopProducts[0];
  const selectedAgentProduct = data.agentProducts[0];
  const selectedOrder = currentOrder ?? data.adminOrders[0] ?? data.agentOrders[0];
  const selectedSettlement = data.settlements.find((sheet) => text(sheet.status) !== "paid") ?? data.settlements[0];
  const selectedOwnProduct = data.ownProducts.find((item) => text(item.reviewStatus) === "pending_review") ?? data.ownProducts[0];
  const selectedOrderNo = text(selectedOrder?.orderNo, "");
  const selectedOrderAmount = amountOf(selectedOrder);

  async function loadAll(status = "数据已刷新") {
    setLoading(true);
    try {
      const [
        shop,
        platformShop,
        publicProducts,
        platformShopProducts,
        agentProducts,
        platformProducts,
        ownProducts,
        agentOrders,
        settlements,
        clawbacks,
        adminOrders,
        agentApplications,
        adminAfterSales,
        adminRefunds,
        adminSettlements,
        adminDeposits,
        channels,
        serviceQrCodes,
        riskFreezes,
        paymentConfigs,
        auditLogs,
        ledgerEntries,
        reconciliation,
        rightsCodes,
        notifications,
        agentDashboard,
        riskDashboard,
        paymentGuide
      ] = await Promise.all([
        api.shop(),
        api.shop("shop-platform"),
        api.shopProducts(),
        api.adminPlatformShopProducts(),
        api.agentProducts(),
        api.adminPlatformProducts(),
        api.ownProducts(),
        api.agentOrders(),
        api.agentSettlements(),
        api.agentClawbacks(),
        api.adminOrders(),
        api.agentApplications(),
        api.adminAfterSales(),
        api.adminRefunds(),
        api.adminSettlements(),
        api.adminDeposits(),
        api.adminChannels(),
        api.serviceQrCodes(),
        api.riskFreezes(),
        api.paymentConfigStatus(),
        api.auditLogs(),
        api.ledgerEntries(),
        api.reconciliationSummary(),
        api.rightsCodes(),
        api.notifications(),
        api.agentDashboard(),
        api.riskDashboard(),
        api.paymentGuide()
      ]);
      setData({
        shop,
        platformShop,
        publicProducts,
        platformShopProducts,
        agentProducts,
        platformProducts,
        ownProducts,
        agentOrders,
        settlements,
        clawbacks,
        adminOrders,
        agentApplications,
        adminAfterSales,
        adminRefunds,
        adminSettlements,
        adminDeposits,
        channels,
        serviceQrCodes,
        riskFreezes,
        paymentConfigs,
        auditLogs,
        ledgerEntries,
        reconciliation,
        rightsCodes,
        notifications,
        agentDashboard,
        riskDashboard,
        paymentGuide
      });
      setCurrentOrder((order: JsonRecord | undefined) => order ?? adminOrders[0] ?? agentOrders[0]);
      setMessage(status);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function runAction(label: string, action: () => Promise<unknown>, refresh = true) {
    setLoading(true);
    try {
      const result = await action();
      if (isRecord(result) && result.orderNo) setCurrentOrder(result);
      if (isRecord(result) && result.afterSaleNo) setCurrentAfterSale(result);
      if (isRecord(result) && isRecord(result.refund)) setCurrentRefund(result.refund as JsonRecord);
      if (isRecord(result) && isRecord(result.allocation)) setCurrentAllocation(result.allocation as JsonRecord);
      if (isRecord(result) && result.refundNo) setCurrentRefund(result);
      setMessage(`${label}成功`);
      if (refresh) await loadAll(`${label}成功，数据已刷新`);
    } catch (error) {
      setMessage(`${label}失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setLoading(false);
    }
  }

  const metrics = useMemo(() => {
    const reconciliation = data.reconciliation ?? {};
    return [
      { label: "GMV", value: cents(reconciliation.totalPaidCents) },
      { label: "退款金额", value: cents(reconciliation.totalRefundedCents) },
      { label: "服务费", value: cents(reconciliation.totalServiceFeeCents) },
      { label: "自营毛收益", value: cents(reconciliation.platformSelfOperatedGrossMarginCents) },
      { label: "保证金余额", value: cents(reconciliation.depositAvailableCents) },
      { label: "活跃商品", value: text(data.agentDashboard?.activeProductCount, "0") },
      { label: "未读消息", value: text(data.agentDashboard?.noticeCount, "0") }
    ];
  }, [data.reconciliation, data.agentDashboard]);

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">ToSell</div>
        <small>平台后台</small>
        <nav>{adminNav.map((item) => <a key={item} href={`#${item}`}>{item}</a>)}</nav>
        <small>代理中心</small>
        <nav>{agentNav.map((item) => <a key={item} href={`#${item}`}>{item}</a>)}</nav>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <h1>虚拟商品小店运营台</h1>
            <p>API：{api.baseUrl}；后台使用 mock header，代理和用户视图使用固定 demo 身份。</p>
          </div>
          <button onClick={() => void loadAll()} disabled={loading}>刷新</button>
        </header>

        <div className={loading ? "notice loading" : "notice"}>{message}</div>

        <section className="metrics" id="基础看板" aria-label="基础看板">
          {metrics.map((item) => (
            <div key={item.label}><span>{item.label}</span><strong>{item.value}</strong></div>
          ))}
        </section>

        <section className="two-col">
          <Panel title="代理审核" owner="运营" id="代理审核">
            <KeyValue label="示例代理" value="agent-1 / 测试代理 A" />
            <KeyValue label="审核状态" value="active，可演示重新置为待缴保证金" />
            <KeyValue label="入驻申请数" value={String(data.agentApplications.length)} />
            <Table rows={data.agentApplications.slice(0, 4)} columns={["applicationNo", "agentId", "status", "contactPhone", "customerServiceWechat"]} />
            <div className="actions">
              <button onClick={() => void runAction("代理审核通过", () => api.reviewAgent("agent-1", true, "资料通过"))}>审核通过</button>
              <button onClick={() => void runAction("代理审核拒绝", () => api.reviewAgent("agent-1", false, "资料需补充"))}>审核拒绝</button>
            </div>
            <KeyValue label="新代理" value="agent-new，可演示完整入驻审核" />
            <button onClick={() => void runAction("新代理审核通过", () => api.reviewAgent("agent-new", true, "资料通过"))}>通过新代理</button>
          </Panel>

          <Panel title="保证金" owner="财务" id="保证金">
            <KeyValue label="应缴/可用" value="¥500.00 / 以后端账户为准" />
            <KeyValue label="保证金账户" value={String(data.adminDeposits.length)} />
            <KeyValue label="操作约束" value="扣减写交易和审计；余额不足触发限制" />
            <Table rows={data.adminDeposits} columns={["agentId", "requiredAmountCents", "availableAmountCents", "status"]} moneyColumns={["requiredAmountCents", "availableAmountCents"]} />
            <div className="actions">
              <button onClick={() => void runAction("新代理保证金确认", () => api.confirmDeposit())}>确认新代理保证金</button>
              <button onClick={() => void runAction("保证金扣减", api.deductDeposit)}>扣减 ¥10.00</button>
            </div>
          </Panel>

          <Panel title="二级渠道管理" owner="运营" id="二级渠道管理">
            <KeyValue label="授权记录" value={String(channelRows(data.channels, "authorizations").length)} />
            <KeyValue label="渠道关系" value={String(channelRows(data.channels, "relations").length)} />
            <KeyValue label="转供商品" value={String(channelRows(data.channels, "offers").length)} />
            <Table rows={channelRows(data.channels, "relations")} columns={["id", "firstTierAgentId", "secondTierAgentId", "status"]} />
            <Table rows={channelRows(data.channels, "offers")} columns={["id", "channelRelationId", "platformProductId", "resellSupplyPriceCents", "status"]} moneyColumns={["resellSupplyPriceCents"]} />
            <div className="actions">
              <button onClick={() => void runAction("一级渠道授权", api.reviewChannel)}>开通二级供货能力</button>
              <button onClick={() => void runAction("创建二级关系", api.createChannelRelation)}>绑定一级/二级</button>
              <button onClick={() => void runAction("配置转供价", api.upsertChannelOffer)}>保存转供价</button>
            </div>
          </Panel>

          <Panel title="店铺管理" owner="运营" id="店铺管理">
            <KeyValue label="店铺" value={`${text(data.shop?.name)} (${text(data.shop?.status)})`} />
            <KeyValue label="客服微信" value={text(data.shop?.customerServiceWechat)} />
            <KeyValue label="客服二维码" value={text(data.shop?.customerServiceQrUrl)} />
            <button onClick={() => void runAction("店铺资料保存", () => api.saveAgentShop("测试代理 A 小店", "购买后按商品规则发放权益"))}>保存店铺资料</button>
          </Panel>

          <Panel title="平台自营" owner="平台" id="平台自营">
            <KeyValue label="自营店" value={`${text(data.platformShop?.name)} (${text(data.platformShop?.status)})`} />
            <KeyValue label="客服二维码" value={text(data.platformShop?.customerServiceQrUrl)} />
            <KeyValue label="自营成交额" value={cents(data.reconciliation?.platformSelfOperatedPaidCents)} />
            <KeyValue label="自营毛收益" value={cents(data.reconciliation?.platformSelfOperatedGrossMarginCents)} />
            <Table rows={data.platformShopProducts} columns={["id", "productType", "salePriceCents", "status"]} moneyColumns={["salePriceCents"]} />
            <div className="actions">
              <button onClick={() => void runAction("自营商品配置", api.upsertPlatformShopProduct)}>保存自营商品</button>
              <button onClick={() => void runAction("平台自营报价", () => api.quoteOrder("shop-platform", text(selectedPlatformShopProduct?.id, "psp-1")), false)}>自营报价</button>
              <button onClick={() => void runAction("创建平台自营订单", async () => {
                const quote = await api.quoteOrder("shop-platform", text(selectedPlatformShopProduct?.id, "psp-1"));
                return api.createOrder("shop-platform", text(selectedPlatformShopProduct?.id, "psp-1"), text(quote.paidAmountCents));
              })}>创建自营订单</button>
            </div>
          </Panel>

          <Panel title="商品管理" owner="运营" id="商品管理">
            <KeyValue label="平台商品数" value={String(data.platformProducts.length)} />
            <KeyValue label="店铺商品数" value={String(data.agentProducts.length)} />
            <Table rows={data.platformProducts} columns={["id", "name", "supplyPriceCents", "minSalePriceCents", "suggestedSalePriceCents", "status"]} moneyColumns={["supplyPriceCents", "minSalePriceCents", "suggestedSalePriceCents"]} />
            <div className="inline-form">
              <label>代理售价(分)<input value={priceCents} onChange={(event) => setPriceCents(event.target.value)} /></label>
              <button onClick={() => void runAction("代理改价", () => api.updateAgentProductPrice(text(selectedAgentProduct?.id, "ap-1"), priceCents))}>保存售价</button>
            </div>
            <button onClick={() => void runAction("创建平台商品", api.createPlatformProduct)}>新增平台商品</button>
          </Panel>

          <Panel title="代理商品审核" owner="运营" id="代理商品审核">
            <KeyValue label="待审/历史" value={String(data.ownProducts.length)} />
            <KeyValue label="当前自有商品" value={text(selectedOwnProduct?.name, "暂无，先提交")} />
            <Table rows={data.ownProducts} columns={["id", "name", "salePriceCents", "minSalePriceCents", "reviewStatus", "status"]} moneyColumns={["salePriceCents", "minSalePriceCents"]} />
            <div className="actions">
              <button onClick={() => void runAction("代理提交自有商品", api.submitOwnProduct)}>提交自有商品</button>
              <button disabled={!selectedOwnProduct?.id} onClick={() => void runAction("自有商品审核通过", () => api.reviewOwnProduct(text(selectedOwnProduct?.id, "")))}>审核通过</button>
              <button disabled={!selectedOwnProduct?.id} onClick={() => void runAction("自有商品审核拒绝", () => api.reviewOwnProduct(text(selectedOwnProduct?.id, ""), false))}>审核拒绝</button>
            </div>
          </Panel>

          <Panel title="订单管理" owner="运营" id="订单管理">
            <KeyValue label="后台订单数" value={String(data.adminOrders.length)} />
            <KeyValue label="当前订单" value={selectedOrderNo || "暂无，先创建订单"} />
            <div className="actions">
              <button onClick={() => void runAction("订单报价", () => api.quoteOrder("shop-1", text(selectedPublicProduct?.id, "ap-1")), false)}>报价</button>
              <button onClick={() => void runAction("创建订单", async () => {
                const quote = await api.quoteOrder("shop-1", text(selectedPublicProduct?.id, "ap-1"));
                return api.createOrder("shop-1", text(selectedPublicProduct?.id, "ap-1"), text(quote.paidAmountCents));
              })}>创建订单</button>
              <button disabled={!selectedOrderNo} onClick={() => void runAction("模拟支付", () => api.mockPayment(selectedOrderNo, selectedOrderAmount))}>模拟支付</button>
            </div>
          </Panel>

          <Panel title="履约管理" owner="运营" id="履约管理">
            <KeyValue label="履约状态" value={text(selectedOrder?.fulfillmentStatus)} />
            <div className="inline-form">
              <label>尝试次数<input value={String(attemptNo)} onChange={(event) => setAttemptNo(Number(event.target.value) || 1)} /></label>
              <button disabled={!selectedOrderNo} onClick={() => void runAction("人工履约", () => api.fulfillOrder(selectedOrderNo, attemptNo))}>发放权益</button>
            </div>
          </Panel>

          <Panel title="售后退款" owner="运营" id="售后退款">
            <KeyValue label="退款状态" value={text(selectedOrder?.refundStatus)} />
            <KeyValue label="售后单数" value={String(data.adminAfterSales.length)} />
            <KeyValue label="退款单数" value={String(data.adminRefunds.length)} />
            <KeyValue label="售后单" value={text(currentAfterSale?.afterSaleNo, "暂无，先提交售后")} />
            <KeyValue label="退款单" value={text(currentRefund?.refundNo, "暂无，先审批退款")} />
            <KeyValue label="最近拆账" value={currentAllocation ? `平台 ${cents(currentAllocation.platformBearCents)} / 代理 ${cents(currentAllocation.agentBearCents)}` : "暂无"} />
            <div className="inline-form">
              <label>申请/拆账金额(分)<input value={refundCents} onChange={(event) => setRefundCents(event.target.value)} /></label>
            </div>
            <div className="actions">
              <button disabled={!selectedOrderNo} onClick={() => void runAction("用户售后申请", () => api.createAfterSale(selectedOrderNo, refundCents))}>提交售后</button>
              <button disabled={!selectedOrderNo} onClick={() => void runAction("退款拆账", () => api.allocateRefund(selectedOrder ?? {}, refundCents, "mixed"), false)}>混合责任拆账</button>
              <button disabled={!currentAfterSale?.afterSaleNo} onClick={() => void runAction("退款审批建单", () => api.createRefund(text(currentAfterSale?.afterSaleNo, ""), selectedOrder ?? {}, refundCents, "mixed"))}>审批退款</button>
              <button disabled={!currentRefund?.refundNo} onClick={() => void runAction("退款回调", () => api.mockRefund(text(currentRefund?.refundNo, "")))}>mock 退款成功</button>
            </div>
            <Table rows={data.adminAfterSales.slice(0, 4)} columns={["afterSaleNo", "orderNo", "status", "reasonCode", "requestedRefundCents"]} moneyColumns={["requestedRefundCents"]} />
          </Panel>

          <Panel title="结算管理" owner="财务" id="结算管理">
            <KeyValue label="结算单数" value={String(data.settlements.length)} />
            <KeyValue label="后台结算单数" value={String(data.adminSettlements.length)} />
            <KeyValue label="当前订单结算状态" value={text(selectedOrder?.settlementStatus)} />
            <KeyValue label="待打款结算单" value={text(selectedSettlement?.settlementNo, "暂无，先生成")} />
            <div className="actions">
              <button onClick={() => void runAction("生成结算单", api.generateSettlement)}>生成 T+1 结算单</button>
              <button disabled={!selectedSettlement?.settlementNo} onClick={() => void runAction("人工打款确认", () => api.confirmPayout(text(selectedSettlement?.settlementNo, "")))}>确认人工打款</button>
            </div>
          </Panel>

          <Panel title="风控冻结" owner="运营/管理员" id="风控冻结">
            <KeyValue label="当前订单风控" value={text(selectedOrder?.riskStatus)} />
            <KeyValue label="冻结记录" value={String(data.riskFreezes.length)} />
            <Table rows={data.riskFreezes.slice(0, 4)} columns={["id", "targetType", "targetId", "freezeType", "status"]} />
            <div className="actions">
              <button disabled={!selectedOrderNo} onClick={() => void runAction("订单风控冻结", () => api.riskFreeze("order", selectedOrderNo))}>冻结订单</button>
              <button onClick={() => void runAction("店铺风控冻结", () => api.riskFreeze("shop", "shop-2"))}>冻结测试店铺 B</button>
            </div>
          </Panel>

          <Panel title="审计日志" owner="管理员" id="审计日志">
            <KeyValue label="审计记录数" value={String(data.auditLogs.length)} />
            <Table rows={data.auditLogs.slice(-5)} columns={["action", "targetType", "targetId", "actor"]} />
          </Panel>

          <Panel title="账务流水" owner="财务" id="账务流水">
            <KeyValue label="流水记录数" value={String(data.ledgerEntries.length)} />
            <Table rows={data.ledgerEntries.slice(-6)} columns={["ledgerNo", "entryType", "orderNo", "agentId", "amountCents"]} moneyColumns={["amountCents"]} />
          </Panel>

          <Panel title="客服二维码" owner="运营" id="客服二维码">
            <KeyValue label="二维码记录" value={String(data.serviceQrCodes.length)} />
            <Table rows={data.serviceQrCodes} columns={["shopId", "ownerType", "name", "customerServiceWechat", "customerServiceQrUrl", "status"]} />
            <button onClick={() => void runAction("客服二维码保存", api.saveServiceQrCode)}>保存示例二维码</button>
          </Panel>

          <Panel title="V2经营看板" owner="运营/代理" id="V2经营看板">
            <KeyValue label="成交订单" value={text(data.agentDashboard?.paidOrderCount, "0")} />
            <KeyValue label="预估收益" value={cents(data.agentDashboard?.expectedIncomeCents)} />
            <KeyValue label="退款率" value={`${(Number(data.agentDashboard?.refundRateBps ?? 0) / 100).toFixed(2)}%`} />
            <KeyValue label="低保证金代理" value={String((data.riskDashboard?.lowDepositAgents as unknown[] | undefined)?.length ?? 0)} />
            <KeyValue label="低库存商品" value={String((data.riskDashboard?.lowStockProducts as unknown[] | undefined)?.length ?? 0)} />
          </Panel>

          <Panel title="权益码池" owner="运营" id="权益码池">
            <KeyValue label="权益码总数" value={String(data.rightsCodes.length)} />
            <KeyValue label="可用权益码" value={String(data.rightsCodes.filter((item) => text(item.status) === "available").length)} />
            <div className="actions">
              <button onClick={() => void runAction("导入权益码", api.importRightsCodes)}>导入测试权益码</button>
              <button onClick={() => void runAction("批量选品", api.batchSelectProducts)}>批量上架示例商品</button>
            </div>
            <Table rows={data.rightsCodes.slice(0, 6)} columns={["codeId", "productId", "batchNo", "status", "orderNo"]} />
          </Panel>

          <Panel title="支付开通" owner="技术/财务" id="支付开通">
            <KeyValue label="当前状态" value={text(data.paymentGuide?.status, "not_configured")} />
            <KeyValue label="生产规则" value={text(data.paymentGuide?.productionRule)} />
            <Table rows={data.paymentConfigs} columns={["channel", "enabled", "feeBps", "fixedFeeCents", "statusNote"]} moneyColumns={["fixedFeeCents"]} />
            <div className="actions">
              <button onClick={() => void runAction("支付配置检查", api.paymentConfigCheck, false)}>检查配置</button>
              <button onClick={() => void runAction("支付配置状态保存", api.updatePaymentConfig)}>保存配置状态</button>
            </div>
            <Table rows={arrayRows(data.paymentGuide?.envVars, "envVar")} columns={["envVar"]} />
          </Panel>
        </section>

        <section className="section">
          <h2>代理经营视图</h2>
          <div className="two-col">
            <Panel title="入驻与店铺" owner="代理" id="入驻与店铺">
              <KeyValue label="店铺" value={text(data.shop?.name)} />
              <KeyValue label="营业状态" value={text(data.shop?.status)} />
              <button onClick={() => void runAction("入驻申请提交", api.submitAgentApplication)}>提交入驻资料</button>
            </Panel>

            <Panel title="选品与定价" owner="代理" id="选品与定价">
              <Table rows={agentProductRows(data.agentProducts)} columns={["id", "productName", "salePriceCents", "supplyPriceCents", "minSalePriceCents", "suggestedSalePriceCents", "status"]} moneyColumns={["salePriceCents", "supplyPriceCents", "minSalePriceCents", "suggestedSalePriceCents"]} />
              <p className="hint">平台商品的供货价、最低价、建议价和预估收益只在代理中心展示，最终金额以后端返回为准。</p>
            </Panel>

            <Panel title="订单收益" owner="代理" id="订单收益">
              <Table rows={orderIncomeRows(data.agentOrders)} columns={["orderNo", "status", "paymentStatus", "paidAmountCents", "agentExpectedIncomeCents", "settlementStatus"]} moneyColumns={["paidAmountCents", "agentExpectedIncomeCents"]} />
            </Panel>

            <Panel title="结算记录" owner="代理" id="结算记录">
              <Table rows={data.settlements} columns={["settlementNo", "status", "totalOrderCount", "totalAgentIncomeCents"]} moneyColumns={["totalAgentIncomeCents"]} />
            </Panel>

            <Panel title="追扣记录" owner="代理" id="追扣记录">
              <Table rows={data.clawbacks} columns={["clawbackNo", "orderNo", "status", "remainingAmountCents"]} moneyColumns={["remainingAmountCents"]} />
            </Panel>

            <Panel title="店铺装修" owner="代理" id="店铺装修">
              <KeyValue label="主题色" value={text(data.shop?.themeColor)} />
              <KeyValue label="分享标题" value={text(data.shop?.shareTitle)} />
              <button onClick={() => void runAction("店铺装修保存", api.saveShopDecor)}>保存 V2 装修示例</button>
            </Panel>

            <Panel title="消息通知" owner="代理" id="消息通知">
              <KeyValue label="消息数" value={String(data.notifications.length)} />
              <Table rows={data.notifications.slice(0, 5)} columns={["title", "type", "readAt"]} />
            </Panel>
          </div>
        </section>
      </section>
    </main>
  );
}

function Panel(props: { title: string; owner: string; id: string; children: React.ReactNode }) {
  return (
    <article className="panel" id={props.id}>
      <div className="panel-head">
        <h2>{props.title}</h2>
        <span>{props.owner}</span>
      </div>
      {props.children}
    </article>
  );
}

function KeyValue(props: { label: string; value: string }) {
  return (
    <div className="kv">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function Table(props: { rows: JsonRecord[]; columns: string[]; moneyColumns?: string[] }) {
  const moneyColumns = new Set(props.moneyColumns ?? []);
  if (props.rows.length === 0) return <p className="empty">暂无记录</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{props.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
        <tbody>
          {props.rows.map((row, index) => (
            <tr key={`${props.columns.map((column) => text(row[column])).join("-")}-${index}`}>
              {props.columns.map((column) => <td key={column}>{moneyColumns.has(column) ? cents(row[column]) : text(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function amountOf(order?: JsonRecord): string {
  if (order?.paidAmountCents) return text(order.paidAmountCents, "15000");
  const snapshot = order?.snapshot as JsonRecord | undefined;
  const amount = snapshot?.amountSnapshot as JsonRecord | undefined;
  return text(amount?.paidAmountCents, "15000");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agentProductRows(rows: JsonRecord[]): JsonRecord[] {
  return rows.map((row) => {
    const product = row.product as JsonRecord | undefined;
    return {
      id: row.id,
      productName: product?.name,
      salePriceCents: row.salePriceCents,
      supplyPriceCents: product?.supplyPriceCents,
      minSalePriceCents: product?.minSalePriceCents,
      suggestedSalePriceCents: product?.suggestedSalePriceCents,
      status: row.status
    };
  });
}

function orderIncomeRows(rows: JsonRecord[]): JsonRecord[] {
  return rows.map((row) => {
    const snapshot = row.snapshot as JsonRecord | undefined;
    const amount = snapshot?.amountSnapshot as JsonRecord | undefined;
    return {
      orderNo: row.orderNo,
      status: row.status,
      paymentStatus: row.paymentStatus,
      paidAmountCents: amount?.paidAmountCents,
      agentExpectedIncomeCents: amount?.agentExpectedIncomeCents,
      settlementStatus: row.settlementStatus
    };
  });
}

function arrayRows(value: unknown, key: string): JsonRecord[] {
  return Array.isArray(value) ? value.map((item) => ({ [key]: item })) : [];
}

function channelRows(channels: JsonRecord | undefined, key: string): JsonRecord[] {
  const value = channels?.[key];
  return Array.isArray(value) ? value as JsonRecord[] : [];
}

createRoot(document.getElementById("root")!).render(<App />);

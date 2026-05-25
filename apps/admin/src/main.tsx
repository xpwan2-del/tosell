import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type ModuleCard = {
  title: string;
  owner: string;
  status: string;
  checks: string[];
};

const modules: ModuleCard[] = [
  {
    title: "代理审核",
    owner: "运营",
    status: "待审核 / 待缴保证金 / 已开通 / 冻结",
    checks: ["审核通过后进入保证金环节", "拒绝必须填写原因", "冻结/禁用必须审计"]
  },
  {
    title: "保证金",
    owner: "财务",
    status: "待缴 / 已缴 / 扣减 / 不足 / 退还观察期",
    checks: ["每次变化写流水", "余额不足限制结算或销售", "退还前检查未完结风险"]
  },
  {
    title: "商品与定价",
    owner: "运营",
    status: "平台商品 / 代理自有商品审核 / 风险下架",
    checks: ["售价不得低于最低限价", "自有商品审核后售卖", "改价不影响订单快照"]
  },
  {
    title: "订单与履约",
    owner: "运营",
    status: "待支付 / 已支付 / 履约中 / 已履约 / 履约失败",
    checks: ["订单归属固化", "履约失败不得结算", "补发和撤销必须留痕"]
  },
  {
    title: "售后退款",
    owner: "运营 + 财务",
    status: "售后中 / 平台介入 / 退款中 / 已退款 / 驳回",
    checks: ["责任归属必填", "退款中冻结结算", "已结算退款生成追扣"]
  },
  {
    title: "结算与人工打款",
    owner: "财务",
    status: "待结算 / 冻结 / 可结算 / 结算中 / 已结算",
    checks: ["T+1 默认从履约成功起算", "同一订单不可重复结算", "V1 不做代理自助提现"]
  },
  {
    title: "风控与审计",
    owner: "管理员",
    status: "订单冻结 / 店铺冻结 / 限制结算 / 商品下架",
    checks: ["冻结期间不可结算", "解冻后重新判断", "敏感操作写审计日志"]
  }
];

function App() {
  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand">ToSell</div>
        <nav>
          {modules.map((item) => (
            <a key={item.title} href={`#${item.title}`}>{item.title}</a>
          ))}
        </nav>
      </aside>
      <section className="content">
        <header className="topbar">
          <div>
            <h1>虚拟商品微商小店后台</h1>
            <p>B2B2C 供货、审核、履约、结算和风控工作台</p>
          </div>
          <div className="pill">V1 结算单 + 人工打款</div>
        </header>

        <section className="metrics" aria-label="核心指标">
          <div><span>GMV</span><strong>¥0.00</strong></div>
          <div><span>待审核代理</span><strong>0</strong></div>
          <div><span>退款中订单</span><strong>0</strong></div>
          <div><span>可结算金额</span><strong>¥0.00</strong></div>
        </section>

        <section className="grid">
          {modules.map((module) => (
            <article className="panel" key={module.title} id={module.title}>
              <div className="panel-head">
                <h2>{module.title}</h2>
                <span>{module.owner}</span>
              </div>
              <p className="status">{module.status}</p>
              <ul>
                {module.checks.map((check) => <li key={check}>{check}</li>)}
              </ul>
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;

function readFiles(dir: string, extensions: string[]): Array<{ path: string; content: string }> {
  const entries: Array<{ path: string; content: string }> = [];
  for (const name of readdirSync(dir)) {
    const fullPath = join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...readFiles(fullPath, extensions));
      continue;
    }
    if (extensions.some((extension) => fullPath.endsWith(extension))) {
      entries.push({ path: fullPath, content: readFileSync(fullPath, "utf8") });
    }
  }
  return entries;
}

describe("frontend MVP static checks", () => {
  it("keeps prohibited growth-model wording out of frontend app code", () => {
    const files = [
      ...readFiles(join(root, "apps", "admin", "src"), [".ts", ".tsx", ".css"]),
      ...readFiles(join(root, "apps", "h5", "src"), [".ts", ".tsx", ".css"]),
      ...readFiles(join(root, "apps", "miniprogram"), [".ts", ".wxml", ".wxss", ".json"])
    ];
    const prohibited = [/直播/u, /分销/u, /返佣/u, /团队奖/u, /邀请奖励/u, /代理等级/u, /下级/u, /commission_rate/u, /team_performance/u];

    for (const file of files) {
      for (const pattern of prohibited) {
        expect(file.content, `${file.path} contains ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("does not show internal finance fields on user mini-program pages", () => {
    const userPageFiles = [
      join(root, "apps", "miniprogram", "pages", "shop", "index.wxml"),
      join(root, "apps", "miniprogram", "pages", "product", "detail.wxml"),
      join(root, "apps", "miniprogram", "pages", "payment", "result.wxml"),
      join(root, "apps", "miniprogram", "pages", "order", "index.wxml"),
      join(root, "apps", "miniprogram", "pages", "order", "detail.wxml")
    ];
    const hiddenTerms = [/供货价/u, /服务费/u, /代理收益/u, /结算金额/u, /冻结金额/u];

    for (const filePath of userPageFiles) {
      const content = readFileSync(filePath, "utf8");
      for (const term of hiddenTerms) {
        expect(content, `${filePath} exposes ${term}`).not.toMatch(term);
      }
    }
  });

  it("exposes all required admin module entries", () => {
    const source = readFileSync(join(root, "apps", "admin", "src", "main.tsx"), "utf8");
    const required = [
      "基础看板",
      "代理审核",
      "保证金",
      "二级渠道管理",
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
      "客服二维码",
      "入驻与店铺",
      "选品与定价",
      "订单收益",
      "结算记录",
      "追扣记录",
      "提交自有商品",
      "确认人工打款",
      "V2经营看板",
      "权益码池",
      "支付开通",
      "店铺装修",
      "消息通知"
    ];

    for (const label of required) {
      expect(source).toContain(label);
    }
  });
});

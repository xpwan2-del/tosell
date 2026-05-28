export type VirtualCatalogProduct = {
  demoId: string;
  productNo: string;
  name: string;
  category: string;
  tags: string[];
  subtitle: string;
  description: string;
  usageGuide: string;
  imageUrl: string;
  specs: string[];
  detailSections: Array<{
    title: string;
    items: string[];
  }>;
  stockCount: number;
  soldCount: number;
  supplyPriceCents: bigint;
  minSalePriceCents: bigint;
  suggestedSalePriceCents: bigint;
  fulfillmentMode: "manual" | "code_pool";
  agentProductId: string;
  agentSalePriceCents: bigint;
  groupName: string;
  platformShopProductId?: string;
  platformSalePriceCents?: bigint;
  fulfillmentCostCents?: bigint;
  rightsCodes?: string[];
};

export const virtualCatalogProducts: VirtualCatalogProduct[] = [
  {
    demoId: "prod-1",
    productNo: "VIRT-AI-CHATGPT-PLUS",
    name: "ChatGPT Plus 成品号月卡",
    category: "AI 会员",
    tags: ["热卖", "人工交付", "质保售后"],
    subtitle: "AI 对话、办公写作、代码辅助类会员账号。",
    description: "AI 会员账号类商品，购买后由客服按订单发放账号资料或使用说明，适合需要人工核验与售后协助的虚拟服务。",
    usageGuide: "下单后在订单中心查看状态；支付成功后添加本店客服领取账号资料，收到后请及时登录测试并修改安全信息。",
    imageUrl: "https://images.unsplash.com/photo-1677442136019-21780ecad995?auto=format&fit=crop&w=900&q=80",
    specs: ["月卡", "独享成品号"],
    detailSections: [
      { title: "产品使用说明", items: ["适合 AI 对话、办公写作、代码辅助和日常学习场景。", "购买后按订单交付账号资料或使用说明。"] },
      { title: "产品特点", items: ["账号资料由客服人工核验后交付。", "订单、交付、售后全程留痕，便于平台仲裁。"] },
      { title: "使用须知", items: ["请勿用于违规用途、批量滥用或破坏服务规则的行为。", "收到资料后请及时登录测试并按说明修改安全信息。"] },
      { title: "交付方式", items: ["系统确认支付成功后，请添加本店客服微信领取账号资料。"] }
    ],
    stockCount: 18,
    soldCount: 428,
    supplyPriceCents: 10_000n,
    minSalePriceCents: 12_000n,
    suggestedSalePriceCents: 15_000n,
    fulfillmentMode: "manual",
    agentProductId: "ap-1",
    agentSalePriceCents: 15_000n,
    groupName: "人工交付",
    platformShopProductId: "psp-1",
    platformSalePriceCents: 14_900n,
    fulfillmentCostCents: 10_000n
  },
  {
    demoId: "prod-code",
    productNo: "VIRT-AI-CLAUDE-CODE",
    name: "Claude Pro 共享兑换码",
    category: "AI 会员",
    tags: ["自动发码", "Claude", "秒级发放"],
    subtitle: "标准卡密库存，支付成功后自动发放。",
    description: "Claude 类虚拟权益自动发卡商品；购买时设置纯数字提取码，支付成功后按订单提取查看卡密。",
    usageGuide: "请妥善保存购买时设置的提取码；错误三次锁定 30 分钟，退款后不可继续查看卡密。",
    imageUrl: "https://images.unsplash.com/photo-1556742502-ec7c0e9f34b1?auto=format&fit=crop&w=900&q=80",
    specs: ["一个月", "自动卡密"],
    detailSections: [
      { title: "产品使用说明", items: ["适合 Claude 会员权益兑换或共享使用场景。", "下单时设置提取码，支付成功后从订单详情提取卡密。"] },
      { title: "产品特点", items: ["自动发码，库存由后台卡密池管理。", "提取记录、发放记录、订单记录均由服务端保存。"] },
      { title: "使用须知", items: ["请妥善保存购买时设置的提取码。", "提取码错误三次锁定 30 分钟；退款后不可继续查看卡密。"] },
      { title: "交付方式", items: ["支付成功后系统自动占用库存并生成发放凭证。"] }
    ],
    stockCount: 26,
    soldCount: 936,
    supplyPriceCents: 2_000n,
    minSalePriceCents: 3_000n,
    suggestedSalePriceCents: 4_900n,
    fulfillmentMode: "code_pool",
    agentProductId: "ap-code",
    agentSalePriceCents: 4_900n,
    groupName: "自动履约",
    platformShopProductId: "psp-code",
    platformSalePriceCents: 4_900n,
    fulfillmentCostCents: 2_000n,
    rightsCodes: ["RIGHT-CODE-001", "RIGHT-CODE-002", "RIGHT-CODE-003"]
  },
  {
    demoId: "prod-video",
    productNo: "VIRT-AI-GROK-MONTH",
    name: "Grok 会员账号月卡",
    category: "AI 会员",
    tags: ["Grok", "热门", "人工交付"],
    subtitle: "AI 会员账号类商品，适合人工交付与售后。",
    description: "Grok 账号权益商品；用户下单后由客服按商品规格发放账号或使用说明，订单、售后和客服入口均在本店闭环。",
    usageGuide: "购买前确认权益周期、登录方式和使用限制；人工交付商品请保持客服微信可联系。",
    imageUrl: "https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?auto=format&fit=crop&w=900&q=80",
    specs: ["1个月会员", "官方充值"],
    detailSections: [
      { title: "产品使用说明", items: ["适合 Grok 会员账号权益购买场景。", "购买前请确认权益周期、登录方式和可用范围。"] },
      { title: "产品特点", items: ["人工交付，客服按订单核验后处理。", "可在订单中心查看支付、履约和售后状态。"] },
      { title: "使用须知", items: ["虚拟权益具有时效性，请按页面说明及时核验。", "账号类商品请避免违规登录和异常使用。"] },
      { title: "交付方式", items: ["系统确认支付成功后，请联系本店客服领取权益。"] }
    ],
    stockCount: 12,
    soldCount: 517,
    supplyPriceCents: 1_900n,
    minSalePriceCents: 2_900n,
    suggestedSalePriceCents: 3_900n,
    fulfillmentMode: "manual",
    agentProductId: "ap-video",
    agentSalePriceCents: 3_900n,
    groupName: "热门推荐",
    platformShopProductId: "psp-video",
    platformSalePriceCents: 3_900n,
    fulfillmentCostCents: 1_900n
  },
  {
    demoId: "prod-cloud-code",
    productNo: "VIRT-AI-GEMINI-CODE",
    name: "Gemini Advanced 兑换码",
    category: "AI 会员",
    tags: ["自动发码", "Gemini", "兑换码"],
    subtitle: "Gemini 类兑换权益，适合自动码池交付。",
    description: "支付成功后系统自动发放兑换码；用户进入订单提取页输入购买时设置的提取码查看。",
    usageGuide: "兑换前请核对账号地区和有效期；已退款订单不可继续查看或使用卡密。",
    imageUrl: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=900&q=80",
    specs: ["一年会员", "自助激活"],
    detailSections: [
      { title: "产品使用说明", items: ["适合 Gemini Advanced 兑换权益场景。", "购买后通过订单详情提取兑换码，并按说明完成激活。"] },
      { title: "产品特点", items: ["自动发码，减少人工等待。", "后台可查看库存、批次、发放状态和订单绑定。"] },
      { title: "使用须知", items: ["兑换前请确认账号地区、有效期和适用范围。", "退款后系统不再展示卡密。"] },
      { title: "交付方式", items: ["支付成功后自动发放，输入提取码即可查看。"] }
    ],
    stockCount: 9,
    soldCount: 301,
    supplyPriceCents: 2_600n,
    minSalePriceCents: 3_600n,
    suggestedSalePriceCents: 5_900n,
    fulfillmentMode: "code_pool",
    agentProductId: "ap-cloud-code",
    agentSalePriceCents: 5_900n,
    groupName: "自动履约",
    rightsCodes: ["CLOUD-MEMBER-001", "CLOUD-MEMBER-002"]
  },
  {
    demoId: "prod-design",
    productNo: "VIRT-ACCOUNT-APPLE-US",
    name: "美区 Apple ID 成品号",
    category: "账号成品",
    tags: ["Apple ID", "人工交付", "成品号"],
    subtitle: "账号类虚拟商品，适合人工核验后交付。",
    description: "账号成品号商品；客服按订单发放账号资料和使用注意事项，适合需要人工确认库存和账号状态的商品。",
    usageGuide: "购买前确认地区、用途和登录限制；交付后请及时核验账号状态，按说明修改安全信息。",
    imageUrl: "https://images.unsplash.com/photo-1498050108023-c5249f4df0852?auto=format&fit=crop&w=900&q=80",
    specs: ["美区", "成品号"],
    detailSections: [
      { title: "产品使用说明", items: ["适合需要美区 Apple ID 的虚拟账号场景。", "购买前请确认地区、用途和登录限制。"] },
      { title: "产品特点", items: ["账号资料由客服人工交付。", "可按订单记录追踪交付和售后处理。"] },
      { title: "使用须知", items: ["交付后请及时核验账号状态。", "请勿用于违规、欺诈或高风险用途。"] },
      { title: "交付方式", items: ["系统确认支付成功后，请添加客服领取账号资料。"] }
    ],
    stockCount: 31,
    soldCount: 802,
    supplyPriceCents: 1_200n,
    minSalePriceCents: 2_000n,
    suggestedSalePriceCents: 2_900n,
    fulfillmentMode: "manual",
    agentProductId: "ap-design",
    agentSalePriceCents: 2_900n,
    groupName: "账号成品"
  },
  {
    demoId: "prod-tg",
    productNo: "VIRT-ACCOUNT-TG-OLD",
    name: "Telegram 老号成品号",
    category: "账号成品",
    tags: ["Telegram", "人工交付", "老号"],
    subtitle: "社交账号类虚拟商品，订单和售后留痕。",
    description: "TG 账号类商品；支付成功后由客服发放账号资料或绑定说明。",
    usageGuide: "请在购买前确认账号类型、使用范围和售后规则；账号类商品以实际交付记录为准。",
    imageUrl: "https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=900&q=80",
    specs: ["老号", "人工交付"],
    detailSections: [
      { title: "产品使用说明", items: ["适合 Telegram 老号成品号购买场景。", "购买前请确认账号类型、使用范围和售后规则。"] },
      { title: "产品特点", items: ["人工交付，客服可协助说明登录注意事项。", "订单归属、履约状态和售后记录均可查询。"] },
      { title: "使用须知", items: ["账号类商品交付后请及时测试。", "异常用途或违反平台规则造成的问题不纳入普通售后。"] },
      { title: "交付方式", items: ["支付成功后联系客服领取账号资料或绑定说明。"] }
    ],
    stockCount: 44,
    soldCount: 1160,
    supplyPriceCents: 3_500n,
    minSalePriceCents: 4_900n,
    suggestedSalePriceCents: 6_900n,
    fulfillmentMode: "manual",
    agentProductId: "ap-learn",
    agentSalePriceCents: 6_900n,
    groupName: "账号成品"
  },
  {
    demoId: "prod-ip",
    productNo: "VIRT-NETWORK-RESIDENTIAL-IP",
    name: "海外住宅 IP 体验包",
    category: "网络服务",
    tags: ["住宅 IP", "人工交付", "短期体验"],
    subtitle: "网络服务类虚拟商品，适合客服交付。",
    description: "住宅 IP/网络服务商品；购买后由客服按订单发放使用说明和服务入口。",
    usageGuide: "购买前确认地区、时长和用途限制；网络服务类商品以后台交付记录和客服说明为准。",
    imageUrl: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?auto=format&fit=crop&w=900&q=80",
    specs: ["一个月", "一年"],
    detailSections: [
      { title: "产品使用说明", items: ["本产品仅限学习、办公和正常网络环境测试使用。", "不支持违法、高风险、攻击、滥发、批量注册等用途。"] },
      { title: "产品特点", items: ["适合 AI 生产力、外网办公和账号环境维护场景。", "可按订单由客服提供配置说明。"] },
      { title: "使用须知", items: ["如不了解相关配置，建议先咨询客服再下单。", "具体体验取决于自身设备、网络质量和使用环境。"] },
      { title: "交付方式", items: ["拍下后联系客服，按订单进行专属配置与使用指导。"] }
    ],
    stockCount: 20,
    soldCount: 265,
    supplyPriceCents: 3_000n,
    minSalePriceCents: 4_900n,
    suggestedSalePriceCents: 7_900n,
    fulfillmentMode: "manual",
    agentProductId: "ap-ip",
    agentSalePriceCents: 7_900n,
    groupName: "网络服务"
  },
  {
    demoId: "prod-api-code",
    productNo: "VIRT-API-CODEX-CARD",
    name: "CODEX API 额度兑换卡",
    category: "API 额度",
    tags: ["自动发码", "API", "兑换卡"],
    subtitle: "API 额度兑换卡密，适合自动发码。",
    description: "API 额度、兑换卡类虚拟商品；购买时设置提取码，系统支付成功后自动发放卡密。",
    usageGuide: "提取码错误三次锁定 30 分钟；兑换前请确认卡密有效期和适用范围。",
    imageUrl: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=900&q=80",
    specs: ["100刀额度", "300刀额度"],
    detailSections: [
      { title: "产品使用说明", items: ["适合 API 额度兑换、开发测试和工具接入场景。", "购买前请确认额度类型、有效期和适用范围。"] },
      { title: "产品特点", items: ["自动发码，支付成功后可立即提取。", "卡密批次、库存和发放状态可在后台管理。"] },
      { title: "使用须知", items: ["请勿公开泄露卡密或用于违规用途。", "退款后不可继续查看或使用已发放卡密。"] },
      { title: "交付方式", items: ["系统支付成功后自动发放，输入提取码查看卡密。"] }
    ],
    stockCount: 14,
    soldCount: 388,
    supplyPriceCents: 5_000n,
    minSalePriceCents: 6_900n,
    suggestedSalePriceCents: 9_900n,
    fulfillmentMode: "code_pool",
    agentProductId: "ap-api-code",
    agentSalePriceCents: 9_900n,
    groupName: "自动履约",
    rightsCodes: ["CODEX-API-100K-001", "CODEX-API-100K-002"]
  }
];

export const virtualShopSeed = {
  name: "云享数码权益店",
  announcement: "主营虚拟账号、会员权益、兑换码与人工交付服务；下单前请确认商品说明，自动发码商品购买时设置提取码。",
  customerServiceWechat: "yunxiang_service",
  collectionAccountName: "云享数码权益店",
  collectionNote: "支付账号开通前用于模拟收款；正式上线后以系统支付结果为准",
  themeColor: "#0f766e",
  bannerUrl: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1200&q=80",
  shareTitle: "账号、卡密、会员权益一站式购买",
  productGroups: [
    { name: "热门推荐", agentProductIds: ["ap-1", "ap-video", "ap-code"] },
    { name: "自动发码", agentProductIds: ["ap-code", "ap-cloud-code", "ap-api-code"] },
    { name: "账号成品", agentProductIds: ["ap-design", "ap-learn"] },
    { name: "网络服务", agentProductIds: ["ap-ip"] }
  ]
};

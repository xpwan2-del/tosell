import { type PlatformProductQuote, quoteAgentOwnedProduct, quotePlatformProduct } from "./money.js";

export type OrderProductType = "platform" | "agent_owned";
export type SaleRiskStatus = "normal" | "order_frozen" | "shop_frozen" | "settlement_restricted" | "product_removed" | "disabled";

export type OrderSnapshotInput = {
  orderNo: string;
  userId: string;
  agent: {
    id: string;
    name: string;
    status: "active" | string;
    riskStatus: SaleRiskStatus | string;
    depositStatus: "paid" | "partially_deducted" | string;
  };
  shop: {
    id: string;
    name: string;
    status: "open" | string;
    riskStatus: SaleRiskStatus | string;
    customerServiceWechat?: string;
    customerServiceQrUrl?: string;
  };
  agentProduct: {
    id: string;
    agentId: string;
    shopId: string;
    productType: OrderProductType;
    platformProductId?: string | null;
    ownProductReviewId?: string | null;
    salePriceCents: bigint;
    status: "listed" | string;
  };
  platformProduct?: {
    id: string;
    name: string;
    supplyPriceCents: bigint;
    minSalePriceCents: bigint;
    suggestedSalePriceCents: bigint;
    fulfillmentRule: unknown;
    afterSaleRule: unknown;
    status: "active" | string;
  };
  ownProduct?: {
    id: string;
    name: string;
    minSalePriceCents?: bigint;
    fulfillmentRule: unknown;
    afterSaleRule: unknown;
    reviewStatus: "approved" | string;
  };
  quantity?: number;
  entrySource?: string;
};

export type OrderSnapshot = {
  orderNo: string;
  userId: string;
  agentId: string;
  shopId: string;
  agentProductId: string;
  productType: OrderProductType;
  productNameSnapshot: string;
  quantity: number;
  quote: PlatformProductQuote;
  amountSnapshot: {
    serviceFeeBps: bigint;
    paidAmountCents: bigint;
    supplyAmountCents: bigint;
    serviceFeeCents: bigint;
    agentExpectedIncomeCents: bigint;
  };
  productSnapshot: unknown;
  shopSnapshot: unknown;
  pricingSnapshot: unknown;
  fulfillmentRuleSnapshot: unknown;
  afterSaleRuleSnapshot: unknown;
};

export function assertCanCreateOrder(input: OrderSnapshotInput): void {
  if (input.agent.status !== "active") throw new Error("agent is not active");
  if (input.agent.depositStatus !== "paid" && input.agent.depositStatus !== "partially_deducted") {
    throw new Error("agent deposit is not paid");
  }
  if (input.shop.status !== "open") throw new Error("shop is not open");
  if (input.agentProduct.agentId !== input.agent.id) {
    throw new Error("agent product does not belong to agent");
  }
  if (input.agentProduct.shopId !== input.shop.id) {
    throw new Error("agent product does not belong to shop");
  }
  if (input.agentProduct.status !== "listed") throw new Error("agent product is not listed");
  if (isSaleBlockedByRisk(input.agent.riskStatus) || isSaleBlockedByRisk(input.shop.riskStatus)) {
    throw new Error("risk freeze blocks order creation");
  }
  if (input.agentProduct.productType === "platform") {
    if (!input.platformProduct) throw new Error("platform product is required");
    if (input.agentProduct.platformProductId !== input.platformProduct.id) {
      throw new Error("agent product does not reference platform product");
    }
    if (input.agentProduct.ownProductReviewId) {
      throw new Error("platform product cannot reference own product review");
    }
    if (input.platformProduct.status !== "active") throw new Error("platform product is not active");
    return;
  }
  if (!input.ownProduct) throw new Error("own product is required");
  if (input.agentProduct.ownProductReviewId !== input.ownProduct.id) {
    throw new Error("agent product does not reference own product review");
  }
  if (input.agentProduct.platformProductId) {
    throw new Error("own product cannot reference platform product");
  }
  if (input.ownProduct.reviewStatus !== "approved") throw new Error("own product is not approved");
}

export function buildOrderSnapshot(input: OrderSnapshotInput): OrderSnapshot {
  assertCanCreateOrder(input);

  const quantity = input.quantity ?? 1;
  const quote = input.agentProduct.productType === "platform"
    ? quotePlatformProduct({
      salePriceCents: input.agentProduct.salePriceCents,
      supplyPriceCents: input.platformProduct!.supplyPriceCents,
      minSalePriceCents: input.platformProduct!.minSalePriceCents,
      quantity
    })
    : quoteAgentOwnedProduct({
      salePriceCents: input.agentProduct.salePriceCents,
      minSalePriceCents: input.ownProduct!.minSalePriceCents,
      quantity
    });

  const product = input.agentProduct.productType === "platform" ? input.platformProduct! : input.ownProduct!;

  return {
    orderNo: input.orderNo,
    userId: input.userId,
    agentId: input.agent.id,
    shopId: input.shop.id,
    agentProductId: input.agentProduct.id,
    productType: input.agentProduct.productType,
    productNameSnapshot: product.name,
    quantity,
    quote,
    amountSnapshot: {
      serviceFeeBps: quote.serviceFeeBps,
      paidAmountCents: quote.paidAmountCents,
      supplyAmountCents: quote.supplyAmountCents,
      serviceFeeCents: quote.serviceFeeCents,
      agentExpectedIncomeCents: quote.agentExpectedIncomeCents
    },
    productSnapshot: {
      id: product.id,
      type: input.agentProduct.productType,
      name: product.name
    },
    shopSnapshot: {
      id: input.shop.id,
      name: input.shop.name,
      customerServiceWechat: input.shop.customerServiceWechat,
      customerServiceQrUrl: input.shop.customerServiceQrUrl,
      agentStatus: input.agent.status,
      shopStatus: input.shop.status,
      entrySource: input.entrySource
    },
    pricingSnapshot: {
      salePriceCents: input.agentProduct.salePriceCents,
      minSalePriceCents: input.platformProduct?.minSalePriceCents ?? input.ownProduct?.minSalePriceCents ?? null,
      suggestedSalePriceCents: input.platformProduct?.suggestedSalePriceCents ?? null
    },
    fulfillmentRuleSnapshot: product.fulfillmentRule,
    afterSaleRuleSnapshot: product.afterSaleRule
  };
}

export function isSaleBlockedByRisk(riskStatus: string): boolean {
  return riskStatus === "shop_frozen" || riskStatus === "product_removed" || riskStatus === "disabled";
}

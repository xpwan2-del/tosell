import { type PlatformProductQuote, quoteMerchantOwnedProduct, quotePlatformProduct } from "./money.js";

export type OrderProductType = "platform" | "merchant_owned";
export type SaleRiskStatus = "normal" | "order_frozen" | "shop_frozen" | "settlement_restricted" | "product_removed" | "disabled";

export type OrderSnapshotInput = {
  orderNo: string;
  userId: string;
  merchant: {
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
    customerServiceQq?: string;
    customerServiceQqQrUrl?: string;
    customerServiceNote?: string;
  };
  merchantProductListing: {
    id: string;
    merchantId: string;
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
  serviceFeeBps?: bigint;
};

export type OrderSnapshot = {
  orderNo: string;
  userId: string;
  merchantId: string;
  shopId: string;
  merchantProductListingId: string;
  productType: OrderProductType;
  productNameSnapshot: string;
  quantity: number;
  quote: PlatformProductQuote;
  amountSnapshot: {
    serviceFeeBps: bigint;
    paidAmountCents: bigint;
    supplyAmountCents: bigint;
    serviceFeeCents: bigint;
    merchantExpectedIncomeCents: bigint;
  };
  productSnapshot: unknown;
  shopSnapshot: unknown;
  pricingSnapshot: unknown;
  fulfillmentRuleSnapshot: unknown;
  afterSaleRuleSnapshot: unknown;
};

export function assertCanCreateOrder(input: OrderSnapshotInput): void {
  if (input.merchant.status !== "active") throw new Error("merchant is not active");
  if (input.merchant.depositStatus !== "paid" && input.merchant.depositStatus !== "partially_deducted") {
    throw new Error("merchant deposit is not paid");
  }
  if (input.shop.status !== "open") throw new Error("shop is not open");
  if (input.merchantProductListing.merchantId !== input.merchant.id) {
    throw new Error("merchant product does not belong to merchant");
  }
  if (input.merchantProductListing.shopId !== input.shop.id) {
    throw new Error("merchant product does not belong to shop");
  }
  if (input.merchantProductListing.status !== "listed") throw new Error("merchant product is not listed");
  if (isSaleBlockedByRisk(input.merchant.riskStatus) || isSaleBlockedByRisk(input.shop.riskStatus)) {
    throw new Error("risk freeze blocks order creation");
  }
  if (input.merchantProductListing.productType === "platform") {
    if (!input.platformProduct) throw new Error("platform product is required");
    if (input.merchantProductListing.platformProductId !== input.platformProduct.id) {
      throw new Error("merchant product does not reference platform product");
    }
    if (input.merchantProductListing.ownProductReviewId) {
      throw new Error("platform product cannot reference own product review");
    }
    if (input.platformProduct.status !== "active") throw new Error("platform product is not active");
    return;
  }
  if (!input.ownProduct) throw new Error("own product is required");
  if (input.merchantProductListing.ownProductReviewId !== input.ownProduct.id) {
    throw new Error("merchant product does not reference own product review");
  }
  if (input.merchantProductListing.platformProductId) {
    throw new Error("own product cannot reference platform product");
  }
  if (input.ownProduct.reviewStatus !== "approved") throw new Error("own product is not approved");
}

export function buildOrderSnapshot(input: OrderSnapshotInput): OrderSnapshot {
  assertCanCreateOrder(input);

  const quantity = input.quantity ?? 1;
  const quote = input.merchantProductListing.productType === "platform"
    ? quotePlatformProduct({
      salePriceCents: input.merchantProductListing.salePriceCents,
      supplyPriceCents: input.platformProduct!.supplyPriceCents,
      minSalePriceCents: input.platformProduct!.minSalePriceCents,
      quantity,
      serviceFeeBps: input.serviceFeeBps
    })
    : quoteMerchantOwnedProduct({
      salePriceCents: input.merchantProductListing.salePriceCents,
      minSalePriceCents: input.ownProduct!.minSalePriceCents,
      quantity,
      serviceFeeBps: input.serviceFeeBps
    });

  const product = input.merchantProductListing.productType === "platform" ? input.platformProduct! : input.ownProduct!;

  return {
    orderNo: input.orderNo,
    userId: input.userId,
    merchantId: input.merchant.id,
    shopId: input.shop.id,
    merchantProductListingId: input.merchantProductListing.id,
    productType: input.merchantProductListing.productType,
    productNameSnapshot: product.name,
    quantity,
    quote,
    amountSnapshot: {
      serviceFeeBps: quote.serviceFeeBps,
      paidAmountCents: quote.paidAmountCents,
      supplyAmountCents: quote.supplyAmountCents,
      serviceFeeCents: quote.serviceFeeCents,
      merchantExpectedIncomeCents: quote.merchantExpectedIncomeCents
    },
    productSnapshot: {
      id: product.id,
      type: input.merchantProductListing.productType,
      name: product.name
    },
    shopSnapshot: {
      id: input.shop.id,
      name: input.shop.name,
      customerServiceWechat: input.shop.customerServiceWechat,
      customerServiceQrUrl: input.shop.customerServiceQrUrl,
      customerServiceQq: input.shop.customerServiceQq,
      customerServiceQqQrUrl: input.shop.customerServiceQqQrUrl,
      customerServiceNote: input.shop.customerServiceNote,
      merchantStatus: input.merchant.status,
      shopStatus: input.shop.status,
      entrySource: input.entrySource
    },
    pricingSnapshot: {
      salePriceCents: input.merchantProductListing.salePriceCents,
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

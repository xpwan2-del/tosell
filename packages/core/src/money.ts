export const SERVICE_FEE_BPS = 50n;
export const BPS_DENOMINATOR = 10_000n;

export type PlatformProductQuoteInput = {
  salePriceCents: bigint;
  supplyPriceCents: bigint;
  minSalePriceCents: bigint;
  quantity?: number;
  serviceFeeBps?: bigint;
};

export type PlatformProductQuote = {
  paidAmountCents: bigint;
  supplyAmountCents: bigint;
  serviceFeeCents: bigint;
  agentExpectedIncomeCents: bigint;
  serviceFeeBps: bigint;
};

export type AgentOwnedProductQuoteInput = {
  salePriceCents: bigint;
  minSalePriceCents?: bigint;
  quantity?: number;
  serviceFeeBps?: bigint;
};

export function calculateServiceFeeCents(
  paidAmountCents: bigint,
  serviceFeeBps: bigint = SERVICE_FEE_BPS
): bigint {
  assertNonNegative(paidAmountCents, "paidAmountCents");
  const numerator = paidAmountCents * serviceFeeBps;
  return (numerator + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR;
}

export function quotePlatformProduct(input: PlatformProductQuoteInput): PlatformProductQuote {
  const quantity = BigInt(input.quantity ?? 1);
  if (quantity <= 0n) throw new Error("quantity must be positive");
  assertMinSalePrice(input.salePriceCents, input.minSalePriceCents);

  const paidAmountCents = input.salePriceCents * quantity;
  const supplyAmountCents = input.supplyPriceCents * quantity;
  const serviceFeeBps = input.serviceFeeBps ?? SERVICE_FEE_BPS;
  const serviceFeeCents = calculateServiceFeeCents(paidAmountCents, serviceFeeBps);
  const agentExpectedIncomeCents = paidAmountCents - supplyAmountCents - serviceFeeCents;

  if (agentExpectedIncomeCents < 0n) {
    throw new Error("agent income cannot be negative");
  }

  return {
    paidAmountCents,
    supplyAmountCents,
    serviceFeeCents,
    agentExpectedIncomeCents,
    serviceFeeBps
  };
}

export function quoteAgentOwnedProduct(input: AgentOwnedProductQuoteInput): PlatformProductQuote {
  const quantity = BigInt(input.quantity ?? 1);
  if (quantity <= 0n) throw new Error("quantity must be positive");
  if (input.minSalePriceCents !== undefined) {
    assertMinSalePrice(input.salePriceCents, input.minSalePriceCents);
  } else {
    assertNonNegative(input.salePriceCents, "salePriceCents");
  }

  const paidAmountCents = input.salePriceCents * quantity;
  const serviceFeeBps = input.serviceFeeBps ?? SERVICE_FEE_BPS;
  const serviceFeeCents = calculateServiceFeeCents(paidAmountCents, serviceFeeBps);

  return {
    paidAmountCents,
    supplyAmountCents: 0n,
    serviceFeeCents,
    agentExpectedIncomeCents: paidAmountCents - serviceFeeCents,
    serviceFeeBps
  };
}

export function assertMinSalePrice(salePriceCents: bigint, minSalePriceCents: bigint): void {
  assertNonNegative(salePriceCents, "salePriceCents");
  assertNonNegative(minSalePriceCents, "minSalePriceCents");
  if (salePriceCents < minSalePriceCents) {
    throw new Error("sale price is below minimum sale price");
  }
}

function assertNonNegative(value: bigint, name: string): void {
  if (value < 0n) throw new Error(`${name} must be non-negative`);
}

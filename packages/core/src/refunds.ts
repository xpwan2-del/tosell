import { calculateServiceFeeCents } from "./money.js";

export type RefundResponsibility = "platform" | "merchant" | "user" | "mixed";
export type RefundServiceFeeBearer = "platform" | "merchant" | "mixed" | "none";

export type RefundAllocationInput = {
  paidAmountCents: bigint;
  supplyAmountCents: bigint;
  merchantIncomeCents: bigint;
  refundAmountCents: bigint;
  alreadyRefundedCents?: bigint;
  responsibility: RefundResponsibility;
  serviceFeeBps?: bigint;
  platformBearCents?: bigint;
  merchantBearCents?: bigint;
  serviceFeeBearer?: RefundServiceFeeBearer;
  platformServiceFeeBearCents?: bigint;
  merchantServiceFeeBearCents?: bigint;
};

export type RefundAllocation = {
  refundAmountCents: bigint;
  platformBearCents: bigint;
  merchantBearCents: bigint;
  serviceFeeRefundCents: bigint;
  serviceFeeBearer: RefundServiceFeeBearer;
  platformServiceFeeBearCents: bigint;
  merchantServiceFeeBearCents: bigint;
  platformTotalCostCents: bigint;
  merchantTotalCostCents: bigint;
};

export function allocateRefund(input: RefundAllocationInput): RefundAllocation {
  if (input.refundAmountCents <= 0n) throw new Error("refund amount must be positive");
  assertRefundCumulativeLimit({
    paidAmountCents: input.paidAmountCents,
    alreadyRefundedCents: input.alreadyRefundedCents ?? 0n,
    refundAmountCents: input.refundAmountCents
  });

  if (input.supplyAmountCents < 0n || input.merchantIncomeCents < 0n || input.paidAmountCents < 0n) {
    throw new Error("amounts must be non-negative");
  }

  const defaultServiceFeeRefundCents = input.responsibility === "user"
    ? 0n
    : calculateServiceFeeCents(input.refundAmountCents, input.serviceFeeBps);

  if (input.responsibility === "mixed") {
    if (input.platformBearCents === undefined || input.merchantBearCents === undefined) {
      throw new Error("mixed responsibility requires explicit bear amounts");
    }
    if (input.platformBearCents + input.merchantBearCents !== input.refundAmountCents) {
      throw new Error("mixed bear amounts must equal refund amount");
    }
    return buildAllocation({
      refundAmountCents: input.refundAmountCents,
      platformBearCents: input.platformBearCents,
      merchantBearCents: input.merchantBearCents,
      serviceFeeRefundCents: defaultServiceFeeRefundCents,
      serviceFeeBearer: input.serviceFeeBearer ?? "mixed",
      platformServiceFeeBearCents: input.platformServiceFeeBearCents,
      merchantServiceFeeBearCents: input.merchantServiceFeeBearCents
    });
  }

  if (input.responsibility === "platform") {
    return buildAllocation({
      refundAmountCents: input.refundAmountCents,
      platformBearCents: input.refundAmountCents,
      merchantBearCents: 0n,
      serviceFeeRefundCents: defaultServiceFeeRefundCents,
      serviceFeeBearer: input.serviceFeeBearer ?? "platform",
      platformServiceFeeBearCents: input.platformServiceFeeBearCents,
      merchantServiceFeeBearCents: input.merchantServiceFeeBearCents
    });
  }

  if (input.responsibility === "merchant") {
    return buildAllocation({
      refundAmountCents: input.refundAmountCents,
      platformBearCents: 0n,
      merchantBearCents: input.refundAmountCents,
      serviceFeeRefundCents: defaultServiceFeeRefundCents,
      serviceFeeBearer: input.serviceFeeBearer ?? "merchant",
      platformServiceFeeBearCents: input.platformServiceFeeBearCents,
      merchantServiceFeeBearCents: input.merchantServiceFeeBearCents
    });
  }

  const platformRatio = input.supplyAmountCents * input.refundAmountCents / input.paidAmountCents;
  const platformBearCents = platformRatio > input.refundAmountCents
    ? input.refundAmountCents
    : platformRatio;

  return buildAllocation({
    refundAmountCents: input.refundAmountCents,
    platformBearCents,
    merchantBearCents: input.refundAmountCents - platformBearCents,
    serviceFeeRefundCents: 0n,
    serviceFeeBearer: input.serviceFeeBearer ?? "none",
    platformServiceFeeBearCents: input.platformServiceFeeBearCents,
    merchantServiceFeeBearCents: input.merchantServiceFeeBearCents
  });
}

function buildAllocation(input: {
  refundAmountCents: bigint;
  platformBearCents: bigint;
  merchantBearCents: bigint;
  serviceFeeRefundCents: bigint;
  serviceFeeBearer: RefundServiceFeeBearer;
  platformServiceFeeBearCents?: bigint;
  merchantServiceFeeBearCents?: bigint;
}): RefundAllocation {
  if (input.platformBearCents < 0n || input.merchantBearCents < 0n) {
    throw new Error("refund bear amounts must be non-negative");
  }
  if (input.platformBearCents + input.merchantBearCents !== input.refundAmountCents) {
    throw new Error("refund bear amounts must equal refund amount");
  }

  const { platformServiceFeeBearCents, merchantServiceFeeBearCents } = allocateServiceFeeBear(input);

  return {
    refundAmountCents: input.refundAmountCents,
    platformBearCents: input.platformBearCents,
    merchantBearCents: input.merchantBearCents,
    serviceFeeRefundCents: input.serviceFeeRefundCents,
    serviceFeeBearer: input.serviceFeeBearer,
    platformServiceFeeBearCents,
    merchantServiceFeeBearCents,
    platformTotalCostCents: input.platformBearCents + platformServiceFeeBearCents,
    merchantTotalCostCents: input.merchantBearCents + merchantServiceFeeBearCents
  };
}

function allocateServiceFeeBear(input: {
  serviceFeeRefundCents: bigint;
  serviceFeeBearer: RefundServiceFeeBearer;
  refundAmountCents: bigint;
  platformBearCents: bigint;
  merchantBearCents: bigint;
  platformServiceFeeBearCents?: bigint;
  merchantServiceFeeBearCents?: bigint;
}): { platformServiceFeeBearCents: bigint; merchantServiceFeeBearCents: bigint } {
  if (input.serviceFeeRefundCents === 0n || input.serviceFeeBearer === "none") {
    return { platformServiceFeeBearCents: 0n, merchantServiceFeeBearCents: 0n };
  }

  if (input.serviceFeeBearer === "platform") {
    return { platformServiceFeeBearCents: input.serviceFeeRefundCents, merchantServiceFeeBearCents: 0n };
  }
  if (input.serviceFeeBearer === "merchant") {
    return { platformServiceFeeBearCents: 0n, merchantServiceFeeBearCents: input.serviceFeeRefundCents };
  }

  if (input.platformServiceFeeBearCents !== undefined || input.merchantServiceFeeBearCents !== undefined) {
    const platform = input.platformServiceFeeBearCents ?? 0n;
    const merchant = input.merchantServiceFeeBearCents ?? 0n;
    if (platform < 0n || merchant < 0n || platform + merchant !== input.serviceFeeRefundCents) {
      throw new Error("mixed service fee bear amounts must equal service fee refund amount");
    }
    return { platformServiceFeeBearCents: platform, merchantServiceFeeBearCents: merchant };
  }

  const platform = input.platformBearCents * input.serviceFeeRefundCents / input.refundAmountCents;
  return {
    platformServiceFeeBearCents: platform,
    merchantServiceFeeBearCents: input.serviceFeeRefundCents - platform
  };
}

export function assertRefundCumulativeLimit(input: {
  paidAmountCents: bigint;
  alreadyRefundedCents: bigint;
  refundAmountCents: bigint;
}): void {
  if (input.alreadyRefundedCents < 0n) throw new Error("already refunded amount must be non-negative");
  if (input.refundAmountCents <= 0n) throw new Error("refund amount must be positive");
  if (input.alreadyRefundedCents + input.refundAmountCents > input.paidAmountCents) {
    throw new Error("cumulative refund amount cannot exceed paid amount");
  }
}

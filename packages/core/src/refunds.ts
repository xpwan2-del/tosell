import { calculateServiceFeeCents } from "./money.js";

export type RefundResponsibility = "platform" | "agent" | "user" | "mixed";
export type RefundServiceFeeBearer = "platform" | "agent" | "mixed" | "none";

export type RefundAllocationInput = {
  paidAmountCents: bigint;
  supplyAmountCents: bigint;
  agentIncomeCents: bigint;
  refundAmountCents: bigint;
  alreadyRefundedCents?: bigint;
  responsibility: RefundResponsibility;
  serviceFeeBps?: bigint;
  platformBearCents?: bigint;
  agentBearCents?: bigint;
  serviceFeeBearer?: RefundServiceFeeBearer;
  platformServiceFeeBearCents?: bigint;
  agentServiceFeeBearCents?: bigint;
};

export type RefundAllocation = {
  refundAmountCents: bigint;
  platformBearCents: bigint;
  agentBearCents: bigint;
  serviceFeeRefundCents: bigint;
  serviceFeeBearer: RefundServiceFeeBearer;
  platformServiceFeeBearCents: bigint;
  agentServiceFeeBearCents: bigint;
  platformTotalCostCents: bigint;
  agentTotalCostCents: bigint;
};

export function allocateRefund(input: RefundAllocationInput): RefundAllocation {
  if (input.refundAmountCents <= 0n) throw new Error("refund amount must be positive");
  assertRefundCumulativeLimit({
    paidAmountCents: input.paidAmountCents,
    alreadyRefundedCents: input.alreadyRefundedCents ?? 0n,
    refundAmountCents: input.refundAmountCents
  });

  if (input.supplyAmountCents < 0n || input.agentIncomeCents < 0n || input.paidAmountCents < 0n) {
    throw new Error("amounts must be non-negative");
  }

  const defaultServiceFeeRefundCents = input.responsibility === "user"
    ? 0n
    : calculateServiceFeeCents(input.refundAmountCents, input.serviceFeeBps);

  if (input.responsibility === "mixed") {
    if (input.platformBearCents === undefined || input.agentBearCents === undefined) {
      throw new Error("mixed responsibility requires explicit bear amounts");
    }
    if (input.platformBearCents + input.agentBearCents !== input.refundAmountCents) {
      throw new Error("mixed bear amounts must equal refund amount");
    }
    return buildAllocation({
      refundAmountCents: input.refundAmountCents,
      platformBearCents: input.platformBearCents,
      agentBearCents: input.agentBearCents,
      serviceFeeRefundCents: defaultServiceFeeRefundCents,
      serviceFeeBearer: input.serviceFeeBearer ?? "mixed",
      platformServiceFeeBearCents: input.platformServiceFeeBearCents,
      agentServiceFeeBearCents: input.agentServiceFeeBearCents
    });
  }

  if (input.responsibility === "platform") {
    return buildAllocation({
      refundAmountCents: input.refundAmountCents,
      platformBearCents: input.refundAmountCents,
      agentBearCents: 0n,
      serviceFeeRefundCents: defaultServiceFeeRefundCents,
      serviceFeeBearer: input.serviceFeeBearer ?? "platform",
      platformServiceFeeBearCents: input.platformServiceFeeBearCents,
      agentServiceFeeBearCents: input.agentServiceFeeBearCents
    });
  }

  if (input.responsibility === "agent") {
    return buildAllocation({
      refundAmountCents: input.refundAmountCents,
      platformBearCents: 0n,
      agentBearCents: input.refundAmountCents,
      serviceFeeRefundCents: defaultServiceFeeRefundCents,
      serviceFeeBearer: input.serviceFeeBearer ?? "agent",
      platformServiceFeeBearCents: input.platformServiceFeeBearCents,
      agentServiceFeeBearCents: input.agentServiceFeeBearCents
    });
  }

  const platformRatio = input.supplyAmountCents * input.refundAmountCents / input.paidAmountCents;
  const platformBearCents = platformRatio > input.refundAmountCents
    ? input.refundAmountCents
    : platformRatio;

  return buildAllocation({
    refundAmountCents: input.refundAmountCents,
    platformBearCents,
    agentBearCents: input.refundAmountCents - platformBearCents,
    serviceFeeRefundCents: 0n,
    serviceFeeBearer: input.serviceFeeBearer ?? "none",
    platformServiceFeeBearCents: input.platformServiceFeeBearCents,
    agentServiceFeeBearCents: input.agentServiceFeeBearCents
  });
}

function buildAllocation(input: {
  refundAmountCents: bigint;
  platformBearCents: bigint;
  agentBearCents: bigint;
  serviceFeeRefundCents: bigint;
  serviceFeeBearer: RefundServiceFeeBearer;
  platformServiceFeeBearCents?: bigint;
  agentServiceFeeBearCents?: bigint;
}): RefundAllocation {
  if (input.platformBearCents < 0n || input.agentBearCents < 0n) {
    throw new Error("refund bear amounts must be non-negative");
  }
  if (input.platformBearCents + input.agentBearCents !== input.refundAmountCents) {
    throw new Error("refund bear amounts must equal refund amount");
  }

  const { platformServiceFeeBearCents, agentServiceFeeBearCents } = allocateServiceFeeBear(input);

  return {
    refundAmountCents: input.refundAmountCents,
    platformBearCents: input.platformBearCents,
    agentBearCents: input.agentBearCents,
    serviceFeeRefundCents: input.serviceFeeRefundCents,
    serviceFeeBearer: input.serviceFeeBearer,
    platformServiceFeeBearCents,
    agentServiceFeeBearCents,
    platformTotalCostCents: input.platformBearCents + platformServiceFeeBearCents,
    agentTotalCostCents: input.agentBearCents + agentServiceFeeBearCents
  };
}

function allocateServiceFeeBear(input: {
  serviceFeeRefundCents: bigint;
  serviceFeeBearer: RefundServiceFeeBearer;
  refundAmountCents: bigint;
  platformBearCents: bigint;
  agentBearCents: bigint;
  platformServiceFeeBearCents?: bigint;
  agentServiceFeeBearCents?: bigint;
}): { platformServiceFeeBearCents: bigint; agentServiceFeeBearCents: bigint } {
  if (input.serviceFeeRefundCents === 0n || input.serviceFeeBearer === "none") {
    return { platformServiceFeeBearCents: 0n, agentServiceFeeBearCents: 0n };
  }

  if (input.serviceFeeBearer === "platform") {
    return { platformServiceFeeBearCents: input.serviceFeeRefundCents, agentServiceFeeBearCents: 0n };
  }
  if (input.serviceFeeBearer === "agent") {
    return { platformServiceFeeBearCents: 0n, agentServiceFeeBearCents: input.serviceFeeRefundCents };
  }

  if (input.platformServiceFeeBearCents !== undefined || input.agentServiceFeeBearCents !== undefined) {
    const platform = input.platformServiceFeeBearCents ?? 0n;
    const agent = input.agentServiceFeeBearCents ?? 0n;
    if (platform < 0n || agent < 0n || platform + agent !== input.serviceFeeRefundCents) {
      throw new Error("mixed service fee bear amounts must equal service fee refund amount");
    }
    return { platformServiceFeeBearCents: platform, agentServiceFeeBearCents: agent };
  }

  const platform = input.platformBearCents * input.serviceFeeRefundCents / input.refundAmountCents;
  return {
    platformServiceFeeBearCents: platform,
    agentServiceFeeBearCents: input.serviceFeeRefundCents - platform
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

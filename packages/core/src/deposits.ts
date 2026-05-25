import { type IdempotencyRegistry } from "./idempotency.js";

export type DepositAccountState = {
  agentId: string;
  requiredAmountCents: bigint;
  availableAmountCents: bigint;
  frozenAmountCents: bigint;
  deductedAmountCents: bigint;
  status: "pending_payment" | "paid" | "partially_deducted" | "frozen" | "refund_reviewing" | "refunded" | "insufficient";
};

export type DepositTransactionResult =
  | { status: "duplicate"; idempotencyKey: string }
  | {
    status: "processed";
    idempotencyKey: string;
    deductedAmountCents: bigint;
    balanceBeforeCents: bigint;
    balanceAfterCents: bigint;
    restricted: boolean;
  };

export function deductDeposit(input: {
  registry: IdempotencyRegistry;
  account: DepositAccountState;
  amountCents: bigint;
  sourceType: string;
  sourceId: string;
  reasonCode: string;
}): DepositTransactionResult {
  if (input.amountCents <= 0n) throw new Error("deposit deduction amount must be positive");
  const idempotencyKey = `deposit:deduct:${input.sourceType}:${input.sourceId}:${input.account.agentId}`;
  const processed = input.registry.runOnce(idempotencyKey, () => {
    const balanceBeforeCents = input.account.availableAmountCents;
    const deductedAmountCents = input.amountCents > input.account.availableAmountCents
      ? input.account.availableAmountCents
      : input.amountCents;
    input.account.availableAmountCents -= deductedAmountCents;
    input.account.deductedAmountCents += deductedAmountCents;
    input.account.status = isDepositInsufficient(input.account) ? "insufficient" : "partially_deducted";

    return {
      status: "processed" as const,
      idempotencyKey,
      deductedAmountCents,
      balanceBeforeCents,
      balanceAfterCents: input.account.availableAmountCents,
      restricted: isDepositInsufficient(input.account)
    };
  });

  return processed ?? { status: "duplicate", idempotencyKey };
}

export function isDepositInsufficient(account: DepositAccountState): boolean {
  return account.availableAmountCents < account.requiredAmountCents;
}

export function shouldRestrictForDeposit(account: DepositAccountState): boolean {
  return account.status === "pending_payment"
    || account.status === "insufficient"
    || account.status === "frozen"
    || account.availableAmountCents < account.requiredAmountCents;
}

export type ClawbackBalances = {
  pendingIncomeCents: bigint;
  payableIncomeCents: bigint;
  depositAvailableCents: bigint;
};

export type ClawbackDeduction = {
  from: "pending_income" | "payable_income" | "deposit";
  amountCents: bigint;
};

export type ClawbackResult = {
  requestedAmountCents: bigint;
  deductedAmountCents: bigint;
  remainingAmountCents: bigint;
  deductions: ClawbackDeduction[];
  balances: ClawbackBalances;
  status: "completed" | "insufficient";
  restrictAgent: boolean;
};

export function applyClawback(
  amountCents: bigint,
  balances: ClawbackBalances
): ClawbackResult {
  if (amountCents <= 0n) throw new Error("clawback amount must be positive");
  const mutable = { ...balances };
  let remaining = amountCents;
  const deductions: ClawbackDeduction[] = [];

  remaining = deductFrom("pending_income", "pendingIncomeCents", remaining, mutable, deductions);
  remaining = deductFrom("payable_income", "payableIncomeCents", remaining, mutable, deductions);
  remaining = deductFrom("deposit", "depositAvailableCents", remaining, mutable, deductions);

  const deductedAmountCents = amountCents - remaining;
  return {
    requestedAmountCents: amountCents,
    deductedAmountCents,
    remainingAmountCents: remaining,
    deductions,
    balances: mutable,
    status: remaining === 0n ? "completed" : "insufficient",
    restrictAgent: remaining > 0n
  };
}

function deductFrom(
  from: ClawbackDeduction["from"],
  field: keyof ClawbackBalances,
  remaining: bigint,
  balances: ClawbackBalances,
  deductions: ClawbackDeduction[]
): bigint {
  if (remaining === 0n) return 0n;
  const available = balances[field];
  if (available <= 0n) return remaining;
  const amountCents = available > remaining ? remaining : available;
  balances[field] -= amountCents;
  deductions.push({ from, amountCents });
  return remaining - amountCents;
}

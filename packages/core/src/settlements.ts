export type SettlementCandidate = {
  orderId: string;
  agentId?: string;
  shopId?: string;
  paymentStatus: "paid" | string;
  fulfillmentStatus: "success" | string;
  settlementStatus: "pending" | "frozen" | "settleable" | "settled" | string;
  refundStatus: "none" | "refunding" | "refunded" | string;
  riskStatus: "normal" | string;
  complaintStatus?: "none" | "pending" | "processing" | string;
  fulfilledAt: Date | null;
  now: Date;
  tPlusOneHours?: number;
};

export type SettlementOrderAmount = SettlementCandidate & {
  paidAmountCents: bigint;
  supplyAmountCents: bigint;
  serviceFeeCents: bigint;
  agentIncomeCents: bigint;
};

export type SettlementItemDraft = {
  orderId: string;
  agentId?: string;
  shopId?: string;
  paidAmountCents: bigint;
  supplyAmountCents: bigint;
  serviceFeeCents: bigint;
  agentIncomeCents: bigint;
  deductedCents: bigint;
  settleAmountCents: bigint;
  fulfilledAt: Date;
  settleableAt: Date;
};

export function isSettlementCandidate(order: SettlementCandidate): boolean {
  if (order.paymentStatus !== "paid") return false;
  if (order.fulfillmentStatus !== "success") return false;
  if (order.settlementStatus !== "pending" && order.settlementStatus !== "settleable") return false;
  if (order.refundStatus !== "none") return false;
  if (order.riskStatus !== "normal") return false;
  if (order.complaintStatus && order.complaintStatus !== "none") return false;
  if (!order.fulfilledAt) return false;

  const hours = order.tPlusOneHours ?? 24;
  return order.now.getTime() - order.fulfilledAt.getTime() >= hours * 60 * 60 * 1000;
}

export function assertNoDuplicateSettlementItems(orderIds: string[]): void {
  const seen = new Set<string>();
  for (const orderId of orderIds) {
    if (seen.has(orderId)) throw new Error(`duplicate settlement item for order ${orderId}`);
    seen.add(orderId);
  }
}

export function selectSettlementCandidates(orders: SettlementCandidate[]): SettlementCandidate[] {
  return orders.filter(isSettlementCandidate);
}

export function buildSettlementItems(
  orders: SettlementOrderAmount[],
  alreadySettledOrderIds: Iterable<string> = [],
  batchAgentId?: string
): SettlementItemDraft[] {
  const settled = new Set(alreadySettledOrderIds);
  const selected = orders.filter((order) => isSettlementCandidate(order) && !settled.has(order.orderId));
  assertNoDuplicateSettlementItems(selected.map((order) => order.orderId));

  return selected.map((order) => {
    if (!order.fulfilledAt) throw new Error(`settlement order ${order.orderId} has no fulfilledAt`);
    if (batchAgentId && order.agentId !== batchAgentId) {
      throw new Error(`settlement order ${order.orderId} does not belong to agent ${batchAgentId}`);
    }
    if (!order.agentId || !order.shopId) {
      throw new Error(`settlement order ${order.orderId} requires agent and shop scope`);
    }
    return {
      orderId: order.orderId,
      agentId: order.agentId,
      shopId: order.shopId,
      paidAmountCents: order.paidAmountCents,
      supplyAmountCents: order.supplyAmountCents,
      serviceFeeCents: order.serviceFeeCents,
      agentIncomeCents: order.agentIncomeCents,
      deductedCents: 0n,
      settleAmountCents: order.agentIncomeCents,
      fulfilledAt: order.fulfilledAt,
      settleableAt: new Date(order.fulfilledAt.getTime() + (order.tPlusOneHours ?? 24) * 60 * 60 * 1000)
    };
  });
}

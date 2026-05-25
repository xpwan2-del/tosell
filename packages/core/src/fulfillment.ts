import { type IdempotencyRegistry } from "./idempotency.js";

export type FulfillmentStatus = "not_started" | "processing" | "success" | "failed" | "resent" | "revoked";
export type OrderFulfillmentStatus = "not_started" | "processing" | "success" | "failed" | "resent" | "revoked";

export type FulfillmentRecordState = {
  fulfillmentId: string;
  orderItemId: string;
  status: FulfillmentStatus;
  attemptCount: number;
};

export type FulfillmentResult = {
  status: "success" | "failed";
  evidence?: string;
  failReason?: string;
};

export function applyFulfillmentAttempt(input: {
  registry: IdempotencyRegistry;
  record: FulfillmentRecordState;
  attemptNo: number;
  result: FulfillmentResult;
}): { duplicate: boolean; status: FulfillmentStatus; orderStatus: "fulfilled" | "fulfillment_failed"; idempotencyKey: string } {
  const idempotencyKey = `fulfill:${input.record.orderItemId}:${input.attemptNo}`;
  const processed = input.registry.runOnce(idempotencyKey, () => {
    input.record.attemptCount += 1;
    input.record.status = input.result.status === "success" ? "success" : "failed";
    return {
      duplicate: false,
      status: input.record.status,
      orderStatus: input.result.status === "success" ? "fulfilled" as const : "fulfillment_failed" as const,
      idempotencyKey
    };
  });

  return processed ?? {
    duplicate: true,
    status: input.record.status,
    orderStatus: input.record.status === "success" ? "fulfilled" : "fulfillment_failed",
    idempotencyKey
  };
}

export function canEnterSettlementAfterFulfillment(status: OrderFulfillmentStatus): boolean {
  return status === "success" || status === "resent";
}

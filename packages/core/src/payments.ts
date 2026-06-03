import { type IdempotencyRegistry, paymentCallbackKey } from "./idempotency.js";

export type PaymentCallbackPayload = {
  channel: string;
  channelTradeNo: string;
  orderNo: string;
  amountCents: bigint;
  signature?: string;
};

export type PaymentProvider = {
  readonly channel: string;
  verifyPaymentCallback(payload: PaymentCallbackPayload): boolean;
};

export type PaymentCallbackOrder = {
  orderNo: string;
  paidAmountCents: bigint;
  paymentStatus: "unpaid" | "paying" | "paid" | string;
};

export type PaymentCallbackResult =
  | { status: "duplicate"; idempotencyKey: string }
  | { status: "processed"; idempotencyKey: string }
  | { status: "already_paid"; idempotencyKey: string };

export function processPaymentCallback(input: {
  provider: PaymentProvider;
  registry: IdempotencyRegistry;
  payload: PaymentCallbackPayload;
  order: PaymentCallbackOrder;
  onProcessed: () => void;
}): PaymentCallbackResult {
  if (!input.provider.verifyPaymentCallback(input.payload)) {
    throw new Error("payment callback verification failed");
  }
  if (input.payload.orderNo !== input.order.orderNo) {
    throw new Error("payment callback order mismatch");
  }
  if (input.payload.amountCents !== input.order.paidAmountCents) {
    throw new Error("payment callback amount mismatch");
  }

  const idempotencyKey = paymentCallbackKey(input.payload.channel, input.payload.channelTradeNo);
  const result = input.registry.runOnce(idempotencyKey, () => {
    if (input.order.paymentStatus === "paid") {
      return { status: "already_paid" as const, idempotencyKey };
    }
    input.onProcessed();
    return { status: "processed" as const, idempotencyKey };
  });

  return result ?? { status: "duplicate", idempotencyKey };
}

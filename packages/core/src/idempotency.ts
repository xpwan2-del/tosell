export function paymentCallbackKey(channel: string, channelTradeNo: string): string {
  return `pay:${channel}:${channelTradeNo}`;
}

export function refundCallbackKey(channel: string, channelRefundNo: string): string {
  return `refund:${channel}:${channelRefundNo}`;
}

export function settlementKey(agentId: string, periodStart: string, periodEnd: string, batchNo: string): string {
  return `settlement:${agentId}:${periodStart}:${periodEnd}:${batchNo}`;
}

export class IdempotencyRegistry {
  private readonly seen = new Set<string>();

  runOnce<T>(key: string, action: () => T): T | undefined {
    if (this.seen.has(key)) return undefined;
    this.seen.add(key);
    try {
      return action();
    } catch (error) {
      this.seen.delete(key);
      throw error;
    }
  }
}

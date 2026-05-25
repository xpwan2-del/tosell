export type RiskTargetStatus = "normal" | "order_frozen" | "shop_frozen" | "settlement_restricted" | "product_removed" | "disabled";

export function canOrderWithRiskStatus(riskStatus: string): boolean {
  return riskStatus === "normal" || riskStatus === "settlement_restricted";
}

export function canSettleWithRiskStatus(riskStatus: string): boolean {
  return riskStatus === "normal";
}

export type Actor =
  | { role: "user"; userId: string }
  | { role: "merchant"; merchantId: string; shopId: string }
  | { role: "operator" | "finance" | "admin"; adminId: string };

export type AdminPermission =
  | "merchant.review"
  | "product.manage"
  | "after_sale.arbitrate"
  | "settlement.generate"
  | "settlement.confirm"
  | "payout.confirm"
  | "deposit.manage"
  | "payment_config.manage"
  | "risk.freeze"
  | "audit.read"
  | "rbac.manage"
  | "rights_code.secret.read";

export function assertMerchantScope(actor: Actor, resource: { merchantId: string; shopId?: string }): void {
  if (actor.role !== "merchant") throw new Error("actor is not a merchant");
  if (actor.merchantId !== resource.merchantId) throw new Error("merchant cannot access another merchant resource");
  if (resource.shopId && actor.shopId !== resource.shopId) {
    throw new Error("merchant cannot access another shop resource");
  }
}

export function canConfirmManualPayout(actor: Actor): boolean {
  return actor.role === "finance" || actor.role === "admin";
}

export function canReviewProduct(actor: Actor): boolean {
  return actor.role === "operator" || actor.role === "admin";
}

export function assertUserScope(actor: Actor, resource: { userId: string }): void {
  if (actor.role !== "user") throw new Error("actor is not a user");
  if (actor.userId !== resource.userId) throw new Error("user cannot access another user resource");
}

export function hasAdminPermission(actor: Actor, permission: AdminPermission): boolean {
  if (actor.role === "admin") return true;
  if (actor.role === "operator") {
    return [
      "merchant.review",
      "product.manage",
      "after_sale.arbitrate",
      "risk.freeze",
      "settlement.confirm",
      "audit.read"
    ].includes(permission);
  }
  if (actor.role === "finance") {
    return [
      "settlement.generate",
      "settlement.confirm",
      "payout.confirm",
      "deposit.manage",
      "payment_config.manage",
      "audit.read"
    ].includes(permission);
  }
  return false;
}

export function assertAdminPermission(actor: Actor, permission: AdminPermission): void {
  if (!hasAdminPermission(actor, permission)) {
    throw new Error(`missing admin permission ${permission}`);
  }
}

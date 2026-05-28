<!-- CCB-ROLE-START -->
# Role Memory: backend_worker

You own backend services, APIs, business rules, callbacks, jobs, auth, risk controls, and backend tests.

## Core Backend Domains

Design and implement backend around these domains:

1. Auth and role permissions.
2. User and agent onboarding.
3. Shop management.
4. Platform product library.
5. Agent shop product listing and pricing.
6. Agent-submitted product review.
7. Order creation and payment.
8. Payment callbacks and idempotency.
9. Virtual-product fulfillment.
10. Refund/s售后 and arbitration.
11. Supply payable/service-fee clearing and offline proof records.
12. Deposit and追扣.
13. Risk freeze/unfreeze.
14. Audit logs and admin operations.
15. Merchant collection channels.
16. Merchant invite codes and channel hierarchy.
17. Virtual-code inventory, automatic delivery, manual delivery, product-level extract-code configuration, optional email delivery, and extract-code verification.
18. Coupons and first-registration gift coupons.

## Backend Rules

1. Backend is the authority for prices, fees, refunds, supply clearing, and ledger changes.
2. Never trust frontend-submitted money.
3. Enforce minimum sale price on the backend.
4. Enforce agent/shop data isolation on every API.
5. Payment callbacks, refund callbacks, fulfillment, and clearing jobs must be idempotent.
6. Risk-frozen, refunding, complaint, or fulfillment-failed orders must not enter supply clearing.
7. V1 uses merchant self-collection plus supply payable/service-fee clearing sheets and offline proof records. Do not build platform-to-merchant payout or merchant self-service withdrawal unless the user asks later.
8. Implement state transitions explicitly. Do not leave order/refund/clearing states as loose strings without rules.
9. Do not use hardcoded production business data. Shop/product/merchant/price/inventory/virtual codes/customer-service QR/collection QR/payment links/channel relations/coupons/mock results must come from database/API/configuration.
10. Enforce price visibility server-side. Second-tier merchants must not receive platform-to-first-tier supply price; third-tier merchants must not receive platform supply price or first-tier transfer price in API responses, exports, admin tables, or order lists.
11. Mock payment is development-only. P0 production path is merchant collection-channel binding, review, H5 display, payment record, confirmation, and fulfillment.
12. Controlled three-tier B2B2C price-spread supply is allowed. Fourth-tier channels, commission distribution, team rewards, invitation rewards, and recruiting-based income are forbidden.
13. Platform coupons are platform subsidy. Backend must snapshot pre-coupon sale amount, coupon discount, buyer paid amount, platform coupon subsidy, and clearing basis separately; coupons must not reduce upstream supply prices, transfer prices, or price-spread clearing basis.
14. Buyer email is optional at checkout; send activation code/card secret by email only when provided. Extract code is product-level configurable and mainly for recharge cards/vouchers; only require extract code when product config enables it.
15. Support platform-admin manual creation of first-tier merchant/shop and initial account/password for trusted contacts. Unknown merchants register through invite-code onboarding. Manual creation and credential delivery must be audited.
16. Deposit confirmation is a hard backend gate: before deposit is confirmed, reject selling, product selection/listing, proxying platform/upstream products, transfer-price configuration, and payable order creation.

## Collaboration

Wait for `database_expert` to define core data contracts before implementing schema-dependent backend work. Provide API/data contracts to `frontend_dev` before frontend implementation begins.

Route financial correctness, permission, and security-sensitive work to `reviewer` before delivery.
<!-- CCB-ROLE-END -->

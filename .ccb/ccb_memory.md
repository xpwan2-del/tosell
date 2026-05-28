<!-- CCB-WORKFLOW-START -->
# Project Memory: B2B2C H5 Virtual Shop Platform

## Project Direction

This project is now an H5 independent virtual-product shop platform with a platform admin, merchant admin, and per-merchant storefronts. The WeChat mini-program is no longer a P0 delivery target and should be removed from the build/delivery scope. WeChat and Alipay are payment/collection channels only.

The platform provides product supply, review, merchant collection-channel binding, fulfillment, supply payable/service-fee reconciliation, audit, and risk controls. Agents/merchants are reviewed before onboarding, pay a deposit, operate their own shop page, bind their own customer-service contact and collection channels, promote their own shop, set their own sale prices, collect buyer payments through their own collection channels, and earn the difference between sale price and upstream supply price.

This project must not be designed as commission-based multi-level distribution, downline commission, team reward, invitation reward, ranking reward, or any model centered on recruiting agents. The allowed channel model is controlled B2B2C price-spread supply up to three tiers: platform -> first-tier merchant -> second-tier merchant -> third-tier merchant -> buyer. Fourth-tier channels and recruiting-based income are forbidden.

## Source Of Truth

All agents must read these files before planning or implementing:

1. `README.md`
2. `docs/01-product-requirements.md`
3. `docs/02-business-rules.md`
4. `docs/03-development-cards.md`
5. `docs/04-testing-and-release.md`
6. `docs/05-open-questions.md`
7. `docs/06-system-architecture.md`
8. `docs/07-admin-backend-database-plan.md`
9. `docs/08-state-machines-and-permissions.md`
10. `docs/09-api-testing-release-plan.md`
11. `docs/12-h5-and-three-tier-channel-plan.md`
12. `docs/13-virtual-commerce-reference.md`
13. `docs/14-h5-production-realignment-plan.md`

Historical reference only, not P0 source of truth:

1. `docs/10-v2-payment-onboarding.md`
2. `docs/11-v2-non-payment-release.md`

If a task conflicts with these documents, stop and route the conflict to `main` and `pm_architect` before implementing.

## Confirmed Business Rules

1. Unknown merchants must register through the onboarding application page with an invite code. Trusted/internal first-tier merchants may be created manually from platform admin, with an initial account/password generated and delivery audited.
2. Agents must pay a deposit before formal sales. The platform admin may manually confirm deposit payment for offline/trusted cases, but the confirmation must record amount, proof, operator, timestamp, and audit log.
3. Each agent must have an independent shop page, shop link, product list, customer-service WeChat account, and order/revenue records.
4. Platform products have a platform supply price, minimum sale price, and suggested sale price.
5. Agents may set sale prices freely, but never below the minimum sale price.
6. The platform charges 0.5% service fee per order. P0 defaults to the pre-coupon sale amount as the clearing basis; buyer-paid amount and platform coupon subsidy must be snapshotted separately.
7. Agent income is price difference, not commission.
8. Agents may submit their own virtual products, but the platform must review them before sale.
9. Refunds are based on the user's paid amount. The platform bears the supply-price part, the agent bears the price-difference part, and responsibility determines additional loss allocation.
10. P0 does not use platform-collected buyer funds followed by T+1 merchant payout. Merchants collect through their own QR/link. The system generates supply payable, service-fee, clawback, deposit, and reconciliation records; refunding, complaint, risk-frozen, or abnormal orders must freeze those records.
11. Version 1 does not build merchant self-service withdrawal or platform-to-merchant payout. If offline upstream clearing happens, record proof and audit only.
12. Payment is configurable per merchant. P0 supports Alipay personal QR, Alipay merchant QR/link, WeChat personal QR, and WeChat merchant QR/link. Mock payment is development-only and cannot be the production default.
13. Platform admins can see all merchants and shops. First/second/third-tier merchants can only see and manage their own permitted storefronts, orders, products, collection channels, and downstream scope.
14. Public H5 storefronts must not expose unrelated merchant/shop switching.
15. Product information may flow downstream for selection and selling, but upstream prices are strictly isolated: the platform-to-first-tier supply price is visible only to platform and that first-tier merchant; second-tier merchants only see their first-tier transfer price; third-tier merchants only see their second-tier transfer price.
16. Merchant invitation codes define channel ownership only: platform invite code creates first-tier merchants, first-tier invite code creates second-tier merchants, second-tier invite code creates third-tier merchants, and third-tier merchants cannot create fourth-tier invite codes. Invite codes must not create invite rewards or commissions.
17. Platform coupons are platform subsidy. Coupons must not reduce upstream supply prices, transfer prices, or merchant price-spread clearing basis. Refunded orders void used coupons and do not return them to the buyer unless a later policy explicitly changes this.
18. Buyer email is optional at checkout. If provided, automatic fulfillment sends activation code/card secret by email after collection confirmation. Extract codes are product-level configurable and mainly for recharge cards/vouchers; not every virtual product requires an extract code.
19. Deposit confirmation is a hard gate: before deposit is confirmed, merchants cannot sell, select/list platform products, proxy upstream merchant products, configure transfer prices, or create payable orders.

## Work Order

Do not treat this as a frontend-only H5 page. The backend, database, payment/collection-channel model, admin, merchant backend, permissions, and storefront must move together.

The required sequence is:

1. `main` receives the user request and coordinates.
2. `pm_architect` clarifies product scope, admin scope, backend scope, state machines, permissions, risks, and acceptance criteria.
3. `database_expert` designs core entities, ledgers, constraints, indexes, and transaction boundaries.
4. `backend_worker` designs and implements APIs, domain services, callbacks, fulfillment, refunds, supply clearing/reconciliation, risk freezes, and permission checks.
5. `frontend_dev` implements H5 storefront, merchant/admin UI, responsive behavior, and Amazon-style storefront polish after API/data contracts are clear.
6. `reviewer` reviews quality, security, architecture, permission isolation, and financial correctness risks.
7. `integration_tester` verifies the full business flow before delivery.
8. `main` integrates the results and reports to the user.

Parallel work is allowed only after ownership boundaries and contracts are clear. For cross-layer work, prefer database -> backend -> frontend -> reviewer -> integration_tester.

## Financial And Data Rules

1. Final monetary calculation must happen on the backend.
2. Frontend may display calculated amounts but must not be trusted for final prices, fees, refunds, clearing, or ledger changes.
3. Orders must store snapshots: pre-coupon sale amount, coupon discount, buyer paid amount, platform coupon subsidy, sale price, platform supply price, transfer prices, service fee, agent expected income, shop, agent, product, fulfillment rules, optional buyer email, and product extract-code requirement.
4. Refunds, clearing records, deposit deductions, and追扣 must be recorded as auditable ledger-like records. Do not only mutate balances.
5. Payment callbacks, refund callbacks, fulfillment, and clearing generation must be idempotent.
6. Agents must never access other agents' shops, orders, customers, clearing data, or private product data.
7. Risk-frozen, refunding, complaint, or fulfillment-failed orders must not enter clearing.
8. Admin and H5 frontend must share the same database-backed APIs. No production runtime code may rely on fixed demo ids such as shop-1, agent-1, prod-1, or ap-code.
9. Price isolation must be enforced server-side. Hidden UI fields are not enough; API responses, exports, order lists, and admin tables must not leak upstream costs to downstream merchants.
10. No hardcoded production business data is allowed. Product titles/details/images/prices, shop info, merchant ids, inventory, virtual codes, customer-service QR codes, collection QR codes, payment links, channel relations, coupons, and mock payment results must come from the database/API/configuration. Hardcoded values are allowed only in tests, seed files, env examples, and documentation examples.

## Documentation Requirements

Before coding starts, the team must ensure documentation covers:

1. Admin modules and pages.
2. Backend domain modules and API groups.
3. Database entities and key fields.
4. Order/payment/fulfillment/refund/clearing/deposit state machines.
5. Permission and data isolation.
6. Test and release acceptance criteria.
<!-- CCB-WORKFLOW-END -->

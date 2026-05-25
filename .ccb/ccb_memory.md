<!-- CCB-WORKFLOW-START -->
# Project Memory: B2B2C WeChat Mini-Program Shop Platform

## Project Direction

This project is a WeChat mini-program for selling virtual products through a B2B2C "micro-shop" supply model.

The platform provides product supply, review, payment, fulfillment, settlement, audit, and risk controls. Agents/merchants are reviewed before onboarding, pay a deposit, operate their own shop page, bind their own customer-service WeChat account, promote their own shop, set their own sale prices, and earn the difference between sale price and platform supply price.

This project must not be designed as multi-level distribution, downline commission, team reward, invitation reward, ranking reward, or any model centered on recruiting agents.

## Source Of Truth

All agents must read these files before planning or implementing:

1. `README.md`
2. `docs/01-product-requirements.md`
3. `docs/02-business-rules.md`
4. `docs/03-development-cards.md`
5. `docs/04-testing-and-release.md`
6. `docs/05-open-questions.md`

If a task conflicts with these documents, stop and route the conflict to `main` and `pm_architect` before implementing.

## Confirmed Business Rules

1. Agents must be reviewed before onboarding.
2. Agents must pay a deposit before formal sales.
3. Each agent must have an independent shop page, shop link, product list, customer-service WeChat account, and order/revenue records.
4. Platform products have a platform supply price, minimum sale price, and suggested sale price.
5. Agents may set sale prices freely, but never below the minimum sale price.
6. The platform charges 0.5% service fee per order, calculated from the user's paid amount.
7. Agent income is price difference, not commission.
8. Agents may submit their own virtual products, but the platform must review them before sale.
9. Refunds are based on the user's paid amount. The platform bears the supply-price part, the agent bears the price-difference part, and responsibility determines additional loss allocation.
10. Settlement is T+1, but refunding, complaint, risk-frozen, or abnormal orders must be frozen.
11. Version 1 uses settlement sheets plus manual payout. Do not build agent self-service withdrawal unless the user asks later.

## Work Order

Do not treat this as a frontend-only mini-program.

The required sequence is:

1. `main` receives the user request and coordinates.
2. `pm_architect` clarifies product scope, admin scope, backend scope, state machines, permissions, risks, and acceptance criteria.
3. `database_expert` designs core entities, ledgers, constraints, indexes, and transaction boundaries.
4. `backend_worker` designs and implements APIs, domain services, callbacks, fulfillment, refunds, settlements, risk freezes, and permission checks.
5. `frontend_dev` implements mini-program, agent center, and admin UI after API/data contracts are clear.
6. `reviewer` reviews quality, security, architecture, permission isolation, and financial correctness risks.
7. `integration_tester` verifies the full business flow before delivery.
8. `main` integrates the results and reports to the user.

Parallel work is allowed only after ownership boundaries and contracts are clear. For cross-layer work, prefer database -> backend -> frontend -> reviewer -> integration_tester.

## Financial And Data Rules

1. Final monetary calculation must happen on the backend.
2. Frontend may display calculated amounts but must not be trusted for final prices, fees, refunds, settlement, or ledger changes.
3. Orders must store snapshots: user paid amount, sale price, platform supply price, service fee, agent expected income, shop, agent, product, and fulfillment rules.
4. Refunds, settlements, deposit deductions, and追扣 must be recorded as auditable ledger-like records. Do not only mutate balances.
5. Payment callbacks, refund callbacks, fulfillment, and settlement generation must be idempotent.
6. Agents must never access other agents' shops, orders, customers, settlement data, or private product data.
7. Risk-frozen, refunding, complaint, or fulfillment-failed orders must not enter settlement.

## Documentation Requirements

Before coding starts, the team must ensure documentation covers:

1. Admin modules and pages.
2. Backend domain modules and API groups.
3. Database entities and key fields.
4. Order/payment/fulfillment/refund/settlement/deposit state machines.
5. Permission and data isolation.
6. Test and release acceptance criteria.
<!-- CCB-WORKFLOW-END -->

<!-- CCB-ROLE-START -->
# Role Memory: integration_tester

You own functional, API, UI, payment, refund, fulfillment, settlement, permission, and regression testing.

## Required Full Flow

Before release, verify this full chain:

1. Agent submits onboarding application.
2. Platform reviews agent.
3. Agent deposit is recorded.
4. Agent configures shop and customer-service WeChat account.
5. Platform creates product.
6. Agent lists product and sets sale price above minimum sale price.
7. User enters agent shop.
8. User places order and pays.
9. Payment callback is processed idempotently.
10. Virtual product is fulfilled.
11. Agent expected income is generated.
12. Refund is requested and freezes settlement.
13. Refund responsibility is assigned.
14. Refund amount and ledger changes are correct.
15. T+1 settlement excludes frozen/refunding/risk orders.
16. Settlement sheet and manual payout record are generated.
17. Already-settled refund creates追扣.
18. Deposit deduction works when needed.

## Must-Test Scenarios

1. Price below minimum sale price is rejected.
2. Agent cannot access another agent's orders, customers, products, or settlement data.
3. User cannot access another user's order.
4. Duplicate payment callback does not duplicate fulfillment or ledger entries.
5. Duplicate refund callback does not duplicate refund or追扣.
6. Fulfillment failure freezes settlement.
7. Risk-frozen order cannot enter settlement.
8. Admin actions create audit logs.

## Reporting

Report test scope, test cases run, pass/fail summary, defects with reproduction steps, and final readiness assessment.
<!-- CCB-ROLE-END -->

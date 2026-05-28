<!-- CCB-ROLE-START -->
# Role Memory: integration_tester

You own functional, API, UI, payment, refund, fulfillment, supply clearing, permission, and regression testing.

## Required Full Flow

Before release, verify this full chain:

1. Unknown agent submits onboarding application with invite code, or trusted first-tier merchant is manually created by platform admin.
2. Platform reviews agent where applicable.
3. Agent deposit is recorded and manually confirmed where applicable.
4. Agent configures shop and customer-service WeChat account.
5. Agent configures collection channel and platform reviews it.
6. Platform creates product.
7. Agent lists product and sets sale price above minimum sale price.
8. User enters H5 agent shop.
9. User places order and selects collection channel.
10. Payment/collection confirmation is processed idempotently.
11. Virtual product is fulfilled automatically or manually.
12. Agent expected income is generated.
13. Refund is requested and freezes supply clearing.
14. Refund responsibility is assigned.
15. Refund amount and ledger changes are correct.
16. Supply payable/service-fee clearing excludes frozen/refunding/risk orders.
17. Clearing sheet and offline proof record are generated when applicable; no platform-to-merchant T+1 payout is expected.
18. Already-cleared refund creates追扣.
19. Deposit deduction works when needed.
20. Automatic virtual-code extraction works only for products configured with extract code: buyer extract code, 3-failure lock for 30 minutes, repeat viewing before refund, and no viewing after refund.
21. Checkout email is optional; email delivery happens only when buyer provides email, and missing email does not block order creation.

## Must-Test Scenarios

1. Price below minimum sale price is rejected.
2. Agent cannot access another agent's orders, customers, products, or clearing data.
3. User cannot access another user's order.
4. Duplicate payment callback does not duplicate fulfillment or ledger entries.
5. Duplicate refund callback does not duplicate refund or追扣.
6. Fulfillment failure freezes supply clearing.
7. Risk-frozen order cannot enter clearing.
8. Admin actions create audit logs.
9. Production UI/API does not rely on hardcoded shop/product/merchant ids, collection QR codes, product details, prices, virtual codes, or mock payment results.
10. Second-tier merchants cannot see platform-to-first-tier supply price; third-tier merchants cannot see platform supply price or first-tier transfer price.
11. Platform/first-tier/second-tier invite codes create only first/second/third-tier merchants; third-tier cannot create fourth-tier invite codes.
12. Before deposit confirmation, merchants cannot sell, select/list products, proxy upstream products, configure transfer prices, or create payable orders.
13. Manual first-tier merchant/shop creation generates account credentials, records delivery status, starts in pending deposit, and writes audit logs.

## Reporting

Report test scope, test cases run, pass/fail summary, defects with reproduction steps, and final readiness assessment.
<!-- CCB-ROLE-END -->

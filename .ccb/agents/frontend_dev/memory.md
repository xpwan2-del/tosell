<!-- CCB-ROLE-START -->
# Role Memory: frontend_dev

You own the H5 buyer storefront, merchant backend UI, and platform admin UI. You do not own final money calculations.

## UI Surfaces

This project includes at least three frontend surfaces:

1. H5 buyer storefront: independent shop, search/category, product list, product details, order confirmation, collection-channel page, order query, optional-email checkout, product-configured virtual-code extraction, refund/s售后 request.
2. Merchant backend: onboarding application with invite code, deposit status, shop setup, customer-service QR binding, collection-channel binding, product selection, pricing, self-submitted products, inventory/virtual codes, orders, income, frozen amount, supply payable/service-fee clearing records.
3. Platform admin: merchant review, manual first-tier merchant/shop creation with initial account/password, deposit management/manual confirmation, product management, product review, collection-channel review, order management, fulfillment management, refund arbitration, supply clearing sheets, risk freeze, audit logs, and dashboards.

## Frontend Rules

1. Do not implement this as a mini-program P0. The buyer surface is H5.
2. Do not make frontend-calculated prices, fees, refunds, or clearing amounts authoritative.
3. Display backend-returned values for sale price, supply price visibility, service fee, expected income, frozen amount, refund amount, and clearing amount.
4. Make statuses visible: order status, fulfillment status, refund status, clearing status, deposit status, and shop status.
5. Admin UI should be work-focused: searchable, filterable, auditable, and efficient for repeated operations.
6. Do not show platform supply price to ordinary users.
7. Agents must only see their own shop, orders, customers, products, and financial data.
8. Do not hardcode shop/product/price/inventory/virtual codes/customer-service QR/collection QR/payment links/channel relations/coupons/mock payment results in production UI.
9. H5 should use Amazon-style clean commerce UI, but every product/detail/payment/customer-service field must come from API.
10. Respect price visibility: second-tier UI must not show platform-to-first-tier supply price; third-tier UI must not show platform supply price or first-tier transfer price.
11. Controlled three-tier B2B2C price-spread supply is allowed. Do not build fourth-tier channels, commission distribution, team rewards, invitation rewards, or recruiting-based income UI.
12. Platform coupons are platform subsidy. UI must display backend-calculated pre-coupon sale amount, coupon discount, buyer paid amount, and clearing values; do not let frontend coupon math change merchant price-spread clearing.
13. Checkout email is optional. Only show required extract-code input when the product API says extract code is enabled; otherwise do not force extract code.
14. H5 storefront must be clean, Amazon-inspired, restrained, polished, and brand-recognizable: white commerce surface, dark header, orange action accents, high readability, no clutter, no generic demo look.
15. Before deposit is confirmed, merchant UI must disable sales, product selection/listing, upstream product proxying, transfer-price configuration, and payable order operations with clear status/reason text.

## Collaboration

Wait for `pm_architect`, `database_expert`, and `backend_worker` to define workflows, data contracts, and API contracts before building screens.

When API contracts are unclear, ask `main` to route clarification to `backend_worker` or `pm_architect`.
<!-- CCB-ROLE-END -->

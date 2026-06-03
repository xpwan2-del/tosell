# ToSell Agent Rules

## Production/Test Database Rule

All functional testing, acceptance testing, smoke testing, browser verification, API verification, and regression sign-off must use the real Google VM PostgreSQL database described in `docs/ops-connection-map.md`.

Do not use local in-memory persistence as evidence that a feature works.

Allowed uses of in-memory tests:

1. Narrow unit tests for pure logic.
2. Fast local checks that are clearly reported as non-acceptance evidence.

Not allowed:

1. Saying a feature is complete based only on in-memory tests.
2. Running page-level acceptance against mock/demo/memory persistence.
3. Using old cloud database URLs or local `localhost:5432` development databases as production-test evidence.

Before any real functional test, run:

```bash
npm run test:real-db:guard
```

For local maintenance, use the SSH tunnel documented in `docs/ops-connection-map.md` and a real database password. The placeholder `CHANGE_ME` must never be used for testing.

Required production-test switches:

```env
APP_ENV=production
ALLOW_DEMO_AUTH=false
MOCK_PAYMENT_ENABLED=false
DATABASE_URL=postgresql://tosell:<password>@127.0.0.1:15432/tosell?sslmode=require
```

On the Google VM itself, `DATABASE_URL` may point to `127.0.0.1:5432`.

If this file conflicts with a task note or older document, this file wins for testing policy.

## Admin Design System Rules

The admin UI must follow `docs/admin-unified-layout-remediation-plan.md`.

IMPORTANT: Do not make isolated visual fixes that create a new layout pattern. Before changing any admin page, classify it as one of these page types: list, detail/drawer, form, review, inventory, finance, dashboard.

Admin implementation rules:

1. Use the existing React admin app in `apps/admin/src/main.tsx` and styling in `apps/admin/src/styles.css` until a deliberate component split is planned.
2. Reuse existing primitives first: `Module`, `Panel`, `Table`, `KeyValue`, `StatusBadge`, `ConfirmModal`, `ProductImage`, structured search blocks, and drawer patterns.
3. Use CSS variables from `apps/admin/src/styles.css` for font size, spacing, colors, border radius, and control height. Do not introduce random page-level font sizes, hex colors, large border radii, decorative gradients, or one-off spacing.
4. Every admin module must have one clear module title, one short subtitle, and human-facing "how to use" copy. Do not put API names, RBAC implementation text, database table names, or audit action names in the primary operator UI.
5. Search areas must be structured: separate keyword, status, date/range, category/type, and price/amount fields where relevant, with Search and Reset buttons.
6. Tables are for desktop density. On mobile, important tables must become object cards or read-only summaries instead of horizontal overflow-heavy maintenance screens.
7. Drawers are for detail and edit. Long batch operations, inventory imports, and finance workflows belong in their dedicated module, not inside unrelated detail drawers.
8. High-risk admin actions must have loading/disabled state, second confirmation, clear before/after values where applicable, and success/failure feedback.
9. Product detail shows product settings and automatic-delivery overview only. Automatic-delivery stock import/export/reveal belongs in the automatic stock module.
10. Browser verification for admin visual changes must check desktop, tablet, and phone widths. Business write-flow verification must still follow the real Google VM PostgreSQL rule above.

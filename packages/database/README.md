# @tosell/database

Database foundation for the V1 B2B2C virtual product shop platform.

The Prisma schema targets PostgreSQL in production and uses static Vitest checks for the initial database contract. All authoritative money fields use integer cents via Prisma `BigInt`.

## Commands

```bash
npm run db:validate
npm test
npm run db:generate
npm run db:seed
```

Set `DATABASE_URL` before running Prisma commands that connect to a database.

export { PrismaClient } from "@prisma/client";
export type { Prisma } from "@prisma/client";
export {
  TransactionService,
  createPrismaRepositories
} from "./repositories.js";
export type {
  PrismaRepositoryRegistry,
  PrismaTx
} from "./repositories.js";

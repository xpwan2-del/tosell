import { buildApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const app = buildApp();

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (error: unknown) {
  app.log.error(error);
  process.exit(1);
}

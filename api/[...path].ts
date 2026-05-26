import { buildApp } from "../apps/api/src/app.js";

const app = buildApp();
const ready = app.ready();

export default async function handler(request: unknown, response: unknown) {
  await ready;
  app.server.emit("request", request, response);
}

import { buildApp } from "../apps/api/src/app.js";

const app = buildApp();
const ready = app.ready();

type VercelRequest = {
  url?: string;
  headers?: { host?: string };
};

export default async function handler(request: VercelRequest, response: unknown) {
  await ready;
  normalizeApiUrl(request);
  app.server.emit("request", request, response);
}

function normalizeApiUrl(request: VercelRequest) {
  const host = request.headers?.host ?? "localhost";
  const url = new URL(request.url ?? "/api", `https://${host}`);
  const path = url.searchParams.get("path");
  if (!path) return;
  url.searchParams.delete("path");
  const query = url.searchParams.toString();
  request.url = `/api/${path}${query ? `?${query}` : ""}`;
}

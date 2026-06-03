import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.ts";

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("api runtime configuration", () => {
  it("does not start without a configured PostgreSQL database", () => {
    delete process.env.DATABASE_URL;
    expect(() => buildApp()).toThrow(/DATABASE_URL is required/);
  });
});

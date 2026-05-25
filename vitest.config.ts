import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node"
  },
  resolve: {
    alias: {
      "@tosell/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@tosell/database": new URL("./packages/database/src/index.ts", import.meta.url).pathname
    }
  }
});

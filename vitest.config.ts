import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/{unit,integration,e2e}/**/*.test.ts"],
    environment: "node",
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/server/**/*.test.{ts,tsx}", "tests/client/**/*.test.{ts,tsx}", "tests/setup/**/*.test.ts"],
  },
});

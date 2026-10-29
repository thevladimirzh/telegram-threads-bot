import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // All tests live under tests/{unit,acceptance,security}; helpers/ holds shared tooling.
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});

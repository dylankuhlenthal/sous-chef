import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only the TypeScript tests: the behaviour suite is Python (tests/test_*.py) until TRV-1157.
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
  },
});

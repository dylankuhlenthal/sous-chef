import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Files run in parallel, the tests within a file one at a time (vitest's default, forks
    // pool): every test has its own temporary home, work folder and code copy, and the fake
    // relay takes a free port. 60 s is the longest wait any test has (a watcher subprocess).
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});

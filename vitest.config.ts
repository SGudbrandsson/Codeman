import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Run test files sequentially to respect mux session limits
    // Individual tests within files still run in parallel where safe
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/cli.ts'],
    },
    testTimeout: 30000, // 30 seconds for integration tests
    hookTimeout: 60000, // 60 seconds for beforeAll/afterAll hooks (Playwright setup under load)
    // Ensure cleanup runs even on test failures
    teardownTimeout: 60000,
  },
});

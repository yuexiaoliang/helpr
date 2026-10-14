import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/workspace/**/*.test.{ts,tsx}'], testTimeout: 10000 },
});

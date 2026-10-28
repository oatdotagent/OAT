import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'web/test/**/*.test.ts'],
    testTimeout: 15000,
    // Tests never touch real providers; this guards against accidental live calls.
    env: { NODE_ENV: 'test' },
  },
});

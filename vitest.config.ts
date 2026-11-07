import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // Bound resource use on shared development hosts.
    maxWorkers: 4,
    minWorkers: 1,
  },
});

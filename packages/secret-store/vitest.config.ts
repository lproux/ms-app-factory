import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // OneDrive NTFS via WSL is slow; per fleet perf note.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // OneDrive NTFS via WSL is slow; allow ample budget for sharp + dynamic imports.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});

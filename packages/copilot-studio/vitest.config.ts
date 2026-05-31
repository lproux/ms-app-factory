import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // /mnt/c (OneDrive-synced NTFS via WSL) is much slower than WSL native;
    // bump per-test and per-hook timeouts so filesystem IO completes.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
